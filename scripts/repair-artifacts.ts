/*
 * One-off repairs for documents written before the artifact design settled.
 *
 * Two faults, both invisible until you open the document:
 *
 *   1. Early `deep_research` runs put the report inline in a `tool-progress`
 *      event and nowhere else — no blob, no reference, no projection row — so it
 *      renders nothing and can't be listed or read back.
 *   2. Citation markers were written `[[n]](url)`. Balanced brackets in link text
 *      are valid CommonMark but streaming-markdown doesn't implement them, so
 *      every marker rendered as "[1" followed by a raw URL in the prose.
 *
 * The second repair rewrites bytes, which content addressing means is really a
 * NEW blob: the fixed text is stored, the artifact row and the tool-result event
 * are repointed at it, and the superseded blob's reference is dropped so the
 * orphan sweep can reclaim it. Repointing the event is a deliberate exception to
 * "the log is authoritative" — the alternative is a thread that keeps opening a
 * broken copy forever, and the bytes are the same document either way.
 *
 * Not repaired: reports with no citations at all. Those predate the citation
 * fix, and which sentence came from which source is not recoverable.
 *
 * Idempotent. Safe to run twice.
 *
 *   bun run scripts/repair-artifacts.ts          # report what it would do
 *   bun run scripts/repair-artifacts.ts --write  # actually do it
 */
import { createBlobStore } from "../src/blobs";
import { Store } from "../src/store";

const write = process.argv.includes("--write");
const store = new Store();
const blobs = createBlobStore();
const say = (s: string) => console.log(s);

// ---- 1. promote reports that only ever lived in the event log --------------
const inline = store.db
  .prepare(
    `SELECT conversation_id, data FROM events
      WHERE event = 'tool-progress'
        AND json_extract(data, '$.phase') = 'done'
        AND json_extract(data, '$.data.report') IS NOT NULL
      ORDER BY seq ASC`,
  )
  .all() as Array<{ conversation_id: string; data: string }>;

let promoted = 0;
for (const row of inline) {
  const payload = JSON.parse(row.data) as {
    messageId?: string;
    data?: { report?: string; filename?: string; title?: string };
  };
  const d = payload.data ?? {};
  if (!d.report || !d.filename) continue;
  if (store.getArtifact(row.conversation_id, d.filename)) continue; // already a document
  if (!write) {
    say(`would promote ${d.filename} (${d.report.length} chars)`);
    promoted++;
    continue;
  }
  const ref = await blobs.put(new TextEncoder().encode(d.report));
  store.recordBlob(ref.sha256, "text/markdown", ref.size);
  store.addBlobRef(ref.sha256, row.conversation_id);
  const version = store.recordArtifact({
    conversationId: row.conversation_id,
    name: d.filename,
    sha256: ref.sha256,
    title: d.title,
    mime: "text/markdown",
    size: ref.size,
    messageId: payload.messageId,
  });
  say(`promoted ${d.filename} v${version}`);
  promoted++;
}

// ---- 2. rewrite unparseable citation markers -------------------------------
const NESTED = /\[\[(\d+)\]\]\(/g;
const docs = store.db
  .prepare("SELECT conversation_id, name, version, sha256 FROM artifacts")
  .all() as Array<{ conversation_id: string; name: string; version: number; sha256: string }>;

let fixed = 0;
for (const doc of docs) {
  const blob = await blobs.get(doc.sha256);
  if (!blob) continue;
  const text = await blob.text();
  const count = (text.match(NESTED) ?? []).length;
  if (!count) continue;
  if (!write) {
    say(`would fix ${count} marker(s) in ${doc.name} v${doc.version}`);
    fixed++;
    continue;
  }
  const repaired = text.replace(NESTED, "[$1](");
  const ref = await blobs.put(new TextEncoder().encode(repaired));
  store.recordBlob(ref.sha256, "text/markdown", ref.size);
  store.addBlobRef(ref.sha256, doc.conversation_id);
  store.db
    .prepare(
      "UPDATE artifacts SET sha256 = ?, size = ? WHERE conversation_id = ? AND name = ? AND version = ?",
    )
    .run(ref.sha256, ref.size, doc.conversation_id, doc.name, doc.version);
  // Repoint the thread's own card, then release the superseded bytes.
  store.db
    .prepare(
      `UPDATE events
          SET data = replace(data, ?, ?)
        WHERE conversation_id = ? AND event = 'tool-result' AND data LIKE ?`,
    )
    .run(doc.sha256, ref.sha256, doc.conversation_id, `%${doc.sha256}%`);
  store.db
    .prepare("DELETE FROM blob_refs WHERE sha256 = ? AND conversation_id = ?")
    .run(doc.sha256, doc.conversation_id);
  say(`fixed ${count} marker(s) in ${doc.name} v${doc.version}`);
  fixed++;
}

say(
  `\n${promoted} promoted · ${fixed} document(s) with markers repaired` +
    (write ? "" : "\n(dry run — pass --write to apply)"),
);
