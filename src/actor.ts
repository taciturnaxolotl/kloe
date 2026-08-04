import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { Store } from "./store";
import {
  Event,
  makeId,
  type EventData,
  type EventName,
  type TokenUsage,
  type AttachmentRef,
  type UserMessageData,
  type TextDeltaData,
  type MessageEndData,
} from "./events";
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
/** Real provider token usage, yielded once after the text stream drains. */
export interface UsageStep {
  kind: "usage";
  usage: TokenUsage;
}
export type RunStep = TextStep | UsageStep;

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
  /** Aborts the in-flight provider stream; set only while a run is streaming. */
  private currentAbort: (() => void) | null = null;
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

  /**
   * Appends the user's prompt; the caller starts the run separately. Any
   * attachments ride in the event and are registered in `blob_refs` so the GC
   * protects those blobs and deleting the conversation frees them.
   */
  appendUser(content: string, runId: string = randomUUID(), attachments?: AttachmentRef[]): void {
    this.persist(Event.User, {
      runId,
      threadId: this.conversationId,
      content: truncateUtf8(content),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    if (attachments) {
      for (const a of attachments) this.store.addBlobRef(a.sha256, this.conversationId);
    }
  }

  /**
   * Parks a steered message in the steer queue (a durable `queued-message`
   * event) instead of interrupting the current run. The drive loop promotes
   * the whole pending queue into `user-message` events and runs it as one
   * batched generation when the current run finishes. The queue is derived
   * from the log, so the event itself is the durable state.
   */
  queueSteer(
    content: string,
    model: string,
    runId: string = randomUUID(),
    attachments?: AttachmentRef[],
  ): string {
    this.persist(Event.Queued, {
      threadId: this.conversationId,
      runId,
      content: truncateUtf8(content),
      model,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    // Register refs now (not just on promotion) so a staged steer's blob is
    // protected from GC during the queued window.
    if (attachments) {
      for (const a of attachments) this.store.addBlobRef(a.sha256, this.conversationId);
    }
    return runId;
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
    } else if (this.currentRunId !== null) {
      this.cancelRunId = this.currentRunId;
    } else {
      this.cancelNext = true;
    }
    // If the run being cancelled is the one in flight, abort its provider
    // stream now — don't wait for the loop to notice between tokens (a slow
    // model can sit mid-token for seconds). The loop's own isCancelled check
    // still covers the between-steps case.
    if (this.currentAbort && this.isCancelled()) this.currentAbort();
  }

  isCancelled(): boolean {
    return this.currentRunId !== null && this.cancelRunId === this.currentRunId;
  }

  /**
   * Reconstructs the durable log as a model-ready message list — the context a
   * run is generated against. `user-message` events become user turns; streamed
   * assistant text (grouped by messageId) becomes assistant turns. Consecutive
   * same-role turns are merged with a blank line, so a flushed steer batch reads
   * as one user turn and providers that require strict role alternation stay
   * valid. The still-unsent steer queue (`queued-message`) and control events
   * are excluded; empty assistant turns (e.g. a stop before the first token) are
   * dropped.
   */
  history(): ModelMessage[] {
    const out: ModelMessage[] = [];
    const assistantText = new Map<string, string>();
    const append = (role: "user" | "assistant", content: string): void => {
      if (content.length === 0) return;
      const last = out[out.length - 1];
      if (last && last.role === role && typeof last.content === "string") {
        last.content = `${last.content}\n\n${content}`;
      } else if (role === "user") {
        out.push({ role: "user", content });
      } else {
        out.push({ role: "assistant", content });
      }
    };
    for (const e of this.store.replay(this.conversationId, 0)) {
      if (e.event === Event.User) {
        append("user", (e.data as UserMessageData).content);
      } else if (e.event === Event.TextDelta) {
        const d = e.data as TextDeltaData;
        assistantText.set(d.messageId, (assistantText.get(d.messageId) ?? "") + d.delta);
      } else if (e.event === Event.MsgEnd) {
        const d = e.data as MessageEndData;
        const text = assistantText.get(d.messageId);
        if (text !== undefined) {
          append("assistant", text);
          assistantText.delete(d.messageId);
        }
      }
    }
    return out;
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

  /** True while at least one SSE stream is attached to this actor. */
  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
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
    this.currentAbort = () => abortController.abort();

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

    let usage: TokenUsage | undefined;
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
        } else if (step.kind === "usage") {
          usage = step.usage;
        }
      }
    } catch (err) {
      // Aborting mid-token (via requestCancel) surfaces here as a rejection —
      // that's a clean stop, not an error. Anything else is a real failure.
      if (!this.isCancelled()) {
        errored = true;
        this.persist(Event.RunErr, {
          runId,
          threadId: this.conversationId,
          error: String(err),
        });
      }
    } finally {
      clearInterval(tick);
      this.currentAbort = null;
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
    this.persist(Event.MsgEnd, { runId, threadId: this.conversationId, messageId, finishReason: finish, usage });
    this.currentRunId = null;
  }
}
