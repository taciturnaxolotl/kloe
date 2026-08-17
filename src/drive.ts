import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { ConversationActor, RunStep } from "./actor";
import type { BlobStore } from "./blobs";
import { HEARTBEAT_INTERVAL_MS, LEASE_GRACE_MS } from "./config";
import { modelSupportsImages, type RunProject, run } from "./inference";
import { ingestConversation } from "./ingest";
import { LOCAL_SUB, lardEnabled } from "./lard";
import { getConfig } from "./settings";
import { type JobParams, type JobRow, parseJobParams, type Store } from "./store";
import { generateTitle, resolveSmallModel } from "./title";

/** Per-run stage timings, filled as a run progresses; logged when KLOE_DEBUG is set. */
const LOG_TIMING = process.env.KLOE_DEBUG === "1" || process.env.KLOE_DEBUG === "true";
interface RunTiming {
  historyMs: number;
  firstTokenAt: number;
  chunks: number;
}

/**
 * The fields a runnable generation needs, whatever its source. The prompt is
 * NOT here: the run is generated against the actor's full history (rebuilt from
 * the log), which already ends with the triggering user message(s).
 */
interface RunSpec {
  runId: string;
  messageId: string;
  model: string;
  /** The reasoning level the sender chose, when the model offers levels. */
  effort?: string;
}

/**
 * The job drive loop, shared by the server (inline driver) and worker.ts
 * (standalone process). Both used to copy-paste this body, so claim/run/
 * checkpoint logic could drift between the two; this is the single canonical
 * implementation.
 *
 * Two job kinds: a plain run (POST /prompt), and a `flush` (POST /steer) that
 * promotes the conversation's pending steer queue into the transcript and
 * runs it as ONE batched generation — all queued messages go out together,
 * never one by one.
 *
 * Single-writer per conversation is enforced twice: in SQL
 * (`claimExpiredExclusive` refuses a second claim while a lease is live) and
 * in-process (`activeRuns` here), since the poll timer can fire again while a
 * run is still finishing.
 */
export class JobDriver {
  private readonly store: Store;
  private readonly getActor: (conversationId: string) => ConversationActor;
  private readonly blobs?: BlobStore;
  /** Conversations with a run in flight in this process. */
  private readonly activeRuns = new Set<string>();
  /** Per-conversation idle timers that trigger a debounced lard ingest. */
  private readonly ingestTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    store: Store,
    getActor: (conversationId: string) => ConversationActor,
    blobs?: BlobStore,
  ) {
    this.store = store;
    this.getActor = getActor;
    this.blobs = blobs;
  }

  /**
   * Claim one job and run it to completion, advancing the durable checkpoint
   * and lease on each flush so a crash mid-run is re-claimed from the last
   * flushed seq. Corrupt job params mark the job failed immediately instead
   * of letting it sit claimed until the lease expires.
   */
  async driveOnce(): Promise<void> {
    const row = this.store.claimExpiredExclusive(Date.now());
    if (!row) return;
    const claimedAt = Date.now();
    if (this.activeRuns.has(row.conversation_id)) {
      // The previous run is still finishing up; hand the job back so the
      // next poll picks it up immediately instead of waiting for the lease
      // to expire and the reaper to reclaim it.
      this.store.requeue(row.id);
      return;
    }

    let params: JobParams;
    try {
      params = parseJobParams(row.params);
    } catch {
      this.store.markFailed(row.id);
      return;
    }

    const actor = this.getActor(row.conversation_id);
    this.activeRuns.add(row.conversation_id);
    // Keep the lease alive independent of delta flushes: a slow first token
    // (or a long quiet stretch) must not let the reaper steal a healthy run.
    const leaseRefresh = setInterval(() => {
      this.store.heartbeat(row.id, Date.now() + LEASE_GRACE_MS);
    }, HEARTBEAT_INTERVAL_MS);
    const timing: RunTiming = { historyMs: 0, firstTokenAt: 0, chunks: 0 };
    try {
      if (params.kind === "flush") {
        await this.flushQueue(row.id, actor, timing);
      } else {
        await this.runSpec(row.id, actor, params, timing);
      }
      this.store.markDone(row.id);
    } catch {
      this.store.markFailed(row.id);
    } finally {
      clearInterval(leaseRefresh);
      this.activeRuns.delete(row.conversation_id);
      if (LOG_TIMING) logTiming(row, claimedAt, timing);
    }
  }

  /**
   * Promotes the conversation's pending steer queue into the transcript and
   * runs it as one batched generation: every queued message becomes a
   * `user-message` (keeping its original steer runId so clients reconcile),
   * the run sees them joined, and the batch carries the first message's
   * runId. The newest message's model wins. An empty queue is a no-op (a
   * stale flush job — e.g. after a crash between promote and completion —
   * just completes).
   */
  private async flushQueue(
    jobId: string,
    actor: ConversationActor,
    timing?: RunTiming,
  ): Promise<void> {
    const msgs = this.store.pendingQueue(actor.conversationId);
    if (msgs.length === 0) return;

    for (const m of msgs) actor.appendUser(m.content, m.runId, m.attachments);
    await this.runSpec(
      jobId,
      actor,
      {
        runId: msgs[0]!.runId,
        messageId: randomUUID(),
        // The newest message's choices win, model and effort alike: a batched
        // flush runs once, and the last thing the user picked is what they meant.
        model: msgs[msgs.length - 1]!.model,
        effort: msgs[msgs.length - 1]!.effort,
      },
      timing,
    );
  }

  /** Streams one generation through the actor, checkpointing as it goes. */
  private async runSpec(
    jobId: string,
    actor: ConversationActor,
    spec: RunSpec,
    timing?: RunTiming,
  ): Promise<void> {
    // Snapshot the conversation (the promoted user messages are already in the
    // log) so the generation carries full context, not just the last message.
    // Attachments are resolved to model parts here (image / inline text / note),
    // gated on whether the target model accepts images.
    const hStart = Date.now();
    const messages = await actor.history({
      blobs: this.blobs,
      supportsImages: modelSupportsImages(spec.model),
    });
    if (timing) timing.historyMs = Date.now() - hStart;
    // Resolve who owns this conversation so the run's tools + memory bind to
    // that user's lard token (local user when unstamped / auth off).
    const owner = this.store.getConversationOwner(actor.conversationId) ?? LOCAL_SUB;
    const project = this.projectContext(actor.conversationId);
    await actor.runText(
      spec.runId,
      spec.messageId,
      (signal) => this.streamTimed(messages, spec, signal, owner, actor, project, timing),
      (seq) => {
        // Advance the job's durable checkpoint + lease on each flush so a
        // crash mid-run is re-claimed from the last flushed seq.
        this.store.checkpoint(jobId, seq);
        this.store.heartbeat(jobId, Date.now() + LEASE_GRACE_MS);
      },
    );
    // The run finished; (re)arm the idle timer so we ingest once the thread goes
    // quiet. A follow-up message cancels + rearms it, so a busy chat isn't pushed
    // mid-conversation.
    this.scheduleIngest(actor.conversationId);
    // Auto-title from the first message once (best-effort, off the hot path).
    void this.maybeTitle(actor);
  }

  /** Generate a short title from the first user message via the small model
   *  (configured or cheapest enabled), once per conversation. No-op once titled
   *  or when no model is enabled. Fully defensive — never disturbs the run. */
  private async maybeTitle(actor: ConversationActor): Promise<void> {
    try {
      const id = actor.conversationId;
      if (this.store.hasCustomTitle(id)) return; // already titled or user-renamed
      const modelRef = resolveSmallModel(this.store);
      if (!modelRef) return;
      const title = await generateTitle(
        this.store,
        id,
        modelRef,
        this.store.getConversationOwner(id) ?? undefined,
      );
      if (title && this.store.setTitleIfEmpty(id, title)) actor.titled(title);
    } catch (e) {
      console.warn("[title]", (e as Error).message);
    }
  }

  /** Debounced, idle-triggered lard ingest: reset a per-conversation timer on
   * each completed run and only push once the thread has sat quiet. */
  private scheduleIngest(conversationId: string): void {
    if (!lardEnabled()) return;
    const idleMs = getConfig().lard.ingestIdleMs;
    if (idleMs <= 0) return;
    const existing = this.ingestTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.ingestTimers.delete(conversationId);
      void ingestConversation(this.store, conversationId);
    }, idleMs);
    if (typeof timer.unref === "function") timer.unref(); // never hold the process open
    this.ingestTimers.set(conversationId, timer);
  }

  /** The provider stream, tapped to record first-token time and chunk count. */
  // A conversation's project context (pinned lard project + uploaded files), or
  // undefined when it's unfiled or the project carries nothing to inject.
  private projectContext(conversationId: string): RunProject | undefined {
    const projectId = this.store.getConversationProject(conversationId);
    if (!projectId) return undefined;
    const proj = this.store.getProject(projectId);
    const files = this.store
      .projectContextFiles(projectId)
      .map((f) => ({ filename: f.filename, body: f.body }));
    if (!proj?.lardProject && !files.length) return undefined;
    return { lardProject: proj?.lardProject, contextFiles: files };
  }

  private async *streamTimed(
    messages: ModelMessage[],
    spec: RunSpec,
    signal: AbortSignal,
    owner: string,
    actor: ConversationActor,
    project: RunProject | undefined,
    timing?: RunTiming,
  ): AsyncGenerator<RunStep> {
    for await (const step of run(messages, {
      runId: spec.runId,
      model: spec.model,
      effort: spec.effort,
      abortSignal: signal,
      store: this.store,
      blobs: this.blobs,
      owner,
      conversationId: actor.conversationId,
      project,
      // A long tool reports straight into the log rather than through this
      // generator, which is parked on the provider stream while it runs.
      onProgress: (p) => actor.toolProgress({ runId: spec.runId, messageId: spec.messageId, ...p }),
    })) {
      if (timing && step.kind === "text") {
        if (!timing.firstTokenAt) timing.firstTokenAt = Date.now();
        timing.chunks++;
      }
      yield step;
    }
  }
}

/**
 * One-line per-run latency breakdown (KLOE_DEBUG): how long the job sat queued
 * before being claimed (the drive-loop poll delay), how long history rebuild
 * took, the provider's time-to-first-token, and the generation stretch + rate.
 */
function logTiming(row: JobRow, claimedAt: number, t: RunTiming): void {
  const now = Date.now();
  const wait = row.created_at ? claimedAt - row.created_at : -1;
  const ttft = t.firstTokenAt ? t.firstTokenAt - (claimedAt + t.historyMs) : -1;
  const gen = t.firstTokenAt ? now - t.firstTokenAt : -1;
  const rate = gen > 0 && t.chunks ? Math.round((t.chunks / gen) * 1000) : 0;
  console.log(
    `[timing ${row.id.slice(-8)}] queue-wait ${wait}ms · history ${t.historyMs}ms · ` +
      `provider-ttft ${ttft}ms · gen ${gen}ms (${t.chunks} chunks, ${rate}/s)`,
  );
}
