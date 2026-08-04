import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
import { FsBlobStore } from "../src/blobs";
import { ConversationActor, type Subscriber, type WireEvent } from "../src/actor";
import { Event } from "../src/events";

let store: Store;
let dbPath: string;

beforeAll(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "kloe-test-")), "test.db");
  store = new Store(dbPath);
});
afterAll(() => {
  store.db.close();
  rmSync(dbPath, { force: true });
});

test("event ids are monotonic across a conversation", async () => {
  const a = new ConversationActor("t1", store);
  const seen: string[] = [];
  const sub: Subscriber = {
    push: (e) => seen.push(e.id),
    closed: false,
  };
  a.follow(sub);
  a.appendUser("hi", "r1");
  await a.runText("r1", "m1", async function* (_signal) {
    yield { kind: "text", chunk: "hello" };
  });
  expect(seen.length).toBeGreaterThan(0);
  const seqs = seen.map((id) => Number(id.split(":")[1]!));
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  }
});

test("a usage step is stamped onto the message-end event", async () => {
  const a = new ConversationActor("t-usage", store);
  const events: WireEvent[] = [];
  const sub: Subscriber = { push: (e) => events.push(e), closed: false };
  a.follow(sub);

  await a.runText("r-u", "m-u", async function* (_signal) {
    yield { kind: "text", chunk: "hello" };
    yield { kind: "usage", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } };
  });

  const end = events.find((e) => e.event === Event.MsgEnd);
  expect(end).toBeDefined();
  const data = end!.data as { finishReason: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
  expect(data.finishReason).toBe("stop");
  expect(data.usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
});

test("message-end omits usage when no usage step is yielded", async () => {
  const a = new ConversationActor("t-nousage", store);
  const events: WireEvent[] = [];
  a.follow({ push: (e) => events.push(e), closed: false });
  await a.runText("r-n", "m-n", async function* (_signal) {
    yield { kind: "text", chunk: "hi" };
  });
  const end = events.find((e) => e.event === Event.MsgEnd);
  expect((end!.data as { usage?: unknown }).usage).toBeUndefined();
});

test("cancel resets between runs", async () => {
  const a = new ConversationActor("t2", store);
  const events: string[] = [];
  const sub: Subscriber = {
    push: (e) => events.push(e.event),
    closed: false,
  };
  a.follow(sub);

  // First run: cancel it.
  a.requestCancel();
  await a.runText("r1", "m1", async function* (_signal) {
    yield { kind: "text", chunk: "should not appear" };
  });
  expect(events).toContain("cancelled");

  // Second run: should NOT be poisoned by the previous cancel.
  events.length = 0;
  await a.runText("r2", "m2", async function* (_signal) {
    yield { kind: "text", chunk: "this should appear" };
  });
  expect(events).toContain("text-delta");
  expect(events).not.toContain("cancelled");
});

test("history reconstructs prior turns as alternating user/assistant messages", async () => {
  const a = new ConversationActor("t-history", store);
  a.appendUser("first question");
  await a.runText("r1", "m1", async function* (_signal) {
    yield { kind: "text", chunk: "first " };
    yield { kind: "text", chunk: "answer" };
  });
  a.appendUser("second question"); // the next run's triggering message

  expect(await a.history()).toEqual([
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]);
});

test("history merges consecutive user turns (a flushed steer batch) into one", async () => {
  const a = new ConversationActor("t-history-batch", store);
  a.appendUser("part one", "r-a");
  a.appendUser("part two", "r-b");
  expect(await a.history()).toEqual([{ role: "user", content: "part one\n\npart two" }]);
});

test("history drops an assistant turn that produced no text (stopped before first token)", async () => {
  const a = new ConversationActor("t-history-empty", store);
  a.appendUser("hi");
  a.requestCancel("r1"); // cancel this run before it starts
  await a.runText("r1", "m1", async function* (_signal) {
    yield { kind: "text", chunk: "never" };
  });
  // Only the user turn survives — no empty assistant message.
  expect(await a.history()).toEqual([{ role: "user", content: "hi" }]);
});

test("cancel mid-token aborts the stream at once and finishes aborted, not error", async () => {
  const a = new ConversationActor("t-abort", store);
  const events: WireEvent[] = [];
  a.follow({ push: (e) => events.push(e), closed: false });

  // A generator that yields once, then blocks until its signal aborts — the
  // shape of a provider stream sitting between tokens. requestCancel must
  // unblock it immediately (not wait for a next token that never comes), and
  // the resulting rejection must read as a clean stop.
  let blocked: () => void = () => {};
  const reachedBlock = new Promise<void>((r) => (blocked = r));
  const run = a.runText("r1", "m1", async function* (signal) {
    yield { kind: "text", chunk: "partial" };
    blocked();
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    yield { kind: "text", chunk: "never reached" };
  });

  await reachedBlock;
  a.requestCancel();
  await run;

  const end = events.find((e) => e.event === Event.MsgEnd);
  expect((end!.data as { finishReason: string }).finishReason).toBe("aborted");
  expect(events.some((e) => e.event === Event.Cancelled)).toBe(true);
  expect(events.some((e) => e.event === Event.RunErr)).toBe(false);
});

test("error sets finishReason to error", async () => {
  const a = new ConversationActor("t3", store);
  const events: WireEvent[] = [];
  const sub: Subscriber = {
    push: (e) => events.push(e),
    closed: false,
  };
  a.follow(sub);

  await a.runText("r1", "m1", async function* (_signal) {
    yield { kind: "text", chunk: "partial" };
    throw new Error("upstream failure");
  });

  const end = events.find((e) => e.event === Event.MsgEnd);
  expect(end).toBeDefined();
  expect((end!.data as { finishReason: string }).finishReason).toBe("error");
  const err = events.find((e) => e.event === Event.RunErr);
  expect(err).toBeDefined();
});

// ---- history: attachment mime-routing ----------------------------------
function blobStore(): FsBlobStore {
  return new FsBlobStore(join(mkdtempSync(join(tmpdir(), "kloe-ah-")), "blobs"));
}
async function stage(
  blobs: FsBlobStore,
  text: string,
  name: string,
  mime: string,
  kind: "image" | "file",
) {
  const ref = await blobs.put(new TextEncoder().encode(text));
  store.recordBlob(ref.sha256, mime, ref.size);
  return { sha256: ref.sha256, name, mime, kind };
}

test("history: an image attachment becomes an image part when the model supports vision", async () => {
  const blobs = blobStore();
  const a = new ConversationActor("t-att-img", store);
  const att = await stage(blobs, "PNGBYTES", "cat.png", "image/png", "image");
  a.appendUser("look", "r1", [att]);

  const msgs = await a.history({ blobs, supportsImages: true });
  expect(msgs).toHaveLength(1);
  const parts = msgs[0]!.content as Array<{ type: string; text?: string; data?: Uint8Array; mediaType?: string }>;
  expect(parts[0]).toEqual({ type: "text", text: "look" });
  expect(parts[1]!.type).toBe("file"); // AI SDK file part with an image mediaType
  expect(parts[1]!.mediaType).toBe("image/png");
  expect(new TextDecoder().decode(parts[1]!.data!)).toBe("PNGBYTES");
});

test("history: an image degrades to a sandbox note when the model can't see images", async () => {
  const blobs = blobStore();
  const a = new ConversationActor("t-att-noimg", store);
  const att = await stage(blobs, "PNGBYTES", "cat.png", "image/png", "image");
  a.appendUser("look", "r1", [att]);

  // No image part to carry, so the turn is all text → collapses to a string
  // that tells the model to reach the file via the sandbox.
  const content = msgs0Text(await a.history({ blobs, supportsImages: false }));
  expect(content).toContain("look");
  expect(content).toContain("inputs/cat.png");
});

test("history: a small text file is inlined into the prompt", async () => {
  const blobs = blobStore();
  const a = new ConversationActor("t-att-text", store);
  const att = await stage(blobs, "col1,col2\n1,2", "data.csv", "text/csv", "file");
  a.appendUser("parse this", "r1", [att]);

  const content = msgs0Text(await a.history({ blobs, supportsImages: true }));
  expect(content).toContain("Attached file data.csv");
  expect(content).toContain("col1,col2");
});

test("history: a binary file becomes a sandbox note, not inlined bytes", async () => {
  const blobs = blobStore();
  const a = new ConversationActor("t-att-bin", store);
  const att = await stage(blobs, "\x00\x01ZIP", "archive.zip", "application/zip", "file");
  a.appendUser("unpack", "r1", [att]);

  const content = msgs0Text(await a.history({ blobs, supportsImages: true }));
  expect(content).toContain("inputs/archive.zip");
});

/** The first message's content as a string (text-only turns collapse to one). */
function msgs0Text(msgs: Awaited<ReturnType<ConversationActor["history"]>>): string {
  const c = msgs[0]!.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

test("reasoning steps stream as reasoning-delta events, ahead of the answer text", async () => {
  const a = new ConversationActor("t-reason", store);
  const events: WireEvent[] = [];
  a.follow({ push: (e) => events.push(e), closed: false });
  await a.runText("rr", "mr", async function* (_signal) {
    yield { kind: "reasoning", chunk: "let me think " };
    yield { kind: "reasoning", chunk: "about it" };
    yield { kind: "text", chunk: "the answer" };
  });
  const names = events.map((e) => e.event);
  expect(names).toContain(Event.ReasoningDelta);
  expect(names).toContain(Event.TextDelta);
  // Reasoning is flushed before the answer text.
  expect(names.indexOf(Event.ReasoningDelta)).toBeLessThan(names.indexOf(Event.TextDelta));
  const rd = events.find((e) => e.event === Event.ReasoningDelta)!.data as { delta: string };
  expect(rd.delta).toContain("let me think");
  // The thinking duration is stamped durably on message-end (so it's right on
  // replay); a number when the model reasoned.
  const end = events.find((e) => e.event === Event.MsgEnd)!.data as { reasoningMs?: number };
  expect(typeof end.reasoningMs).toBe("number");
  // Reasoning is display-only for now — it is NOT fed back into model history.
  const hist = await a.history();
  expect(JSON.stringify(hist)).not.toContain("let me think");
});

test("message-end omits reasoningMs when the turn produced no reasoning", async () => {
  const a = new ConversationActor("t-noreason", store);
  const events: WireEvent[] = [];
  a.follow({ push: (e) => events.push(e), closed: false });
  await a.runText("nr", "mnr", async function* (_signal) {
    yield { kind: "text", chunk: "just an answer" };
  });
  const end = events.find((e) => e.event === Event.MsgEnd)!.data as { reasoningMs?: number };
  expect(end.reasoningMs).toBeUndefined();
});

test("tool-call and tool-result steps persist as durable, ordered events", async () => {
  const a = new ConversationActor("t-tools", store);
  const events: WireEvent[] = [];
  a.follow({ push: (e) => events.push(e), closed: false });
  await a.runText("rt", "mt", async function* (_signal) {
    yield { kind: "text", chunk: "let me check the time" };
    yield { kind: "tool-call", toolCallId: "c1", toolName: "get_time", input: { timezone: "UTC" } };
    yield { kind: "tool-result", toolCallId: "c1", toolName: "get_time", output: { iso: "2026-08-04T00:00:00Z" } };
    yield { kind: "text", chunk: "it is midnight UTC" };
  });
  const names = events.map((e) => e.event);
  expect(names).toContain(Event.ToolCall);
  expect(names).toContain(Event.ToolResult);
  // Ordering: the text preceding the call flushed before it; result follows call.
  expect(names.indexOf(Event.TextDelta)).toBeLessThan(names.indexOf(Event.ToolCall));
  expect(names.indexOf(Event.ToolCall)).toBeLessThan(names.indexOf(Event.ToolResult));

  const call = events.find((e) => e.event === Event.ToolCall)!.data as
    { toolName: string; toolCallId: string; messageId: string; input: { timezone: string } };
  expect(call.toolName).toBe("get_time");
  expect(call.toolCallId).toBe("c1");
  expect(call.messageId).toBe("mt");
  expect(call.input.timezone).toBe("UTC");
  const res = events.find((e) => e.event === Event.ToolResult)!.data as { output: { iso: string } };
  expect(res.output.iso).toBe("2026-08-04T00:00:00Z");
});
