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
