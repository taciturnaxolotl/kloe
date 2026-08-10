import { afterEach, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { buildSystemPrompt, renderTemplate } from "../src/prompt";
import { loadConfig, setConfig } from "../src/settings";

afterEach(() => setConfig(null)); // drop any test config override

test("renderTemplate substitutes fields and honors if/else", () => {
  const tpl = "Hi {{.Name}}{{if .Tag}}, {{.Tag}}{{end}}. {{if .On}}ON{{else}}OFF{{end}}";
  expect(renderTemplate(tpl, { Name: "Kloe", Tag: "bot", On: true })).toBe("Hi Kloe, bot. ON");
  expect(renderTemplate(tpl, { Name: "Kloe", Tag: "", On: false })).toBe("Hi Kloe. OFF");
});

test("renderTemplate ranges over a list binding the dot", () => {
  const tpl = "{{range .Files}}<{{.Path}}:{{.Content}}>{{end}}";
  const out = renderTemplate(tpl, {
    Files: [
      { Path: "a", Content: "1" },
      { Path: "b", Content: "2" },
    ],
  });
  expect(out).toBe("<a:1><b:2>");
});

test("renderTemplate strips comments and treats empty list as falsey", () => {
  const tpl = "{{/* a comment */}}A{{if .Xs}}has{{end}}B";
  expect(renderTemplate(tpl, { Xs: [] })).toBe("AB");
  expect(renderTemplate(tpl, { Xs: [1] })).toBe("AhasB");
});

function cfg(prompt: Record<string, unknown>): void {
  const base = loadConfig({ path: "/nonexistent", env: {} }); // schema defaults only
  setConfig({ ...base, prompt: { ...base.prompt, ...prompt } });
}

test("buildSystemPrompt includes the date and a tools section only when tools exist", () => {
  cfg({});
  const now = new Date("2026-08-04T12:00:00Z");
  const noTools = buildSystemPrompt({ tools: {} as ToolSet, now });
  expect(noTools).toContain("August 4, 2026");
  expect(noTools).not.toContain("<tools>");

  const withTools = buildSystemPrompt({
    tools: { web_search: { description: "Search the web." } } as unknown as ToolSet,
    now,
  });
  expect(withTools).toContain("<tools>");
  expect(withTools).toContain("web_search: Search the web.");
});

test("the tools section is an inventory: first sentence only, and no sandbox line without one", () => {
  cfg({});
  const now = new Date("2026-08-04T12:00:00Z");
  // The provider already sends the full description next to the schema, so the
  // prompt carries the summary and stops there.
  const out = buildSystemPrompt({
    tools: {
      web_search: { description: "Search the web.\n\nA second paragraph of detail." },
    } as unknown as ToolSet,
    now,
  });
  expect(out).toContain("web_search: Search the web.");
  expect(out).not.toContain("second paragraph");
  expect(out).not.toContain("/workspace/outputs");

  const sandboxed = buildSystemPrompt({
    tools: {
      run_shell: { description: "Run a shell command in an isolated sandbox — a container." },
    } as unknown as ToolSet,
    now,
  });
  expect(sandboxed).toContain("/workspace/outputs");
});

test("buildSystemPrompt injects a project's context files as <file> blocks", () => {
  cfg({});
  const out = buildSystemPrompt({
    tools: {} as ToolSet,
    now: new Date("2026-08-04"),
    contextFiles: [{ filename: "spec.md", body: "The widget must be blue." }],
  });
  expect(out).toContain('<file path="spec.md">');
  expect(out).toContain("The widget must be blue.");
});

test("buildSystemPrompt renders configured persona and drops emoji when asked", () => {
  cfg({ name: "Nova", personality: "Terse and precise.", noEmoji: true });
  const out = buildSystemPrompt({ tools: {} as ToolSet, now: new Date("2026-08-04") });
  expect(out).toContain("You are Nova.");
  expect(out).toContain("Terse and precise.");
  expect(out).toContain("Skip emoji");
});
