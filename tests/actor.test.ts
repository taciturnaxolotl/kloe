import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationActor, type Subscriber, type WireEvent } from "../src/actor";
import { FsBlobStore } from "../src/blobs";
import { Event } from "../src/events";
import { Store } from "../src/store";

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
  const data = end!.data as {
    finishReason: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  };
  expect(data.finishReason).toBe("stop");
  expect(data.usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
});

test("tool progress reaches subscribers while the tool is still running", async () => {
  // A tool reports from inside its own execute, so this bypasses the RunStep
  // generator — which, mid-tool, is parked on the provider stream. The test
  // mirrors that: the progress goes out from inside the run, before the step
  // that follows it, and the durable log keeps it so a reload can replay it.
  const a = new ConversationActor("t-prog", store);
  const events: WireEvent[] = [];
  a.follow({ push: (e) => events.push(e), closed: false });

  await a.runText("r-p", "m-p", async function* (_signal) {
    a.toolProgress({
      runId: "r-p",
      messageId: "m-p",
      toolCallId: "call-1",
      toolName: "deep_research",
      phase: "read",
      data: { url: "https://a.test/x" },
    });
    yield { kind: "text", chunk: "after" };
  });

  const names = events.map((e) => e.event);
  expect(names.indexOf(Event.ToolProgress)).toBeGreaterThanOrEqual(0);
  expect(names.indexOf(Event.ToolProgress)).toBeLessThan(names.lastIndexOf(Event.TextDelta));
  const p = events.find((e) => e.event === Event.ToolProgress)!.data as {
    phase: string;
    toolCallId: string;
    threadId: string;
  };
  expect(p).toMatchObject({ phase: "read", toolCallId: "call-1", threadId: "t-prog" });
  // Durable, like every other event: replay sees it.
  expect(store.replay("t-prog", 0).some((e) => e.event === Event.ToolProgress)).toBe(true);
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
  const parts = msgs[0]!.content as Array<{
    type: string;
    text?: string;
    data?: Uint8Array;
    mediaType?: string;
  }>;
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
    yield { kind: "text", chunk: "let me search" };
    yield { kind: "tool-call", toolCallId: "c1", toolName: "web_search", input: { query: "kloe" } };
    yield {
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "web_search",
      output: { results: [{ title: "T", url: "u" }] },
    };
    yield { kind: "text", chunk: "here's what I found" };
  });
  const names = events.map((e) => e.event);
  expect(names).toContain(Event.ToolCall);
  expect(names).toContain(Event.ToolResult);
  // Ordering: the text preceding the call flushed before it; result follows call.
  expect(names.indexOf(Event.TextDelta)).toBeLessThan(names.indexOf(Event.ToolCall));
  expect(names.indexOf(Event.ToolCall)).toBeLessThan(names.indexOf(Event.ToolResult));

  const call = events.find((e) => e.event === Event.ToolCall)!.data as {
    toolName: string;
    toolCallId: string;
    messageId: string;
    input: { query: string };
  };
  expect(call.toolName).toBe("web_search");
  expect(call.toolCallId).toBe("c1");
  expect(call.messageId).toBe("mt");
  expect(call.input.query).toBe("kloe");
  const res = events.find((e) => e.event === Event.ToolResult)!.data as {
    output: { results: unknown[] };
  };
  expect(res.output.results.length).toBe(1);
});

test("history folds a tool turn into paired assistant/tool messages", async () => {
  const a = new ConversationActor("t-tool-hist", store);
  a.appendUser("what's new");
  await a.runText("r", "m", async function* (_signal) {
    yield { kind: "text", chunk: "let me search" };
    yield { kind: "tool-call", toolCallId: "c1", toolName: "web_search", input: { query: "news" } };
    yield {
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "web_search",
      output: { results: [1] },
    };
    yield { kind: "text", chunk: "here's what I found" };
  });
  expect(await a.history()).toEqual([
    { role: "user", content: "what's new" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me search" },
        { type: "tool-call", toolCallId: "c1", toolName: "web_search", input: { query: "news" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "web_search",
          output: { type: "json", value: { results: [1] } },
        },
      ],
    },
    { role: "assistant", content: "here's what I found" },
  ]);
});

test("history drops a tool-call that has no matching result (no dangling call)", async () => {
  const a = new ConversationActor("t-tool-dangling", store);
  a.appendUser("q");
  await a.runText("r", "m", async function* (_signal) {
    yield { kind: "text", chunk: "calling" };
    yield { kind: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} };
    // no tool-result (e.g. cancelled mid-tool)
  });
  // The dangling call is dropped; the assistant turn is just its text, no tool message.
  expect(await a.history()).toEqual([
    { role: "user", content: "q" },
    { role: "assistant", content: "calling" },
  ]);
});

test("history wraps an errored tool result as error output", async () => {
  const a = new ConversationActor("t-tool-err", store);
  a.appendUser("q");
  await a.runText("r", "m", async function* (_signal) {
    yield { kind: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} };
    yield {
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "web_search",
      output: "boom",
      isError: true,
    };
    yield { kind: "text", chunk: "sorry, that failed" };
  });
  const h = await a.history();
  const toolMsg = h.find((m) => m.role === "tool") as { content: Array<{ output: unknown }> };
  expect(toolMsg.content[0]!.output).toEqual({ type: "error-text", value: "boom" });
});

test("an oversized tool output is truncated in the durable log", async () => {
  const a = new ConversationActor("t-tool-big", store);
  a.appendUser("q");
  const big = "x".repeat(40 * 1024); // > TOOL_OUTPUT_MAX (32K)
  await a.runText("r", "m", async function* (_signal) {
    yield { kind: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} };
    yield { kind: "tool-result", toolCallId: "c1", toolName: "web_search", output: big };
    yield { kind: "text", chunk: "done" };
  });
  const h = await a.history();
  const toolMsg = h.find((m) => m.role === "tool") as {
    content: Array<{ output: { value: string } }>;
  };
  const value = toolMsg.content[0]!.output.value;
  expect(value.length).toBeLessThan(big.length);
  expect(value).toContain("truncated");
  // A small result is left untouched (verified above); truncation only kicks in past the cap.
});

test("history echoes a signed reasoning block back as a reasoning part before its tool call", async () => {
  const a = new ConversationActor("t-reason-sig", store);
  a.appendUser("q");
  const opts = { anthropic: { signature: "sig-abc" } };
  await a.runText("r", "m", async function* (_signal) {
    yield { kind: "reasoning", chunk: "let me " };
    yield { kind: "reasoning", chunk: "think" };
    yield { kind: "reasoning-signature", providerOptions: opts };
    yield { kind: "tool-call", toolCallId: "c1", toolName: "web_search", input: { query: "x" } };
    yield { kind: "tool-result", toolCallId: "c1", toolName: "web_search", output: { r: 1 } };
    yield { kind: "text", chunk: "answer" };
  });
  const h = await a.history();
  const asst = h.find((m) => m.role === "assistant" && Array.isArray(m.content)) as {
    content: Array<{ type: string; text?: string; providerOptions?: unknown; toolCallId?: string }>;
  };
  expect(asst.content[0]).toEqual({
    type: "reasoning",
    text: "let me think",
    providerOptions: opts,
  });
  expect(asst.content[1]).toMatchObject({ type: "tool-call", toolCallId: "c1" });
});

test("history drops unsigned reasoning (only signed thinking is echoed)", async () => {
  const a = new ConversationActor("t-reason-unsigned", store);
  a.appendUser("q");
  await a.runText("r", "m", async function* (_signal) {
    yield { kind: "reasoning", chunk: "thinking with no signature" };
    yield { kind: "text", chunk: "answer" };
  });
  expect(await a.history()).toEqual([
    { role: "user", content: "q" },
    { role: "assistant", content: "answer" },
  ]);
});

test("reclaim: completed tools stay paired in history; an in-flight one is dropped", async () => {
  // A run that finished tool A (call + result persisted) then "crashed" during
  // tool B (call persisted, result never). This is exactly the log a reclaim
  // replays from.
  const a = new ConversationActor("t-reclaim", store);
  a.appendUser("do two things");
  await a.runText("r", "m", async function* (_signal) {
    yield {
      kind: "tool-call",
      toolCallId: "A",
      toolName: "run_shell",
      input: { command: "echo a" },
    };
    yield { kind: "tool-result", toolCallId: "A", toolName: "run_shell", output: "a done" };
    yield {
      kind: "tool-call",
      toolCallId: "B",
      toolName: "run_shell",
      input: { command: "echo b" },
    };
    // no result for B — the crash point
  });

  // history() is what a reclaimed job feeds back to the model.
  const h = await a.history();
  const flat = JSON.stringify(h);
  // A is a complete pair → the resumed model sees it and will NOT re-issue it.
  expect(flat).toContain('"toolCallId":"A"');
  expect(flat).toContain('"type":"tool-result"');
  expect(flat).toContain("a done");
  // B is unpaired → dropped, so the model re-issues it. The in-flight tool is
  // the ONLY thing that re-runs on reclaim; every completed tool is preserved.
  expect(flat).not.toContain('"toolCallId":"B"');
});
