import { expect, test } from "bun:test";
import { Store } from "../src/store";

/**
 * A finished `deep_research` run, as the actor logs it: the document rides the
 * progress channel (durable, rendered, never sent to a model) rather than the
 * tool result. These are the read side of that.
 */
function seedDocument(
  store: Store,
  conv: string,
  seq: number,
  filename: string,
  title: string,
  report: string,
): void {
  const db = (
    store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }
  ).db;
  db.query("INSERT OR IGNORE INTO conversations (id, created_at, last_seq) VALUES (?, ?, 0)").run(
    conv,
    Date.now(),
  );
  db.query(
    "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES (?, ?, ?, 'tool-progress', ?, ?)",
  ).run(
    `${conv}:${seq}`,
    conv,
    seq,
    JSON.stringify({
      threadId: conv,
      toolName: "deep_research",
      phase: "done",
      data: { filename, title, report },
    }),
    Date.now() + seq,
  );
}

test("a document written to the log can be read back by name", () => {
  const store = new Store(":memory:");
  seedDocument(store, "c1", 1, "funding.md", "How it's funded", "# Funding\n\nThe body.");
  expect(store.readArtifact("c1", "funding.md")).toBe("# Funding\n\nThe body.");
  expect(store.listArtifacts("c1")).toEqual([
    { filename: "funding.md", title: "How it's funded", at: expect.any(Number) },
  ]);
});

test("documents are scoped to their conversation", () => {
  const store = new Store(":memory:");
  seedDocument(store, "c1", 1, "a.md", "A", "body a");
  seedDocument(store, "c2", 1, "b.md", "B", "body b");
  expect(store.readArtifact("c1", "b.md")).toBeNull();
  expect(store.listArtifacts("c2").map((a) => a.filename)).toEqual(["b.md"]);
});

test("a name rewritten later reads as one document, at its newest", () => {
  const store = new Store(":memory:");
  seedDocument(store, "c1", 1, "report.md", "Draft", "first pass");
  seedDocument(store, "c1", 2, "report.md", "Final", "second pass");
  expect(store.readArtifact("c1", "report.md")).toBe("second pass");
  expect(store.listArtifacts("c1")).toHaveLength(1);
  expect(store.listArtifacts("c1")[0]?.title).toBe("Final");
});

test("an unknown name reads as absent, not as an error", () => {
  const store = new Store(":memory:");
  expect(store.readArtifact("c1", "nope.md")).toBeNull();
  expect(store.listArtifacts("c1")).toEqual([]);
});

test("progress events that aren't documents are ignored", () => {
  const store = new Store(":memory:");
  const db = (
    store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }
  ).db;
  db.query("INSERT INTO conversations (id, created_at, last_seq) VALUES ('c1', ?, 0)").run(
    Date.now(),
  );
  // A `read` phase — hundreds of these per run, none of them a document.
  db.query(
    "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES ('c1:1','c1',1,'tool-progress',?,?)",
  ).run(
    JSON.stringify({ threadId: "c1", phase: "read", data: { url: "https://a.test" } }),
    Date.now(),
  );
  expect(store.listArtifacts("c1")).toEqual([]);
});
