import { tool, jsonSchema, type Tool, type ToolSet } from "ai";
import { createSearchProvider, type SearchProvider } from "./search";
import { createFetchProvider, type FetchProvider } from "./fetch";
import { getExecutor, formatExecResult, type Executor } from "./executor";
import {
  lardEnabled, lardConnected, contextToText,
  getContext, memoryList, memoryRead, memoryWrite, memoryAppend,
} from "./lard";
import type { Store } from "./store";

/**
 * The tool registry. Each entry is an AI SDK `tool` with an input schema and an
 * `execute`; `streamText` runs the agentic loop (call → execute → feed back),
 * and the actor persists each tool-call/tool-result as a durable event that the
 * UI renders as a timeline step.
 *
 * Tools are only offered when their backing capability is configured (e.g.
 * `web_search` appears only when a search provider is set), so a deployment
 * without them sends no `tools` at all.
 *
 * First slice: read-only, side-effect-free tools executed in-process. The
 * durable-loop guarantee (persist a result before the model sees it, so a job
 * reclaim doesn't re-run a side-effecting tool) and the sandbox executor come
 * with dangerous tools later — pure tools are safe to re-run on reclaim.
 */

function webSearch(provider: SearchProvider) {
  return tool({
    description:
      "Search the web for current information, beyond your training data. Returns " +
      "results with title, URL, and snippet. Write a specific, keyword-focused " +
      "query with the key entities and context (e.g. \"OpenAI GPT-5 release date\"), " +
      "not a conversational question. Search operators (site:, intitle:, inurl:, " +
      "define:, related:) are unsupported and make the search fail.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword-focused query: specific entities and context, not a full sentence. No operators.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query }) => ({ results: await provider.search(query) }),
  });
}

function fetchUrl(provider: FetchProvider) {
  return tool({
    description:
      "Fetch a web page and return its main article content as clean markdown " +
      "(navigation, ads, and boilerplate removed). Use it to read a page found " +
      "via web_search, or any known URL. Provide the full http(s) URL.",
    inputSchema: jsonSchema<{ url: string }>({
      type: "object",
      properties: { url: { type: "string", description: "The full http(s) URL to fetch" } },
      required: ["url"],
      additionalProperties: false,
    }),
    execute: async ({ url }) => provider.fetch(url),
  });
}

// A shell command in the sandbox executor (docker locally, a spindle microVM on
// the homelab later). Offered only when a sandbox is configured. Marked
// `sandbox` so the (future) durable loop routes it to the executor rather than
// running it in-process; today its `execute` calls the executor directly.
function runShell(executor: Executor, session?: string) {
  return tool({
    description:
      "Run a shell command in an isolated sandbox — a Linux container private to this " +
      "conversation. `/workspace` (the working directory) and anything you install " +
      "(e.g. `apk add git`) PERSIST across calls in this chat, so you can build up state " +
      "step by step. Returns the exit code, stdout, and stderr. No network unless the " +
      "deployment enables it. It is NOT the user's machine — it can't reach their real " +
      "filesystem or services, and it's torn down when the conversation ends.",
    inputSchema: jsonSchema<{ command: string }>({
      type: "object",
      properties: { command: { type: "string", description: "The shell command line to run (via sh -c), starting in /workspace." } },
      required: ["command"],
      additionalProperties: false,
    }),
    execute: async ({ command }, { abortSignal }) => formatExecResult(await executor.run({ command, session }, abortSignal)),
  });
}

/**
 * The tool table: each entry's `create` returns its AI SDK tool, or null when
 * its backing capability isn't configured (so it's simply not offered), and an
 * `executor` tag — `in-proc` runs in this process (pure/read-only), `sandbox`
 * hands off to the executor. Add a tool by adding one entry here (and, for a
 * nicer UI, one entry in the client's TOOL_UI registry — unknown tools still
 * render with a sensible default).
 */
const REGISTRY: Array<{ name: string; executor: "in-proc" | "sandbox"; create: (ctx: ToolContext) => Tool | null }> = [
  { name: "fetch_url", executor: "in-proc", create: () => { const p = createFetchProvider(); return p ? fetchUrl(p) : null; } },
  { name: "web_search", executor: "in-proc", create: () => { const p = createSearchProvider(); return p ? webSearch(p) : null; } },
  { name: "run_shell", executor: "sandbox", create: (ctx) => { const e = getExecutor(); return e ? runShell(e, ctx.conversationId) : null; } },
];

// lard memory tools, bound to ONE kloe user's token (store + sub). Only offered
// when that user is connected, so the model can read/record durable context.
// Paths are lard's own: `profile`, `areas/<n>`, `topics/<n>`, `people/<n>`.
function lardTools(store: Store, sub: string): ToolSet {
  const pathSchema = jsonSchema<{ path: string }>({
    type: "object", additionalProperties: false, required: ["path"],
    properties: { path: { type: "string", description: "Subject path, e.g. profile, areas/homelab, people/kieran." } },
  });
  return {
    memory_get_context: tool({
      description: "Get the durable memory context: the user profile plus a listing of every subject on record. Call this to ground yourself before answering.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false, properties: {} }),
      execute: async () => contextToText(await getContext(store, sub)),
    }),
    memory_list: tool({
      description: "List all memory subjects (path, kind, name, description).",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false, properties: {} }),
      execute: async () => JSON.stringify(await memoryList(store, sub)),
    }),
    memory_read: tool({
      description: "Read one memory subject's markdown body.",
      inputSchema: pathSchema,
      execute: async ({ path }) => memoryRead(store, sub, path),
    }),
    memory_write: tool({
      description: "Overwrite a memory subject with new markdown. Use to correct or rewrite a subject; prefer memory_append for adding a single fact.",
      inputSchema: jsonSchema<{ path: string; body: string }>({
        type: "object", additionalProperties: false, required: ["path", "body"],
        properties: { path: { type: "string" }, body: { type: "string", description: "Full markdown body to store." } },
      }),
      execute: async ({ path, body }) => { await memoryWrite(store, sub, path, body); return `wrote ${path}`; },
    }),
    memory_append: tool({
      description: "Append one line/fact to a memory subject (created if absent).",
      inputSchema: jsonSchema<{ path: string; line: string }>({
        type: "object", additionalProperties: false, required: ["path", "line"],
        properties: { path: { type: "string" }, line: { type: "string", description: "A single line to append." } },
      }),
      execute: async ({ path, line }) => { await memoryAppend(store, sub, path, line); return `appended to ${path}`; },
    }),
  };
}

/** Extra context a run passes in so per-user tools (lard) bind to the right token. */
export interface ToolContext { store?: Store; owner?: string; conversationId?: string; }

/**
 * Wrap every tool's `execute` so a failure returns a clean, recoverable message
 * instead of throwing. A thrown execute is not fatal on its own (the SDK feeds
 * it back as a tool-error), but a raw throw dumps a stack trace to the logs and
 * hands the model an opaque `Error` object; a caught, phrased result keeps the
 * turn moving and tells the model it may simply try something else. Backends
 * fail routinely — a 404 page, a 400 from a strict API — so this is the norm,
 * not the exception.
 */
export function harden(tools: ToolSet): ToolSet {
  for (const [name, t] of Object.entries(tools)) {
    const orig = t.execute;
    if (!orig) continue;
    t.execute = async (input: unknown, options: Parameters<NonNullable<Tool["execute"]>>[1]) => {
      try {
        return await orig(input as never, options);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[tool ${name}] ${msg}`);
        return `Tool "${name}" failed: ${msg}. This is not fatal — try a different input or approach, or tell the user plainly what went wrong.`;
      }
    };
  }
  return tools;
}

/** The tools available to a run; empty → no tools passed to the provider. */
export function toolSet(ctx: ToolContext = {}): ToolSet {
  const tools: ToolSet = {};
  for (const entry of REGISTRY) {
    const t = entry.create(ctx);
    if (t) tools[entry.name] = t;
  }
  if (ctx.store && ctx.owner && lardEnabled() && lardConnected(ctx.store, ctx.owner)) {
    Object.assign(tools, lardTools(ctx.store, ctx.owner));
  }
  return harden(tools);
}
