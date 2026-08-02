import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { Event, makeId, type EventData, type EventName } from "./events";
import { truncateUtf8 } from "./sse";
import { BATCH_FLUSH_MS, BATCH_MAX_DELTAS } from "./config";

export interface WireEvent {
  id: string;
  event: EventName;
  data: EventData;
}

export interface Subscriber {
  push(e: WireEvent): void;
  closed: boolean;
}

/** A step the run loop applies inside the actor's synchronous window. */
export interface TextStep {
  kind: "text";
  chunk: string;
}
export type RunStep = TextStep;

/**
 * One single-writer conversation. Owns the durable event log (via Store), the
 * set of live SSE subscribers, the cancel flag, and the in-flight run.
 *
 * Every `persist*` helper assigns the next monotonic seq, writes the event
 * durably (synchronous, before fan-out), then emits it to all subscribers.
 * Deltas are batched (BATCH_MAX_DELTAS per persist) with an in-memory tail;
 * the tail is flushed to durable storage on a full batch, keeping resume
 * granularity coarse while the live in-flight text stays in memory.
 */
export class ConversationActor {
  readonly conversationId: string;
  private readonly store: Store;
  private subscribers: Set<Subscriber> = new Set();
  private cancelRunId: string | null = null;
  private cancelNext = false;
  private currentRunId: string | null = null;
  private seq = 0;
  lastActivity = Date.now();

  constructor(conversationId: string, store: Store) {
    this.conversationId = conversationId;
    this.store = store;
    this.seq = this.store.lastSeq(conversationId);
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private persist(eventName: EventName, data: EventData): WireEvent {
    const seq = this.nextSeq();
    const id = makeId(this.conversationId, seq);
    this.store.appendAndBump(this.conversationId, seq, eventName, data);
    const e: WireEvent = { id, event: eventName, data };
    this.emit(e);
    this.lastActivity = Date.now();
    return e;
  }

  private emit(e: WireEvent): void {
    for (const s of this.subscribers) {
      if (!s.closed) s.push(e);
    }
  }

  /** Appends the user's prompt; the caller starts the run separately. */
  appendUser(content: string, runId: string = randomUUID()): void {
    this.persist(Event.User, {
      runId,
      threadId: this.conversationId,
      content: truncateUtf8(content),
    });
  }

  /**
   * Requests cancellation. With no argument: aborts the currently running run
   * if there is one, otherwise defers to the next run (covers the
   * `/cancel`-before-claim race). With a runId: cancels that specific run even
   * if it hasn't started yet — the flag is scoped to the runId so it can't
   * leak into a later run.
   */
  requestCancel(runId?: string): void {
    if (runId !== undefined) {
      this.cancelRunId = runId;
      return;
    }
    if (this.currentRunId !== null) {
      this.cancelRunId = this.currentRunId;
    } else {
      this.cancelNext = true;
    }
  }

  isCancelled(): boolean {
    return this.currentRunId !== null && this.cancelRunId === this.currentRunId;
  }

  /** Replay the durable log strictly after `afterSeq`, oldest first. */
  replay(afterSeq: number): WireEvent[] {
    if (afterSeq >= this.seq) return [];
    return this.store.replay(this.conversationId, Math.max(0, afterSeq)).map((r) => ({
      id: makeId(this.conversationId, r.seq),
      event: r.event as EventName,
      data: r.data as EventData,
    }));
  }

  /** Current tail seq, used for Last-Event-ID resume cursor arithmetic. */
  lastCommittedSeq(): number {
    return this.seq;
  }

  /**
   * Adds a subscriber and (re)plays the gap since `afterSeq` for a resuming
   * EventSource. Returns an unsubscribe function.
   */
  subscribe(sub: Subscriber, afterSeq: number): () => void {
    for (const e of this.replay(afterSeq)) sub.push(e);
    this.subscribers.add(sub);
    this.lastActivity = Date.now();
    return () => {
      this.subscribers.delete(sub);
      sub.closed = true;
      this.lastActivity = Date.now();
    };
  }

  /**
   * Subscribes without replay, for following the live tail.
   */
  follow(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    this.lastActivity = Date.now();
    return () => {
      this.subscribers.delete(sub);
      sub.closed = true;
      this.lastActivity = Date.now();
    };
  }

  /**
   * Runs one assistant turn inside this actor (single-writer guarantees no
   * interleaving): message-start, streamed text-deltas, message-end. Honors
   * the cancel flag between batches. `onProgress(seq)` fires after each
   * durable delta flush so the caller can advance a job's checkpoint and
   * heartbeat lease.
   *
   * The `steps` generator receives an AbortSignal; when cancel is requested
   * the signal is aborted so the upstream provider stream stops generating.
   */
  async runText(
    runId: string,
    messageId: string,
    steps: (signal: AbortSignal) => AsyncGenerator<RunStep>,
    onProgress?: (seq: number) => void,
  ): Promise<void> {
    this.currentRunId = runId;
    // Honor a cancel that arrived before this run was claimed.
    if (this.cancelNext) {
      this.cancelRunId = runId;
      this.cancelNext = false;
    }
    this.lastActivity = Date.now();

    const abortController = new AbortController();

    this.persist(Event.RunStart, { runId, threadId: this.conversationId, messageId });
    this.persist(Event.MsgStart, { runId, threadId: this.conversationId, messageId, type: "text" });

    let delta = "";
    let batch = 0;
    let errored = false;
    const flushDelta = () => {
      if (delta.length === 0) return;
      const seq = this.nextSeq();
      const id = makeId(this.conversationId, seq);
      const truncated = truncateUtf8(delta);
      this.store.appendAndBump(this.conversationId, seq, Event.TextDelta, {
        runId,
        threadId: this.conversationId,
        messageId,
        delta: truncated,
      });
      const e: WireEvent = {
        id,
        event: Event.TextDelta,
        data: { runId, threadId: this.conversationId, messageId, delta: truncated },
      };
      this.emit(e);
      delta = "";
      this.lastActivity = Date.now();
      onProgress?.(seq);
    };

    const tick = setInterval(() => {
      flushDelta();
    }, BATCH_FLUSH_MS);

    try {
      for await (const step of steps(abortController.signal)) {
        if (this.isCancelled()) {
          abortController.abort();
          break;
        }
        if (step.kind === "text") {
          delta += step.chunk;
          batch++;
          if (batch >= BATCH_MAX_DELTAS) {
            flushDelta();
            batch = 0;
          }
        }
      }
    } catch (err) {
      errored = true;
      this.persist(Event.RunErr, {
        runId,
        threadId: this.conversationId,
        error: String(err),
      });
    } finally {
      clearInterval(tick);
    }

    flushDelta();
    const finish = errored
      ? "error"
      : this.isCancelled()
        ? "aborted"
        : "stop";
    if (finish === "aborted") {
      this.persist(Event.Cancelled, { runId, threadId: this.conversationId });
    }
    this.persist(Event.MsgEnd, { runId, threadId: this.conversationId, messageId, finishReason: finish });
    this.currentRunId = null;
  }
}
