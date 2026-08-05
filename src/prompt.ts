import { readFileSync } from "node:fs";
import type { ToolSet } from "ai";
import { getConfig } from "./settings";

/**
 * The system prompt. A single publisher-owned template (`prompt.tpl`, Go
 * text/template syntax so it reads like Crush's) is rendered per run with the
 * current date, the deployment's persona/preferences from config, and the set
 * of tools actually exposed. The rendered string is passed to `streamText` as
 * `system` (see inference.ts) — so every turn is grounded in the date and knows
 * which tools it may reach for, which is the other half of getting a model to
 * actually call them (the first half is exposing the tools at all).
 *
 * The renderer implements just the subset of Go templating the file uses —
 * `{{.Field}}`, `{{if .Cond}}…{{else}}…{{end}}`, `{{range .List}}…{{end}}`, and
 * `{{/* comments *\/}}` — deliberately small, not a general engine.
 */

// ---- template renderer (Go text/template subset) -----------------------

type Node =
  | { k: "text"; v: string }
  | { k: "var"; path: string }
  | { k: "if"; cond: string; then: Node[]; alt: Node[] }
  | { k: "range"; path: string; body: Node[] };

type Tok = { t: "text"; v: string } | { t: "act"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\{\{(.*?)\}\}/gs; // comments/actions never contain `}}`
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) toks.push({ t: "text", v: src.slice(last, m.index) });
    toks.push({ t: "act", v: m[1]!.trim() });
    last = re.lastIndex;
  }
  if (last < src.length) toks.push({ t: "text", v: src.slice(last) });
  return toks;
}

/** Parses tokens into a node list until an `else`/`end` at this level (or EOF). */
function parseNodes(toks: Tok[], start: number): { nodes: Node[]; end: number } {
  const nodes: Node[] = [];
  let i = start;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (tok.t === "text") { nodes.push({ k: "text", v: tok.v }); i++; continue; }
    const a = tok.v;
    if (a.startsWith("/*") || a === "") { i++; continue; } // comment / empty
    if (a === "else" || a === "end") return { nodes, end: i };
    if (a.startsWith("if ")) {
      const cond = a.slice(3).trim();
      const thenP = parseNodes(toks, i + 1);
      let alt: Node[] = [];
      let j = thenP.end;
      if (toks[j]?.t === "act" && (toks[j] as { v: string }).v === "else") {
        const elseP = parseNodes(toks, j + 1);
        alt = elseP.nodes;
        j = elseP.end;
      }
      nodes.push({ k: "if", cond, then: thenP.nodes, alt });
      i = j + 1; // skip the matching `end`
      continue;
    }
    if (a.startsWith("range ")) {
      const path = a.slice(6).trim();
      const bodyP = parseNodes(toks, i + 1);
      nodes.push({ k: "range", path, body: bodyP.nodes });
      i = bodyP.end + 1; // skip `end`
      continue;
    }
    if (a.startsWith(".")) { nodes.push({ k: "var", path: a }); i++; continue; }
    i++; // unknown action: ignore
  }
  return { nodes, end: i };
}

/** Resolves a dotted path against the current dot (`.` is the dot itself). */
function resolve(path: string, dot: unknown): unknown {
  if (path === ".") return dot;
  let cur: unknown = dot;
  for (const key of path.slice(1).split(".")) {
    cur = cur == null ? undefined : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  if (v == null || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function render(nodes: Node[], dot: unknown): string {
  let out = "";
  for (const n of nodes) {
    if (n.k === "text") out += n.v;
    else if (n.k === "var") { const v = resolve(n.path, dot); out += v == null ? "" : String(v); }
    else if (n.k === "if") out += truthy(resolve(n.cond, dot)) ? render(n.then, dot) : render(n.alt, dot);
    else if (n.k === "range") {
      const list = resolve(n.path, dot);
      if (Array.isArray(list)) for (const item of list) out += render(n.body, item);
    }
  }
  return out;
}

/** Renders a Go-template-subset string against `data`. Exported for tests. */
export function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  return render(parseNodes(tokenize(tpl), 0).nodes, data);
}

// ---- system prompt assembly --------------------------------------------

let compiled: Node[] | null = null;

function templateNodes(path?: string): Node[] {
  // Cache the parsed default template; a per-config override path is re-read
  // (cheap, and lets a deployment iterate on its prompt without a restart cost
  // worth optimizing).
  if (path) return parseNodes(tokenize(readFileSync(path, "utf8")), 0).nodes;
  if (!compiled) {
    const src = readFileSync(new URL("./prompt.tpl", import.meta.url), "utf8");
    compiled = parseNodes(tokenize(src), 0).nodes;
  }
  return compiled;
}

/** A friendly, unambiguous date for the prompt: "Monday, August 4, 2026". */
function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

/** The `<tools>` body: one line per exposed tool. Empty → the section is dropped. */
function toolsBlock(tools: ToolSet): string {
  const names = Object.keys(tools);
  if (names.length === 0) return "";
  return names
    .map((n) => {
      const desc = (tools[n] as { description?: string }).description ?? "";
      return `- ${n}: ${desc}`;
    })
    .join("\n");
}

/** Reads the configured context files into `{Path, Content}` for the <memory> block. */
function contextFiles(paths: string[]): Array<{ Path: string; Content: string }> {
  const out: Array<{ Path: string; Content: string }> = [];
  for (const p of paths) {
    try { out.push({ Path: p, Content: readFileSync(p, "utf8").trimEnd() }); }
    catch { /* a missing context file is skipped, not fatal */ }
  }
  return out;
}

/**
 * Builds the system prompt for a run. `tools` is the set actually exposed to
 * this run (so the <tools> section — and its "reach for tools" nudge — appears
 * only when there are tools to reach for).
 */
export function buildSystemPrompt(opts: { tools: ToolSet; now?: Date; memory?: string }): string {
  const p = getConfig().prompt;
  const data: Record<string, unknown> = {
    Memory: opts.memory?.trim() ?? "",
    Name: p.name,
    Tagline: p.tagline ?? "",
    Date: formatDate(opts.now ?? new Date()),
    Math: p.math,
    NoEmoji: p.noEmoji,
    Personality: p.personality ?? "",
    Preferences: p.preferences ?? "",
    Boundaries: p.boundaries ?? "",
    Platform: p.platform ?? "",
    Tools: toolsBlock(opts.tools),
    ContextFiles: contextFiles(p.contextFiles),
  };
  // Collapse the blank-line runs Go-style block actions leave behind (an
  // `{{if}}…{{end}}` that renders nothing still leaves its surrounding newlines).
  return render(templateNodes(p.templatePath), data).replace(/\n{3,}/g, "\n\n").trim();
}
