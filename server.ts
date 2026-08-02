import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { Store } from "./src/store";
import { ConversationActor, type Subscriber, type WireEvent } from "./src/actor";
import { run, initInference, getRegistry } from "./src/inference";
import { sseBlock } from "./src/sse";
import { parseEventId } from "./src/events";
import {
  ACTOR_IDLE_TTL_MS,
  LEASE_GRACE_MS,
  REAP_INTERVAL_MS,
  SUBSCRIBER_HEARTBEAT_MS,
} from "./src/config";

/**
 * Parses the Last-Event-ID header. The browser sends back the full event id
 * (`<conversationId>:<seq>`); we extract the seq. Returns 0 (replay all) on
 * any parse failure.
 */
function readLastEventId(req: Request): number {
  const raw = req.headers.get("last-event-id");
  if (raw === null) return 0;
  try {
    return parseEventId(raw).seq;
  } catch {
    return 0;
  }
}

/**
 * Subscriber backed by a ReadableStream: Bun's stream layer pulls strictly
 * serially, so a double-delivery is structurally impossible (unlike an async
 * iterator whose concurrent pulls race on a shared waiter). The actor `push`es
 * each event straight into the controller; backpressure is the platform's job.
 */
class MySubscriber implements Subscriber {
  closed = false;
  readonly stream: ReadableStream<WireEvent>;
  private controller!: ReadableStreamDefaultController<WireEvent>;
  private readonly onClose: () => void;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.stream = new ReadableStream<WireEvent>({
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

function evictIdleActors(): void {
  const cutoff = Date.now() - ACTOR_IDLE_TTL_MS;
  for (const [id, actor] of actors) {
    if (actor.lastActivity < cutoff) {
      actors.delete(id);
    }
  }
}

/** Refs of every model this deployment can run (enabled providers + echo). */
function knownModelRefs(): Set<string> {
  return new Set(getRegistry().listModels().map((m) => m.ref));
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
    .filter((m) => settings.get(m.ref)?.visible)
    .map((m) => {
      const s = settings.get(m.ref)!;
      return {
        ref: m.ref,
        name: s.displayName ?? m.name,
        contextWindow: m.contextWindow,
        reasoningLevels: m.reasoningLevels,
        supportsImages: m.supportsImages,
        sortOrder: s.sortOrder,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function buildApp(deps: {
  store: Store;
}): Elysia {
  const { store } = deps;
  const app = new Elysia();

  app.get("/health", () => ({ ok: true }));

  // Settings/admin view: every model available to this deployment (enabled
  // providers × catalog) with its catalog metadata joined to its curation
  // state (visible / displayName / sortOrder).
  app.get("/models", () => ({ models: adminModels(store) }));

  // Chat view: the curated, opt-in subset — only models explicitly marked
  // visible, with pretty names applied, ordered for the picker.
  app.get("/models/chat", () => ({ models: chatModels(store) }));

  // Curation mutation for the settings menu. Partial: omitted fields keep
  // their current value; `displayName: null` clears an override.
  app.patch(
    "/models",
    ({ body, set }) => {
      if (!knownModelRefs().has(body.ref)) {
        set.status = 422;
        return { error: `unknown model "${body.ref}"` };
      }
      const prev = store.getModelSetting(body.ref);
      const merged = {
        ref: body.ref,
        visible: body.visible ?? prev?.visible ?? false,
        displayName:
          body.displayName !== undefined
            ? body.displayName
            : (prev?.displayName ?? null),
        sortOrder: body.sortOrder ?? prev?.sortOrder ?? 0,
      };
      store.setModelSetting(merged);
      return merged;
    },
    {
      body: t.Object({
        ref: t.String(),
        visible: t.Optional(t.Boolean()),
        displayName: t.Optional(t.Union([t.String(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  );

  app.get(
    "/conversations/:id/stream",
    ({ params, request }) => {
      // TODO(auth): cookie/session auth so native EventSource works unmodified.
      const conversationId = params.id;
      const actor = getActor(conversationId, store);
      const after = readLastEventId(request);

      let unsub: () => void = () => {};
      const sub = new MySubscriber(() => unsub());
      unsub = actor.subscribe(sub, after);

      // NOTE: this stream is intentionally long-lived. It does not close when
      // a run ends; the next run's events arrive on the same connection. A
      // dropped connection is what triggers replay via Last-Event-ID.
      //
      // Keepalive: emit SSE comments periodically so proxies and load
      // balancers don't close the idle connection.
      const KEEPALIVE = Symbol("keepalive");
      const sseTransform = new TransformStream<WireEvent | typeof KEEPALIVE, string>({
        transform: (e, controller) => {
          if (e === KEEPALIVE) {
            controller.enqueue(": keepalive\n\n");
          } else {
            controller.enqueue(sseBlock(e));
          }
        },
      });
      const body = sub.stream.pipeThrough(sseTransform);

      const keepAlive = setInterval(() => {
        if (sub.closed) {
          clearInterval(keepAlive);
          return;
        }
        sub.push(KEEPALIVE as unknown as WireEvent);
      }, SUBSCRIBER_HEARTBEAT_MS);

      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );

  app.post(
    "/conversations/:id/prompt",
    async ({ params, body, set }) => {
      const conversationId = params.id;

      // Reject unknown models up front: otherwise the job is accepted (202)
      // and fails silently in the worker at resolve time.
      if (!knownModelRefs().has(body.model)) {
        set.status = 422;
        return { error: `unknown model "${body.model}"` };
      }

      const actor = getActor(conversationId, store);
      const runId = body.runId ?? randomUUID();
      const messageId = randomUUID();

      // Use the SAME runId for the user message and the run so clients can
      // correlate them.
      actor.appendUser(body.content, runId);

      const jobId = `${conversationId}:${randomUUID()}`;
      store.enqueue(jobId, conversationId, {
        conversationId,
        runId,
        messageId,
        prompt: body.content,
        model: body.model,
      });

      // Enqueue decouples the response from the run: the client opens /stream
      // separately and receives message-start/text-deltas/message-end as the
      // worker (possibly in another process) executes the job.
      set.status = 202;
      return { jobId, runId, messageId };
    },
    {
      body: t.Object({
        content: t.String(),
        runId: t.Optional(t.String()),
        model: t.String(),
      }),
    },
  );

  app.post(
    "/conversations/:id/cancel",
    ({ params }) => {
      const actor = getActor(params.id, store);
      actor.requestCancel();
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );

  app.post(
    "/conversations/:id/steer",
    async ({ params, body, set }) => {
      const conversationId = params.id;

      if (!knownModelRefs().has(body.model)) {
        set.status = 422;
        return { error: `unknown model "${body.model}"` };
      }

      const actor = getActor(conversationId, store);
      // Hard steer: abort the current run, then queue a new one with the
      // redirect message.
      actor.requestCancel();

      const runId = randomUUID();
      const messageId = randomUUID();
      actor.appendUser(body.content, runId);

      const jobId = `${conversationId}:${randomUUID()}`;
      store.enqueue(jobId, conversationId, {
        conversationId,
        runId,
        messageId,
        prompt: body.content,
        model: body.model,
      });

      set.status = 202;
      return { ok: true, jobId, runId, messageId };
    },
    {
      body: t.Object({ content: t.String(), model: t.String() }),
    },
  );

  app.get("/conversations/:id/events", ({ params }) => {
    const actor = getActor(params.id, store);
    return actor.replay(0).map((e) => e);
  });

  return app;
}

// Side effects happen only when run as the entry point (`bun server.ts`), so
// tests can import `buildApp` and use their own store without touching `data/`.
const isEntryPoint = import.meta.main;

let store: Store;
let app: Elysia;
if (isEntryPoint) {
  // Load the catalog and build the provider registry before serving, so the
  // first request already has models resolvable.
  await initInference();

  store = new Store();
  app = buildApp({ store });

  // Track in-flight runs per conversation so the drive loop never claims two
  // jobs for the same conversation concurrently (single-writer invariant).
  const activeRuns = new Set<string>();

  async function driveOnce(): Promise<void> {
    const row = store.claimExpiredExclusive(Date.now());
    if (!row) return;
    if (activeRuns.has(row.conversation_id)) return;

    const params = JSON.parse(row.params) as {
      runId: string;
      messageId: string;
      prompt: string;
      model: string;
    };
    const actor = getActor(row.conversation_id, store);
    activeRuns.add(row.conversation_id);
    try {
      await actor.runText(
        params.runId,
        params.messageId,
        async function* (signal) {
          for await (const step of run(params.prompt, {
            runId: params.runId,
            model: params.model,
            abortSignal: signal,
          })) {
            yield step;
          }
        },
        (seq) => {
          // Advance the job's durable checkpoint + lease on each flush so a
          // crash mid-run is re-claimed from the last flushed seq.
          store.checkpoint(row.id, seq);
          store.heartbeat(row.id, Date.now() + LEASE_GRACE_MS);
        },
      );
      store.markDone(row.id);
    } catch (err) {
      store.markFailed(row.id);
    } finally {
      activeRuns.delete(row.conversation_id);
    }
  }

  setInterval(() => {
    void driveOnce();
  }, 1000);

  // Reaper: re-queue jobs whose lease expired (worker died mid-run) so any
  // process (this one or a peer) can claim them again from checkpoint_seq.
  setInterval(() => {
    store.reap(Date.now());
    evictIdleActors();
  }, REAP_INTERVAL_MS);

  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: app.fetch });
  console.log(`kloe listening on http://localhost:${port}`);
}
