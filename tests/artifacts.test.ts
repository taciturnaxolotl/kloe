import { expect, test } from "bun:test";
import { Store } from "../src/store";

/**
 * Documents a tool produced (spec, "Artifacts — the promotion path"). Bytes live
 * in the content-addressed blob store; this table is the projection that makes
 * "list this chat's documents" and "read the newest report.md" cheap.
 */
function fresh(): Store {
  return new Store(":memory:");
}
function record(store: Store, conv: string, name: string, sha256: string, title = "T"): number {
  return store.recordArtifact({
    conversationId: conv,
    name,
    sha256,
    title,
    mime: "text/markdown",
    size: 100,
    messageId: "m1",
  });
}

test("a recorded document is listed at version 1", () => {
  const store = fresh();
  expect(record(store, "c1", "funding.md", "a".repeat(64), "How it's funded")).toBe(1);
  const [doc] = store.listArtifacts("c1");
  expect(doc).toMatchObject({
    name: "funding.md",
    version: 1,
    versions: 1,
    title: "How it's funded",
    mime: "text/markdown",
  });
});

test("writing the same name again is a new version, and the newest wins", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64), "Draft");
  expect(record(store, "c1", "report.md", "b".repeat(64), "Final")).toBe(2);
  // One document, two revisions — not two documents.
  const list = store.listArtifacts("c1");
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ version: 2, versions: 2, title: "Final" });
  expect(store.getArtifact("c1", "report.md")?.sha256).toBe("b".repeat(64));
});

test("history is readable by version", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64), "Draft");
  record(store, "c1", "report.md", "b".repeat(64), "Final");
  expect(store.getArtifact("c1", "report.md", 1)?.title).toBe("Draft");
  expect(store.artifactVersions("c1", "report.md").map((v) => v.version)).toEqual([2, 1]);
  expect(store.getArtifact("c1", "report.md", 9)).toBeNull();
});

test("identical bytes are the same document written twice, not a new version", () => {
  // Content addressing makes this free, and it matters: a rerun that reaches the
  // same answer shouldn't manufacture history.
  const store = fresh();
  const sha = "a".repeat(64);
  expect(record(store, "c1", "report.md", sha)).toBe(1);
  expect(record(store, "c1", "report.md", sha)).toBe(1);
  expect(store.artifactVersions("c1", "report.md")).toHaveLength(1);
});

test("documents are scoped to their conversation", () => {
  const store = fresh();
  record(store, "c1", "a.md", "a".repeat(64));
  record(store, "c2", "b.md", "b".repeat(64));
  expect(store.getArtifact("c1", "b.md")).toBeNull();
  expect(store.listArtifacts("c2").map((a) => a.name)).toEqual(["b.md"]);
});

test("an empty conversation has no documents", () => {
  const store = fresh();
  expect(store.listArtifacts("c1")).toEqual([]);
  expect(store.getArtifact("c1", "nope.md")).toBeNull();
});

test("different names in one conversation are different documents", () => {
  const store = fresh();
  record(store, "c1", "a.md", "a".repeat(64));
  record(store, "c1", "b.md", "b".repeat(64));
  expect(
    store
      .listArtifacts("c1")
      .map((a) => a.name)
      .sort(),
  ).toEqual(["a.md", "b.md"]);
});

test("the sandbox sees one list of files: attachments and documents alike", () => {
  // The spec's rule is that agent output shares the store with user uploads, so
  // "open the PDF from turn 1" and "reuse the report from turn 3" are the same
  // operation on the same kind of handle.
  const store = fresh();
  const db = (
    store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }
  ).db;
  db.query("INSERT INTO conversations (id, created_at, last_seq) VALUES ('c1', ?, 0)").run(
    Date.now(),
  );
  db.query(
    "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES ('c1:1','c1',1,'user-message',?,?)",
  ).run(
    JSON.stringify({
      content: "have a look",
      attachments: [{ sha256: "d".repeat(64), name: "budget.csv", mime: "text/csv", kind: "file" }],
    }),
    Date.now(),
  );
  record(store, "c1", "report.md", "e".repeat(64));

  const files = store.listFiles("c1");
  expect(files).toEqual([
    { name: "budget.csv", sha256: "d".repeat(64), mime: "text/csv", kind: "attachment" },
    { name: "report.md", sha256: "e".repeat(64), mime: "text/markdown", kind: "document" },
  ]);
});

test("a conversation with no files lists none", () => {
  expect(fresh().listFiles("c1")).toEqual([]);
});

// ---- publishing ------------------------------------------------------------

test("publishing mints one link per DOCUMENT, and publishing again re-points it", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64), "Draft");
  record(store, "c1", "report.md", "b".repeat(64), "Final");

  const first = store.publish("c1", "report.md", 2)!;
  expect(first.token).toMatch(/^[0-9a-f]{32}$/);
  expect(first).toMatchObject({ mode: "pinned", version: 2, sha256: "b".repeat(64) });

  // Publishing an older version moves the SAME link rather than minting a
  // second one: a document is public in one way at a time.
  const repinned = store.publish("c1", "report.md", 1)!;
  expect(repinned.token).toBe(first.token);
  expect(repinned).toMatchObject({ version: 1, sha256: "a".repeat(64) });
  expect(store.publicationFor("c1", "report.md")!.token).toBe(first.token);
});

test("a pinned link keeps serving what was shared; a following one moves on", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64), "Draft");

  const pinned = store.publish("c1", "report.md", 1, "pinned")!;
  record(store, "c1", "report.md", "b".repeat(64), "Rewritten");
  expect(store.getPublication(pinned.token)).toMatchObject({
    version: 1,
    sha256: "a".repeat(64),
    title: "Draft",
  });

  // Same token, different contract: the link now resolves at read time.
  const live = store.publish("c1", "report.md", 1, "latest")!;
  expect(live.token).toBe(pinned.token);
  expect(store.getPublication(live.token)).toMatchObject({
    version: 2,
    sha256: "b".repeat(64),
    title: "Rewritten",
  });

  // …and keeps moving as the document does.
  record(store, "c1", "report.md", "c".repeat(64), "Rewritten again");
  expect(store.getPublication(live.token)!.sha256).toBe("c".repeat(64));

  // Pinning it again freezes it where the owner chose, link intact.
  store.publish("c1", "report.md", 2, "pinned");
  expect(store.getPublication(live.token)).toMatchObject({ version: 2, sha256: "b".repeat(64) });
});

test("a version that doesn't exist cannot be published", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64));
  expect(store.publish("c1", "report.md", 7)).toBeNull();
  expect(store.publish("c1", "nope.md", 1)).toBeNull();
});

test("unpublishing needs the conversation, not just the token", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64));
  const pub = store.publish("c1", "report.md", 1)!;

  expect(store.unpublish("other", pub.token)).toBe(false);
  expect(store.getPublication(pub.token)).not.toBeNull();

  expect(store.unpublish("c1", pub.token)).toBe(true);
  expect(store.getPublication(pub.token)).toBeNull();
  expect(store.publicationFor("c1", "report.md")).toBeNull();
});

test("deleting a conversation revokes the links it published", () => {
  const store = fresh();
  record(store, "c1", "report.md", "a".repeat(64));
  const pub = store.publish("c1", "report.md", 1)!;
  store.deleteConversation("c1");
  expect(store.getPublication(pub.token)).toBeNull();
});
