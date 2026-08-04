import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsBlobStore, S3BlobStore, createBlobStore } from "../src/blobs";

let root: string;
let blobs: FsBlobStore;

// sha256("hello") — the fixed content address we assert against, so a broken
// hasher or a path bug shows up as a mismatch rather than passing silently.
const HELLO = "hello";
const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kloe-blobs-"));
  blobs = new FsBlobStore(root);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("put returns the content's sha256 and byte length", async () => {
  const ref = await blobs.put(new TextEncoder().encode(HELLO));
  expect(ref.sha256).toBe(HELLO_SHA);
  expect(ref.size).toBe(5);
});

test("get returns the exact bytes back", async () => {
  const ref = await blobs.put(new TextEncoder().encode(HELLO));
  const blob = await blobs.get(ref.sha256);
  expect(blob).not.toBeNull();
  expect(await blob!.text()).toBe(HELLO);
});

test("hashes a streamed upload the same as in-memory bytes", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("hel"));
      c.enqueue(new TextEncoder().encode("lo"));
      c.close();
    },
  });
  const ref = await blobs.put(stream);
  expect(ref.sha256).toBe(HELLO_SHA);
  expect(ref.size).toBe(5);
});

test("identical bytes dedup to a single stored file", async () => {
  const bytes = new TextEncoder().encode("dedup me");
  const a = await blobs.put(bytes);
  const b = await blobs.put(bytes);
  expect(b.sha256).toBe(a.sha256);
  const shardDir = join(root, a.sha256.slice(0, 2));
  expect(readdirSync(shardDir)).toHaveLength(1);
});

test("exists reflects presence; delete is idempotent", async () => {
  const ref = await blobs.put(new TextEncoder().encode("transient"));
  expect(await blobs.exists(ref.sha256)).toBe(true);
  await blobs.delete(ref.sha256);
  expect(await blobs.exists(ref.sha256)).toBe(false);
  await blobs.delete(ref.sha256); // second delete must not throw
});

test("a malformed sha256 never touches the filesystem", async () => {
  // Path-traversal / junk keys resolve to nothing rather than escaping root.
  expect(await blobs.get("../../etc/passwd")).toBeNull();
  expect(await blobs.exists("not-a-hash")).toBe(false);
  await blobs.delete("../../etc/passwd"); // no throw, no escape
});

// ---- factory (backend selection) ---------------------------------------
test("createBlobStore defaults to the fs backend", () => {
  const prev = process.env.KLOE_BLOB_BACKEND;
  delete process.env.KLOE_BLOB_BACKEND;
  try {
    expect(createBlobStore()).toBeInstanceOf(FsBlobStore);
    process.env.KLOE_BLOB_BACKEND = "fs";
    expect(createBlobStore()).toBeInstanceOf(FsBlobStore);
  } finally {
    if (prev === undefined) delete process.env.KLOE_BLOB_BACKEND;
    else process.env.KLOE_BLOB_BACKEND = prev;
  }
});

test("createBlobStore rejects an unknown backend", () => {
  const prev = process.env.KLOE_BLOB_BACKEND;
  process.env.KLOE_BLOB_BACKEND = "gopher";
  try {
    expect(() => createBlobStore()).toThrow(/unknown KLOE_BLOB_BACKEND/);
  } finally {
    if (prev === undefined) delete process.env.KLOE_BLOB_BACKEND;
    else process.env.KLOE_BLOB_BACKEND = prev;
  }
});

// ---- S3 backend (opt-in: needs a real S3-compatible endpoint) -----------
// Set KLOE_TEST_S3_BUCKET (+ S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY,
// or the AWS_* equivalents) to run these against MinIO/Garage/etc. Skipped otherwise
// so CI without object storage stays green.
const s3Bucket = process.env.KLOE_TEST_S3_BUCKET;

test.skipIf(!s3Bucket)("S3 backend satisfies the BlobStore contract", async () => {
  const s3 = new S3BlobStore({ bucket: s3Bucket, prefix: `kloe-test-${randomHex()}/` });
  const bytes = new TextEncoder().encode(HELLO);
  const ref = await s3.put(bytes);
  expect(ref.sha256).toBe(HELLO_SHA);
  expect(ref.size).toBe(5);
  expect(await s3.exists(ref.sha256)).toBe(true);
  const blob = await s3.get(ref.sha256);
  expect(await blob!.text()).toBe(HELLO);
  await s3.delete(ref.sha256);
  expect(await s3.exists(ref.sha256)).toBe(false);
  expect(await s3.get("not-a-hash")).toBeNull(); // guard holds across backends
});

function randomHex(): string {
  return Math.random().toString(16).slice(2, 10);
}
