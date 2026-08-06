import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../src/blobs";
import { sweepOrphanBlobs } from "../src/gc";
import { Store } from "../src/store";

let tmp: string;
let store: Store;
let blobs: FsBlobStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kloe-gc-"));
  store = new Store(join(tmp, "test.db"));
  blobs = new FsBlobStore(join(tmp, "blobs"));
});
afterEach(() => {
  store.db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Stores bytes + metadata and backdates the row so it's past any grace window. */
async function putAged(text: string, createdAt = 0): Promise<string> {
  const ref = await blobs.put(new TextEncoder().encode(text));
  store.recordBlob(ref.sha256, "text/plain", ref.size);
  store.db.prepare("UPDATE blobs SET created_at = ? WHERE sha256 = ?").run(createdAt, ref.sha256);
  return ref.sha256;
}

test("sweep collects an unreferenced, aged blob — bytes and row both go", async () => {
  const sha = await putAged("orphan");
  const collected = await sweepOrphanBlobs(store, blobs, 1000);
  expect(collected).toEqual([sha]);
  expect(await blobs.exists(sha)).toBe(false);
  expect(store.getBlob(sha)).toBeUndefined();
});

test("sweep spares a blob still within the grace window", async () => {
  const ref = await blobs.put(new TextEncoder().encode("fresh"));
  store.recordBlob(ref.sha256, "text/plain", ref.size); // created_at = now
  const collected = await sweepOrphanBlobs(store, blobs, 60_000);
  expect(collected).toEqual([]);
  expect(await blobs.exists(ref.sha256)).toBe(true);
});

test("sweep spares a referenced blob however old it is", async () => {
  const sha = await putAged("referenced");
  store.db.prepare("INSERT INTO blob_refs (sha256, conversation_id) VALUES (?, ?)").run(sha, "c1");
  const collected = await sweepOrphanBlobs(store, blobs, 1000);
  expect(collected).toEqual([]);
  expect(await blobs.exists(sha)).toBe(true);
  expect(store.getBlob(sha)).toBeDefined();
});

test("a blob still referenced by ONE conversation survives (dedup safety)", async () => {
  const sha = await putAged("shared");
  // Two conversations referenced it; one is deleted (its ref removed).
  store.db.prepare("INSERT INTO blob_refs (sha256, conversation_id) VALUES (?, ?)").run(sha, "c1");
  store.db.prepare("INSERT INTO blob_refs (sha256, conversation_id) VALUES (?, ?)").run(sha, "c2");
  store.db.prepare("DELETE FROM blob_refs WHERE conversation_id = ?").run("c1");
  const collected = await sweepOrphanBlobs(store, blobs, 1000);
  expect(collected).toEqual([]); // c2 still holds it
  expect(await blobs.exists(sha)).toBe(true);
});
