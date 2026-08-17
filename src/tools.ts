import { generateText, jsonSchema, type LanguageModel, type Tool, type ToolSet, tool } from "ai";
import { OWNER, type Role, roleCan } from "./auth";
import type { BlobStore } from "./blobs";
import { replaceOnce, viewSlice } from "./edits";
import type { ArtifactRef } from "./events";
import {
  type Executor,
  formatExecResult,
  getExecutor,
  type ReadResult,
  type SandboxInfo,
} from "./executor";
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
import { recoverRun, runResearch } from "./research";
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
  // What the backend actually honors, rather than a blanket claim. Promising
  // `site:` to an engine that reads it as a word is the worse error of the two:
  // the search succeeds and quietly answers a different question.
  const operators = provider.operators
    ? "Two operators work: `site:example.com` restricts the search to one site, " +
      "and `A OR B` accepts either term. Others (intitle:, inurl:, define:, " +
      "related:) are unsupported."
    : "Search operators (site:, intitle:, inurl:, define:, related:) are " +
      "unsupported and make the search fail.";
  return tool({
    description:
      "Search the web for current information, beyond your training data. Returns " +
      "results with title, URL, and snippet. Write a specific, keyword-focused " +
      'query with the key entities and context (e.g. "OpenAI GPT-5 release date"), ' +
      `not a conversational question. ${operators}`,
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `Keyword-focused query: specific entities and context, not a full sentence. ${
            provider.operators ? "site: and OR may be used." : "No operators."
          }`,
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
      "via web_search, or any known URL. Provide the full http(s) URL. " +
      "A page that can't be read directly is retried by other routes, and the " +
      "result says which one it came from: `amp` and `rendered` are the page " +
      "itself, `archive` may be an older copy of it, and `structured` is only " +
      "the summary the page publishes for search engines — treat that last one " +
      "as a lead, not as the article. If a page is blocked outright, the error " +
      "says so: read a different source rather than retrying the same URL.",
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
      // A server restart re-claims the job and the model reissues this call.
      // Anything the interrupted attempt filed is in the event log; inheriting
      // it is the difference between resuming and starting over.
      const prior =
        ctx.store && ctx.conversationId
          ? recoverRun(ctx.store.replay(ctx.conversationId, 0), question)
          : null;
      const out = await runResearch({
        question,
        model,
        resume: prior ?? undefined,
        leadModel: ctx.researchLead,
        workerModel: ctx.researchWorker,
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
      // Shaped rather than a bare string: the model reads `content`, and the UI
      // gets enough to render the step as "the document you can see", with its
      // name and revision, instead of an anonymous wall of text.
      return {
        name: doc.name,
        title: doc.title ?? doc.name,
        version: doc.version,
        content: await blob.text(),
      };
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
export function sandboxDescription(
  info: SandboxInfo,
  hasAttachments: boolean,
  hasFileTools = false,
): string {
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
      "Keep everything you are working ON in /workspace itself: source files, intermediates, test fixtures, anything " +
      "you will read back or build on.",
    "",
    "Delivery: /workspace/outputs/ (already created) is not a directory to work in — it is where you HAND something " +
      "to the user. Every file that lands there becomes a document in their conversation, so put only finished " +
      "results there, and only ones worth opening: the report, the chart, the one script they asked for. Copy them " +
      "over at the end rather than building in place — a project assembled inside outputs/ arrives as thirty " +
      "documents, which buries the one that mattered. A promoted file is removed from the directory, so do not " +
      "expect to find it again; writing the same name later becomes a new version. A `.md` file is shown as a formatted document and a " +
      "`.html` file is shown as a rendered page (its own CSS and scripts run, isolated from the app), so reach for " +
      "HTML when the result is visual — a chart, a diagram, a small interactive thing — and Markdown when it is prose." +
      (hasAttachments
        ? " Files the user attached, and documents from earlier turns, arrive at /workspace/inputs/ via get_attachment."
        : ""),
    ...(hasFileTools
      ? [
          "",
          "Files: reach for view_file, write_file and edit_file rather than doing it here. A " +
            "heredoc has to survive the shell's quoting and a `sed` expression has to survive its " +
            "own, and when that goes wrong the result is a mangled file rather than an error. " +
            "This tool is still the right one for everything around the file: listing, searching, " +
            "running it, moving it, installing what it needs.",
        ]
      : []),
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
    description: sandboxDescription(executor.info, hasAttachments, Boolean(ctx.conversationId)),
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
 * Working with a file, without going through a shell.
 *
 * `run_shell` can already read and write files, and for one-liners it is the
 * better tool. It falls down on exactly the operations a model does most: get a
 * file's contents with line numbers you can then refer to, and change a few
 * lines in the middle of it. Through a shell the second one is a heredoc or a
 * `sed` expression, where the model's real content has to survive two levels of
 * quoting — and the failure mode is not an error but a mangled file.
 *
 * So the bytes make one trip to this process, the edit happens in a real string
 * API, and the bytes go back. What the model sends is what lands.
 */
// Exported for tests: the wrappers are exercised against a fake executor, so
// path handling and the phrasing of every failure are checkable without docker.
function describePaths(): string {
  return (
    "Paths are inside the sandbox and may be relative to /workspace (so " +
    "'notes.md' and '/workspace/notes.md' are the same file)."
  );
}

/** Absolute, or resolved against the workspace root the sandbox starts in. */
function sandboxPath(path: string): string {
  const p = path.trim();
  if (!p) return "";
  return p.startsWith("/") ? p : `/workspace/${p.replace(/^\.\//, "")}`;
}

/** A read that failed, phrased so the model knows what to do next. */
function explainRead(result: ReadResult, path: string): string | null {
  switch (result.kind) {
    case "missing":
      return `No file at ${path}. Check the path with run_shell (\`ls\`) — it may be somewhere else, or not written yet.`;
    case "directory":
      return `${path} is a directory, not a file. List it with run_shell (\`ls ${path}\`).`;
    case "too-large":
      return `${path} is ${result.bytes} bytes, too big to read in one piece. Use run_shell to slice the part you need (\`head\`, \`sed -n\`, \`grep -n\`).`;
    case "binary":
      return `${path} is not text, so it can't be viewed or edited this way. Handle it with run_shell, or promote it to /workspace/outputs to hand it to the user.`;
    default:
      return null;
  }
}

export function viewFile(executor: Executor, session: string) {
  return tool({
    description:
      "Read a text file from the sandbox, with line numbers. Prefer this over `cat`: the numbers " +
      "are what later edits and your own explanations refer to, and long lines are truncated " +
      "rather than flooding the conversation. Reads 200 lines from the top by default; pass " +
      "offset and limit to walk a longer file. " +
      describePaths(),
    inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
      type: "object",
      properties: {
        path: { type: "string", description: "The file to read, e.g. 'src/main.py'." },
        offset: {
          type: "number",
          description: "0-based line to start at. Omit to start at the top.",
        },
        limit: { type: "number", description: "How many lines to read. Defaults to 200." },
      },
      required: ["path"],
      additionalProperties: false,
    }),
    execute: async ({ path, offset, limit }, { abortSignal }) => {
      const full = sandboxPath(path);
      if (!full) return "path is required.";
      const read = await executor.readFile(session, full, abortSignal);
      const problem = explainRead(read, full);
      if (problem) return problem;
      if (read.kind !== "file") return problem ?? "Could not read that file.";
      if (read.text === "") return `${full} is empty (0 bytes).`;
      const slice = viewSlice(read.text, offset ?? 0, limit ?? DEFAULT_VIEW_LINES);
      if (slice.shown === 0) {
        return `${full} has ${slice.total} lines, so there is nothing at offset ${offset}.`;
      }
      const end = slice.from + slice.shown - 1;
      const more =
        end < slice.total
          ? `\n\n[showing lines ${slice.from}-${end} of ${slice.total}. Pass offset: ${end} to continue.]`
          : "";
      return `${full}\n${slice.body}${more}`;
    },
  });
}

export function writeFile(executor: Executor, session: string) {
  return tool({
    description:
      "Write a text file in the sandbox, creating parent directories and replacing anything " +
      "already there. This is the tool for a NEW file, or for a rewrite so extensive that " +
      "quoting the old text would be pointless; to change part of a file, edit_file leaves the " +
      "rest alone and is far harder to get wrong. Content is written exactly as given — no shell " +
      "quoting, no escaping. " +
      describePaths(),
    inputSchema: jsonSchema<{ path: string; content: string }>({
      type: "object",
      properties: {
        path: { type: "string", description: "The file to write, e.g. 'src/main.py'." },
        content: { type: "string", description: "The file's complete new contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    }),
    execute: async ({ path, content }, { abortSignal }) => {
      const full = sandboxPath(path);
      if (!full) return "path is required.";
      const before = await executor.readFile(session, full, abortSignal);
      if (before.kind === "directory") return `${full} is a directory, not a file.`;
      await executor.putFile(session, full, new TextEncoder().encode(content), abortSignal);
      const lines = content === "" ? 0 : content.split("\n").length;
      return before.kind === "file"
        ? `Overwrote ${full} (${lines} lines, ${content.length} bytes).`
        : `Created ${full} (${lines} lines, ${content.length} bytes).`;
    },
  });
}

export function editFile(executor: Executor, session: string) {
  return tool({
    description:
      "Change part of a text file in the sandbox by exact find-and-replace. old_string must " +
      "appear EXACTLY once — include the surrounding lines that make it unique — or pass " +
      "replace_all to change every occurrence. Copy old_string byte-for-byte from view_file, " +
      "whitespace included; if it doesn't match, the reply shows you what the file really says. " +
      "Nothing outside old_string is touched. " +
      describePaths(),
    inputSchema: jsonSchema<{
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }>({
      type: "object",
      properties: {
        path: { type: "string", description: "The file to edit." },
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: {
          type: "string",
          description: "What to put in its place (may be empty to delete).",
        },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring a unique one.",
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    }),
    execute: async ({ path, old_string, new_string, replace_all }, { abortSignal }) => {
      const full = sandboxPath(path);
      if (!full) return "path is required.";
      const read = await executor.readFile(session, full, abortSignal);
      const problem = explainRead(read, full);
      if (problem) return problem;
      if (read.kind !== "file") return "Could not read that file.";
      const out = replaceOnce(read.text, old_string, new_string, replace_all === true);
      if (!out.ok) return out.reason;
      await executor.putFile(session, full, new TextEncoder().encode(out.text), abortSignal);
      const delta = out.text.split("\n").length - read.text.split("\n").length;
      const shape =
        delta === 0 ? "same line count" : delta > 0 ? `+${delta} lines` : `${delta} lines`;
      return `Edited ${full} — ${out.replaced} replacement${out.replaced === 1 ? "" : "s"}, ${shape}.`;
    },
  });
}

/** Lines a view returns when the caller doesn't say. Anthropic's tool uses the same default. */
const DEFAULT_VIEW_LINES = 200;

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
    // The whole relative path, flattened — not the basename. A name is a
    // document's identity within the conversation, so `a/notes.md` and
    // `b/notes.md` reduced to "notes.md" would become two versions of one
    // document, each silently shadowing the other's history.
    const name = safeSegment(f.path);
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
 * Let a text-only model see a picture.
 *
 * The conversation's model decides whether an image can be inlined at all: a
 * non-vision model gets a note saying a file exists and nothing else, which is
 * a dead end for "what's in this screenshot?". This tool is the way through —
 * a second, image-capable model looks at the file and answers in words, and
 * those words are what enters the conversation.
 *
 * Which is also its limitation, and the description says so: the reader gets
 * one question and answers it in isolation. Asking a precise question beats
 * asking for "a description" and hoping the detail you needed survived.
 */
function readImage(store: Store, blobs: BlobStore, conversationId: string, vision: LanguageModel) {
  return tool({
    description:
      "Look at an image in this conversation and get back a description in words. You cannot see " +
      "images yourself; this hands the file to a model that can. Ask a SPECIFIC question when you " +
      "have one — 'what does the error message say?' gets you the text, where a general look gets " +
      "you a general answer and a second call. Name the file exactly as it appears in the " +
      "conversation. What comes back is one reader's account of the image, not the image: if the " +
      "answer is thin, ask again about the part you care about.",
    inputSchema: jsonSchema<{ name: string; question?: string }>({
      type: "object",
      properties: {
        name: { type: "string", description: "The image's name, e.g. 'screenshot.png'." },
        question: {
          type: "string",
          description:
            "What you need to know about it. Omit for a general description of what it shows.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    }),
    execute: async ({ name, question }, { abortSignal }) => {
      const images = store.listFiles(conversationId).filter((f) => f.mime.startsWith("image/"));
      const hit = images.find((f) => f.name === name) ?? images.find((f) => f.sha256 === name);
      if (!hit) {
        return images.length
          ? `No image named "${name}" in this conversation. Images here: ${images.map((f) => f.name).join(", ")}.`
          : "This conversation has no images.";
      }
      const blob = await blobs.get(hit.sha256);
      if (!blob) return `The bytes for "${name}" are missing from the blob store.`;
      const ask =
        question?.trim() ||
        "Describe this image: what it shows, and any text in it, transcribed exactly.";
      const out = await generateText({
        model: vision,
        abortSignal,
        maxOutputTokens: VISION_MAX_TOKENS,
        system:
          "You are looking at an image on behalf of someone who cannot see it. Answer the " +
          "question directly and concretely, in plain prose. Transcribe any text exactly as it " +
          "appears. Say plainly when the image does not show what was asked about — a guess " +
          "presented as an observation is worse than nothing.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: ask },
              {
                type: "file",
                data: new Uint8Array(await blob.arrayBuffer()),
                mediaType: hit.mime,
              },
            ],
          },
        ],
      });
      const text = out.text.trim();
      return text || `The image reader returned nothing for ${hit.name}.`;
    },
  });
}

/** A description is prose about one picture, not a document. */
const VISION_MAX_TOKENS = 2_000;

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
    create: (ctx) => {
      // Resolved by the caller when a user pays for their own engines; falling
      // back here keeps every non-run caller (tests, scripts) working.
      const p = ctx.search ?? createSearchProvider();
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
      // A research run is the heaviest search consumer there is, so it spends
      // the same engines the plain tool does — a user's own when they have any.
      const search = ctx.search ?? createSearchProvider();
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
    // Offered only to a model that can't see images itself, and only once this
    // conversation HAS one. A vision model with the tool would be a slower,
    // lossier path to what it can already do.
    name: "read_image",
    executor: "in-proc",
    create: (ctx) =>
      ctx.store &&
      ctx.blobs &&
      ctx.conversationId &&
      ctx.visionModel &&
      !ctx.modelReadsImages &&
      ctx.store.listFiles(ctx.conversationId).some((f) => f.mime.startsWith("image/"))
        ? readImage(ctx.store, ctx.blobs, ctx.conversationId, ctx.visionModel)
        : null,
  },
  {
    name: "run_shell",
    executor: "sandbox",
    create: (ctx) => {
      const e = getExecutor();
      return e ? runShell(e, ctx) : null;
    },
  },
  // The file tools need a conversation to be the sandbox session: a one-off
  // container would be a fresh filesystem per call, so viewing a file you just
  // wrote would find nothing.
  {
    name: "view_file",
    executor: "sandbox",
    create: (ctx) => {
      const e = getExecutor();
      return e && ctx.conversationId ? viewFile(e, ctx.conversationId) : null;
    },
  },
  {
    name: "write_file",
    executor: "sandbox",
    create: (ctx) => {
      const e = getExecutor();
      return e && ctx.conversationId ? writeFile(e, ctx.conversationId) : null;
    },
  },
  {
    name: "edit_file",
    executor: "sandbox",
    create: (ctx) => {
      const e = getExecutor();
      return e && ctx.conversationId ? editFile(e, ctx.conversationId) : null;
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
  /**
   * The role of whoever owns this run. Absent means nobody asked — a script, a
   * test, an instance with auth off — which resolves to the owner's own
   * powers, matching what those callers had before roles existed.
   */
  role?: Role;
  conversationId?: string;
  /**
   * The search provider this run should use, already resolved — a user's own
   * engines when they connected any. Resolving needs a credential lookup, which
   * is async, and building a tool set is not.
   */
  search?: SearchProvider;
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
  /**
   * A resolved image-capable model, and whether the run's own model needs it.
   * Both are decided by the caller for the same reason `model` is: choosing a
   * model needs the registry, which lives in inference.ts, which imports this
   * module. `read_image` is offered only when the run's model can't see images
   * and this one can.
   */
  visionModel?: LanguageModel;
  modelReadsImages?: boolean;
  /**
   * Models for the two jobs inside a research run, when the deployment has
   * chosen them. Resolved by the caller for the same reason `model` is.
   */
  researchLead?: LanguageModel;
  researchWorker?: LanguageModel;
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
  // The sandbox is the operator's own compute on a machine they pay for, and
  // it is the one capability nobody can bring for themselves — a user with
  // their own API key still runs commands on somebody else's box. So it is
  // gated by role, where a model or a search is gated by whose key pays.
  const mayShell = roleCan(ctx.role ?? OWNER, "sandbox");
  for (const entry of REGISTRY) {
    if (entry.executor === "sandbox" && !mayShell) continue;
    const t = entry.create(ctx);
    if (t) tools[entry.name] = t;
  }
  if (ctx.store && ctx.owner && lardEnabled() && lardConnected(ctx.store, ctx.owner)) {
    Object.assign(tools, lardTools(ctx.store, ctx.owner));
  }
  return harden(tools);
}
