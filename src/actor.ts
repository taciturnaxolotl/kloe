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
  type ReasoningDeltaData,
  type ReasoningSignatureData,
  type ToolCallData,
  type ToolResultData,
} from "./events";
import { truncateUtf8 } from "./sse";
import { BATCH_FLUSH_MS, BATCH_MAX_DELTAS, ATTACHMENT_INLINE_TEXT_MAX, TOOL_OUTPUT_MAX } from "./config";
import type { BlobStore } from "./blobs";

/** A user-message content part while building model messages. */
type UserPart =
  | { type: "text"; text: string }
  // AI SDK's image part is deprecated; images ride as file parts with an
  // `image/*` mediaType, which vision models consume the same way.
  | { type: "file"; data: Uint8Array; mediaType: string };

/** Options controlling how `history()` renders attachments for the model. */
export interface HistoryOptions {
  /** Resolves attachment bytes; without it, attachments degrade to text notes. */
  blobs?: BlobStore;
  /** Whether the target model can accept image parts (else images become notes). */
  supportsImages?: boolean;
}

/** Text-like mimes we inline into the prompt (small ones) rather than sandbox. */
function isTextLike(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    /^application\/(json|xml|x-?yaml|javascript|typescript|toml|x-ndjson)$/.test(mime)
  );
}

/** A tool-call part in a reconstructed assistant message. */
type ToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };
/** A signed reasoning block echoed back on replay (Anthropic thinking). */
type ReasoningPart = { type: "reasoning"; text: string; providerOptions: Record<string, Record<string, unknown>> };
/** An assistant message's content while folding: reasoning + text + tool calls. */
type AsstPart = ReasoningPart | { type: "text"; text: string } | ToolCallPart;

/**
 * Caps a tool output before it's persisted so one tool that returns a whole
 * file or a giant JSON blob can't bloat the durable log (and every future
 * replay/context). A string is truncated in place; anything else is measured by
 * its JSON serialization and, if oversized, degraded to a truncated string note.
 * Returned unchanged when within budget, so the common small result is untouched.
 */
function capToolOutput(output: unknown): unknown {
  const note = (s: string): string =>
    s.slice(0, TOOL_OUTPUT_MAX) + `\n…[truncated, ${s.length} chars total]`;
  if (typeof output === "string") return output.length > TOOL_OUTPUT_MAX ? note(output) : output;
  let json: string;
  try { json = JSON.stringify(output); } catch { return output; }
  return json.length > TOOL_OUTPUT_MAX ? note(json) : output;
}

/** Wraps a logged tool output in the AI SDK's typed tool-result output shape. */
function toolOutput(output: unknown, isError?: boolean) {
  const text = typeof output === "string";
  if (isError) return text ? { type: "error-text", value: output } : { type: "error-json", value: output };
  return text ? { type: "text", value: output } : { type: "json", value: output };
}

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
/** A chunk of the model's reasoning/thinking (a separate stream from the answer). */
export interface ReasoningStep {
  kind: "reasoning";
  chunk: string;
}
/**
 * Closes a reasoning block that the provider SIGNED — carries the metadata to
 * echo back on replay (Anthropic's thinking signature). Emitted only when a
 * signature is present; unsigned reasoning yields no such step.
 */
export interface ReasoningSignatureStep {
  kind: "reasoning-signature";
  providerOptions: Record<string, Record<string, unknown>>;
}
/** The model invoked a tool. */
export interface ToolCallStep {
  kind: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}
/** A tool returned (or errored); `isError` marks a thrown/failed execution. */
export interface ToolResultStep {
  kind: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
}
/** Real provider token usage, yielded once after the text stream drains. */
export interface UsageStep {
  kind: "usage";
  usage: TokenUsage;
}
export type RunStep =
  | TextStep
  | ReasoningStep
  | ReasoningSignatureStep
  | ToolCallStep
  | ToolResultStep
  | UsageStep;

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
   * Tombstones a queued steer so it drops out of the pending queue. The queue
   * is derived from the log, so this is just another event — every device sees
   * the removal, and a reconnecting client rebuilds the queue without it. The
   * blob_refs added at queue time are left: the (now-tombstoned) queued-message
   * still holds the reference, so the blob stays protected until the whole
   * conversation is deleted (per-message deref would need finer-grained refs).
   */
  cancelSteer(runId: string): void {
    this.persist(Event.QueuedCancelled, { threadId: this.conversationId, runId });
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
   * run is generated against. Events are processed IN ORDER (not accumulated by
   * messageId) so tool interactions interleave correctly:
   *
   *   `user-message`  → a user turn (text + attachments); consecutive user turns
   *                     (a flushed steer batch) merge with a blank line.
   *   `text-delta`    → streamed assistant text; text after a tool result starts
   *                     a NEW assistant step.
   *   `tool-call`     → a `{type:"tool-call"}` part on the current assistant msg.
   *   `tool-result`   → closes the assistant step, then a `tool`-role message.
   *
   * Only tool calls that have a matching result are folded (and vice-versa): a
   * dangling tool-call — e.g. from a run cancelled mid-tool — makes providers
   * error, so it's dropped. Reasoning is normally dropped too, EXCEPT a block
   * the provider signed (Anthropic thinking): its signature must be echoed back
   * verbatim or the provider rejects a follow-up that contains tool calls, so a
   * signed block is reconstructed as a `reasoning` part ahead of the text/tools
   * it preceded. The unsent steer queue and control events are excluded; empty
   * assistant turns are dropped.
   */
  async history(opts: HistoryOptions = {}): Promise<ModelMessage[]> {
    const out: ModelMessage[] = [];

    // Fold only tool-call/result pairs where both sides exist; and note which
    // messages carry signed reasoning, so unsigned-reasoning turns skip the
    // (potentially huge) text accumulation entirely.
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    const signedMsgs = new Set<string>();
    for (const e of this.store.replay(this.conversationId, 0)) {
      if (e.event === Event.ToolCall) callIds.add((e.data as ToolCallData).toolCallId);
      else if (e.event === Event.ToolResult) resultIds.add((e.data as ToolResultData).toolCallId);
      else if (e.event === Event.ReasoningSig) signedMsgs.add((e.data as ReasoningSignatureData).messageId);
    }
    const paired = new Set([...callIds].filter((id) => resultIds.has(id)));

    // Assembly state, flushed in role order as the transcript alternates.
    let userParts: UserPart[] | null = null;
    let asstText = "";
    let asstParts: AsstPart[] = [];
    // The reasoning block currently accumulating and its signature (set when the
    // block's reasoning-signature event lands). Emitted as a part only if signed.
    let asstReasoning = "";
    let asstReasoningSig: Record<string, Record<string, unknown>> | null = null;
    let toolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: unknown }> = [];

    const flushUser = (): void => {
      const parts = userParts;
      userParts = null;
      if (!parts || parts.length === 0) return;
      if (parts.every((p) => p.type === "text")) {
        const text = parts.map((p) => (p as { text: string }).text).join("\n\n");
        if (text.length > 0) out.push({ role: "user", content: text });
      } else {
        out.push({ role: "user", content: parts } as ModelMessage);
      }
    };
    // Emit the pending reasoning block as a part if the provider signed it (must
    // precede the text/tool it introduced); otherwise drop it. Always resets, so
    // each block is considered once.
    const flushReasoningPart = (): void => {
      if (asstReasoning.length > 0 && asstReasoningSig) {
        asstParts.push({ type: "reasoning", text: asstReasoning, providerOptions: asstReasoningSig });
      }
      asstReasoning = "";
      asstReasoningSig = null;
    };
    const pushAsstText = (): void => {
      flushReasoningPart(); // a signed thinking block sits before the answer text
      if (asstText.length > 0) { asstParts.push({ type: "text", text: asstText }); asstText = ""; }
    };
    const flushAsst = (): void => {
      pushAsstText();
      if (asstParts.length === 0) return;
      // Text-only collapses to a string (the prior shape); a tool call makes it an array.
      if (asstParts.every((p) => p.type === "text")) {
        out.push({ role: "assistant", content: (asstParts as Array<{ text: string }>).map((p) => p.text).join("\n\n") });
      } else {
        out.push({ role: "assistant", content: asstParts } as ModelMessage);
      }
      asstParts = [];
    };
    const flushTools = (): void => {
      if (toolResults.length === 0) return;
      out.push({ role: "tool", content: toolResults } as ModelMessage);
      toolResults = [];
    };

    for (const e of this.store.replay(this.conversationId, 0)) {
      if (e.event === Event.User) {
        flushAsst();
        flushTools();
        const d = e.data as UserMessageData;
        userParts ??= [];
        if (d.content.length > 0) userParts.push({ type: "text", text: d.content });
        for (const a of d.attachments ?? []) userParts.push(await this.renderAttachment(a, opts));
      } else if (e.event === Event.TextDelta) {
        flushUser();
        if (toolResults.length > 0) flushTools(); // text after a result: new step
        asstText += (e.data as TextDeltaData).delta;
      } else if (e.event === Event.ReasoningDelta) {
        flushUser();
        if (toolResults.length > 0) flushTools(); // reasoning after a result: new step
        const d = e.data as ReasoningDeltaData;
        // Accumulate only for turns that carry a signature — everything else is
        // dropped from history, so there's no need to build the string.
        if (signedMsgs.has(d.messageId)) asstReasoning += d.delta;
      } else if (e.event === Event.ReasoningSig) {
        asstReasoningSig = (e.data as ReasoningSignatureData).providerOptions;
      } else if (e.event === Event.ToolCall) {
        flushUser();
        const d = e.data as ToolCallData;
        if (paired.has(d.toolCallId)) {
          pushAsstText();
          asstParts.push({ type: "tool-call", toolCallId: d.toolCallId, toolName: d.toolName, input: d.input });
        }
      } else if (e.event === Event.ToolResult) {
        flushUser();
        const d = e.data as ToolResultData;
        if (paired.has(d.toolCallId)) {
          flushAsst(); // close the assistant step (text + calls) before its results
          toolResults.push({
            type: "tool-result", toolCallId: d.toolCallId, toolName: d.toolName,
            output: toolOutput(d.output, d.isError),
          });
        }
      }
    }
    flushAsst();
    flushTools();
    flushUser();
    return out;
  }

  /**
   * Routes one attachment to a model part by mime (see spec "Attachment
   * handling"): an image → an image part when the model supports vision; a
   * small text-like file → inlined text; everything else (binary, oversized
   * text, images a non-vision model can't read, or an unresolvable blob) → a
   * text note telling the model to fetch it from the sandbox by name.
   */
  private async renderAttachment(a: AttachmentRef, opts: HistoryOptions): Promise<UserPart> {
    const size = this.store.getBlob(a.sha256)?.size;
    const isImage = a.kind === "image" || a.mime.startsWith("image/");
    if (isImage && opts.supportsImages && opts.blobs) {
      const blob = await opts.blobs.get(a.sha256);
      if (blob) return { type: "file", data: new Uint8Array(await blob.arrayBuffer()), mediaType: a.mime };
    }
    if (isTextLike(a.mime) && opts.blobs && (size === undefined || size <= ATTACHMENT_INLINE_TEXT_MAX)) {
      const blob = await opts.blobs.get(a.sha256);
      if (blob) return { type: "text", text: `Attached file ${a.name}:\n\n\`\`\`\n${await blob.text()}\n\`\`\`` };
    }
    const sz = size !== undefined ? `, ${size} bytes` : "";
    // TODO(sandbox): the `inputs/<name>` path is naive — two different files
    // with the same name (or the same name twice in a turn) collide. When the
    // sandbox lands (slice 5), disambiguate with a prefix dir (`inputs/<n>/<name>`)
    // and emit the SAME path the inputs mount actually uses, so the note and the
    // filesystem agree. Until then this path is indicative, not guaranteed.
    return {
      type: "text",
      text: `[attachment: ${a.name} (${a.mime}${sz}) — not inlined; fetch it in the sandbox as inputs/${a.name}]`,
    };
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
    let reasoning = "";
    let rbatch = 0;
    let errored = false;
    // Text and reasoning are two batched streams; each flushes as its own delta
    // event (same batching rule). Reasoning flushes also heartbeat the job so a
    // long thinking stretch before the first answer token can't be reaped.
    const flush = (eventName: EventName, text: string): void => {
      if (text.length === 0) return;
      const seq = this.nextSeq();
      const id = makeId(this.conversationId, seq);
      const truncated = truncateUtf8(text);
      const data = { runId, threadId: this.conversationId, messageId, delta: truncated };
      this.store.appendAndBump(this.conversationId, seq, eventName, data);
      this.emit({ id, event: eventName, data });
      this.lastActivity = Date.now();
      onProgress?.(seq);
    };
    const flushDelta = () => {
      if (delta.length === 0) return;
      flush(Event.TextDelta, delta);
      delta = "";
    };
    const flushReasoning = () => {
      if (reasoning.length === 0) return;
      flush(Event.ReasoningDelta, reasoning);
      reasoning = "";
    };

    const tick = setInterval(() => {
      flushReasoning();
      flushDelta();
    }, BATCH_FLUSH_MS);

    let usage: TokenUsage | undefined;
    // Reasoning duration: wall-clock from the start of generation to the first
    // answer token. This captures silent server-side thinking (a long ttft with
    // no tokens) that the client can't see, and is durable so it's right on
    // replay. Only meaningful when the model actually reasoned.
    const genStart = Date.now();
    let sawReasoning = false;
    let firstTextAt = 0;
    try {
      for await (const step of steps(abortController.signal)) {
        if (this.isCancelled()) {
          abortController.abort();
          break;
        }
        if (step.kind === "text") {
          if (firstTextAt === 0) firstTextAt = Date.now();
          delta += step.chunk;
          batch++;
          if (batch >= BATCH_MAX_DELTAS) {
            flushDelta();
            batch = 0;
          }
        } else if (step.kind === "reasoning") {
          sawReasoning = true;
          reasoning += step.chunk;
          rbatch++;
          if (rbatch >= BATCH_MAX_DELTAS) {
            flushReasoning();
            rbatch = 0;
          }
        } else if (step.kind === "reasoning-signature") {
          // The signed reasoning block just ended: flush its buffered text so the
          // signature event lands right after it in the log, then persist the
          // signature (durable, so history() can echo it back on replay).
          flushReasoning();
          this.persist(Event.ReasoningSig, {
            runId, threadId: this.conversationId, messageId,
            providerOptions: step.providerOptions,
          });
        } else if (step.kind === "tool-call") {
          // Flush pending text/reasoning first so the durable log stays ordered
          // (a tool call sits after the text that preceded it). Tool events are
          // durable (via persist), not batched.
          flushReasoning();
          flushDelta();
          this.persist(Event.ToolCall, {
            runId, threadId: this.conversationId, messageId,
            toolCallId: step.toolCallId, toolName: step.toolName, input: step.input,
          });
        } else if (step.kind === "tool-result") {
          this.persist(Event.ToolResult, {
            runId, threadId: this.conversationId, messageId,
            toolCallId: step.toolCallId, toolName: step.toolName,
            output: capToolOutput(step.output), isError: step.isError,
          });
        } else if (step.kind === "usage") {
          usage = step.usage;
        }
      }
    } catch (err) {
      // Aborting mid-token (via requestCancel) surfaces here as a rejection —
      // that's a clean stop, not an error. Anything else is a real failure.
      if (!this.isCancelled()) {
        errored = true;
        // Also log server-side: the RunErr event reaches the client, but the
        // terminal is where you're watching, and a stack is more diagnostic.
        console.error(`[run ${runId}] provider error:`, err);
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

    flushReasoning();
    flushDelta();
    const finish = errored
      ? "error"
      : this.isCancelled()
        ? "aborted"
        : "stop";
    if (finish === "aborted") {
      this.persist(Event.Cancelled, { runId, threadId: this.conversationId });
    }
    // Reasoning time = start-of-generation → first answer token (or end, if the
    // model reasoned but never produced an answer). Only when it reasoned.
    const reasoningMs = sawReasoning ? (firstTextAt || Date.now()) - genStart : undefined;
    this.persist(Event.MsgEnd, { runId, threadId: this.conversationId, messageId, finishReason: finish, usage, reasoningMs });
    this.currentRunId = null;
  }
}
