import { ParseError } from "./errors";

/**
 * Event type names are stable across the wire, persistence, and the actor.
 * These align with AG-UI's `message.`/`run.` conventions so the same schema can
 * ride a different transport unchanged.
 */
export const Event = {
  User: "user-message",
  MsgStart: "message-start",
  TextDelta: "text-delta",
  ToolCall: "tool-call",
  ToolResult: "tool-result",
  MsgEnd: "message-end",
  RunStart: "run-started",
  RunErr: "run-error",
  Cancelled: "cancelled",
  Steer: "steer",
} as const;
export type EventName = (typeof Event)[keyof typeof Event];

export interface UserMessageData {
  threadId: string;
  runId: string;
  content: string;
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

export interface ToolCallData {
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultData {
  threadId: string;
  runId: string;
  toolCallId: string;
  output: unknown;
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

export interface SteerData {
  threadId: string;
  runId: string;
  message: string;
}

export type EventData =
  | UserMessageData
  | RunStartedData
  | MessageStartData
  | TextDeltaData
  | ToolCallData
  | ToolResultData
  | MessageEndData
  | RunErrorData
  | CancelledData
  | SteerData;

export interface ParsedEvent {
  id: string;
  event: EventName;
  data: EventData;
}

export function makeId(conversationId: string, seq: number): string {
  return `${conversationId}:${seq}`;
}

export function isEventName(v: unknown): v is EventName {
  return typeof v === "string" && (Object.values(Event) as string[]).includes(v);
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
