import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
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
