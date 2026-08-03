import { Store, parseJobParams, type EnqueueParams } from "./store";
import { ConversationActor } from "./actor";
import { run } from "./inference";
import { LEASE_GRACE_MS, HEARTBEAT_INTERVAL_MS } from "./config";

/**
 * The job drive loop, shared by the server (inline driver) and worker.ts
 * (standalone process). Both used to copy-paste this body, so claim/run/
 * checkpoint logic could drift between the two; this is the single canonical
 * implementation.
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
   * Claim one job and run it to completion: stream provider steps through the
   * conversation actor, advancing the durable checkpoint and lease on each
   * flush so a crash mid-run is re-claimed from the last flushed seq.
   * Corrupt job params mark the job failed immediately instead of letting it
   * sit claimed until the lease expires.
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

    let params: EnqueueParams;
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
      await actor.runText(
        params.runId,
        params.messageId,
        (signal) =>
          run(params.prompt, { runId: params.runId, model: params.model, abortSignal: signal }),
        (seq) => {
          // Advance the job's durable checkpoint + lease on each flush so a
          // crash mid-run is re-claimed from the last flushed seq.
          this.store.checkpoint(row.id, seq);
          this.store.heartbeat(row.id, Date.now() + LEASE_GRACE_MS);
        },
      );
      this.store.markDone(row.id);
    } catch {
      this.store.markFailed(row.id);
    } finally {
      clearInterval(leaseRefresh);
      this.activeRuns.delete(row.conversation_id);
    }
  }
}
