import { randomUUID } from "node:crypto";
import { Store, parseJobParams, type JobParams } from "./store";
import { ConversationActor } from "./actor";
import { run } from "./inference";
import { LEASE_GRACE_MS, HEARTBEAT_INTERVAL_MS } from "./config";

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
  /** Conversations with a run in flight in this process. */
  private readonly activeRuns = new Set<string>();

  constructor(store: Store, getActor: (conversationId: string) => ConversationActor) {
    this.store = store;
    this.getActor = getActor;
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
    try {
      if (params.kind === "flush") {
        await this.flushQueue(row.id, actor);
      } else {
        await this.runSpec(row.id, actor, params);
      }
      this.store.markDone(row.id);
    } catch {
      this.store.markFailed(row.id);
    } finally {
      clearInterval(leaseRefresh);
      this.activeRuns.delete(row.conversation_id);
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
  private async flushQueue(jobId: string, actor: ConversationActor): Promise<void> {
    const msgs = this.store.pendingQueue(actor.conversationId);
    if (msgs.length === 0) return;

    for (const m of msgs) actor.appendUser(m.content, m.runId, m.attachments);
    await this.runSpec(jobId, actor, {
      runId: msgs[0]!.runId,
      messageId: randomUUID(),
      model: msgs[msgs.length - 1]!.model,
    });
  }

  /** Streams one generation through the actor, checkpointing as it goes. */
  private async runSpec(jobId: string, actor: ConversationActor, spec: RunSpec): Promise<void> {
    // Snapshot the conversation (the promoted user messages are already in the
    // log) so the generation carries full context, not just the last message.
    const messages = actor.history();
    await actor.runText(
      spec.runId,
      spec.messageId,
      (signal) =>
        run(messages, { runId: spec.runId, model: spec.model, abortSignal: signal }),
      (seq) => {
        // Advance the job's durable checkpoint + lease on each flush so a
        // crash mid-run is re-claimed from the last flushed seq.
        this.store.checkpoint(jobId, seq);
        this.store.heartbeat(jobId, Date.now() + LEASE_GRACE_MS);
      },
    );
  }
}
