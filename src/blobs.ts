import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { S3Client } from "bun";
import { type Config, getConfig } from "./settings";

/**
 * Content-addressed blob storage — the byte layer behind attachments and agent
 * artifacts (see spec "Tools, attachments, thinking & sandboxing"). Keys are the
 * sha256 of the content, so the store is immutable, self-deduplicating (writing
 * the same bytes twice is a no-op), and safe to cache forever. Metadata (mime,
 * refcounts) is NOT here — it lives in `Store`; this layer is bytes only, so the
 * backend is swappable (a local-fs default now, a self-hosted S3 backend at
 * multi-node) without touching the metadata/GC bookkeeping.
 */

/** The identity of a stored blob: its content hash and byte length. */
export interface BlobRef {
  sha256: string;
  size: number;
}

/** Anything a caller can hand `put` — a stream (uploads) or in-memory bytes. */
export type BlobInput = ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | Blob;

export interface BlobStore {
  /** Streams-and-hashes the input, stores it under its sha256, returns the ref. */
  put(input: BlobInput): Promise<BlobRef>;
  /** The bytes as a Blob (Response-ready, streaming), or null if absent. */
  get(sha256: string): Promise<Blob | null>;
  exists(sha256: string): Promise<boolean>;
  /** Idempotent: deleting an absent blob is a no-op, not an error. */
  delete(sha256: string): Promise<void>;
}

/** A 64-char lowercase hex sha256 — the only thing we'll build a path from. */
function isSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Normalizes any BlobInput to an async iterable of byte chunks for hashing. */
async function* chunks(input: BlobInput): AsyncGenerator<Uint8Array> {
  if (input instanceof ReadableStream) {
    yield* input as unknown as AsyncIterable<Uint8Array>;
  } else if (input instanceof Blob) {
    yield* input.stream() as unknown as AsyncIterable<Uint8Array>;
  } else if (input instanceof Uint8Array) {
    yield input;
  } else {
    yield new Uint8Array(input);
  }
}

/**
 * Filesystem-backed store: bytes live at `<root>/<ab>/<rest-of-sha>`, sharded by
 * the first byte so one directory never holds the whole corpus. Writes go to a
 * temp file first and are atomically renamed into place once the hash is known,
 * so a crash mid-write can't leave a truncated blob at a valid content address.
 */
export class FsBlobStore implements BlobStore {
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(root: string = "data/blobs") {
    this.root = root;
    this.tmpDir = join(root, "tmp");
    mkdirSync(this.tmpDir, { recursive: true });
  }

  /** `<root>/<first-byte>/<remaining-hex>` — assumes `sha256` is validated. */
  private pathFor(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256.slice(2));
  }

  async put(input: BlobInput): Promise<BlobRef> {
    const hasher = new Bun.CryptoHasher("sha256");
    const tmp = join(this.tmpDir, randomUUID());
    const writer = Bun.file(tmp).writer();
    let size = 0;
    try {
      for await (const chunk of chunks(input)) {
        hasher.update(chunk);
        size += chunk.byteLength;
        writer.write(chunk);
      }
      await writer.end();
      const sha256 = hasher.digest("hex");
      const dest = this.pathFor(sha256);
      // Content-addressed: identical bytes always hash to the same path, so if
      // it's already there the upload is a dedup — drop the temp and return.
      if (await Bun.file(dest).exists()) {
        await unlink(tmp).catch(() => {});
        return { sha256, size };
      }
      mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
      await rename(tmp, dest); // same filesystem → atomic publish
      return { sha256, size };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async get(sha256: string): Promise<Blob | null> {
    if (!isSha256(sha256)) return null;
    const file = Bun.file(this.pathFor(sha256));
    return (await file.exists()) ? file : null;
  }

  async exists(sha256: string): Promise<boolean> {
    if (!isSha256(sha256)) return false;
    return Bun.file(this.pathFor(sha256)).exists();
  }

  async delete(sha256: string): Promise<void> {
    if (!isSha256(sha256)) return;
    await unlink(this.pathFor(sha256)).catch(() => {});
  }
}

/** Options for the S3 backend. Omitted credentials fall back to Bun's env. */
export interface S3BlobStoreOptions {
  /** Inject a pre-built client (tests); otherwise one is built from the rest. */
  client?: S3Client;
  /** Key prefix so blobs don't collide with other bucket contents. */
  prefix?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  virtualHostedStyle?: boolean;
}

/**
 * S3-compatible backend — self-hosted (Garage/MinIO/SeaweedFS) or any provider,
 * over Bun's native `S3Client` (no `aws-sdk`). Credentials come from explicit
 * options or, when omitted, the `S3_*`/`AWS_*` env vars Bun reads by default.
 *
 * The write path buffers the upload to hash it (a content address needs the
 * whole content before it knows the key), which is bounded by the endpoint's
 * `MAX_BLOB_BYTES` cap — fine for attachments and artifacts. A temp-key + copy
 * streaming path is the upgrade if very large artifacts ever need it.
 *
 * `get` returns the `S3File` (a `Blob`); handing it to `new Response(...)`
 * redirects the client to a presigned URL rather than proxying bytes — free
 * serving offload, but note it sidesteps the app's own auth, so gate accordingly.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(opts: S3BlobStoreOptions = {}) {
    const { client, prefix, ...creds } = opts;
    this.prefix = prefix ?? "blobs/";
    // Drop undefined so an unset option doesn't clobber Bun's env fallback.
    const clean = Object.fromEntries(Object.entries(creds).filter(([, v]) => v !== undefined));
    this.client = client ?? new S3Client(clean);
  }

  /** `<prefix><first-byte>/<remaining-hex>` — assumes `sha256` is validated. */
  private keyFor(sha256: string): string {
    return `${this.prefix}${sha256.slice(0, 2)}/${sha256.slice(2)}`;
  }

  async put(input: BlobInput): Promise<BlobRef> {
    const hasher = new Bun.CryptoHasher("sha256");
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of chunks(input)) {
      hasher.update(chunk);
      size += chunk.byteLength;
      parts.push(chunk);
    }
    const sha256 = hasher.digest("hex");
    const key = this.keyFor(sha256);
    // Content-addressed: an existing key already holds identical bytes, so skip
    // the upload entirely (dedup) rather than rewriting them.
    if (!(await this.client.exists(key))) {
      await this.client.write(key, new Blob(parts));
    }
    return { sha256, size };
  }

  async get(sha256: string): Promise<Blob | null> {
    if (!isSha256(sha256)) return null;
    const file = this.client.file(this.keyFor(sha256));
    return (await file.exists()) ? file : null;
  }

  async exists(sha256: string): Promise<boolean> {
    if (!isSha256(sha256)) return false;
    return this.client.exists(this.keyFor(sha256));
  }

  async delete(sha256: string): Promise<void> {
    if (!isSha256(sha256)) return;
    await this.client.delete(this.keyFor(sha256)).catch(() => {});
  }
}

/**
 * Builds the blob store from validated config (`config.blobs`): `backend`
 * selects `fs` (root = `path`) or `s3` (creds + `prefix`, missing creds falling
 * back to Bun's `S3_*`/`AWS_*` env). The backend value is schema-validated
 * upstream, so an invalid one fails at config load, not here. This is the one
 * place the deployment picks a backend — everything else takes a `BlobStore`.
 */
export function createBlobStore(blobs: Config["blobs"] = getConfig().blobs): BlobStore {
  switch (blobs.backend) {
    case "fs":
      return new FsBlobStore(blobs.path);
    case "s3":
      return new S3BlobStore({ ...blobs.s3 });
    default:
      throw new Error(`unknown blob backend "${blobs.backend}"`);
  }
}
