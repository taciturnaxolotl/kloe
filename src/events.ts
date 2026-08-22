import { ParseError } from "./errors";

/**
 * Event type names are stable across the wire, persistence, and the actor.
 * These align with AG-UI's `message.`/`run.` conventions so the same schema can
 * ride a different transport unchanged.
 */
export const Event = {
  User: "user-message",
  Queued: "queued-message",
  QueuedCancelled: "queued-cancelled",
  MsgStart: "message-start",
  TextDelta: "text-delta",
  ReasoningDelta: "reasoning-delta",
  ReasoningSig: "reasoning-signature",
  ToolCall: "tool-call",
  ToolProgress: "tool-progress",
  ToolResult: "tool-result",
  MsgEnd: "message-end",
  RunStart: "run-started",
  RunErr: "run-error",
  Cancelled: "cancelled",
  Title: "conversation-title",
} as const;
export type EventName = (typeof Event)[keyof typeof Event];

/**
 * A document a tool produced: a reference, never bytes (spec, "Artifacts — the
 * promotion path"). Agent-made files use the same content-addressed blob store
 * as user uploads — one mechanism — so an artifact can be downloaded, fed back
 * into a later tool, or materialized into the sandbox by its sha256.
 *
 * `name` is the document's identity within a conversation; writing it again
 * makes a new version rather than a new document.
 */
export interface ArtifactRef {
  sha256: string;
  /** Filename, e.g. "hack-club-funding.md". */
  name: string;
  /** Human title for the card; falls back to the name. */
  title?: string;
  mime: string;
  size: number;
  /** Assigned by the store when the reference is recorded. */
  version?: number;
}

/** A blob referenced by a message (bytes in the BlobStore, keyed by sha256). */
export interface AttachmentRef {
  sha256: string;
  name: string;
  mime: string;
  kind: "image" | "file";
}

export interface UserMessageData {
  threadId: string;
  runId: string;
  content: string;
  /** Files/images the user attached; absent for a plain text turn. */
  attachments?: AttachmentRef[];
  /** Present when this message is the answer to an `ask_user` form. */
  ask?: AskReply;
}

/** A steered message parked in the queue until the current run finishes. */
export interface QueuedMessageData {
  threadId: string;
  runId: string;
  content: string;
  model: string;
  /** Files/images attached to the steered message; absent for plain text. */
  attachments?: AttachmentRef[];
}

/** Tombstones a queued steer (by runId) so it drops out of the pending queue. */
export interface QueuedCancelledData {
  threadId: string;
  runId: string;
}

export interface RunStartedData {
  threadId: string;
  runId: string;
  messageId: string;
}

export interface MessageStartData {
  threadId: string;
  runId: string;
  messageId: string;
  type: "text" | "tool-call";
}

export interface TextDeltaData {
  threadId: string;
  runId: string;
  messageId: string;
  delta: string;
}

/** A chunk of the model's reasoning/thinking (separate stream from the answer). */
export interface ReasoningDeltaData {
  threadId: string;
  runId: string;
  messageId: string;
  delta: string;
}

/**
 * Closes a signed reasoning block: the provider metadata (e.g. Anthropic's
 * thinking-block signature) that must be echoed back verbatim when this turn is
 * replayed as history, or the provider rejects the follow-up. Persisted only
 * when the provider actually signed the reasoning — unsigned reasoning (most
 * providers) is never echoed. `providerOptions` is the raw metadata, keyed by
 * provider, and is passed straight back as the reasoning part's providerOptions.
 */
export interface ReasoningSignatureData {
  threadId: string;
  runId: string;
  messageId: string;
  providerOptions: Record<string, Record<string, unknown>>;
}

export interface ToolCallData {
  threadId: string;
  runId: string;
  /** The assistant turn this tool call belongs to (for rendering into its timeline). */
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/**
 * A tool reporting from inside its own execution, before it returns.
 *
 * Most tools are quick enough that a spinner is the whole story. A tool that
 * runs for minutes is not — `deep_research` searches, reads, and drafts for long
 * enough that silence reads as a hang. These carry what it is doing right now,
 * and they are durable like everything else, so reloading mid-run rebuilds the
 * live view instead of showing an empty step.
 *
 * `phase` is the tool's own vocabulary; the client renders what it recognizes and
 * ignores the rest, so a tool can add a phase without a client change.
 */
export interface ToolProgressData {
  threadId: string;
  runId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  phase: string;
  /** Phase-specific payload — a query, a page, a chunk of the draft. */
  data?: unknown;
}

/**
 * A choice offered by `ask_user`. The `id` is what comes back in the answer, so
 * it is what the model reads — name it for meaning ("postgres"), not position.
 */
export interface AskChoice {
  id: string;
  label: string;
  /** One line of what picking this means; shown under the label. */
  description?: string;
}

/** One question in an `ask_user` call. */
export interface AskQuestion {
  /** Everything but `free_text` carries `choices`, which `rank_priorities` orders. */
  type: "single_choice" | "multi_choice" | "rank_priorities" | "free_text";
  question: string;
  /** Markdown context under the question: the tradeoff, the default, the risk. */
  description?: string;
  choices?: AskChoice[];
}

/**
 * One question's answer. `choiceIds` is a set for the choice types and a running
 * ORDER for `rank_priorities` — same field, because "which of these" and "these,
 * in this order" are the same act with more information in the second.
 *
 * Both may carry `text` as well: the composer keeps a line for the user's own
 * words under every question, so "the second one, but only for images" is
 * sayable without an "Other" choice to invent it.
 */
export interface AskAnswer {
  choiceIds?: string[];
  text?: string;
}

/**
 * The form, answered. It rides the user's message so their turn can render as
 * what it is — a question and what they picked — instead of the prose the model
 * reads. Self-contained on purpose: `questions` is copied in rather than looked
 * up from the tool call, because a tail-loaded thread may not have that call on
 * screen at all.
 */
export interface AskReply {
  toolCallId: string;
  questions: AskQuestion[];
  /** Positional with `questions`; an empty entry is a question left alone. */
  answers: AskAnswer[];
}

export interface ToolResultData {
  threadId: string;
  runId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  output: unknown;
  /** Documents this tool produced. References only — bytes live in the blob store. */
  artifacts?: ArtifactRef[];
  /** True when the tool threw / errored rather than returning a result. */
  isError?: boolean;
}

/** Real token usage reported by the provider (AI SDK LanguageModelUsage). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Tokens resident in the model's window when the run ended: the final step's
   * prompt plus what it generated.
   *
   * The fields above are summed over every step of a tool loop, and each step
   * re-sends the whole conversation — so they measure how much work the turn
   * took, not how full the window is. A ten-step turn bills several times the
   * context it actually occupies, and the next one-step turn bills less than the
   * last, which is why a gauge fed from them walks backwards.
   */
  contextTokens?: number;
  /** `contextTokens` came from measuring the prompt, not from the provider. */
  contextEstimated?: boolean;
}

export interface MessageEndData {
  threadId: string;
  runId: string;
  messageId: string;
  finishReason: "stop" | "length" | "tool-calls" | "aborted" | "error";
  /** Present when the provider reported usage for this run. */
  usage?: TokenUsage;
  /** Wall-clock ms the model spent reasoning before the answer — for the thinking label. */
  reasoningMs?: number;
}

export interface RunErrorData {
  threadId: string;
  runId: string;
  error: string;
}

export interface CancelledData {
  threadId: string;
  runId: string;
}

/** A generated (or renamed) conversation title, pushed live so open clients
 *  update their header + tab without a reload. */
export interface ConversationTitleData {
  threadId: string;
  title: string;
}

export type EventData =
  | UserMessageData
  | QueuedMessageData
  | QueuedCancelledData
  | RunStartedData
  | MessageStartData
  | TextDeltaData
  | ReasoningDeltaData
  | ReasoningSignatureData
  | ToolCallData
  | ToolProgressData
  | ToolResultData
  | MessageEndData
  | RunErrorData
  | CancelledData
  | ConversationTitleData;

export interface ParsedEvent {
  id: string;
  event: EventName;
  data: EventData;
}

export function makeId(conversationId: string, seq: number): string {
  return `${conversationId}:${seq}`;
}

export function parseEventId(id: string): {
  conversationId: string;
  seq: number;
} {
  const i = id.lastIndexOf(":");
  if (i === -1) throw new ParseError(`malformed event id: ${id}`);
  const seq = Number(id.slice(i + 1));
  if (!Number.isInteger(seq) || seq < 0) {
    throw new ParseError(`malformed sequence in event id: ${id}`);
  }
  return { conversationId: id.slice(0, i), seq };
}
