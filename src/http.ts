import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { ConversationActor, type Subscriber, type WireEvent } from "./actor";
import { getRegistry } from "./inference";
import { sseBlock } from "./sse";
import { parseEventId } from "./events";
import { withBody } from "./validate";
import { PromptBody, SteerBody, ModelPatchBody } from "./schemas";
import { ACTOR_IDLE_TTL_MS, SUBSCRIBER_HEARTBEAT_MS } from "./config";

/**
 * The web layer as a plain data structure: `apiRoutes(deps)` returns a Bun
 * `routes` object, and the entrypoint (server.ts) merges it with the HTML page
 * routes and hands it to `Bun.serve`. Keeping this framework-free (Bun's native
 * per-method routes + a Standard-Schema `withBody`, no Elysia) means it's the
 * same shape production runs and tests exercise against a real ephemeral server.
 */

/**
 * Parses the Last-Event-ID header. The browser sends back the full event id
 * (`<conversationId>:<seq>`); we extract the seq. Returns 0 (replay all) on
 * any parse failure, or when the id belongs to a different conversation — an
 * id is scoped to its own conversation, so a stale or foreign cursor must
 * never skip events here.
 */
function readLastEventId(req: Request, conversationId: string): number {
  const raw = req.headers.get("last-event-id");
  if (raw === null) return 0;
  try {
    const parsed = parseEventId(raw);
    return parsed.conversationId === conversationId ? parsed.seq : 0;
  } catch {
    return 0;
  }
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
  private controller!: ReadableStreamDefaultController<StreamItem>;
  private readonly onClose: () => void;

  constructor(onClose: () => void) {
    this.onClose = onClose;
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
    this.controller.enqueue(e);
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

/** Refs of every model this deployment can run (enabled providers + echo). */
function knownModelRefs(): Set<string> {
  return new Set(getRegistry().listModels().map((m) => m.ref));
}

/** 422 for unknown model refs, null when known. The gate every model-taking endpoint starts with. */
function requireKnownModel(ref: string): Response | null {
  if (knownModelRefs().has(ref)) return null;
  return Response.json({ error: `unknown model "${ref}"` }, { status: 422 });
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
        displayName: s?.displayName ?? null,
        sortOrder: s?.sortOrder ?? 0,
      };
    });
}

/**
 * The curated subset shown in the chat picker: opt-in (visible only), with
 * displayName applied and ordered by sortOrder then name.
 */
function chatModels(store: Store) {
  const settings = new Map(store.listModelSettings().map((s) => [s.ref, s]));
  return getRegistry()
    .listModels()
    .flatMap((m) => {
      const s = settings.get(m.ref);
      if (!s?.visible) return [];
      return [{
        ref: m.ref,
        name: s.displayName ?? m.name,
        contextWindow: m.contextWindow,
        reasoningLevels: m.reasoningLevels,
        supportsImages: m.supportsImages,
        sortOrder: s.sortOrder,
      }];
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** The long-lived SSE stream for a conversation (down channel). */
function openStream(conversationId: string, req: Request, store: Store): Response {
  // TODO(auth): cookie/session auth so native EventSource works unmodified.
  const actor = getActor(conversationId, store);
  const after = readLastEventId(req, conversationId);

  let unsub: () => void = () => {};
  const sub = new StreamSubscriber(() => unsub());
  unsub = actor.subscribe(sub, after);

  // NOTE: this stream is intentionally long-lived. It does not close when a run
  // ends; the next run's events arrive on the same connection. A dropped
  // connection is what triggers replay via Last-Event-ID. Keepalive comments
  // keep proxies (and Bun's idle timeout) from closing the idle connection.
  const sseTransform = new TransformStream<StreamItem, string>({
    transform: (item, controller) => {
      if (item === KEEPALIVE) controller.enqueue(": keepalive\n\n");
      else controller.enqueue(sseBlock(item));
    },
  });
  const body = sub.stream.pipeThrough(sseTransform);

  const keepAlive = setInterval(() => {
    if (sub.closed) {
      clearInterval(keepAlive);
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
function startRun(conversationId: string, data: PromptBody, store: Store): Response {
  const rejected = requireKnownModel(data.model);
  if (rejected) return rejected;

  const actor = getActor(conversationId, store);
  const runId = data.runId ?? randomUUID();
  const messageId = randomUUID();
  actor.appendUser(data.content, runId);

  const jobId = `${conversationId}:${randomUUID()}`;
  store.enqueue(jobId, conversationId, { conversationId, runId, messageId, prompt: data.content, model: data.model });

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
function startSteer(conversationId: string, data: SteerBody, store: Store): Response {
  const rejected = requireKnownModel(data.model);
  if (rejected) return rejected;

  const actor = getActor(conversationId, store);
  const runId = data.runId ?? randomUUID();
  actor.queueSteer(data.content, data.model, runId);

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

/** Partial curation update; `displayName: null` clears an override. */
function patchModel(data: ModelPatchBody, store: Store): Response {
  const rejected = requireKnownModel(data.ref);
  if (rejected) return rejected;
  const prev = store.getModelSetting(data.ref);
  const merged = {
    ref: data.ref,
    visible: data.visible ?? prev?.visible ?? false,
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
export function apiRoutes(deps: { store: Store }) {
  const { store } = deps;
  return {
    "/health": { GET: () => Response.json({ ok: true }) },

    "/api/conversations": {
      // `?q=` searches titles + message contents; no query lists all, newest first.
      GET: (req: Bun.BunRequest<"/api/conversations">) => {
        const q = new URL(req.url).searchParams.get("q")?.trim();
        const conversations = q ? store.searchConversations(q) : store.listConversations();
        return Response.json({ conversations });
      },
    },

    // Settings/admin view: every available model + its curation state.
    "/api/models": {
      GET: () => Response.json({ models: adminModels(store) }),
      PATCH: withBody(ModelPatchBody, (data) => patchModel(data, store)),
    },

    // Chat view: the curated, opt-in subset, ordered for the picker.
    "/api/models/chat": {
      GET: () => Response.json({ models: chatModels(store) }),
    },

    "/api/conversations/:id/stream": {
      GET: (req: Bun.BunRequest<"/api/conversations/:id/stream">) =>
        openStream(req.params.id, req, store),
    },
    "/api/conversations/:id/prompt": {
      POST: withBody(PromptBody, (data, req: Bun.BunRequest<"/api/conversations/:id/prompt">) =>
        startRun(req.params.id, data, store)),
    },
    "/api/conversations/:id/cancel": {
      POST: (req: Bun.BunRequest<"/api/conversations/:id/cancel">) => {
        getActor(req.params.id, store).requestCancel();
        return Response.json({ ok: true });
      },
    },
    "/api/conversations/:id/steer": {
      POST: withBody(SteerBody, (data, req: Bun.BunRequest<"/api/conversations/:id/steer">) =>
        startSteer(req.params.id, data, store)),
      GET: (req: Bun.BunRequest<"/api/conversations/:id/steer">) =>
        Response.json({ queued: store.pendingQueue(req.params.id) }),
    },
    "/api/conversations/:id/events": {
      GET: (req: Bun.BunRequest<"/api/conversations/:id/events">) =>
        Response.json(getActor(req.params.id, store).replay(0)),
    },
    "/api/conversations/:id": {
      DELETE: (req: Bun.BunRequest<"/api/conversations/:id">) => {
        store.deleteConversation(req.params.id);
        actors.delete(req.params.id); // drop the in-memory actor so it can't resurrect the log
        return Response.json({ ok: true });
      },
    },
  };
}
