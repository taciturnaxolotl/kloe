import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { Store, parseJobParams, type JobParams, type JobRow } from "./store";
import { ConversationActor, type RunStep } from "./actor";
import { run, modelSupportsImages } from "./inference";
import type { BlobStore } from "./blobs";
import { LEASE_GRACE_MS, HEARTBEAT_INTERVAL_MS } from "./config";

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
  private async flushQueue(jobId: string, actor: ConversationActor, timing?: RunTiming): Promise<void> {
    const msgs = this.store.pendingQueue(actor.conversationId);
    if (msgs.length === 0) return;

    for (const m of msgs) actor.appendUser(m.content, m.runId, m.attachments);
    await this.runSpec(jobId, actor, {
      runId: msgs[0]!.runId,
      messageId: randomUUID(),
      model: msgs[msgs.length - 1]!.model,
    }, timing);
  }

  /** Streams one generation through the actor, checkpointing as it goes. */
  private async runSpec(jobId: string, actor: ConversationActor, spec: RunSpec, timing?: RunTiming): Promise<void> {
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
    await actor.runText(
      spec.runId,
      spec.messageId,
      (signal) => this.streamTimed(messages, spec, signal, timing),
      (seq) => {
        // Advance the job's durable checkpoint + lease on each flush so a
        // crash mid-run is re-claimed from the last flushed seq.
        this.store.checkpoint(jobId, seq);
        this.store.heartbeat(jobId, Date.now() + LEASE_GRACE_MS);
      },
    );
  }

  /** The provider stream, tapped to record first-token time and chunk count. */
  private async *streamTimed(
    messages: ModelMessage[],
    spec: RunSpec,
    signal: AbortSignal,
    timing?: RunTiming,
  ): AsyncGenerator<RunStep> {
    for await (const step of run(messages, { runId: spec.runId, model: spec.model, abortSignal: signal })) {
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
