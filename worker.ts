import { Store } from "./src/store";
import { ConversationActor } from "./src/actor";
import { run } from "./src/inference";
import { LEASE_GRACE_MS, HEARTBEAT_INTERVAL_MS, REAP_INTERVAL_MS } from "./src/config";

interface CurrentJob {
  jobId: string;
  conversationId: string;
  checkpointSeq: number;
  runId: string;
  messageId: string;
  prompt: string;
  model: string;
}

/**
 * Standalone worker process: claim → run → heartbeat → checkpoint → done.
 * Reclaims expired leases on startup; `bun:sqlite`'s atomic UPDATE...RETURNING
 * does the race-free claim. Run with `bun worker.ts` alongside the server for
 * crash isolation (a crash in either tier doesn't take the other down).
 */
export class Worker {
  private readonly store: Store;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private current: CurrentJob | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  start(): void {
    // Reclaim any jobs whose lease expired while we were down.
    this.store.reap(Date.now());
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(
        () => this.heartbeat(),
        HEARTBEAT_INTERVAL_MS,
      );
    }
  }

  private heartbeat(): void {
    if (this.current) {
      this.store.heartbeat(this.current.jobId, Date.now() + LEASE_GRACE_MS);
    }
  }

  /**
   * One claim-attempt: pulls a queued (or expired-lease) job for a
   * conversation with no other active run, and returns true if work was
   * claimed. Returns false when idle.
   */
  async maybeClaim(): Promise<boolean> {
    const row = this.store.claimExpiredExclusive(Date.now());
    if (!row) return false;
    const params = JSON.parse(row.params) as {
      runId: string;
      messageId: string;
      prompt: string;
      model: string;
    };
    this.current = {
      jobId: row.id,
      conversationId: row.conversation_id,
      checkpointSeq: row.checkpoint_seq,
      runId: params.runId,
      messageId: params.messageId,
      prompt: params.prompt,
      model: params.model,
    };
    return true;
  }

  async runClaimed(): Promise<void> {
    const j = this.current;
    if (!j) return;
    const actor = new ConversationActor(j.conversationId, this.store);
    try {
      await actor.runText(
        j.runId,
        j.messageId,
        async function* (signal) {
          for await (const step of run(j.prompt, {
            runId: j.runId,
            model: j.model,
            abortSignal: signal,
          })) {
            yield step;
          }
        },
        (seq) => {
          // Durable progress: checkpoint + lease advance on each delta flush.
          this.store.checkpoint(j.jobId, seq);
          this.store.heartbeat(j.jobId, Date.now() + LEASE_GRACE_MS);
        },
      );
      this.store.markDone(j.jobId);
    } catch (err) {
      this.store.markFailed(j.jobId);
    } finally {
      this.current = null;
    }
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

// Entry point: run the claim loop when invoked directly.
if (import.meta.main) {
  const store = new Store();
  const worker = new Worker(store);
  worker.start();

  // Reap expired leases periodically.
  setInterval(() => {
    store.reap(Date.now());
  }, REAP_INTERVAL_MS);

  // Claim loop: poll for work every second.
  const drive = async () => {
    if (await worker.maybeClaim()) {
      await worker.runClaimed();
    }
  };
  setInterval(() => {
    void drive();
  }, 1000);

  console.log("kloe worker started");
}
