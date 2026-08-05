import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { buildSession } from "../src/ingest";

// Insert raw events (bypassing the actor) so the fold can be tested directly.
function seed(store: Store, id: string, events: Array<[string, unknown]>): void {
  const ins = (store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db.query(
    "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let seq = 0;
  const t0 = 1_700_000_000_000;
  for (const [event, data] of events) {
    ins.run(`${id}:${seq}`, id, seq, event, JSON.stringify(data), t0 + seq * 1000);
    seq++;
  }
}

test("buildSession sends user turns only (lard ignores assistant text)", () => {
  const store = new Store(":memory:");
  seed(store, "c1", [
    ["user-message", { content: "who is kieran?" }],
    ["message-start", {}],
    ["text-delta", { delta: "Kieran is " }],
    ["text-delta", { delta: "a developer." }],
    ["message-end", { finishReason: "stop" }],
    ["user-message", { content: "thanks" }],
  ]);
  const s = buildSession(store, "c1");
  expect(s).not.toBeNull();
  expect(s!.sessionId).toBe("c1");
  expect(s!.source).toBe("kloe");
  expect(s!.turns.map((t) => [t.role, t.content])).toEqual([
    ["user", "who is kieran?"],
    ["user", "thanks"], // assistant turn is dropped
  ]);
  expect(s!.turns.map((t) => t.index)).toEqual([0, 1]);
  expect(typeof s!.turns[0]!.ts).toBe("string"); // ISO timestamp
});

test("buildSession returns null with nothing to ingest", () => {
  const store = new Store(":memory:");
  expect(buildSession(store, "empty")).toBeNull();
  // an assistant message with no text (e.g. a cancelled run) is not a turn
  seed(store, "c2", [
    ["message-start", {}],
    ["message-end", { finishReason: "aborted" }],
  ]);
  expect(buildSession(store, "c2")).toBeNull();
});

test("buildSession skips empty user messages", () => {
  const store = new Store(":memory:");
  seed(store, "c3", [
    ["user-message", { content: "   " }],
    ["user-message", { content: "real question" }],
  ]);
  const s = buildSession(store, "c3");
  expect(s!.turns).toHaveLength(1);
  expect(s!.turns[0]!.content).toBe("real question");
});
