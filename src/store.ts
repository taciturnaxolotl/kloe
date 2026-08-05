import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "./settings";
import type { AttachmentRef } from "./events";

export interface JobRow {
  id: string;
  conversation_id: string;
  status: "queued" | "running" | "done" | "failed";
  lease_until: number;
  checkpoint_seq: number;
  params: string;
  /** ms epoch when the job was enqueued — for measuring queue-wait latency. */
  created_at: number;
}

export interface RunJobParams {
  /** Absent for plain runs; present as `"flush"` on steer-queue flush jobs. */
  kind?: undefined;
  conversationId: string;
  runId: string;
  messageId: string;
  prompt: string;
  model: string;
}

/**
 * A flush job: no prompt of its own. At claim time the driver promotes the
 * conversation's pending steer queue and runs it as one batched generation.
 */
export interface FlushJobParams {
  kind: "flush";
  conversationId: string;
}

export type JobParams = RunJobParams | FlushJobParams;

/** A steered message still waiting to be flushed into a run. */
export interface PendingMessage {
  runId: string;
  content: string;
  model: string;
  attachments?: AttachmentRef[];
}

/**
 * Decodes a job's params blob — the inverse of `enqueue`, and the only place
 * job params are parsed. Rows without a `kind` are plain runs (the original
 * shape); `kind: "flush"` marks a steer-queue flush. Throws on a corrupt or
 * incomplete row; callers mark the job failed rather than re-claiming it
 * forever.
 */
export function parseJobParams(params: string): JobParams {
  const p = JSON.parse(params) as Record<string, unknown>;
  if (p.kind === "flush") {
    if (typeof p.conversationId !== "string") {
      throw new Error('malformed job params: bad or missing "conversationId"');
    }
    return { kind: "flush", conversationId: p.conversationId };
  }
  for (const key of ["conversationId", "runId", "messageId", "prompt", "model"] as const) {
    if (typeof p[key] !== "string") {
      throw new Error(`malformed job params: bad or missing "${key}"`);
    }
  }
  // Rebuild the object explicitly (rather than casting the blob) so a change to
  // RunJobParams' shape is a compile error here, not a silent mismatch.
  return {
    conversationId: p.conversationId as string,
    runId: p.runId as string,
    messageId: p.messageId as string,
    prompt: p.prompt as string,
    model: p.model as string,
  };
}

export interface StoredEvent {
  seq: number;
  event: string;
  data: unknown;
}

/** Metadata for a stored blob (bytes live in the BlobStore, keyed by sha256). */
export interface BlobMeta {
  sha256: string;
  mime: string;
  size: number;
  createdAt: number;
}

interface BlobRow {
  sha256: string;
  mime: string;
  size: number;
  created_at: number;
}

/** A conversation as shown in the chat rail: id, age, and a derived title. */
export interface ConversationSummary {
  id: string;
  createdAt: number;
  /** Time of the newest event (falls back to createdAt) — for the "last active" date. */
  updatedAt: number;
  lastSeq: number;
  /** First user message, truncated — null for a conversation with no prompt yet. */
  title: string | null;
}

/** A project groups conversations and pins shared context (a lard memory project). */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Pinned lard memory project id (scopes context + ingest). */
  lardProject?: string;
  createdAt: number;
  updatedAt: number;
}

/** A project as shown in the gallery — with a count of its conversations. */
export interface ProjectSummary extends Project {
  chatCount: number;
}

/** A project context file's metadata (no body). */
export interface ContextFileMeta {
  id: string;
  filename: string;
  lines: number;
  chars: number;
  createdAt: number;
}

/** A search hit: a conversation plus an excerpt of the matching message. */
export interface ConversationSearchResult extends ConversationSummary {
  /** Text around the match (title match → excerpt of the first message). */
  snippet: string | null;
}

/** The row shape returned by the conversation-list / search queries. */
interface ConversationRow {
  id: string;
  created_at: number;
  last_activity: number;
  last_seq: number;
  first_user: string | null;
  custom_title: string | null;
}

function rowToSummary(r: ConversationRow): ConversationSummary {
  let title: string | null = null;
  // A user-set title wins; otherwise derive from the first message.
  if (typeof r.custom_title === "string" && r.custom_title.trim() !== "") {
    title = r.custom_title;
  } else if (r.first_user) {
    try {
      const content = (JSON.parse(r.first_user) as { content?: string }).content;
      if (typeof content === "string") title = content.slice(0, 80);
    } catch {
      // malformed row: leave title null rather than crash the list
    }
  }
  return { id: r.id, createdAt: r.created_at, updatedAt: r.last_activity, lastSeq: r.last_seq, title };
}

/** Escapes LIKE wildcards so a user query matches literally (paired with ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A short excerpt of `text` centered on the first (case-insensitive) hit of `query`. */
function snippetAround(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i === -1) return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  const start = Math.max(0, i - 30);
  const end = Math.min(text.length, i + query.length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Curation of a model for the chat UI. Opt-in: a model with no row (or
 * `visible: false`) is hidden from the chat picker. `displayName` overrides the
 * catalog name; `sortOrder` controls ordering in the picker.
 */
export interface ModelSetting {
  ref: string;
  visible: boolean;
  displayName: string | null;
  sortOrder: number;
}

interface ModelSettingRow {
  model_ref: string;
  visible: number;
  display_name: string | null;
  sort_order: number;
}

function rowToSetting(r: ModelSettingRow): ModelSetting {
  return {
    ref: r.model_ref,
    visible: r.visible === 1,
    displayName: r.display_name,
    sortOrder: r.sort_order,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  custom_title TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_conv_seq
  ON events (conversation_id, seq);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  lease_until INTEGER NOT NULL DEFAULT 0,
  checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS model_settings (
  model_ref TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Blob metadata (the bytes live in the BlobStore, keyed by sha256). Content-
-- addressed, so a row is immutable once written; mime/size come from the upload.
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Which conversations reference which blobs. Populated when attachments/artifacts
-- land in the event log (a later slice); a blob with no row here is unreferenced
-- and, past the grace window, GC-eligible. Content-addressed dedup means a blob
-- can have rows from several conversations — the sweep collects only zero-ref ones.
CREATE TABLE IF NOT EXISTS blob_refs (
  sha256 TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  PRIMARY KEY (sha256, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_blob_refs_conv ON blob_refs (conversation_id);

-- Auth sessions (indiko OAuth). The cookie holds an opaque high-entropy id; the
-- row carries the user's identity (sub) and cached profile JSON. Expired rows
-- are swept periodically. Only used when auth is enabled.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Projects group conversations and carry shared context. A project is owned by
-- one kloe user, optionally pins a lard memory project, and its conversations
-- reference it via conversations.project_id (nullable — "unfiled" chats).
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  owner_sub    TEXT,
  lard_project TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Context files attached to a project: hand-authored text (markdown) injected
-- into every chat in the project. Small text bodies stored inline (no blob GC).
CREATE TABLE IF NOT EXISTS project_context (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  filename    TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_context ON project_context (project_id);

-- Per-user OAuth device-grant tokens for the lard memory server. One row per
-- kloe user (sub); "local" is the implicit user when kloe auth is disabled.
-- Never in the event log. access_token is refreshed lazily via refresh_token.
CREATE TABLE IF NOT EXISTS lard_tokens (
  sub           TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

/** Cached profile fields for a signed-in user (from the OAuth token response). */
export interface SessionProfile {
  name?: string;
  email?: string;
  picture?: string;
  url?: string;
}

/** A user's stored lard device-grant token. `expiresAt` is epoch ms (0 = unknown). */
export interface LardToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}
/** A live auth session: the cookie id, the user's stable subject, and profile. */
export interface Session {
  id: string;
  sub: string;
  expiresAt: number;
  profile: SessionProfile;
}

/**
 * Durable stores for one node: the append-only event log, the conversations
 * table (source of seq), and the job table (queued/running/done/failed +
 * lease/heartbeat/checkpoint).
 *
 * `bun:sqlite` is synchronous and WAL-durable; a single store is the canonical
 * reconcilable state. In-memory actors hold only the live delta tail; every
 * durable (non-delta) event is inserted synchronously before fan-out.
 */
export class Store {
  readonly db: Database;
  private readStmt: ReturnType<Database["prepare"]>;
  private insertEventStmt: ReturnType<Database["prepare"]>;
  private insertConversationStmt: ReturnType<Database["prepare"]>;
  private upsertConversationStmt: ReturnType<Database["prepare"]>;
  private enqueueStmt: ReturnType<Database["prepare"]>;
  private claimExclusiveStmt: ReturnType<Database["prepare"]>;
  private heartbeatStmt: ReturnType<Database["prepare"]>;
  private checkpointStmt: ReturnType<Database["prepare"]>;
  private reapStmt: ReturnType<Database["prepare"]>;
  private requeueStmt: ReturnType<Database["prepare"]>;
  private finishStmt: ReturnType<Database["prepare"]>;
  private listConversationsStmt: ReturnType<Database["prepare"]>;
  private searchConversationsStmt: ReturnType<Database["prepare"]>;
  private listSettingsStmt: ReturnType<Database["prepare"]>;
  private getSettingStmt: ReturnType<Database["prepare"]>;
  private upsertSettingStmt: ReturnType<Database["prepare"]>;
  private pendingQueueStmt: ReturnType<Database["prepare"]>;
  private hasPendingFlushStmt: ReturnType<Database["prepare"]>;
  private insertBlobStmt: ReturnType<Database["prepare"]>;
  private getBlobStmt: ReturnType<Database["prepare"]>;
  private findOrphanBlobsStmt: ReturnType<Database["prepare"]>;
  private deleteBlobStmt: ReturnType<Database["prepare"]>;
  private addBlobRefStmt: ReturnType<Database["prepare"]>;

  constructor(databasePath: string = getConfig().server.dbPath) {
    // Ensure the parent directory exists so a fresh checkout (where `data/` is
    // gitignored and absent) doesn't crash with SQLITE_CANTOPEN. Skipped for
    // in-memory databases, which have no filesystem path.
    if (databasePath !== ":memory:" && !databasePath.startsWith("file::memory:")) {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(SCHEMA);
    // Migration for DBs created before custom_title existed. Ignore the error
    // when the column is already present.
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN custom_title TEXT");
    } catch {
      // column already exists
    }
    // Migration for DBs created before jobs.created_at existed.
    try {
      this.db.exec("ALTER TABLE jobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    } catch {
      // column already exists
    }
    // Migration: owner_sub records which kloe user started a conversation (for
    // per-user lard identity). NULL for pre-existing rows / auth-off (→ local).
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN owner_sub TEXT");
    } catch {
      // column already exists
    }
    // Migration: which project a conversation belongs to (NULL = unfiled).
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
    } catch {
      // column already exists
    }

    this.readStmt = this.db.prepare(
      `SELECT seq, event, data FROM events
       WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC`,
    );
    this.insertEventStmt = this.db.prepare(
      `INSERT INTO events (id, conversation_id, seq, event, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.insertConversationStmt = this.db.prepare(
      `INSERT INTO conversations (id, created_at) VALUES (?, ?)`,
    );
    this.upsertConversationStmt = this.db.prepare(
      `INSERT INTO conversations (id, created_at, last_seq) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seq = excluded.last_seq`,
    );

    this.enqueueStmt = this.db.prepare(
      `INSERT INTO jobs (id, conversation_id, status, params, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    );
    // The hot claim query: queued or expired-lease jobs, but only for
    // conversations with no other live running job. Enforces the single-writer
    // invariant (one active run per conversation) atomically in SQL. Ordered by
    // `rowid` (insertion order) so a conversation's jobs claim strictly FIFO —
    // a steer's flush must never run ahead of the prompt it followed. (`id` is
    // a random UUID, so ordering by it would be nondeterministic.)
    this.claimExclusiveStmt = this.db.prepare(
      `UPDATE jobs
       SET status = 'running', lease_until = ?
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE (j.status = 'queued'
                  OR (j.status = 'running' AND j.lease_until < ?))
           AND NOT EXISTS (
             SELECT 1 FROM jobs j2
             WHERE j2.conversation_id = j.conversation_id
               AND j2.status = 'running'
               AND j2.lease_until >= ?
           )
         ORDER BY j.rowid LIMIT 1
       )
       RETURNING id, conversation_id, status, lease_until, checkpoint_seq, params, created_at`,
    );
    this.heartbeatStmt = this.db.prepare(
      `UPDATE jobs SET lease_until = ? WHERE id = ? AND status = 'running'`,
    );
    this.checkpointStmt = this.db.prepare(
      `UPDATE jobs SET checkpoint_seq = ? WHERE id = ? AND status = 'running'`,
    );
    this.reapStmt = this.db.prepare(
      `UPDATE jobs SET status = 'queued' WHERE status = 'running' AND lease_until < ?`,
    );
    this.requeueStmt = this.db.prepare(
      `UPDATE jobs SET status = 'queued', lease_until = 0 WHERE id = ?`,
    );
    this.finishStmt = this.db.prepare(
      `UPDATE jobs SET status = ?, lease_until = 0 WHERE id = ?`,
    );

    this.listConversationsStmt = this.db.prepare(
      `SELECT c.id AS id, c.created_at AS created_at, c.last_seq AS last_seq, c.custom_title AS custom_title,
              c.owner_sub AS owner_sub, c.project_id AS project_id,
              (SELECT e.data FROM events e
               WHERE e.conversation_id = c.id AND e.event = 'user-message'
               ORDER BY e.seq ASC LIMIT 1) AS first_user,
              COALESCE((SELECT MAX(e.created_at) FROM events e
                        WHERE e.conversation_id = c.id), c.created_at) AS last_activity
       FROM conversations c
       ORDER BY last_activity DESC`,
    );
    // Full-text-ish search over titles AND message contents: a conversation
    // matches when any user-message content or assistant text-delta LIKEs the
    // query. `match_text` grabs the first matching message so the UI can show an
    // excerpt of WHY it matched (title matches surface the first message).
    this.searchConversationsStmt = this.db.prepare(
      `SELECT c.id AS id, c.created_at AS created_at, c.last_seq AS last_seq, c.custom_title AS custom_title,
              c.owner_sub AS owner_sub,
              (SELECT e.data FROM events e
               WHERE e.conversation_id = c.id AND e.event = 'user-message'
               ORDER BY e.seq ASC LIMIT 1) AS first_user,
              COALESCE((SELECT MAX(e.created_at) FROM events e
                        WHERE e.conversation_id = c.id), c.created_at) AS last_activity,
              (SELECT COALESCE(json_extract(e.data, '$.content'), json_extract(e.data, '$.delta'))
               FROM events e
               WHERE e.conversation_id = c.id
                 AND ((e.event = 'user-message' AND json_extract(e.data, '$.content') LIKE ? ESCAPE '\\')
                   OR (e.event = 'text-delta'   AND json_extract(e.data, '$.delta')   LIKE ? ESCAPE '\\'))
               ORDER BY e.seq ASC LIMIT 1) AS match_text
       FROM conversations c
       WHERE c.custom_title LIKE ? ESCAPE '\\'
          OR EXISTS (
         SELECT 1 FROM events e
         WHERE e.conversation_id = c.id
           AND ((e.event = 'user-message' AND json_extract(e.data, '$.content') LIKE ? ESCAPE '\\')
             OR (e.event = 'text-delta'   AND json_extract(e.data, '$.delta')   LIKE ? ESCAPE '\\'))
       )
       ORDER BY last_activity DESC
       LIMIT 100`,
    );

    this.listSettingsStmt = this.db.prepare(
      `SELECT model_ref, visible, display_name, sort_order FROM model_settings`,
    );
    this.getSettingStmt = this.db.prepare(
      `SELECT model_ref, visible, display_name, sort_order
       FROM model_settings WHERE model_ref = ?`,
    );
    this.upsertSettingStmt = this.db.prepare(
      `INSERT INTO model_settings (model_ref, visible, display_name, sort_order)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(model_ref) DO UPDATE SET
         visible = excluded.visible,
         display_name = excluded.display_name,
         sort_order = excluded.sort_order`,
    );

    // The steer queue, derived from the log: `queued-message` events that no
    // `user-message` with the same runId has promoted yet. Single source of
    // truth — nothing to keep in sync, crash-safe by construction.
    this.pendingQueueStmt = this.db.prepare(
      `SELECT e.data FROM events e
       WHERE e.conversation_id = ? AND e.event = 'queued-message'
         AND NOT EXISTS (
           SELECT 1 FROM events u
           WHERE u.conversation_id = e.conversation_id
             AND u.event IN ('user-message', 'queued-cancelled')
             AND json_extract(u.data, '$.runId') = json_extract(e.data, '$.runId')
         )
       ORDER BY e.seq ASC`,
    );
    // Is a flush job already queued for this conversation? One flush drains
    // the whole steer queue, so a second is redundant.
    this.hasPendingFlushStmt = this.db.prepare(
      `SELECT 1 FROM jobs WHERE conversation_id = ? AND status = 'queued'
       AND json_extract(params, '$.kind') = 'flush' LIMIT 1`,
    );

    // Content-addressed, so a re-upload of identical bytes is a no-op: keep the
    // original row (and its created_at) rather than rewriting it.
    this.insertBlobStmt = this.db.prepare(
      `INSERT INTO blobs (sha256, mime, size, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(sha256) DO NOTHING`,
    );
    this.getBlobStmt = this.db.prepare(
      `SELECT sha256, mime, size, created_at FROM blobs WHERE sha256 = ?`,
    );
    // Orphans: no conversation references them and they're older than the grace
    // cutoff (so a just-uploaded, not-yet-referenced blob is spared).
    this.findOrphanBlobsStmt = this.db.prepare(
      `SELECT sha256 FROM blobs
       WHERE created_at < ?
         AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256 = blobs.sha256)`,
    );
    this.deleteBlobStmt = this.db.prepare(`DELETE FROM blobs WHERE sha256 = ?`);
    this.addBlobRefStmt = this.db.prepare(
      `INSERT INTO blob_refs (sha256, conversation_id) VALUES (?, ?)
       ON CONFLICT(sha256, conversation_id) DO NOTHING`,
    );
  }

  /**
   * All conversations, most recently active first (by newest event, so a
   * conversation that gets activity again rises to the top), each with a title
   * derived from its first user message. Used by the chat rail. The title
   * subquery pulls the earliest `user-message` event's content per conversation.
   */
  listConversations(owner?: string, projectId?: string): ConversationSummary[] {
    const rows = this.listConversationsStmt.all() as Array<ConversationRow & { owner_sub: string | null; project_id: string | null }>;
    return rows
      .filter((r) => (!owner || r.owner_sub === owner) && (projectId === undefined || r.project_id === projectId))
      .map(rowToSummary);
  }

  /**
   * Conversations whose title or any message (user prompt or assistant text)
   * contains `query`, most recently active first. Each carries a `snippet`
   * around the match. Wildcards in the query are escaped so it matches
   * literally. Capped at 100 hits.
   */
  searchConversations(query: string, owner?: string): ConversationSearchResult[] {
    const like = `%${escapeLike(query)}%`;
    const rows = this.searchConversationsStmt.all(like, like, like, like, like) as Array<
      ConversationRow & { match_text: string | null; owner_sub: string | null }
    >;
    return rows
      .filter((r) => !owner || r.owner_sub === owner)
      .map((r) => ({ ...rowToSummary(r), snippet: r.match_text ? snippetAround(r.match_text, query) : null }));
  }

  /** Sets a conversation's custom title (empty/whitespace clears it back to the derived one). */
  renameConversation(id: string, title: string): void {
    const trimmed = title.trim();
    this.db
      .prepare("UPDATE conversations SET custom_title = ? WHERE id = ?")
      .run(trimmed === "" ? null : trimmed, id);
  }

  /**
   * Permanently removes a conversation and everything scoped to it, and returns
   * the sha256s of blobs left orphaned by the removal (referenced by this
   * conversation and now by no other). The caller deletes those bytes from the
   * BlobStore, then `deleteBlob`s the rows — bytes-first, so a crash between
   * leaves the row for the periodic sweep rather than a byte with no record.
   */
  deleteConversation(id: string): string[] {
    return this.db.transaction(() => {
      // Blobs this conversation referenced — the only candidates for orphaning.
      const candidates = (
        this.db
          .prepare("SELECT DISTINCT sha256 FROM blob_refs WHERE conversation_id = ?")
          .all(id) as Array<{ sha256: string }>
      ).map((r) => r.sha256);
      this.db.prepare("DELETE FROM blob_refs WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM jobs WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      // Of those candidates, the ones no conversation references anymore.
      const stillRef = this.db.prepare("SELECT 1 FROM blob_refs WHERE sha256 = ? LIMIT 1");
      return candidates.filter((sha) => stillRef.get(sha) == null);
    })();
  }

  /** All curation rows (models with no row are hidden by default). */
  listModelSettings(): ModelSetting[] {
    return (this.listSettingsStmt.all() as ModelSettingRow[]).map(rowToSetting);
  }

  getModelSetting(ref: string): ModelSetting | undefined {
    const row = this.getSettingStmt.get(ref) as ModelSettingRow | null;
    return row ? rowToSetting(row) : undefined;
  }

  setModelSetting(s: ModelSetting): void {
    this.upsertSettingStmt.run(
      s.ref,
      s.visible ? 1 : 0,
      s.displayName,
      s.sortOrder,
    );
  }

  /**
   * Records blob metadata (mime/size) for a stored sha256. Idempotent: a
   * re-upload of the same content keeps the original row. The bytes are written
   * to the BlobStore separately; this is only the metadata index.
   */
  recordBlob(sha256: string, mime: string, size: number): void {
    this.insertBlobStmt.run(sha256, mime, size, Date.now());
  }

  /** Metadata for a stored blob, or undefined if unknown. */
  getBlob(sha256: string): BlobMeta | undefined {
    const row = this.getBlobStmt.get(sha256) as BlobRow | null;
    return row
      ? { sha256: row.sha256, mime: row.mime, size: row.size, createdAt: row.created_at }
      : undefined;
  }

  /**
   * Sha256s of blobs referenced by no conversation and created before
   * `olderThan` (ms epoch) — the GC sweep's candidate set. The bytes are
   * deleted from the BlobStore, then `deleteBlob` drops the row.
   */
  findOrphanBlobs(olderThan: number): string[] {
    return (this.findOrphanBlobsStmt.all(olderThan) as Array<{ sha256: string }>).map(
      (r) => r.sha256,
    );
  }

  /** Drops a blob's metadata row (bytes are removed from the BlobStore separately). */
  deleteBlob(sha256: string): void {
    this.deleteBlobStmt.run(sha256);
  }

  // ---- auth sessions -----------------------------------------------------

  /** Creates a session; `id` is the opaque high-entropy cookie value. */
  createSession(id: string, sub: string, profile: SessionProfile, expiresAt: number): void {
    this.db
      .query("INSERT INTO sessions (id, sub, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, sub, JSON.stringify(profile), Date.now(), expiresAt);
  }

  /** The session for a cookie id, or undefined if missing/expired (expired rows are dropped). */
  getSession(id: string): Session | undefined {
    const row = this.db.query("SELECT sub, data, expires_at FROM sessions WHERE id = ?").get(id) as
      | { sub: string; data: string; expires_at: number }
      | null;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      this.deleteSession(id);
      return undefined;
    }
    return { id, sub: row.sub, expiresAt: row.expires_at, profile: JSON.parse(row.data) as SessionProfile };
  }

  deleteSession(id: string): void {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** Drops expired sessions (periodic sweep). */
  sweepSessions(now: number = Date.now()): void {
    this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  // ---- lard device-grant tokens (per kloe user) --------------------------
  getLardToken(sub: string): LardToken | undefined {
    const row = this.db
      .query("SELECT access_token, refresh_token, expires_at FROM lard_tokens WHERE sub = ?")
      .get(sub) as { access_token: string; refresh_token: string | null; expires_at: number } | null;
    if (!row) return undefined;
    return { accessToken: row.access_token, refreshToken: row.refresh_token ?? undefined, expiresAt: row.expires_at };
  }

  setLardToken(sub: string, tok: LardToken): void {
    this.db
      .query(
        `INSERT INTO lard_tokens (sub, access_token, refresh_token, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET access_token=excluded.access_token,
           refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
      )
      .run(sub, tok.accessToken, tok.refreshToken ?? null, tok.expiresAt, Date.now());
  }

  deleteLardToken(sub: string): void {
    this.db.query("DELETE FROM lard_tokens WHERE sub = ?").run(sub);
  }

  // ---- conversation ownership --------------------------------------------
  /** Stamp who started a conversation, first writer wins (no-op without a sub). */
  setConversationOwner(id: string, sub: string | undefined): void {
    if (!sub) return;
    this.db.query("UPDATE conversations SET owner_sub = ? WHERE id = ? AND owner_sub IS NULL").run(sub, id);
  }

  /** The kloe user `sub` that owns a conversation, or undefined (auth-off / legacy). */
  getConversationOwner(id: string): string | undefined {
    const row = this.db.query("SELECT owner_sub FROM conversations WHERE id = ?").get(id) as { owner_sub: string | null } | null;
    return row?.owner_sub ?? undefined;
  }

  // ---- projects ----------------------------------------------------------
  createProject(id: string, name: string, description: string | undefined, owner: string | undefined): void {
    const now = Date.now();
    this.db
      .query("INSERT INTO projects (id, name, description, owner_sub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, description ?? null, owner ?? null, now, now);
  }

  getProject(id: string): Project | undefined {
    const r = this.db
      .query("SELECT id, name, description, lard_project, created_at, updated_at FROM projects WHERE id = ?")
      .get(id) as { id: string; name: string; description: string | null; lard_project: string | null; created_at: number; updated_at: number } | null;
    if (!r) return undefined;
    return { id: r.id, name: r.name, description: r.description ?? undefined, lardProject: r.lard_project ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  getProjectOwner(id: string): string | undefined {
    const r = this.db.query("SELECT owner_sub FROM projects WHERE id = ?").get(id) as { owner_sub: string | null } | null;
    return r?.owner_sub ?? undefined;
  }

  /** Projects for the gallery, newest-updated first, with a chat count. */
  listProjects(owner?: string): ProjectSummary[] {
    const rows = this.db
      .query(
        `SELECT p.id, p.name, p.description, p.lard_project, p.owner_sub, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS chat_count
         FROM projects p ORDER BY p.updated_at DESC`,
      )
      .all() as Array<{ id: string; name: string; description: string | null; lard_project: string | null; owner_sub: string | null; created_at: number; updated_at: number; chat_count: number }>;
    return rows
      .filter((r) => !owner || r.owner_sub === owner)
      .map((r) => ({ id: r.id, name: r.name, description: r.description ?? undefined, lardProject: r.lard_project ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at, chatCount: r.chat_count }));
  }

  updateProject(id: string, fields: { name?: string; description?: string | null; lardProject?: string | null }): void {
    const sets: string[] = [];
    const vals: Array<string | null> = [];
    if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
    if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description); }
    if (fields.lardProject !== undefined) { sets.push("lard_project = ?"); vals.push(fields.lardProject); }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    this.db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Date.now(), id);
  }

  /** Bump a project's updated_at (e.g. when one of its chats gets a new message). */
  touchProject(id: string): void {
    this.db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteProject(id: string): void {
    this.db.query("UPDATE conversations SET project_id = NULL WHERE project_id = ?").run(id); // unfile its chats
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }

  setConversationProject(conversationId: string, projectId: string | null): void {
    this.db.query("UPDATE conversations SET project_id = ? WHERE id = ?").run(projectId, conversationId);
  }

  getConversationProject(conversationId: string): string | undefined {
    const r = this.db.query("SELECT project_id FROM conversations WHERE id = ?").get(conversationId) as { project_id: string | null } | null;
    return r?.project_id ?? undefined;
  }

  // ---- project context files ---------------------------------------------
  addProjectContext(id: string, projectId: string, filename: string, body: string): void {
    this.db.query("INSERT INTO project_context (id, project_id, filename, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, filename, body, Date.now());
    this.touchProject(projectId);
  }

  /** A project's context files (metadata only — line/char counts, no body). */
  listProjectContext(projectId: string): ContextFileMeta[] {
    const rows = this.db.query("SELECT id, filename, body, created_at FROM project_context WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Array<{ id: string; filename: string; body: string; created_at: number }>;
    return rows.map((r) => ({ id: r.id, filename: r.filename, lines: r.body.split("\n").length, chars: r.body.length, createdAt: r.created_at }));
  }

  /** Full context files (with body) — for viewing and for prompt injection. */
  projectContextFiles(projectId: string): Array<{ id: string; filename: string; body: string }> {
    return this.db.query("SELECT id, filename, body FROM project_context WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as Array<{ id: string; filename: string; body: string }>;
  }

  deleteProjectContext(projectId: string, id: string): void {
    this.db.query("DELETE FROM project_context WHERE id = ? AND project_id = ?").run(id, projectId);
  }

  /**
   * Links a blob to a conversation (idempotent). A blob keeps rows from every
   * conversation that references it, so dedup is safe: deleting one conversation
   * only orphans a blob no other conversation still points at.
   */
  addBlobRef(sha256: string, conversationId: string): void {
    this.addBlobRefStmt.run(sha256, conversationId);
  }

  /** Atomic append + seq advance in one transaction. */
  appendAndBump(
    conversationId: string,
    seq: number,
    eventName: string,
    data: unknown,
  ): void {
    this.db.transaction(() => {
      const id = `${conversationId}:${seq}`;
      this.insertEventStmt.run(
        id,
        conversationId,
        seq,
        eventName,
        JSON.stringify(data),
        Date.now(),
      );
      this.upsertConversationStmt.run(conversationId, Date.now(), seq);
    })();
  }

  /** The last seq durable for a conversation (0 if none). */
  lastSeq(conversationId: string): number {
    const row = this.db
      .prepare("SELECT last_seq FROM conversations WHERE id = ?")
      .get(conversationId) as { last_seq: number } | null;
    return row?.last_seq ?? 0;
  }

  /** Events after `afterSeq`, oldest first. `data` is JSON-decoded. */
  replay(conversationId: string, afterSeq: number): StoredEvent[] {
    const rows = this.readStmt.all(conversationId, afterSeq) as Array<{
      seq: number;
      event: string;
      data: string;
    }>;
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  /** Every event of a conversation with its wall-clock time — for folding a
   * conversation into a lard ingest session (needs per-turn timestamps). */
  allEventsTimed(conversationId: string): Array<{ event: string; data: unknown; createdAt: number }> {
    const rows = this.db
      .query("SELECT event, data, created_at FROM events WHERE conversation_id = ? ORDER BY seq ASC")
      .all(conversationId) as Array<{ event: string; data: string; created_at: number }>;
    return rows.map((r) => ({ event: r.event, data: JSON.parse(r.data), createdAt: r.created_at }));
  }

  enqueue(jobId: string, conversationId: string, params: JobParams): void {
    this.enqueueStmt.run(jobId, conversationId, JSON.stringify(params), Date.now());
  }

  /**
   * Returns a job that needs running (queued, or an expired running lease the
   * original worker may have died with) for a conversation with no other live
   * run, claiming it atomically. The returned row is claimed (status
   * 'running') — the caller owns it until markDone/markFailed.
   */
  claimExpiredExclusive(now: number): JobRow | null {
    return this.claimExclusiveStmt.get(now, now, now) as JobRow | null;
  }

  heartbeat(id: string, leaseUntil: number): void {
    this.heartbeatStmt.run(leaseUntil, id);
  }

  checkpoint(jobId: string, seq: number): void {
    this.checkpointStmt.run(seq, jobId);
  }

  /** All running jobs with expired leases are re-queued (safe re-claim). */
  reap(now: number): number {
    return this.reapStmt.run(now).changes;
  }

  /** Voluntarily hand a claimed job back without running it. */
  requeue(id: string): void {
    this.requeueStmt.run(id);
  }

  markDone(id: string): void {
    this.finishStmt.run("done", id);
  }

  markFailed(id: string): void {
    this.finishStmt.run("failed", id);
  }

  /** True if a flush job is already queued for this conversation. */
  hasPendingFlush(conversationId: string): boolean {
    return this.hasPendingFlushStmt.get(conversationId) != null;
  }

  /**
   * Steered messages waiting to be flushed into a run, oldest first. Derived
   * from the event log: a `queued-message` is pending until a `user-message`
   * (promotion) or a `queued-cancelled` (removal) with the same runId supersedes
   * it. Malformed rows are skipped, never fatal.
   */
  pendingQueue(conversationId: string): PendingMessage[] {
    const rows = this.pendingQueueStmt.all(conversationId) as Array<{ data: string }>;
    const out: PendingMessage[] = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as Record<string, unknown>;
        if (typeof d.runId === "string" && typeof d.content === "string" && typeof d.model === "string") {
          const msg: PendingMessage = { runId: d.runId, content: d.content, model: d.model };
          if (Array.isArray(d.attachments)) msg.attachments = d.attachments as AttachmentRef[];
          out.push(msg);
        }
      } catch {
        // malformed row: skip it rather than poison the flush
      }
    }
    return out;
  }
}
