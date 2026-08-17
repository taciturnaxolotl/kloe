import { randomUUID } from "node:crypto";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { ConversationActor, type Subscriber, type WireEvent } from "./actor";
import {
  authEnabled,
  gateApi,
  getSession,
  type Role,
  requestRole,
  roleFor,
  sessionUser,
} from "./auth";
import type { BlobStore } from "./blobs";
import { ACTOR_IDLE_TTL_MS, SSE_RETRY_MS, SUBSCRIBER_HEARTBEAT_MS } from "./config";
import { Event, type EventData, type EventName, parseEventId } from "./events";
import { getExecutor } from "./executor";
import { getRegistry } from "./inference";
import {
  getContext,
  LOCAL_SUB,
  lardConnected,
  lardDisconnect,
  lardEnabled,
  memoryDelete,
  memoryList,
  memoryProjects,
  memoryRead,
  memoryWrite,
} from "./lard";
import {
  ModelPatchBody,
  PrefsPatchBody,
  ProjectAssignBody,
  ProjectCreateBody,
  ProjectPatchBody,
  PromptBody,
  PublishBody,
  RenameBody,
  SteerBody,
} from "./schemas";
import { getConfig } from "./settings";
import { sseBlock } from "./sse";
import type { Store } from "./store";
import { withBody } from "./validate";

/**
 * The web layer as a plain data structure: `apiRoutes(deps)` returns a Bun
 * `routes` object, and the entrypoint (server.ts) merges it with the HTML page
 * routes and hands it to `Bun.serve`. Keeping this framework-free (Bun's native
 * per-method routes + a Standard-Schema `withBody`, no Elysia) means it's the
 * same shape production runs and tests exercise against a real ephemeral server.
 */

/**
 * The seq to replay after when a stream opens. On a live reconnect the browser
 * sends the full event id (`<conversationId>:<seq>`) as `Last-Event-ID`; on the
 * INITIAL connect the client hands off from a batch history load via `?after=`
 * (native EventSource can't set a header on the first request). The header wins
 * when present (it's the freshest cursor). Returns 0 (replay all) on any parse
 * failure, or when the id belongs to a different conversation — an id is scoped
 * to its own conversation, so a stale or foreign cursor must never skip events.
 */
function afterSeqFor(req: Request, conversationId: string): number {
  const raw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  if (raw === null) return 0;
  try {
    const parsed = parseEventId(raw);
    return parsed.conversationId === conversationId ? parsed.seq : 0;
  } catch {
    return 0;
  }
}

// Context-file gating: keep uploads to text. A denylist of common binary
// extensions gives a clear early "no", and a content sniff catches the rest —
// binary decoded as UTF-8 carries NUL and replacement (U+FFFD) chars.
const BINARY_EXT = new Set([
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "ico",
  "svg",
  "heic",
  "zip",
  "gz",
  "tar",
  "rar",
  "7z",
  "bz2",
  "xz",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "wasm",
  "class",
  "o",
  "a",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "sqlite",
  "db",
]);
function isBinaryName(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i >= 0 && BINARY_EXT.has(name.slice(i + 1).toLowerCase());
}
function looksBinary(s: string): boolean {
  if (s.indexOf("\u0000") !== -1) return true; // NUL never appears in real text
  const n = Math.min(s.length, 8192);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd || c < 9 || (c > 13 && c < 32)) bad++; // U+FFFD or a control char
  }
  return n > 0 && bad / n > 0.02;
}

/** Sentinel enqueued into an idle stream so proxies keep the connection open. */
const KEEPALIVE = Symbol("keepalive");
type StreamItem = WireEvent | typeof KEEPALIVE;

/**
 * Subscriber backed by a ReadableStream: Bun's stream layer pulls strictly
 * serially, so a double-delivery is structurally impossible (unlike an async
 * iterator whose concurrent pulls race on a shared waiter). The actor `push`es
 * each event straight into the controller; backpressure is the platform's job.
 */
class StreamSubscriber implements Subscriber {
  closed = false;
  readonly stream: ReadableStream<StreamItem>;
  private lastSeq: number;
  private controller!: ReadableStreamDefaultController<StreamItem>;
  private readonly onClose: () => void;

  constructor(afterSeq: number, onClose: () => void) {
    this.onClose = onClose;
    this.lastSeq = afterSeq;
    this.stream = new ReadableStream<StreamItem>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.close();
      },
    });
  }

  push(e: WireEvent): void {
    if (this.closed) return;
    try {
      const seq = parseEventId(e.id).seq;
      if (seq <= this.lastSeq) return;
      this.lastSeq = seq;
    } catch {
      return;
    }
    this.controller.enqueue(e);
  }

  /** Last event put on this stream, for cross-process log fan-out. */
  get afterSeq(): number {
    return this.lastSeq;
  }

  keepalive(): void {
    if (this.closed) return;
    this.controller.enqueue(KEEPALIVE);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    try {
      this.controller.close();
    } catch {
      // already closed by the consumer
    }
  }
}

/**
 * Per-conversation actors with idle eviction. Actors with no subscribers and
 * no recent activity are removed so the map doesn't grow without bound.
 * Subscribed actors are never evicted: an SSE stream is pinned to its actor
 * instance, and evicting it would orphan the stream from every future run.
 */
const actors = new Map<string, ConversationActor>();
export function getActor(id: string, store: Store): ConversationActor {
  let a = actors.get(id);
  if (!a) {
    a = new ConversationActor(id, store);
    actors.set(id, a);
  }
  return a;
}

export function evictIdleActors(): void {
  const cutoff = Date.now() - ACTOR_IDLE_TTL_MS;
  for (const [id, actor] of actors) {
    if (!actor.hasSubscribers() && actor.lastActivity < cutoff) {
      actors.delete(id);
    }
  }
}

/**
 * A body compressed per the client's Accept-Encoding — brotli (quality 5, a fast
 * ratio/speed balance) preferred over gzip, both better than nothing over a
 * tunnel (Bun.serve does no compression of its own). The browser delivers the
 * response as a decompressing stream, so the client can render it incrementally.
 */
function compressed(req: Request, body: string, contentType: string): Response {
  const accept = req.headers.get("accept-encoding") ?? "";
  if (/\bbr\b/.test(accept)) {
    const out = brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
    return new Response(out, {
      headers: { "Content-Type": contentType, "Content-Encoding": "br" },
    });
  }
  if (/\bgzip\b/.test(accept)) {
    return new Response(gzipSync(body), {
      headers: { "Content-Type": contentType, "Content-Encoding": "gzip" },
    });
  }
  return new Response(body, { headers: { "Content-Type": contentType } });
}

/** Refs of every model this deployment can run (enabled providers + echo). */
function knownModelRefs(): Set<string> {
  return new Set(
    getRegistry()
      .listModels()
      .map((m) => m.ref),
  );
}

/** 422 for unknown model refs, null when known. The gate every model-taking endpoint starts with. */
function requireKnownModel(ref: string): Response | null {
  if (knownModelRefs().has(ref)) return null;
  return Response.json({ error: `unknown model "${ref}"` }, { status: 422 });
}

/**
 * The same gate, narrowed by role: a guest may only run what curation offers
 * guests. The picker already hides the rest, but the picker is a suggestion —
 * this is the boundary, and it has to sit on every path that names a model,
 * because a run costs someone real credits.
 */
function requireUsableModel(ref: string, store: Store, role: Role): Response | null {
  const unknown = requireKnownModel(ref);
  if (unknown) return unknown;
  if (role === "owner") return null;
  const s = store.getModelSetting(ref);
  if (s?.visible && s.guestVisible) return null;
  return Response.json({ error: `model "${ref}" is not available to you` }, { status: 403 });
}

/** 403 unless the caller runs this instance. */
function requireOwner(req: Request, store: Store): Response | null {
  if (requestRole(req, store) === "owner") return null;
  return Response.json({ error: "owners only" }, { status: 403 });
}

/**
 * Every available model joined to its curation state, for the settings UI.
 * Models with no curation row default to hidden with their catalog name.
 */
function adminModels(store: Store) {
  const settings = new Map(store.listModelSettings().map((s) => [s.ref, s]));
  return getRegistry()
    .listModels()
    .map((m) => {
      const s = settings.get(m.ref);
      return {
        ...m,
        visible: s?.visible ?? false,
        guestVisible: s?.guestVisible ?? false,
        displayName: s?.displayName ?? null,
        sortOrder: s?.sortOrder ?? 0,
      };
    });
}

/**
 * The curated subset shown in the chat picker: opt-in (visible only), with
 * displayName applied and ordered by sortOrder then name.
 */
function chatModels(store: Store, role: Role) {
  const settings = new Map(store.listModelSettings().map((s) => [s.ref, s]));
  return getRegistry()
    .listModels()
    .flatMap((m) => {
      const s = settings.get(m.ref);
      if (!s?.visible) return [];
      if (role === "guest" && !s.guestVisible) return [];
      return [
        {
          ref: m.ref,
          name: s.displayName ?? m.name,
          contextWindow: m.contextWindow,
          reasoningLevels: m.reasoningLevels,
          supportsImages: m.supportsImages,
          sortOrder: s.sortOrder,
        },
      ];
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** The long-lived SSE stream for a conversation (down channel). */
function openStream(conversationId: string, req: Request, store: Store): Response {
  const actor = getActor(conversationId, store);
  const after = afterSeqFor(req, conversationId);

  let unsub: () => void = () => {};
  let poll: ReturnType<typeof setInterval> | null = null;
  const sub = new StreamSubscriber(after, () => {
    unsub();
    if (poll) clearInterval(poll);
  });
  unsub = actor.subscribe(sub, after);

  // A standalone worker persists through its own actor, so it cannot directly
  // notify this server process's subscribers. The log is authoritative: poll
  // only the cursor gap and let StreamSubscriber dedupe local actor fan-out.
  poll = setInterval(() => {
    for (const e of store.replay(conversationId, sub.afterSeq)) {
      sub.push({
        id: `${conversationId}:${e.seq}`,
        event: e.event as EventName,
        data: e.data as EventData,
      });
    }
  }, 250);

  // NOTE: this stream is intentionally long-lived. It does not close when a run
  // ends; the next run's events arrive on the same connection. A dropped
  // connection is what triggers replay via Last-Event-ID. Keepalive comments
  // keep proxies (and Bun's idle timeout) from closing the idle connection.
  const sseTransform = new TransformStream<StreamItem, string>({
    // The reconnect delay is ours to set, not the browser's to guess.
    start: (controller) => controller.enqueue(`retry: ${SSE_RETRY_MS}\n\n`),
    transform: (item, controller) => {
      if (item === KEEPALIVE) controller.enqueue(": keepalive\n\n");
      else controller.enqueue(sseBlock(item));
    },
  });
  const body = sub.stream.pipeThrough(sseTransform);

  const keepAlive = setInterval(() => {
    if (sub.closed) {
      clearInterval(keepAlive);
      if (poll) clearInterval(poll);
      return;
    }
    sub.keepalive();
  }, SUBSCRIBER_HEARTBEAT_MS);

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Starts a generation run: appends the user message through the actor and
 * enqueues a job. Rejects unknown models up front (422): otherwise the job is
 * accepted and fails silently in the drive loop at resolve time. The user
 * message and the run share `runId` so the client can correlate the
 * optimistic echo.
 */
/**
 * 422 if any attachment references a blob that was never uploaded, so the log
 * never carries a dangling reference (and blob_refs never points at nothing).
 * Shared by the prompt and steer paths.
 */
function requireKnownBlobs(attachments: PromptBody["attachments"], store: Store): Response | null {
  for (const a of attachments ?? []) {
    if (!store.getBlob(a.sha256)) {
      return Response.json({ error: `unknown blob "${a.sha256}"` }, { status: 422 });
    }
  }
  return null;
}

function startRun(
  conversationId: string,
  data: PromptBody,
  store: Store,
  role: Role,
  owner?: string,
): Response {
  const rejected = requireUsableModel(data.model, store, role);
  if (rejected) return rejected;
  const badBlob = requireKnownBlobs(data.attachments, store);
  if (badBlob) return badBlob;
  // Claim a new conversation before appending its first event. This is the
  // ownership boundary: two users racing a chosen id cannot both enqueue work.
  if (owner && !store.claimConversationOwner(conversationId, owner)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const actor = getActor(conversationId, store);
  const runId = data.runId ?? randomUUID();
  const messageId = randomUUID();
  actor.appendUser(data.content, runId, data.attachments);
  // Record the owner on the freshly-created conversation (first writer wins), so
  // per-user lard identity can resolve back to whose token to use.
  store.setConversationOwner(conversationId, owner);

  const jobId = `${conversationId}:${randomUUID()}`;
  store.enqueue(jobId, conversationId, {
    conversationId,
    runId,
    messageId,
    prompt: data.content,
    model: data.model,
    ...(data.effort ? { effort: data.effort } : {}),
  });

  // Enqueue decouples the response from the run: the client opens the stream
  // separately and receives message-start/text-deltas/message-end as the drive
  // loop (possibly in another process) executes the job.
  return Response.json({ jobId, runId, messageId }, { status: 202 });
}

/**
 * Steers mid-run WITHOUT interrupting: parks the message in the steer queue
 * (a durable `queued-message` event, so every device sees it immediately) and
 * enqueues one flush job if none is already queued for the conversation. When
 * the current run finishes, the drive loop promotes the WHOLE pending queue
 * and runs it as a single batched generation.
 */
function startSteer(conversationId: string, data: SteerBody, store: Store, role: Role): Response {
  const rejected = requireUsableModel(data.model, store, role);
  if (rejected) return rejected;
  const badBlob = requireKnownBlobs(data.attachments, store);
  if (badBlob) return badBlob;

  const actor = getActor(conversationId, store);
  const runId = data.runId ?? randomUUID();
  actor.queueSteer(data.content, data.model, runId, data.attachments, data.effort);

  // One flush job is enough to drain the whole queue; skip it when one is
  // already waiting (it drains everything queued by the time it runs).
  if (!store.hasPendingFlush(conversationId)) {
    store.enqueue(`${conversationId}:${randomUUID()}`, conversationId, {
      kind: "flush",
      conversationId,
    });
  }
  return Response.json({ ok: true, runId }, { status: 202 });
}

/** A 64-char lowercase hex sha256 — the shape a blob id must have. */
function isSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Marks a body that ran past the size cap while streaming. */
class PayloadTooLarge extends Error {}

/**
 * Wraps an upload stream so it errors past `max` bytes instead of buffering the
 * whole thing to find out — Content-Length is only a hint (and spoofable), so
 * the cap is enforced on the actual byte flow.
 */
function limitBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new PayloadTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Content-addressed upload: streams the body into the blob store (hashing as it
 * goes), records its metadata, and returns the sha256. The raw body IS the blob
 * (Content-Type is its mime), so this bypasses `withBody`'s JSON path. Dedup and
 * the content address both fall out of the store; the 413 is enforced mid-stream.
 */
async function uploadBlob(req: Request, store: Store, blobs: BlobStore): Promise<Response> {
  const max = getConfig().blobs.maxBytes;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return Response.json({ error: `blob exceeds ${max} bytes` }, { status: 413 });
  }
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });
  const mime = req.headers.get("content-type") || "application/octet-stream";
  try {
    const ref = await blobs.put(limitBody(req.body, max));
    store.recordBlob(ref.sha256, mime, ref.size);
    return Response.json({ sha256: ref.sha256, size: ref.size, mime }, { status: 201 });
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      return Response.json({ error: `blob exceeds ${max} bytes` }, { status: 413 });
    }
    throw err;
  }
}

/**
 * Serves blob bytes by sha256. Immutable (content-addressed) so it's cached
 * hard; the mime comes from the metadata row, not the file. With the S3 backend
 * the returned `S3File` makes this a redirect to a presigned URL (serving
 * offload) rather than a proxy of the bytes.
 */
async function serveBlob(
  sha256: string,
  store: Store,
  blobs: BlobStore,
  filename?: string,
): Promise<Response> {
  if (!isSha256(sha256)) return new Response("not found", { status: 404 });
  const meta = store.getBlob(sha256);
  const blob = meta ? await blobs.get(sha256) : null;
  if (!meta || !blob) return new Response("not found", { status: 404 });
  // The original filename is per-reference (not stored on the content-addressed
  // blob), so the caller passes it via `?name=`. Sanitized to a single safe
  // path segment so it can't inject header bytes or a Content-Disposition break.
  const safe = filename ? sanitizeFilename(filename) : "";
  const disposition = safe ? `inline; filename="${safe}"` : "inline";
  const headers: Record<string, string> = {
    "Content-Type": meta.mime,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": disposition,
    // Never let a sniffed type outrank the declared one: a .txt blob whose
    // bytes start with `<html>` must not become a document.
    "X-Content-Type-Options": "nosniff",
  };
  // Blobs are model- and upload-authored bytes served from the app's own origin,
  // so anything the browser would run script from has to be defanged. `sandbox`
  // with no tokens drops the response into an opaque origin with scripting off,
  // which makes a direct visit to an HTML artifact inert — it cannot read the
  // session cookie's requests, call /api on the user's behalf, or touch the app.
  //
  // The header is ignored for `<img>`/`<embed>` of the same bytes (no document
  // is created), so inline images keep working. Rendering an artifact as a live
  // page is a separate, deliberate path: a sandboxed iframe in the client.
  if (ACTIVE_MIME.test(meta.mime)) headers["Content-Security-Policy"] = "sandbox";
  return new Response(blob, { headers });
}

/**
 * Preferences the settings page may write.
 *
 * A closed set, because the run loop reads this table: an endpoint that stored
 * any key anyone sent would make the table a place to put things, and the two
 * that matter here decide which model spends the tokens.
 */
const KNOWN_PREFS = new Set(["research.leadModel", "research.workerModel"]);

/**
 * Preferences, and what they are overriding.
 *
 * Two sources decide these: a line in kloe.json and a click in the settings
 * page, the click winning. A UI shown only its own half cannot tell "nobody
 * chose" from "the file chose" — it would offer "same as the chat model" while
 * the run used the configured model, which is a straightforward lie about what
 * the deployment does. So the config value ships alongside, and clearing a
 * preference visibly reverts to it rather than to nothing.
 */
function prefsPayload(store: Store) {
  const cfg = getConfig().research;
  return {
    prefs: store.listPrefs(),
    config: {
      "research.leadModel": cfg.leadModel ?? null,
      "research.workerModel": cfg.workerModel ?? null,
    },
  };
}

/** Mimes a browser will execute script from when it renders them as a document. */
const ACTIVE_MIME =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(?:text|application)\/xml)\b/i;

/** A filename reduced to one safe segment: no path separators, quotes, or control bytes. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 128);
}

/** Partial curation update; `displayName: null` clears an override. */
function patchModel(data: ModelPatchBody, store: Store): Response {
  const rejected = requireKnownModel(data.ref);
  if (rejected) return rejected;
  const prev = store.getModelSetting(data.ref);
  const merged = {
    ref: data.ref,
    visible: data.visible ?? prev?.visible ?? false,
    guestVisible: data.guestVisible ?? prev?.guestVisible ?? false,
    displayName: data.displayName !== undefined ? data.displayName : (prev?.displayName ?? null),
    sortOrder: data.sortOrder ?? prev?.sortOrder ?? 0,
  };
  store.setModelSetting(merged);
  return Response.json(merged);
}

/**
 * The API routes as a Bun `routes` object. Per-method handlers give free method
 * dispatch + `req.params`; `withBody` validates + types JSON bodies before the
 * handler runs. Everything dynamic lives under `/api/` so a future service
 * worker can bypass it cleanly and cache only the static shell.
 */
export function apiRoutes(deps: { store: Store; blobs: BlobStore; kick?: () => void }) {
  const { store, blobs } = deps;
  // Nudge the drive loop to claim a freshly enqueued job NOW instead of waiting
  // for the next poll tick (that poll delay is up to ~1s of pure queue-wait on
  // every message). No-op in tests, which drive jobs manually.
  const kick = deps.kick ?? (() => {});

  // Authorization for a specific conversation. gateApi only proves you're signed
  // in; this proves the conversation is YOURS. When auth is on you may only touch
  // conversations you own — an unowned (legacy/new) row is claimed by the first
  // authenticated user to reach it, and someone else's conversation 404s (not
  // 403, so we don't confirm it exists). Returns a Response to short-circuit, or
  // null to proceed.
  const guardConv = (req: Request, id: string): Response | null => {
    if (!authEnabled()) return null;
    const sub = getSession(req, store)?.sub;
    if (!sub) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (store.isConversationDeleted(id))
      return Response.json({ error: "not found" }, { status: 404 });
    const owner = store.getConversationOwner(id);
    if (owner === undefined) {
      store.setConversationOwner(id, sub);
      return null;
    }
    if (owner !== sub) return Response.json({ error: "not found" }, { status: 404 });
    return null;
  };

  // Same, for a project: you may only touch a project you own (404 hides others').
  const guardProject = (req: Request, id: string): Response | null => {
    if (!authEnabled()) return null;
    const owner = store.getProjectOwner(id);
    const sub = getSession(req, store)?.sub;
    if (owner !== undefined && owner !== sub)
      return Response.json({ error: "not found" }, { status: 404 });
    return null;
  };

  const routes = {
    "/health": { GET: () => Response.json({ ok: true }) },

    // Who's signed in — the SPA renders the avatar from this and, on a 401
    // (auth on, no session), redirects to /auth/login. When auth is OFF the gate
    // is a no-op, so this returns {authenticated:false} and the SPA stays open.
    "/api/me": {
      GET: (req: Bun.BunRequest<"/api/me">) => {
        const s = getSession(req, store);
        // The role rides along so the UI can hide what it may not touch; the
        // API gates on its own reading of the session either way.
        return s
          ? Response.json(sessionUser(s))
          : Response.json({ authenticated: false, role: roleFor(undefined) });
      },
    },

    // lard link status for the settings page: whether the integration is enabled
    // for this deployment and whether THIS user has connected their account.
    "/api/lard": {
      GET: (req: Bun.BunRequest<"/api/lard">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        return Response.json({
          enabled: lardEnabled(),
          connected: lardEnabled() && lardConnected(store, sub),
        });
      },
      DELETE: async (req: Bun.BunRequest<"/api/lard">) => {
        await lardDisconnect(store, getSession(req, store)?.sub ?? LOCAL_SUB);
        return Response.json({ ok: true });
      },
    },

    // Inspect this user's lard memory — the settings page proxies through kloe
    // because the token is server-side and per-user. List of subjects, and a
    // single subject's markdown (read + overwrite). Subject path is a query param
    // so multi-segment paths (areas/<name>) need no wildcard route.
    "/api/lard/memory": {
      GET: async (req: Bun.BunRequest<"/api/lard/memory">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        if (!lardEnabled() || !lardConnected(store, sub))
          return Response.json({ error: "not connected" }, { status: 409 });
        try {
          return Response.json({ listing: await memoryList(store, sub) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
    },
    // The lard project registry, for the project page's "pin memory" picker.
    "/api/lard/projects": {
      GET: async (req: Bun.BunRequest<"/api/lard/projects">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        if (!lardEnabled() || !lardConnected(store, sub))
          return Response.json({ error: "not connected" }, { status: 409 });
        try {
          return Response.json({ projects: await memoryProjects(store, sub) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
    },
    // The context bundle for a project (profile + that project's area + listing),
    // for the project page's Memory preview.
    "/api/lard/context": {
      GET: async (req: Bun.BunRequest<"/api/lard/context">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        if (!lardEnabled() || !lardConnected(store, sub))
          return Response.json({ error: "not connected" }, { status: 409 });
        const project = new URL(req.url).searchParams.get("project") || undefined;
        try {
          return Response.json(await getContext(store, sub, project));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
    },
    "/api/lard/subject": {
      GET: async (req: Bun.BunRequest<"/api/lard/subject">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        const path = new URL(req.url).searchParams.get("path");
        if (!path) return Response.json({ error: "missing path" }, { status: 400 });
        if (!lardEnabled() || !lardConnected(store, sub))
          return Response.json({ error: "not connected" }, { status: 409 });
        try {
          return Response.json({ path, body: await memoryRead(store, sub, path) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
      PUT: async (req: Bun.BunRequest<"/api/lard/subject">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        const path = new URL(req.url).searchParams.get("path");
        if (!path) return Response.json({ error: "missing path" }, { status: 400 });
        if (!lardEnabled() || !lardConnected(store, sub))
          return Response.json({ error: "not connected" }, { status: 409 });
        try {
          await memoryWrite(store, sub, path, await req.text());
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
      DELETE: async (req: Bun.BunRequest<"/api/lard/subject">) => {
        const sub = getSession(req, store)?.sub ?? LOCAL_SUB;
        const path = new URL(req.url).searchParams.get("path");
        if (!path) return Response.json({ error: "missing path" }, { status: 400 });
        if (!lardEnabled() || !lardConnected(store, sub))
          return Response.json({ error: "not connected" }, { status: 409 });
        try {
          await memoryDelete(store, sub, path);
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 });
        }
      },
    },

    // Documents this conversation's tools produced — newest version of each, for
    // the header list and the artifact pane. Bytes come from /api/blobs/:sha256.
    //
    // `?name=` narrows to one document and answers with its history instead:
    // same resource, one level in. A path segment would have been the other
    // shape, but names are filenames and filenames carry slashes.
    "/api/conversations/:id/artifacts": {
      GET: (req: Bun.BunRequest<"/api/conversations/:id/artifacts">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        const name = new URL(req.url).searchParams.get("name");
        if (name) {
          // The link belongs to the DOCUMENT, so it is reported once beside the
          // history rather than smeared across the version rows.
          const pub = store.publicationFor(req.params.id, name);
          return Response.json({
            versions: store.artifactVersions(req.params.id, name),
            publication: pub && { token: pub.token, mode: pub.mode, version: pub.version },
          });
        }
        return Response.json({ artifacts: store.listArtifacts(req.params.id) });
      },
    },

    // Public links for this conversation's documents. Creating one is
    // idempotent per version, so the owner can press Publish twice and still
    // have exactly one link to revoke. The public side of these lives in
    // src/share.ts, outside the auth gate — nothing here serves a reader.
    "/api/conversations/:id/publications": {
      POST: (req: Bun.BunRequest<"/api/conversations/:id/publications">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return Promise.resolve(denied);
        return withBody(PublishBody, (data) => {
          const pub = store.publish(req.params.id, data.name, data.version, data.mode);
          if (!pub) return Response.json({ error: "not found" }, { status: 404 });
          return Response.json({
            token: pub.token,
            url: `/s/${pub.token}`,
            mode: pub.mode,
            version: pub.version,
          });
        })(req);
      },
    },
    "/api/conversations/:id/publications/:token": {
      DELETE: (req: Bun.BunRequest<"/api/conversations/:id/publications/:token">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        // Idempotent: a link that is already gone is in the state the caller
        // asked for, so unpublishing twice is not an error.
        store.unpublish(req.params.id, req.params.token);
        return Response.json({ ok: true });
      },
    },

    // Preferences the settings page owns. Deliberately a flat map: these are
    // choices made by clicking, and each one should not cost an endpoint.
    "/api/prefs": {
      GET: () => Response.json(prefsPayload(store)),
      PATCH: withBody(PrefsPatchBody, (data, req: Bun.BunRequest<"/api/prefs">) => {
        const denied = requireOwner(req, store);
        if (denied) return denied;
        for (const [key, value] of Object.entries(data)) {
          // Only keys we know: an open key/value endpoint is an invitation to
          // store whatever, and this table is read by the run loop.
          if (!KNOWN_PREFS.has(key)) {
            return Response.json({ error: `unknown preference "${key}"` }, { status: 422 });
          }
          if (value && key.endsWith("Model")) {
            const rejected = requireKnownModel(value);
            if (rejected) return rejected;
          }
        }
        for (const [key, value] of Object.entries(data)) store.setPref(key, value);
        return Response.json(prefsPayload(store));
      }),
    },

    // Content-addressed blobs: upload (raw body) → sha256; fetch by sha256.
    "/api/blobs": {
      POST: (req: Bun.BunRequest<"/api/blobs">) => uploadBlob(req, store, blobs),
    },
    "/api/blobs/:sha256": {
      GET: (req: Bun.BunRequest<"/api/blobs/:sha256">) =>
        serveBlob(
          req.params.sha256,
          store,
          blobs,
          new URL(req.url).searchParams.get("name") ?? undefined,
        ),
    },

    "/api/conversations": {
      // `?q=` searches titles + message contents; no query lists all, newest first.
      GET: (req: Bun.BunRequest<"/api/conversations">) => {
        const q = new URL(req.url).searchParams.get("q")?.trim();
        // Only list the caller's own conversations (undefined owner → no filter
        // when auth is off).
        const owner = authEnabled() ? getSession(req, store)?.sub : undefined;
        const conversations = q
          ? store.searchConversations(q, owner)
          : store.listConversations(owner);
        return Response.json({ conversations });
      },
    },

    // Settings/admin view: every available model + its curation state.
    // Curation is the instance's shape, so it is the owner's to see and change.
    "/api/models": {
      GET: (req: Bun.BunRequest<"/api/models">) =>
        requireOwner(req, store) ?? Response.json({ models: adminModels(store) }),
      PATCH: withBody(
        ModelPatchBody,
        (data, req: Bun.BunRequest<"/api/models">) =>
          requireOwner(req, store) ?? patchModel(data, store),
      ),
    },

    // Chat view: the curated, opt-in subset, ordered for the picker.
    "/api/models/chat": {
      GET: (req: Bun.BunRequest<"/api/models/chat">) =>
        Response.json({ models: chatModels(store, requestRole(req, store)) }),
    },

    "/api/conversations/:id/stream": {
      GET: (req: Bun.BunRequest<"/api/conversations/:id/stream">) =>
        guardConv(req, req.params.id) ?? openStream(req.params.id, req, store),
    },
    "/api/conversations/:id/prompt": {
      POST: withBody(PromptBody, (data, req: Bun.BunRequest<"/api/conversations/:id/prompt">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        const res = startRun(
          req.params.id,
          data,
          store,
          requestRole(req, store),
          getSession(req, store)?.sub,
        );
        kick();
        return res;
      }),
    },
    "/api/conversations/:id/cancel": {
      POST: (req: Bun.BunRequest<"/api/conversations/:id/cancel">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        getActor(req.params.id, store).requestCancel();
        return Response.json({ ok: true });
      },
    },
    "/api/conversations/:id/steer": {
      POST: withBody(SteerBody, (data, req: Bun.BunRequest<"/api/conversations/:id/steer">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        const res = startSteer(req.params.id, data, store, requestRole(req, store));
        kick();
        return res;
      }),
      GET: (req: Bun.BunRequest<"/api/conversations/:id/steer">) =>
        guardConv(req, req.params.id) ??
        Response.json({ queued: store.pendingQueue(req.params.id) }),
    },
    // Remove a still-pending steer from the queue (before it's promoted).
    "/api/conversations/:id/steer/:runId": {
      DELETE: (req: Bun.BunRequest<"/api/conversations/:id/steer/:runId">) => {
        const { id, runId } = req.params;
        const denied = guardConv(req, id);
        if (denied) return denied;
        // Only tombstone something actually queued, so a bad runId can't spam
        // the log; already-promoted or already-cancelled steers 404.
        if (!store.pendingQueue(id).some((m) => m.runId === runId)) {
          return Response.json({ error: "no such queued message" }, { status: 404 });
        }
        getActor(id, store).cancelSteer(runId);
        return Response.json({ ok: true });
      },
    },
    "/api/conversations/:id/events": {
      // History as NDJSON (one event per line) so the client parses + renders it
      // incrementally as the compressed stream arrives. Brotli'd; the browser
      // decompresses on the fly. For bottom-first loading the client fetches the
      // last few turns (`?tailTurns=N`) to fill the viewport instantly, then
      // backfills everything older (`?before=<seq>`) above. No params → full log.
      GET: (req: Bun.BunRequest<"/api/conversations/:id/events">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        const url = new URL(req.url);
        const all = getActor(req.params.id, store).replay(0);
        const seqOf = (e: { id: string }) => {
          try {
            return parseEventId(e.id).seq;
          } catch {
            return 0;
          }
        };
        let events = all;
        const beforeParam = url.searchParams.get("before");
        const tailParam = url.searchParams.get("tailTurns");
        if (beforeParam !== null) {
          const before = Number(beforeParam);
          if (Number.isFinite(before)) events = all.filter((e) => seqOf(e) < before);
        } else if (tailParam !== null) {
          const tailTurns = Number(tailParam);
          // A "turn" starts at a user-message; keep everything from the Nth-from-last one.
          const userSeqs = all.filter((e) => e.event === Event.User).map(seqOf);
          if (tailTurns > 0 && userSeqs.length > tailTurns) {
            const cut = userSeqs[userSeqs.length - tailTurns]!;
            events = all.filter((e) => seqOf(e) >= cut);
          }
        }
        return compressed(
          req,
          events.map((e) => JSON.stringify(e)).join("\n"),
          "application/x-ndjson",
        );
      },
    },
    "/api/conversations/:id": {
      DELETE: async (req: Bun.BunRequest<"/api/conversations/:id">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        getActor(req.params.id, store).requestCancel();
        const orphaned = store.deleteConversation(req.params.id);
        actors.delete(req.params.id); // drop the in-memory actor so it can't resurrect the log
        getExecutor()?.disposeSession(req.params.id); // tear down this chat's persistent sandbox
        // Free blobs this conversation was the last to reference: bytes first,
        // then the metadata row (a crash between leaves it for the GC sweep).
        for (const sha256 of orphaned) {
          await blobs.delete(sha256);
          store.deleteBlob(sha256);
        }
        return Response.json({ ok: true });
      },
      PATCH: withBody(RenameBody, (data, req: Bun.BunRequest<"/api/conversations/:id">) => {
        const denied = guardConv(req, req.params.id);
        if (denied) return denied;
        store.renameConversation(req.params.id, data.title);
        return Response.json({ ok: true });
      }),
    },

    // File (or unfile) a conversation into a project.
    "/api/conversations/:id/project": {
      PUT: withBody(
        ProjectAssignBody,
        (data, req: Bun.BunRequest<"/api/conversations/:id/project">) => {
          const denied = guardConv(req, req.params.id);
          if (denied) return denied;
          if (data.projectId) {
            const pd = guardProject(req, data.projectId);
            if (pd) return pd;
          }
          store.setConversationProject(req.params.id, data.projectId);
          if (data.projectId) store.touchProject(data.projectId);
          return Response.json({ ok: true });
        },
      ),
    },

    // ---- projects ----
    "/api/projects": {
      GET: (req: Bun.BunRequest<"/api/projects">) => {
        const owner = authEnabled() ? getSession(req, store)?.sub : undefined;
        return Response.json({ projects: store.listProjects(owner) });
      },
      POST: withBody(ProjectCreateBody, (data, req: Bun.BunRequest<"/api/projects">) => {
        const id = randomUUID();
        store.createProject(id, data.name, data.description, getSession(req, store)?.sub);
        return Response.json({ id }, { status: 201 });
      }),
    },
    "/api/projects/:id": {
      GET: (req: Bun.BunRequest<"/api/projects/:id">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        const project = store.getProject(req.params.id);
        if (!project) return Response.json({ error: "not found" }, { status: 404 });
        const owner = authEnabled() ? getSession(req, store)?.sub : undefined;
        return Response.json({
          project,
          conversations: store.listConversations(owner, req.params.id),
        });
      },
      PATCH: withBody(ProjectPatchBody, (data, req: Bun.BunRequest<"/api/projects/:id">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        if (!store.getProject(req.params.id))
          return Response.json({ error: "not found" }, { status: 404 });
        // An empty lardProject string clears the pin.
        store.updateProject(req.params.id, {
          name: data.name,
          description: data.description,
          lardProject: data.lardProject === undefined ? undefined : data.lardProject || null,
        });
        return Response.json({ ok: true });
      }),
      DELETE: (req: Bun.BunRequest<"/api/projects/:id">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        store.deleteProject(req.params.id);
        return Response.json({ ok: true });
      },
    },

    // Project context files — hand-authored text injected into the project's chats.
    "/api/projects/:id/context": {
      GET: (req: Bun.BunRequest<"/api/projects/:id/context">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        return Response.json({ files: store.listProjectContext(req.params.id) });
      },
      POST: async (req: Bun.BunRequest<"/api/projects/:id/context">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        if (!store.getProject(req.params.id))
          return Response.json({ error: "not found" }, { status: 404 });
        const name = (new URL(req.url).searchParams.get("name") || "file.txt").slice(0, 200);
        const body = await req.text();
        if (body.length > 512 * 1024)
          return Response.json({ error: "file too large (max 512KB text)" }, { status: 413 });
        // Context files are injected verbatim into the prompt, so only text is
        // useful (and safe). A spreadsheet/image/PDF decodes to a UTF-8 string
        // riddled with NUL and replacement chars — reject those, and known
        // binary extensions, with a clear message.
        if (isBinaryName(name) || looksBinary(body)) {
          return Response.json(
            {
              error:
                "only text files can be added as context (no spreadsheets, images, or other binary files)",
            },
            { status: 415 },
          );
        }
        const cid = randomUUID();
        store.addProjectContext(cid, req.params.id, name, body);
        return Response.json({ id: cid }, { status: 201 });
      },
    },
    "/api/projects/:id/context/:cid": {
      GET: (req: Bun.BunRequest<"/api/projects/:id/context/:cid">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        const f = store.projectContextFiles(req.params.id).find((x) => x.id === req.params.cid);
        if (!f) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(f);
      },
      DELETE: (req: Bun.BunRequest<"/api/projects/:id/context/:cid">) => {
        const denied = guardProject(req, req.params.id);
        if (denied) return denied;
        store.deleteProjectContext(req.params.id, req.params.cid);
        return Response.json({ ok: true });
      },
    },
  };
  // When auth is enabled, every /api/* route requires a session (401 otherwise);
  // /health stays open. A no-op when auth is off.
  return gateApi(routes as never, store) as typeof routes;
}
