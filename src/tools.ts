import { jsonSchema, type LanguageModel, type Tool, type ToolSet, tool } from "ai";
import type { BlobStore } from "./blobs";
import type { ArtifactRef } from "./events";
import { type Executor, formatExecResult, getExecutor, type SandboxInfo } from "./executor";
import { createFetchProvider, type FetchProvider } from "./fetch";
import {
  contextToText,
  getContext,
  lardConnected,
  lardEnabled,
  memoryAppend,
  memoryList,
  memoryRead,
  memoryWrite,
} from "./lard";
import { runResearch } from "./research";
import { createSearchProvider, type SearchProvider } from "./search";
import { getConfig } from "./settings";
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
      'query with the key entities and context (e.g. "OpenAI GPT-5 release date"), ' +
      "not a conversational question. Search operators (site:, intitle:, inurl:, " +
      "define:, related:) are unsupported and make the search fail.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keyword-focused query: specific entities and context, not a full sentence. No operators.",
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

/**
 * Hand a whole question to a research subagent (research.ts) and get back one
 * cited answer.
 *
 * The point is the context boundary. The subagent burns its own window on
 * searches and full page text and returns a few hundred tokens of findings, so
 * the conversation gets the conclusions of twenty pages without carrying twenty
 * pages. That only pays off when the question is actually worth it, which is
 * what the description spends its words on: a model that reaches for this to
 * check one fact has bought a minute of latency for nothing.
 */
function deepResearch(
  model: LanguageModel,
  search: SearchProvider,
  fetcher: FetchProvider,
  ctx: ToolContext,
) {
  const onProgress = ctx.onProgress;
  return tool({
    description:
      "Hand off a question that needs real research — several searches, several " +
      "pages read, findings reconciled across sources — to a subagent that does " +
      "the whole job and returns a cited summary. It splits the question into " +
      "angles, researches them in parallel, and merges the findings — it can read " +
      "a couple of hundred pages and take ten minutes or more, so treat it as a " +
      "job worth waiting for rather than a lookup. " +
      "Use it for open questions where the answer has to be assembled: comparisons " +
      "across vendors or papers, the current state of a moving topic, anything " +
      "where one page won't settle it. Do NOT use it to look up a single fact or " +
      "read a URL you already have — web_search and fetch_url are faster and " +
      "cheaper for those. Ask ONE self-contained question, with the context the " +
      "subagent needs: it cannot see this conversation. You get back a summary and " +
      "the name of a document that is shown to the user directly — relay the summary " +
      "and point at the document rather than trying to reproduce it. If a later " +
      "question needs detail the summary doesn't carry, read the document back with " +
      "read_artifact.",
    inputSchema: jsonSchema<{ question: string }>({
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The full research question, self-contained. Include any constraints " +
            "that matter (timeframe, which alternatives to weigh, what it's for).",
        },
      },
      required: ["question"],
      additionalProperties: false,
    }),
    execute: async ({ question }, { toolCallId, abortSignal }) => {
      const out = await runResearch({
        question,
        model,
        search,
        fetcher,
        signal: abortSignal,
        onProgress: onProgress
          ? (phase, data) => onProgress({ toolCallId, toolName: "deep_research", phase, data })
          : undefined,
      });
      // The report becomes a blob and the result carries a REFERENCE — never the
      // bytes. A finished document is thousands of tokens and a tool result is
      // permanent context, re-sent on every later turn; the reference is a
      // handful of tokens and is also the handle everything else works from,
      // since agent output shares the content-addressed store with user uploads
      // (read it back, download it, feed it to a later tool by sha256).
      const result: {
        summary: string;
        document: string;
        title: string;
        sources: number;
        stats: unknown;
        artifacts?: ArtifactRef[];
      } = {
        summary: out.summary,
        document: out.filename,
        title: out.title,
        sources: out.sources.length,
        stats: out.stats,
      };
      if (ctx.blobs) {
        const bytes = new TextEncoder().encode(out.report);
        const ref = await ctx.blobs.put(bytes);
        ctx.store?.recordBlob(ref.sha256, "text/markdown", ref.size);
        result.artifacts = [
          {
            sha256: ref.sha256,
            name: out.filename,
            title: out.title,
            mime: "text/markdown",
            size: ref.size,
          },
        ];
      }
      return result;
    },
  });
}

/**
 * Read back a document this conversation produced.
 *
 * `deep_research` hands the assistant a summary and a filename, never the report
 * — a finished document is thousands of tokens and a tool result is permanent
 * context. That's the right default and a bad absolute: sooner or later someone
 * asks "what did it say about the donors?", and the answer is sitting in the
 * event log.
 *
 * So the full text is available on request rather than by default. The cost is
 * paid once, in the turn that needs it, by the model that asked.
 */
function readArtifact(store: Store, blobs: BlobStore, conversationId: string) {
  return tool({
    description:
      "Read the full text of a document produced earlier in this conversation " +
      "(e.g. a report from deep_research, by its filename). Use it when the user " +
      "asks about something a document covers in more detail than the summary you " +
      "were given. The user can already see the document, so answer from it rather " +
      "than reproducing it wholesale. Pass a version to read an older revision; " +
      "the newest is used by default.",
    inputSchema: jsonSchema<{ name: string; version?: number }>({
      type: "object",
      properties: {
        name: { type: "string", description: "The document's name, e.g. 'hack-club-funding.md'." },
        version: {
          type: "number",
          description: "An earlier revision to read. Omit for the newest.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async ({ name, version }) => {
      const doc = store.getArtifact(conversationId, name, version);
      if (!doc) {
        // A wrong name is worth answering with the right ones — the model named
        // it from memory of a tool result several turns back.
        const have = store.listArtifacts(conversationId);
        return have.length
          ? `No document named "${name}"${version ? ` at version ${version}` : ""}. This conversation has: ${have
              .map((a) => `${a.name} (v${a.version})`)
              .join(", ")}.`
          : "No documents have been produced in this conversation yet.";
      }
      const blob = await blobs.get(doc.sha256);
      if (!blob) return `The bytes for "${name}" are missing from the blob store.`;
      return await blob.text();
    },
  });
}

/**
 * A safe single path segment. The model picks the name; it never picks the
 * directory, so a name can carry no separators, no traversal and no leading dot.
 */
function safeSegment(name: string): string {
  const base = name.replace(/[\\/]/g, "-").replace(/^\.+/, "").trim();
  return base.slice(0, 80) || "file";
}

/**
 * Pull a file into the sandbox so a tool can operate on it.
 *
 * The spec's universal invariant: every attachment and every artifact is
 * addressable by a stable handle and can be materialized into the workspace on
 * demand — independent of whether it ever appeared in context. An image the
 * model already saw can still be pulled in to be resized; a 200MB archive it
 * never saw can be pulled in and unpacked. Inlining is a convenience for what
 * fits in a prompt; this is how the bytes are actually worked with.
 */
function getAttachment(store: Store, blobs: BlobStore, executor: Executor, conversationId: string) {
  return tool({
    description:
      "Copy a file from this conversation — something the user attached, or a " +
      "document produced earlier — into the sandbox at /workspace/inputs/<name>, " +
      "so you can run commands against it. Works for any file of any size and " +
      "any type, including ones you were never shown the contents of. Name it " +
      "exactly as it appears in the conversation.",
    inputSchema: jsonSchema<{ name: string }>({
      type: "object",
      properties: {
        name: { type: "string", description: "The file's name, e.g. 'budget.csv'." },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async ({ name }, { abortSignal }) => {
      const files = store.listFiles(conversationId);
      const hit = files.find((f) => f.name === name) ?? files.find((f) => f.sha256 === name);
      if (!hit) {
        return files.length
          ? `No file named "${name}" in this conversation. Available: ${files.map((f) => f.name).join(", ")}.`
          : "This conversation has no files to pull in.";
      }
      const blob = await blobs.get(hit.sha256);
      if (!blob) return `The bytes for "${name}" are missing from the blob store.`;
      const path = `/workspace/inputs/${safeSegment(hit.name)}`;
      await executor.putFile(
        conversationId,
        path,
        new Uint8Array(await blob.arrayBuffer()),
        abortSignal,
      );
      return `Copied ${hit.name} (${blob.size} bytes, ${hit.mime}) to ${path}.`;
    },
  });
}

/**
 * Describe the sandbox the way it actually is.
 *
 * Everything the model knows about this environment it learns here, so the text
 * is assembled from the executor's own `info` rather than written once and hoped
 * over: a static "you can `apk add` things" is a lie under the default
 * `network: false`, and a model that doesn't know its wall clock will keep
 * writing commands that get killed at 30 seconds and reading the corpse as a bug.
 *
 * The other half is what is NOT claimed. The image is whatever the deployment
 * configured, so promising an interpreter is guesswork; a base alpine has
 * busybox and little else. Better to say so and point at `command -v` than to
 * send the model chasing a python3 that isn't there.
 */
export function sandboxDescription(info: SandboxInfo, hasAttachments: boolean): string {
  const secs = (ms: number) => Math.round(ms / 1000);
  const net = info.network
    ? "It HAS network access, so package installs work and persist for the rest of the chat — use the image's own " +
      "package manager (`apt-get install -y …`, `apk add …`, whichever it has). Reach only for what the task needs."
    : "It has NO network access: downloads, package installs, and any command that reaches out will fail. Work with what is in the image and what you are given.";
  return [
    "Run a shell command in an isolated sandbox — a Linux container private to this conversation. " +
      "Returns the exit code, stdout, and stderr. It is NOT the user's machine: it cannot see their files, " +
      "and it is torn down when the chat goes idle.",
    "",
    `Environment: the \`${info.image}\` image, ${info.cpus} cpu, ${info.memory} memory, no root outside the container. ` +
      "Do not assume what is installed, in either direction — the image may be a bare busybox or may already carry " +
      "a language runtime and a toolchain. `command -v python3` costs one call and settles it. " +
      net,
    "",
    `Time: a command is killed at ${secs(info.defaultTimeoutMs)}s by default. If it will legitimately take longer ` +
      `(a build, a large file), pass timeout_seconds — up to ${secs(info.maxTimeoutMs)}s. Long-running or interactive ` +
      "commands have nowhere to go: nothing can answer a prompt, so pass `-y`/`--yes` and redirect input from /dev/null.",
    "",
    "State: /workspace is the working directory and it PERSISTS across calls in this chat, so build things up step by " +
      "step rather than cramming a session into one command. It is still scratch — it dies with the container. " +
      "To KEEP a file, write it to /workspace/outputs/ (already created): anything there is saved as a document the " +
      "user can open and download, and is then removed from the directory, so do not expect to find it again — a " +
      "second write of the same name becomes a new version." +
      (hasAttachments
        ? " Files the user attached, and documents from earlier turns, arrive at /workspace/inputs/ via get_attachment."
        : ""),
  ].join("\n");
}

// A shell command in the sandbox executor (docker locally, a spindle microVM on
// the homelab later). Offered only when a sandbox is configured. Marked
// `sandbox` so the (future) durable loop routes it to the executor rather than
// running it in-process; today its `execute` calls the executor directly.
function runShell(executor: Executor, ctx: ToolContext) {
  const session = ctx.conversationId;
  const hasAttachments = Boolean(
    ctx.store && ctx.conversationId && ctx.store.listFiles(ctx.conversationId).length,
  );
  const maxSeconds = Math.round(executor.info.maxTimeoutMs / 1000);
  return tool({
    description: sandboxDescription(executor.info, hasAttachments),
    inputSchema: jsonSchema<{ command: string; timeout_seconds?: number }>({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command line to run (via sh -c), starting in /workspace.",
        },
        timeout_seconds: {
          type: "number",
          description: `Wall-clock cap for this command, up to ${maxSeconds}. Omit for the default.`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    execute: async ({ command, timeout_seconds }, { abortSignal }) => {
      const timeoutMs =
        typeof timeout_seconds === "number" && timeout_seconds > 0
          ? Math.round(timeout_seconds * 1000)
          : undefined;
      const result = formatExecResult(
        await executor.run({ command, session, timeoutMs }, abortSignal),
      );
      const artifacts = session ? await promoteOutputs(executor, ctx, session, abortSignal) : [];
      // Shape only shifts when there IS something to carry, so the ordinary
      // command keeps returning the plain transcript it always did.
      return artifacts.length ? { output: result, artifacts } : result;
    },
  });
}

/**
 * Drain /workspace/outputs into blobs after a command.
 *
 * The spec's promotion rule, in one place: if it wasn't promoted, it was
 * scratch. Auto-harvesting means a model that writes a chart to the outbox gets
 * a real document without having to know about a save tool — and the actor takes
 * it from here, refcounting and versioning it like any other artifact.
 */
async function promoteOutputs(
  executor: Executor,
  ctx: ToolContext,
  session: string,
  signal?: AbortSignal,
): Promise<ArtifactRef[]> {
  if (!ctx.blobs) return [];
  const cfg = getConfig();
  let files: Awaited<ReturnType<Executor["harvest"]>>;
  try {
    files = await executor.harvest(
      session,
      "/workspace/outputs",
      { maxFiles: MAX_PROMOTED_FILES, maxBytes: cfg.blobs.maxBytes },
      signal,
    );
  } catch (e) {
    // A failed harvest costs the files, not the command's result.
    console.warn("[sandbox] harvest failed:", (e as Error).message);
    return [];
  }
  const out: ArtifactRef[] = [];
  for (const f of files) {
    const ref = await ctx.blobs.put(f.bytes);
    const name = safeSegment(f.path.split("/").pop() ?? f.path);
    const mime = mimeForName(name);
    ctx.store?.recordBlob(ref.sha256, mime, ref.size);
    out.push({ sha256: ref.sha256, name, mime, size: ref.size });
  }
  return out;
}

/** Cap on files promoted from one command, so a runaway loop can't blob a tree. */
const MAX_PROMOTED_FILES = 20;

/** A coarse mime from a filename — enough for rendering and Content-Type. */
function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const table: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return table[ext] ?? "application/octet-stream";
}

/**
 * The tool table: each entry's `create` returns its AI SDK tool, or null when
 * its backing capability isn't configured (so it's simply not offered), and an
 * `executor` tag — `in-proc` runs in this process (pure/read-only), `sandbox`
 * hands off to the executor. Add a tool by adding one entry here (and, for a
 * nicer UI, one entry in the client's TOOL_UI registry — unknown tools still
 * render with a sensible default).
 */
const REGISTRY: Array<{
  name: string;
  executor: "in-proc" | "sandbox";
  create: (ctx: ToolContext) => Tool | null;
}> = [
  {
    name: "fetch_url",
    executor: "in-proc",
    create: () => {
      const p = createFetchProvider();
      return p ? fetchUrl(p) : null;
    },
  },
  {
    name: "web_search",
    executor: "in-proc",
    create: () => {
      const p = createSearchProvider();
      return p ? webSearch(p) : null;
    },
  },
  {
    name: "deep_research",
    executor: "in-proc",
    create: (ctx) => {
      // Needs a model to run on, and both halves of the search layer: discovery
      // without extraction reads nothing, extraction without discovery finds
      // nothing. Missing any of the three and the tool is simply not offered.
      if (!ctx.model || !getConfig().research.enabled) return null;
      const search = createSearchProvider();
      const fetcher = createFetchProvider();
      return search && fetcher ? deepResearch(ctx.model, search, fetcher, ctx) : null;
    },
  },
  {
    name: "read_artifact",
    executor: "in-proc",
    // Offered only once this conversation HAS a document. A tool that can only
    // answer "there aren't any" is prompt weight in every chat that never
    // researched anything.
    create: (ctx) =>
      ctx.store &&
      ctx.blobs &&
      ctx.conversationId &&
      ctx.store.listArtifacts(ctx.conversationId).length
        ? readArtifact(ctx.store, ctx.blobs, ctx.conversationId)
        : null,
  },
  {
    name: "get_attachment",
    executor: "in-proc",
    // Needs a sandbox to put the file INTO; without one there's nowhere for it
    // to go, and without files there's nothing to fetch.
    create: (ctx) => {
      const e = getExecutor();
      return e &&
        ctx.store &&
        ctx.blobs &&
        ctx.conversationId &&
        ctx.store.listFiles(ctx.conversationId).length
        ? getAttachment(ctx.store, ctx.blobs, e, ctx.conversationId)
        : null;
    },
  },
  {
    name: "run_shell",
    executor: "sandbox",
    create: (ctx) => {
      const e = getExecutor();
      return e ? runShell(e, ctx) : null;
    },
  },
];

// lard memory tools, bound to ONE kloe user's token (store + sub). Only offered
// when that user is connected, so the model can read/record durable context.
// Paths are lard's own: `profile`, `areas/<n>`, `topics/<n>`, `people/<n>`.
function lardTools(store: Store, sub: string): ToolSet {
  const pathSchema = jsonSchema<{ path: string }>({
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Subject path, e.g. profile, areas/homelab, people/kieran.",
      },
    },
  });
  return {
    memory_get_context: tool({
      description:
        "Get the durable memory context: the user profile plus a listing of every subject on record. Call this to ground yourself before answering.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        additionalProperties: false,
        properties: {},
      }),
      execute: async () => contextToText(await getContext(store, sub)),
    }),
    memory_list: tool({
      description: "List all memory subjects (path, kind, name, description).",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        additionalProperties: false,
        properties: {},
      }),
      execute: async () => JSON.stringify(await memoryList(store, sub)),
    }),
    memory_read: tool({
      description: "Read one memory subject's markdown body.",
      inputSchema: pathSchema,
      execute: async ({ path }) => memoryRead(store, sub, path),
    }),
    memory_write: tool({
      description:
        "Overwrite a memory subject with new markdown. Use to correct or rewrite a subject; prefer memory_append for adding a single fact.",
      inputSchema: jsonSchema<{ path: string; body: string }>({
        type: "object",
        additionalProperties: false,
        required: ["path", "body"],
        properties: {
          path: { type: "string" },
          body: { type: "string", description: "Full markdown body to store." },
        },
      }),
      execute: async ({ path, body }) => {
        await memoryWrite(store, sub, path, body);
        return `wrote ${path}`;
      },
    }),
    memory_append: tool({
      description: "Append one line/fact to a memory subject (created if absent).",
      inputSchema: jsonSchema<{ path: string; line: string }>({
        type: "object",
        additionalProperties: false,
        required: ["path", "line"],
        properties: {
          path: { type: "string" },
          line: { type: "string", description: "A single line to append." },
        },
      }),
      execute: async ({ path, line }) => {
        await memoryAppend(store, sub, path, line);
        return `appended to ${path}`;
      },
    }),
  };
}

/** Extra context a run passes in so per-user tools (lard) bind to the right token. */
export interface ToolContext {
  store?: Store;
  owner?: string;
  conversationId?: string;
  /**
   * The run's own model, already resolved. `deep_research` runs its subagent on
   * it, so the research reasons as well as the conversation does.
   *
   * Passed down rather than re-resolved here on purpose: resolving needs the
   * provider registry, which lives in inference.ts, which imports this module —
   * so reaching for it would close an import cycle. The caller already has the
   * model in hand.
   */
  model?: LanguageModel;
  /** Where a tool's output files go: agent artifacts share the user-upload store. */
  blobs?: BlobStore;
  /**
   * Report from inside a long-running tool, so the UI can show the work as it
   * happens rather than a spinner that lasts minutes. Absent when nothing is
   * listening (a nested run, a test), and every caller treats it as optional.
   */
  onProgress?: (p: { toolCallId: string; toolName: string; phase: string; data?: unknown }) => void;
}

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
