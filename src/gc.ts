import type { BlobStore } from "./blobs";
import type { Store } from "./store";

/**
 * Deletes blobs that no conversation references and that are older than the
 * grace window, reclaiming both the bytes and the metadata row. Returns the
 * sha256s collected.
 *
 * Order matters for crash-safety: the bytes go first, then the row. A crash in
 * between leaves the row as a retry marker (the next sweep re-collects it),
 * never a byte with no record. The sweep is idempotent, so running it in one
 * process (or repeatedly) is safe.
 *
 * Until attachments/artifacts populate `blob_refs`, every blob is unreferenced,
 * so this reclaims stray uploads — e.g. a file staged but whose prompt was
 * never sent — once they age past the grace window.
 */
export async function sweepOrphanBlobs(
  store: Store,
  blobs: BlobStore,
  graceMs: number,
): Promise<string[]> {
  const olderThan = Date.now() - graceMs;
  const orphans = store.findOrphanBlobs(olderThan);
  const collected: string[] = [];
  for (const sha256 of orphans) {
    await blobs.delete(sha256); // bytes first…
    store.deleteBlob(sha256); // …then the row
    collected.push(sha256);
  }
  return collected;
}
