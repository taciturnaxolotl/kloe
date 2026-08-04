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
  ToolCall: "tool-call",
  ToolResult: "tool-result",
  MsgEnd: "message-end",
  RunStart: "run-started",
  RunErr: "run-error",
  Cancelled: "cancelled",
} as const;
export type EventName = (typeof Event)[keyof typeof Event];

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

export interface ToolCallData {
  threadId: string;
  runId: string;
  /** The assistant turn this tool call belongs to (for rendering into its timeline). */
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultData {
  threadId: string;
  runId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  output: unknown;
  /** True when the tool threw / errored rather than returning a result. */
  isError?: boolean;
}

/** Real token usage reported by the provider (AI SDK LanguageModelUsage). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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

export type EventData =
  | UserMessageData
  | QueuedMessageData
  | QueuedCancelledData
  | RunStartedData
  | MessageStartData
  | TextDeltaData
  | ReasoningDeltaData
  | ToolCallData
  | ToolResultData
  | MessageEndData
  | RunErrorData
  | CancelledData;

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
