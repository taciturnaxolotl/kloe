import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttachmentRef } from "./events";
import { getConfig } from "./settings";

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
  /** Reasoning level for this run, when the sender chose one. */
  effort?: string;
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
  /** The reasoning level this steer was sent at, when one was chosen. */
  effort?: string;
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
    ...(typeof p.effort === "string" ? { effort: p.effort } : {}),
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
  /** The project this conversation is filed under, for the header breadcrumb (null when unfiled). */
  projectId?: string | null;
  projectName?: string | null;
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

/** One stored version of a document a tool produced. */
export interface ArtifactVersion {
  name: string;
  version: number;
  sha256: string;
  title: string | null;
  mime: string;
  size: number;
  messageId: string | null;
  createdAt: number;
}

/** A document at its newest version, with a count of how many exist. */
export interface ArtifactSummary extends ArtifactVersion {
  versions: number;
}

/** Whether a link is frozen at a version or follows the newest one. */
export type PublicationMode = "pinned" | "latest";

/** A document its owner has put behind a public link. */
export interface Publication {
  token: string;
  conversationId: string;
  name: string;
  mode: PublicationMode;
  /** Pinned: the version served. Latest: the version currently newest. */
  version: number;
  sha256: string;
  title: string | null;
  mime: string;
  size: number;
  createdAt: number;
}

/** A search hit: a conversation plus an excerpt of the matching message. */
export interface ConversationSearchResult extends ConversationSummary {
  /** Text around the match (title match → excerpt of the first message). */
  snippet: string | null;
}

// How much of the opening exchange `titleSeed` hands the model. Enough to name
// the subject, nowhere near enough to be worth paying for.
const TITLE_OPENER_CHARS = 1_200;
const TITLE_REPLY_CHARS = 800;

// The conversation-list SELECT (owner + optional project filters are appended
// as a WHERE by listConversations). `last_activity` is the newest event time,
// falling back to createdAt; the LEFT JOIN carries the project name for the
// header breadcrumb.
const LIST_CONVERSATIONS_SELECT = `SELECT c.id AS id, c.created_at AS created_at, c.last_seq AS last_seq, c.custom_title AS custom_title,
          c.owner_sub AS owner_sub, c.project_id AS project_id, p.name AS project_name,
          (SELECT e.data FROM events e
           WHERE e.conversation_id = c.id AND e.event = 'user-message'
           ORDER BY e.seq ASC LIMIT 1) AS first_user,
          COALESCE((SELECT MAX(e.created_at) FROM events e
                    WHERE e.conversation_id = c.id), c.created_at) AS last_activity
   FROM conversations c
   LEFT JOIN projects p ON p.id = c.project_id`;

/** The row shape returned by the conversation-list / search queries. */
interface ConversationRow {
  id: string;
  created_at: number;
  last_activity: number;
  last_seq: number;
  first_user: string | null;
  custom_title: string | null;
  /** Present on the list query (LEFT JOIN projects); absent on search. */
  project_id?: string | null;
  project_name?: string | null;
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
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.last_activity,
    lastSeq: r.last_seq,
    title,
    projectId: r.project_id ?? null,
    projectName: r.project_name ?? null,
  };
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
/** One model in somebody's picker: what they call it and where it sits. */
export interface ModelSetting {
  ref: string;
  displayName: string | null;
  sortOrder: number;
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

-- A deletion is a durable tombstone, not merely the absence of a row. An
-- in-flight worker may still hold an actor after DELETE; the tombstone prevents
-- that actor from recreating the conversation while it unwinds.
CREATE TABLE IF NOT EXISTS deleted_conversations (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

-- Cancellation must cross the server/worker process boundary. One pending row
-- cancels the current run, or the next one when it has not yet been claimed.
CREATE TABLE IF NOT EXISTS cancel_requests (
  conversation_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_settings (
  model_ref TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 0,
  allowed_roles TEXT,
  display_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Blob metadata (the bytes live in the BlobStore, keyed by sha256). Content-
-- addressed, so a row is immutable once written; mime/size come from the upload.
-- Deployment preferences a person sets in the UI, as opposed to the ops config
-- a person sets in kloe.json. One flat key/value table rather than a column per
-- setting: these are chosen by clicking, they change without a deploy, and a
-- migration per checkbox is a bad trade.
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

-- Documents a conversation's tools produced (see spec "Artifacts — the promotion
-- path"). A PROJECTION of the log, like blob_refs: the tool-result event stays
-- authoritative, this is the index that makes "list this chat's documents" and
-- "read the newest report.md" cheap instead of a scan.
--
-- (conversation_id, name) is the document; version is its revision, so a rerun
-- into the same filename builds history rather than shadowing what came before.
-- The bytes are the blob, addressed by sha256 and shared with every other file
-- in the system.
CREATE TABLE IF NOT EXISTS artifacts (
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts (conversation_id, created_at DESC);

-- Documents their owner has published to a public link. The token IS the
-- capability: unguessable, and revoking the row revokes the link.
--
-- ONE link per document, with a mode, rather than a link per version. A
-- document is either private, shared frozen, or shared live — three states a
-- person can hold in their head. A link per version would mean a document could
-- be public in several ways at once, and revoking "the" link would not be a
-- thing you could do.
--
--   pinned  — serves the stored version, whose bytes are copied into
--             sha256/mime/size here. The conversation can rewrite the document
--             freely; a reader keeps getting what was actually shared.
--   latest  — serves whatever the newest version is at the moment of the
--             request. The stored version records what it was published from,
--             so the owner can see where the link started.
--
-- A live link is the one case where serving a public request has to read the
-- artifacts table. That's still bounded by the token: it resolves the newest
-- version OF THE DOCUMENT THE PUBLICATION NAMES, and nothing else is reachable
-- from a token, correct or guessed.
CREATE TABLE IF NOT EXISTS publications (
  token TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'pinned',
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- One link per document: publishing again re-points the link that exists
-- instead of minting a second one nobody can keep track of.
CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_doc
  ON publications (conversation_id, name);
CREATE INDEX IF NOT EXISTS idx_publications_conv ON publications (conversation_id);

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

-- Each person's own picker: which models are in it, what they call them, and
-- what order they sit in. Curation is personal — an operator says what a role
-- may pick FROM (auth.roles[].models in kloe.json), and everything after that
-- is the person's. Opt-in, because "every model this instance can reach" is a
-- hundred rows nobody wants in a dropdown.
CREATE TABLE IF NOT EXISTS user_models (
  sub          TEXT NOT NULL,
  model_ref    TEXT NOT NULL,
  display_name TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (sub, model_ref)
);

-- The role the identity provider last reported for a user, recorded at every
-- sign-in. Durable rather than session-scoped because a queued job outlives the
-- request that enqueued it — and often the session too — and the run still has
-- to know whether that person may reach the sandbox.
CREATE TABLE IF NOT EXISTS user_roles (
  sub        TEXT PRIMARY KEY,
  role       TEXT,
  updated_at INTEGER NOT NULL
);

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

-- A credential a USER gave us for an inference provider, so their runs spend
-- their own credits: either a pasted API key (kind 'key') or an OAuth grant
-- (kind 'oauth'). secret and refresh_token are ciphertext (secrets.ts) --
-- this table ends up in a backup, the encryption key does not.
--
-- refresh_lease is how two processes avoid both refreshing at once. Hyper
-- rotates the refresh token on every exchange and revokes the old one, so a
-- lost race does not mean a wasted request, it means the user is disconnected.
CREATE TABLE IF NOT EXISTS user_credentials (
  sub           TEXT NOT NULL,
  service       TEXT NOT NULL DEFAULT 'inference',
  provider_id   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  secret        TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  label         TEXT,
  meta          TEXT,
  refresh_lease INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (sub, service, provider_id)
);

-- What each model call cost, and who it was spent on behalf of. One row per
-- provider call: a turn with three tool steps is three rows, and a research
-- run's workers land here beside the conversation that asked for them.
--
-- payer is the whole reason this table is not just a log. 'instance' is the
-- operator's credits and is what a budget bounds; 'user' is someone spending
-- their own connected account, which nobody needs to ration. cost_usd is
-- computed at write time from the catalog's prices, because a price that
-- changes next month must not silently restate what last month cost.
CREATE TABLE IF NOT EXISTS usage_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  sub             TEXT NOT NULL,
  payer           TEXT NOT NULL,
  service         TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  model_ref       TEXT NOT NULL,
  conversation_id TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_sub_ts ON usage_log (sub, ts);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log (ts);
`;

/** One provider call, as the ledger records it. */
export interface UsageEntry {
  ts: number;
  sub: string;
  /** Whose credits: the deployment's, or the user's own connected account. */
  payer: "instance" | "user";
  service: "inference" | "search";
  providerId: string;
  modelRef: string;
  conversationId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A ledger total, by whatever the query grouped on. */
export interface UsageTotal {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The stored row, ciphertext and all. Decrypted into a UserCredential by credentials.ts. */
export interface CredentialRow {
  sub: string;
  service: string;
  provider_id: string;
  kind: string;
  secret: string;
  refresh_token: string | null;
  expires_at: number | null;
  label: string | null;
  /** JSON: non-secret bits a request needs, e.g. a ChatGPT account id. */
  meta: string | null;
  refresh_lease: number;
  updated_at: number;
}

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
/**
 * A user's own credential for one provider. `secret` is their API key (kind
 * "key") or their current access token (kind "oauth"); both arrive here already
 * decrypted, since every caller wants the plaintext and the encryption is the
 * store's business.
 */
export interface UserCredential {
  sub: string;
  service: "inference" | "search";
  providerId: string;
  /** Non-secret provider bits stored beside the token. */
  meta?: Record<string, string>;
  kind: "key" | "oauth";
  secret: string;
  refreshToken?: string;
  /** Epoch ms; undefined for a key, which does not expire on its own. */
  expiresAt?: number;
  /** Something to recognize it by in the UI — a hyper team name, say. */
  label?: string;
  updatedAt: number;
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
  private upsertConversationStmt: ReturnType<Database["prepare"]>;
  private enqueueStmt: ReturnType<Database["prepare"]>;
  private claimExclusiveStmt: ReturnType<Database["prepare"]>;
  private heartbeatStmt: ReturnType<Database["prepare"]>;
  private checkpointStmt: ReturnType<Database["prepare"]>;
  private reapStmt: ReturnType<Database["prepare"]>;
  private requeueStmt: ReturnType<Database["prepare"]>;
  private finishStmt: ReturnType<Database["prepare"]>;
  private searchConversationsStmt: ReturnType<Database["prepare"]>;
  private pendingQueueStmt: ReturnType<Database["prepare"]>;
  private hasPendingFlushStmt: ReturnType<Database["prepare"]>;
  private insertBlobStmt: ReturnType<Database["prepare"]>;
  private getBlobStmt: ReturnType<Database["prepare"]>;
  private findOrphanBlobsStmt: ReturnType<Database["prepare"]>;
  private deleteBlobStmt: ReturnType<Database["prepare"]>;
  private addBlobRefStmt: ReturnType<Database["prepare"]>;
  private claimConversationOwnerStmt: ReturnType<Database["prepare"]>;
  private isDeletedConversationStmt: ReturnType<Database["prepare"]>;
  private requestCancelStmt: ReturnType<Database["prepare"]>;
  private takeCancelStmt: ReturnType<Database["prepare"]>;

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
    // Migration: a picker began as a bare list of refs and grew a name and an
    // order per person. CREATE TABLE IF NOT EXISTS leaves an existing table
    // exactly as it found it, so the columns have to be added by hand.
    for (const column of ["display_name TEXT", "sort_order INTEGER NOT NULL DEFAULT 0"]) {
      try {
        this.db.exec(`ALTER TABLE user_models ADD COLUMN ${column}`);
      } catch {
        // column already exists
      }
    }
    // Migration: room for the non-secret bits a provider needs alongside the
    // token (a ChatGPT account id, so far).
    try {
      this.db.exec("ALTER TABLE user_credentials ADD COLUMN meta TEXT");
    } catch {
      // column already exists
    }
    // Migration: a credential's identity gained the service it belongs to. The
    // primary key changes, which SQLite only does by rebuilding — cheap here,
    // and every existing row is an inference credential by construction.
    try {
      const cols = this.db.query("PRAGMA table_info(user_credentials)").all() as Array<{
        name: string;
      }>;
      if (cols.length > 0 && !cols.some((c) => c.name === "service")) {
        this.db.exec("ALTER TABLE user_credentials RENAME TO user_credentials_old");
        this.db.exec(SCHEMA);
        this.db.exec(
          `INSERT INTO user_credentials
             (sub, service, provider_id, kind, secret, refresh_token, expires_at, label, meta, refresh_lease, updated_at)
           SELECT sub, 'inference', provider_id, kind, secret, refresh_token, expires_at, label, NULL, refresh_lease, updated_at
           FROM user_credentials_old`,
        );
        this.db.exec("DROP TABLE user_credentials_old");
      }
    } catch {
      // already migrated
    }
    // Migration: curation is per person now, so the per-role columns are gone.
    // `visible` stays as the instance's starting selection — the list a user
    // who has chosen nothing inherits.
    for (const dead of ["guest_visible", "allowed_roles"]) {
      try {
        this.db.exec(`ALTER TABLE model_settings DROP COLUMN ${dead}`);
      } catch {
        // already gone
      }
    }
    // Migration: which project a conversation belongs to (NULL = unfiled).
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
    } catch {
      // column already exists
    }
    // Migration: publications began as one row per VERSION and are now one row
    // per DOCUMENT with a mode. Reshaping the index means collapsing any doc
    // that had several links down to its newest — the table is a day old and
    // nothing depends on the discarded rows, so this is a cheap correction
    // rather than a data migration.
    try {
      this.db.exec("ALTER TABLE publications ADD COLUMN mode TEXT NOT NULL DEFAULT 'pinned'");
      this.db.exec("DROP INDEX IF EXISTS idx_publications_doc");
      this.db.exec(
        `DELETE FROM publications WHERE rowid NOT IN
           (SELECT MAX(rowid) FROM publications GROUP BY conversation_id, name)`,
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_doc ON publications (conversation_id, name)",
      );
    } catch {
      // already reshaped
    }
    // Index the foreign key so the gallery's per-project chat COUNT, the
    // project-detail chat list, and unfiling on delete don't scan every
    // conversation. Created after the ALTER so the column exists.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id)",
    );

    this.readStmt = this.db.prepare(
      `SELECT seq, event, data FROM events
       WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC`,
    );
    this.insertEventStmt = this.db.prepare(
      `INSERT INTO events (id, conversation_id, seq, event, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.upsertConversationStmt = this.db.prepare(
      `INSERT INTO conversations (id, created_at, last_seq) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seq = conversations.last_seq + 1
       RETURNING last_seq`,
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
    this.finishStmt = this.db.prepare(`UPDATE jobs SET status = ?, lease_until = 0 WHERE id = ?`);

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
      // A published document is a reference too. Today it can't outlive its
      // conversation's blob_refs row (deleting a conversation drops both in one
      // transaction), but this keeps "a live link always has bytes" true here,
      // rather than true only because of what some other method happens to do.
      `SELECT sha256 FROM blobs
       WHERE created_at < ?
         AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256 = blobs.sha256)
         AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.sha256 = blobs.sha256)`,
    );
    this.deleteBlobStmt = this.db.prepare(`DELETE FROM blobs WHERE sha256 = ?`);
    this.addBlobRefStmt = this.db.prepare(
      `INSERT INTO blob_refs (sha256, conversation_id) VALUES (?, ?)
       ON CONFLICT(sha256, conversation_id) DO NOTHING`,
    );
    this.claimConversationOwnerStmt = this.db.prepare(
      `INSERT INTO conversations (id, created_at, last_seq, owner_sub) VALUES (?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET owner_sub = COALESCE(conversations.owner_sub, excluded.owner_sub)
       RETURNING owner_sub`,
    );
    this.isDeletedConversationStmt = this.db.prepare(
      "SELECT 1 FROM deleted_conversations WHERE id = ?",
    );
    this.requestCancelStmt = this.db.prepare(
      `INSERT INTO cancel_requests (conversation_id, created_at) VALUES (?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET created_at = excluded.created_at`,
    );
    this.takeCancelStmt = this.db.prepare(
      "DELETE FROM cancel_requests WHERE conversation_id = ? RETURNING conversation_id",
    );
  }

  /**
   * All conversations, most recently active first (by newest event, so a
   * conversation that gets activity again rises to the top), each with a title
   * derived from its first user message. Used by the chat rail. The title
   * subquery pulls the earliest `user-message` event's content per conversation.
   */
  listConversations(owner?: string, projectId?: string): ConversationSummary[] {
    // Filter in SQL, not JS, so a big log doesn't materialize every row (owner,
    // and — for a project's chat list — its project) just to drop most of them.
    const where: string[] = [];
    const binds: string[] = [];
    if (owner) {
      where.push("c.owner_sub = ?");
      binds.push(owner);
    }
    if (projectId !== undefined) {
      where.push("c.project_id = ?");
      binds.push(projectId);
    }
    const sql =
      LIST_CONVERSATIONS_SELECT +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY last_activity DESC";
    return (this.db.query(sql).all(...binds) as ConversationRow[]).map(rowToSummary);
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
      .map((r) => ({
        ...rowToSummary(r),
        snippet: r.match_text ? snippetAround(r.match_text, query) : null,
      }));
  }

  /** Sets a conversation's custom title (empty/whitespace clears it back to the derived one). */
  renameConversation(id: string, title: string): void {
    const trimmed = title.trim();
    this.db
      .prepare("UPDATE conversations SET custom_title = ? WHERE id = ?")
      .run(trimmed === "" ? null : trimmed, id);
  }

  /** Whether the conversation has a title set (generated or user rename). */
  hasCustomTitle(id: string): boolean {
    const r = this.db.prepare("SELECT custom_title FROM conversations WHERE id = ?").get(id) as {
      custom_title: string | null;
    } | null;
    return !!(r && r.custom_title && r.custom_title.trim());
  }

  /** The first user message's text, for deriving a title. */
  firstUserMessage(id: string): string | null {
    const r = this.db
      .prepare(
        "SELECT data FROM events WHERE conversation_id = ? AND event = 'user-message' ORDER BY seq ASC LIMIT 1",
      )
      .get(id) as { data: string } | null;
    if (!r) return null;
    try {
      return (JSON.parse(r.data) as { content?: string }).content ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The opening exchange, as text to title from: the first user message plus the
   * start of the first reply.
   *
   * The user's opener alone is often nothing to work with — a conversation that
   * starts "hi" has no subject in it yet, and one that starts with only an image
   * has no text at all. The reply is where the subject actually surfaces, so it
   * comes along, capped: a title needs the gist, not the essay.
   */
  titleSeed(id: string): string | null {
    const row = this.db
      .prepare(
        "SELECT data FROM events WHERE conversation_id = ? AND event = 'user-message' ORDER BY seq ASC LIMIT 1",
      )
      .get(id) as { data: string } | null;
    if (!row) return null;
    let opener = "";
    try {
      const d = JSON.parse(row.data) as {
        content?: string;
        attachments?: Array<{ name?: string }>;
      };
      opener = (d.content ?? "").trim();
      // An attachments-only opener still names its files, which is a subject.
      if (!opener && d.attachments?.length) {
        opener = d.attachments
          .map((a) => a.name)
          .filter(Boolean)
          .join(", ");
      }
    } catch {
      return null;
    }
    // Deltas arrive in seq order and the first run's are the first ones logged,
    // so reading until the cap never reaches a later turn.
    const deltas = this.db
      .prepare(
        "SELECT data FROM events WHERE conversation_id = ? AND event = 'text-delta' ORDER BY seq ASC LIMIT 400",
      )
      .all(id) as Array<{ data: string }>;
    let reply = "";
    for (const d of deltas) {
      try {
        reply += (JSON.parse(d.data) as { delta?: string }).delta ?? "";
      } catch {
        /* a malformed delta is not worth abandoning the title over */
      }
      if (reply.length >= TITLE_REPLY_CHARS) break;
    }
    const parts: string[] = [];
    if (opener) parts.push(`User: ${opener.slice(0, TITLE_OPENER_CHARS)}`);
    if (reply.trim()) parts.push(`Assistant: ${reply.slice(0, TITLE_REPLY_CHARS).trim()}`);
    return parts.length ? parts.join("\n\n") : null;
  }

  /**
   * Record a document a tool produced, as a new version of its name.
   *
   * Content addressing makes the no-op case free: bytes identical to the current
   * version aren't a new version, they're the same document written twice. That
   * matters because a rerun with the same answer shouldn't manufacture history.
   *
   * Returns the version it landed on, so the caller can say "v3" without a
   * second query.
   */
  recordArtifact(a: {
    conversationId: string;
    name: string;
    sha256: string;
    title?: string;
    mime: string;
    size: number;
    messageId?: string;
  }): number {
    const latest = this.db
      .prepare(
        "SELECT version, sha256 FROM artifacts WHERE conversation_id = ? AND name = ? ORDER BY version DESC LIMIT 1",
      )
      .get(a.conversationId, a.name) as { version: number; sha256: string } | null;
    if (latest?.sha256 === a.sha256) return latest.version; // same bytes, same document
    const version = (latest?.version ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO artifacts
           (conversation_id, name, version, sha256, title, mime, size, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.conversationId,
        a.name,
        version,
        a.sha256,
        a.title ?? null,
        a.mime,
        a.size,
        a.messageId ?? null,
        Date.now(),
      );
    return version;
  }

  /**
   * Every file this conversation can hand to the sandbox: what the user
   * attached, and what its tools produced.
   *
   * One list because the sandbox doesn't care which is which — the spec's rule
   * is that agent output shares the content-addressed store with user uploads,
   * so "reuse an artifact from turn 3" and "open the PDF from turn 1" are the
   * same operation on the same kind of handle. `kind` is only there so a wrong
   * name can be answered with a useful list.
   */
  listFiles(conversationId: string): Array<{
    name: string;
    sha256: string;
    mime: string;
    kind: "attachment" | "document";
  }> {
    const attachments = this.db
      .prepare(
        `SELECT DISTINCT json_extract(a.value, '$.sha256') AS sha256,
                json_extract(a.value, '$.name')   AS name,
                json_extract(a.value, '$.mime')   AS mime
           FROM events e, json_each(json_extract(e.data, '$.attachments')) a
          WHERE e.conversation_id = ?
            AND e.event IN ('user-message', 'queued-message')`,
      )
      .all(conversationId) as Array<{ sha256: string; name: string; mime: string }>;
    const docs = this.listArtifacts(conversationId);
    return [
      ...attachments.map((a) => ({
        name: a.name,
        sha256: a.sha256,
        mime: a.mime || "application/octet-stream",
        kind: "attachment" as const,
      })),
      ...docs.map((d) => ({
        name: d.name,
        sha256: d.sha256,
        mime: d.mime,
        kind: "document" as const,
      })),
    ];
  }

  /** Every version of one document, newest first. */
  artifactVersions(conversationId: string, name: string): ArtifactVersion[] {
    return this.db
      .prepare(
        `SELECT name, version, sha256, title, mime, size, message_id AS messageId, created_at AS createdAt
           FROM artifacts WHERE conversation_id = ? AND name = ? ORDER BY version DESC`,
      )
      .all(conversationId, name) as ArtifactVersion[];
  }

  /**
   * One row per document — its newest version, plus how many there are. This is
   * what the header list and the artifact pane read.
   */
  listArtifacts(conversationId: string): ArtifactSummary[] {
    return this.db
      .prepare(
        `SELECT a.name, a.version, a.sha256, a.title, a.mime, a.size,
                a.message_id AS messageId, a.created_at AS createdAt,
                (SELECT COUNT(*) FROM artifacts v
                  WHERE v.conversation_id = a.conversation_id AND v.name = a.name) AS versions
           FROM artifacts a
          WHERE a.conversation_id = ?
            AND a.version = (SELECT MAX(v.version) FROM artifacts v
                              WHERE v.conversation_id = a.conversation_id AND v.name = a.name)
          ORDER BY a.created_at DESC`,
      )
      .all(conversationId) as ArtifactSummary[];
  }

  // ---- publications ------------------------------------------------------

  /**
   * Put a document behind a public link, or re-point the one it already has.
   *
   * "Published" is a state a document is in, not an event, so this is an upsert
   * keyed on the document: pressing Publish again from a different version
   * moves the existing link rather than scattering a second one the owner would
   * never think to revoke. The token survives, which is what makes "pin it to
   * this version instead" and "let it follow the newest" changes to a link
   * people already have, rather than a new link to re-send.
   */
  publish(
    conversationId: string,
    name: string,
    version: number,
    mode: PublicationMode = "pinned",
  ): Publication | null {
    const doc = this.getArtifact(conversationId, name, version);
    if (!doc) return null;
    const existing = this.publicationFor(conversationId, name);
    const row: Publication = {
      token: existing?.token ?? randomUUID().replace(/-/g, ""),
      conversationId,
      name: doc.name,
      mode,
      version: doc.version,
      sha256: doc.sha256,
      title: doc.title,
      mime: doc.mime,
      size: doc.size,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO publications
           (token, conversation_id, name, mode, version, sha256, title, mime, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, name) DO UPDATE SET
           mode = excluded.mode, version = excluded.version, sha256 = excluded.sha256,
           title = excluded.title, mime = excluded.mime, size = excluded.size`,
      )
      .run(
        row.token,
        row.conversationId,
        row.name,
        row.mode,
        row.version,
        row.sha256,
        row.title,
        row.mime,
        row.size,
        row.createdAt,
      );
    return this.getPublication(row.token);
  }

  /**
   * A public document by its token — the only lookup the public path needs.
   *
   * A live publication is resolved here rather than at every call site, so
   * "which bytes does this link serve" has exactly one answer in the codebase.
   * A pinned one is already the answer.
   */
  getPublication(token: string): Publication | null {
    const row = this.readPublication("token = ?", token);
    if (!row || row.mode !== "latest") return row;
    const newest = this.getArtifact(row.conversationId, row.name);
    if (!newest) return row; // nothing newer to serve; the stored copy stands
    return {
      ...row,
      version: newest.version,
      sha256: newest.sha256,
      title: newest.title,
      mime: newest.mime,
      size: newest.size,
    };
  }

  /** The link a document has, if any — resolved the same way as by token. */
  publicationFor(conversationId: string, name: string): Publication | null {
    const row = this.readPublication("conversation_id = ? AND name = ?", conversationId, name);
    return row ? this.getPublication(row.token) : null;
  }

  private readPublication(where: string, ...args: unknown[]): Publication | null {
    return (
      (this.db
        .prepare(
          `SELECT token, conversation_id AS conversationId, name, mode, version, sha256, title,
                  mime, size, created_at AS createdAt
             FROM publications WHERE ${where}`,
        )
        .get(...(args as [])) as Publication | null) ?? null
    );
  }

  /** Revoke a link. Scoped to the conversation so a token alone can't unpublish. */
  unpublish(conversationId: string, token: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM publications WHERE conversation_id = ? AND token = ?")
        .run(conversationId, token).changes > 0
    );
  }

  /** One document by name — its newest version, or a specific one. */
  getArtifact(conversationId: string, name: string, version?: number): ArtifactVersion | null {
    const row = version
      ? this.db
          .prepare(
            `SELECT name, version, sha256, title, mime, size, message_id AS messageId, created_at AS createdAt
               FROM artifacts WHERE conversation_id = ? AND name = ? AND version = ?`,
          )
          .get(conversationId, name, version)
      : this.db
          .prepare(
            `SELECT name, version, sha256, title, mime, size, message_id AS messageId, created_at AS createdAt
               FROM artifacts WHERE conversation_id = ? AND name = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(conversationId, name);
    return (row as ArtifactVersion | null) ?? null;
  }

  /** Set the title only if none is set yet  /** Set the title only if none is set yet (auto-title never clobbers a rename).
   *  Returns whether it actually set one. */
  setTitleIfEmpty(id: string, title: string): boolean {
    const t = title.trim();
    if (!t) return false;
    const r = this.db
      .prepare(
        "UPDATE conversations SET custom_title = ? WHERE id = ? AND (custom_title IS NULL OR custom_title = '')",
      )
      .run(t, id);
    return r.changes > 0;
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
      // Deleting the conversation revokes every link it published. A link that
      // outlived the only place its owner could see it would be unrevokable.
      this.db.prepare("DELETE FROM publications WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM jobs WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_conversations (id, deleted_at) VALUES (?, ?)")
        .run(id, Date.now());
      // Of those candidates, the ones no conversation references anymore.
      const stillRef = this.db.prepare("SELECT 1 FROM blob_refs WHERE sha256 = ? LIMIT 1");
      return candidates.filter((sha) => stillRef.get(sha) == null);
    })();
  }

  // ---- preferences -------------------------------------------------------

  /** One preference, or null when it has never been set. */
  getPref(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Set a preference, or clear it when the value is empty. */
  setPref(key: string, value: string | null): void {
    if (!value) {
      this.db.prepare("DELETE FROM prefs WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Every preference, for the settings page. */
  listPrefs(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM prefs").all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
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

  /**
   * Record what the provider said this user's role is, at sign-in. Only a
   * record of what was said: who holds which role is decided by config, and
   * this is what a deployment mapping provider roles reads.
   */
  setUserRole(sub: string, role: string | undefined): void {
    this.db
      .query(
        `INSERT INTO user_roles (sub, role, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(sub, role ?? null, Date.now());
  }

  /** What the provider last said about this user, or undefined if never seen. */
  getUserRole(sub: string): string | undefined {
    const row = this.db.query("SELECT role FROM user_roles WHERE sub = ?").get(sub) as {
      role: string | null;
    } | null;
    return row?.role ?? undefined;
  }

  // ---- per-user model choices ---------------------------------------------

  /**
   * One person's picker, in their order.
   *
   * A person with no rows inherits what the instance curated back when curation
   * was instance-wide (`model_settings`), so an upgrade doesn't empty anybody's
   * picker. That legacy table has no UI any more and is read nowhere else.
   */
  listUserModels(sub: string): ModelSetting[] {
    const rows = this.db
      .query(
        `SELECT model_ref, display_name, sort_order FROM user_models
         WHERE sub = ? ORDER BY sort_order, model_ref`,
      )
      .all(sub) as Array<{ model_ref: string; display_name: string | null; sort_order: number }>;
    if (rows.length === 0) return this.legacyCuration();
    return rows.map((r) => ({
      ref: r.model_ref,
      displayName: r.display_name,
      sortOrder: r.sort_order,
    }));
  }

  /** What the instance curated before curation was personal. Seed only. */
  private legacyCuration(): ModelSetting[] {
    const rows = this.db
      .query(
        `SELECT model_ref, display_name, sort_order FROM model_settings
         WHERE visible = 1 ORDER BY sort_order, model_ref`,
      )
      .all() as Array<{ model_ref: string; display_name: string | null; sort_order: number }>;
    return rows.map((r) => ({
      ref: r.model_ref,
      displayName: r.display_name,
      sortOrder: r.sort_order,
    }));
  }

  /**
   * Put a model in someone's picker, or take it out; also renames and reorders.
   *
   * The first write materializes whatever they inherited, so removing one model
   * does not read as "chose exactly nothing" and hand the legacy list back on
   * the next read.
   */
  setUserModel(
    sub: string,
    ref: string,
    patch: { enabled?: boolean; displayName?: string | null; sortOrder?: number },
  ): void {
    const count = this.db.query("SELECT COUNT(*) AS n FROM user_models WHERE sub = ?").get(sub) as {
      n: number;
    };
    if (count.n === 0) {
      for (const seed of this.legacyCuration()) {
        this.db
          .query(
            `INSERT OR IGNORE INTO user_models (sub, model_ref, display_name, sort_order, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(sub, seed.ref, seed.displayName, seed.sortOrder, Date.now());
      }
    }
    if (patch.enabled === false) {
      this.db.query("DELETE FROM user_models WHERE sub = ? AND model_ref = ?").run(sub, ref);
      return;
    }
    const prev = this.db
      .query("SELECT display_name, sort_order FROM user_models WHERE sub = ? AND model_ref = ?")
      .get(sub, ref) as { display_name: string | null; sort_order: number } | null;
    this.db
      .query(
        `INSERT INTO user_models (sub, model_ref, display_name, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sub, model_ref) DO UPDATE SET
           display_name = excluded.display_name,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .run(
        sub,
        ref,
        patch.displayName !== undefined ? patch.displayName : (prev?.display_name ?? null),
        patch.sortOrder ?? prev?.sort_order ?? 0,
        Date.now(),
      );
  }

  /** Everyone kloe has seen sign in, for the admin view that hands roles out. */
  listUserRoles(): Array<{ sub: string; role?: string; updatedAt: number }> {
    return (
      this.db.query("SELECT sub, role, updated_at FROM user_roles ORDER BY sub").all() as Array<{
        sub: string;
        role: string | null;
        updated_at: number;
      }>
    ).map((r) => ({ sub: r.sub, role: r.role ?? undefined, updatedAt: r.updated_at }));
  }

  /**
   * Ends every session this person holds. The revocation primitive: a role
   * takes effect immediately, but signing someone out is what forces the
   * provider to be asked about them again.
   */
  deleteSessionsFor(sub: string): number {
    return this.db.query("DELETE FROM sessions WHERE sub = ?").run(sub).changes;
  }

  /** The session for a cookie id, or undefined if missing/expired (expired rows are dropped). */
  getSession(id: string): Session | undefined {
    const row = this.db
      .query("SELECT sub, data, expires_at FROM sessions WHERE id = ?")
      .get(id) as {
      sub: string;
      data: string;
      expires_at: number;
    } | null;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      this.deleteSession(id);
      return undefined;
    }
    return {
      id,
      sub: row.sub,
      expiresAt: row.expires_at,
      profile: JSON.parse(row.data) as SessionProfile,
    };
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
      .get(sub) as {
      access_token: string;
      refresh_token: string | null;
      expires_at: number;
    } | null;
    if (!row) return undefined;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      expiresAt: row.expires_at,
    };
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

  // ---- user credentials ---------------------------------------------------
  // Ciphertext in and out is handled by credentials.ts; this layer only moves
  // rows, so a caller that forgets to encrypt is a compile error there rather
  // than a plaintext key here.

  getCredentialRow(sub: string, service: string, providerId: string): CredentialRow | undefined {
    return (
      (this.db
        .query(
          `SELECT sub, service, provider_id, kind, secret, refresh_token, expires_at, label, meta, refresh_lease, updated_at
           FROM user_credentials WHERE sub = ? AND service = ? AND provider_id = ?`,
        )
        .get(sub, service, providerId) as CredentialRow | null) ?? undefined
    );
  }

  listCredentialRows(sub: string, service?: string): CredentialRow[] {
    const cols = `sub, service, provider_id, kind, secret, refresh_token, expires_at, label, meta, refresh_lease, updated_at`;
    return service
      ? (this.db
          .query(
            `SELECT ${cols} FROM user_credentials WHERE sub = ? AND service = ? ORDER BY provider_id`,
          )
          .all(sub, service) as CredentialRow[])
      : (this.db
          .query(`SELECT ${cols} FROM user_credentials WHERE sub = ? ORDER BY service, provider_id`)
          .all(sub) as CredentialRow[]);
  }

  setCredentialRow(row: Omit<CredentialRow, "refresh_lease" | "updated_at">): void {
    this.db
      .query(
        `INSERT INTO user_credentials
           (sub, service, provider_id, kind, secret, refresh_token, expires_at, label, meta, refresh_lease, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(sub, service, provider_id) DO UPDATE SET
           kind=excluded.kind, secret=excluded.secret, refresh_token=excluded.refresh_token,
           expires_at=excluded.expires_at, label=excluded.label, meta=excluded.meta,
           refresh_lease=0, updated_at=excluded.updated_at`,
      )
      .run(
        row.sub,
        row.service,
        row.provider_id,
        row.kind,
        row.secret,
        row.refresh_token,
        row.expires_at,
        row.label,
        row.meta,
        Date.now(),
      );
  }

  deleteCredential(sub: string, service: string, providerId: string): void {
    this.db
      .query("DELETE FROM user_credentials WHERE sub = ? AND service = ? AND provider_id = ?")
      .run(sub, service, providerId);
  }

  /**
   * Take the right to refresh this credential until `until`, if nobody else
   * holds it. Returns false when someone else is mid-exchange — the caller
   * waits for their result rather than racing them into a revoked token.
   */
  claimRefresh(
    sub: string,
    service: string,
    providerId: string,
    now: number,
    until: number,
  ): boolean {
    return (
      this.db
        .query(
          `UPDATE user_credentials SET refresh_lease = ?
           WHERE sub = ? AND service = ? AND provider_id = ? AND refresh_lease < ?`,
        )
        .run(until, sub, service, providerId, now).changes > 0
    );
  }

  // ---- the spend ledger ---------------------------------------------------

  /** Record one provider call. Never throws — a lost row must not fail a run. */
  recordUsage(e: UsageEntry): void {
    try {
      this.db
        .query(
          `INSERT INTO usage_log
             (ts, sub, payer, service, provider_id, model_ref, conversation_id,
              input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.ts,
          e.sub,
          e.payer,
          e.service,
          e.providerId,
          e.modelRef,
          e.conversationId ?? null,
          e.inputTokens,
          e.outputTokens,
          e.costUsd,
        );
    } catch (err) {
      console.warn("[usage] could not record:", (err as Error).message);
    }
  }

  /**
   * What one person has spent of the INSTANCE's credits since `since`.
   *
   * Their own connected accounts are excluded on purpose: a budget bounds what
   * the operator pays for, and someone paying their own way is not spending it.
   */
  spentSince(sub: string, since: number): { costUsd: number; tokens: number } {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
         FROM usage_log WHERE sub = ? AND payer = 'instance' AND ts >= ?`,
      )
      .get(sub, since) as { cost: number; tokens: number };
    return { costUsd: row.cost, tokens: row.tokens };
  }

  /**
   * Ledger totals since `since`, grouped by model, by person, or by day.
   *
   * `sub` narrows it to one person — the difference between "what have I spent"
   * and the admin's "what has this instance spent".
   */
  usageTotals(opts: {
    since: number;
    groupBy: "model" | "sub" | "day";
    sub?: string;
    payer?: "instance" | "user";
  }): UsageTotal[] {
    const column =
      opts.groupBy === "model"
        ? "model_ref"
        : opts.groupBy === "sub"
          ? "sub"
          : "date(ts / 1000, 'unixepoch')";
    const where = ["ts >= ?"];
    const args: Array<string | number> = [opts.since];
    if (opts.sub) {
      where.push("sub = ?");
      args.push(opts.sub);
    }
    if (opts.payer) {
      where.push("payer = ?");
      args.push(opts.payer);
    }
    return this.db
      .query(
        `SELECT ${column} AS key, COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM usage_log WHERE ${where.join(" AND ")}
         GROUP BY key ORDER BY ${opts.groupBy === "day" ? "key ASC" : "costUsd DESC, calls DESC"}`,
      )
      .all(...args) as UsageTotal[];
  }

  /** Drop ledger rows older than `before` — for whoever prunes. */
  pruneUsage(before: number): number {
    return this.db.query("DELETE FROM usage_log WHERE ts < ?").run(before).changes;
  }

  // ---- conversation ownership --------------------------------------------
  /** Stamp who started a conversation, first writer wins (no-op without a sub). */
  setConversationOwner(id: string, sub: string | undefined): void {
    if (!sub) return;
    this.db
      .query("UPDATE conversations SET owner_sub = ? WHERE id = ? AND owner_sub IS NULL")
      .run(sub, id);
  }

  /** Atomically create or claim an unowned conversation for an authenticated user. */
  claimConversationOwner(id: string, sub: string): boolean {
    const row = this.claimConversationOwnerStmt.get(id, Date.now(), sub) as {
      owner_sub: string;
    } | null;
    return row?.owner_sub === sub;
  }

  /** Whether this id was deleted and must never be revived by a stale actor. */
  isConversationDeleted(id: string): boolean {
    return this.isDeletedConversationStmt.get(id) != null;
  }

  /** Request cancellation durably so the process running the job can observe it. */
  requestCancel(conversationId: string): void {
    this.requestCancelStmt.run(conversationId, Date.now());
  }

  /** Consume one cancellation request. A pre-claim cancel therefore reaches the next run. */
  takeCancelRequest(conversationId: string): boolean {
    return this.takeCancelStmt.get(conversationId) != null;
  }

  /** The kloe user `sub` that owns a conversation, or undefined (auth-off / legacy). */
  getConversationOwner(id: string): string | undefined {
    const row = this.db.query("SELECT owner_sub FROM conversations WHERE id = ?").get(id) as {
      owner_sub: string | null;
    } | null;
    return row?.owner_sub ?? undefined;
  }

  // ---- projects ----------------------------------------------------------
  createProject(
    id: string,
    name: string,
    description: string | undefined,
    owner: string | undefined,
  ): void {
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO projects (id, name, description, owner_sub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, description ?? null, owner ?? null, now, now);
  }

  getProject(id: string): Project | undefined {
    const r = this.db
      .query(
        "SELECT id, name, description, lard_project, created_at, updated_at FROM projects WHERE id = ?",
      )
      .get(id) as {
      id: string;
      name: string;
      description: string | null;
      lard_project: string | null;
      created_at: number;
      updated_at: number;
    } | null;
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? undefined,
      lardProject: r.lard_project ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  getProjectOwner(id: string): string | undefined {
    const r = this.db.query("SELECT owner_sub FROM projects WHERE id = ?").get(id) as {
      owner_sub: string | null;
    } | null;
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
      .all() as Array<{
      id: string;
      name: string;
      description: string | null;
      lard_project: string | null;
      owner_sub: string | null;
      created_at: number;
      updated_at: number;
      chat_count: number;
    }>;
    return rows
      .filter((r) => !owner || r.owner_sub === owner)
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description ?? undefined,
        lardProject: r.lard_project ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        chatCount: r.chat_count,
      }));
  }

  updateProject(
    id: string,
    fields: { name?: string; description?: string | null; lardProject?: string | null },
  ): void {
    const sets: string[] = [];
    const vals: Array<string | null> = [];
    if (fields.name !== undefined) {
      sets.push("name = ?");
      vals.push(fields.name);
    }
    if (fields.description !== undefined) {
      sets.push("description = ?");
      vals.push(fields.description);
    }
    if (fields.lardProject !== undefined) {
      sets.push("lard_project = ?");
      vals.push(fields.lardProject);
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    this.db
      .query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals, Date.now(), id);
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
    this.db
      .query("UPDATE conversations SET project_id = ? WHERE id = ?")
      .run(projectId, conversationId);
  }

  getConversationProject(conversationId: string): string | undefined {
    const r = this.db
      .query("SELECT project_id FROM conversations WHERE id = ?")
      .get(conversationId) as { project_id: string | null } | null;
    return r?.project_id ?? undefined;
  }

  // ---- project context files ---------------------------------------------
  addProjectContext(id: string, projectId: string, filename: string, body: string): void {
    this.db
      .query(
        "INSERT INTO project_context (id, project_id, filename, body, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, projectId, filename, body, Date.now());
    this.touchProject(projectId);
  }

  /** A project's context files (metadata only — line/char counts, no body). */
  listProjectContext(projectId: string): ContextFileMeta[] {
    const rows = this.db
      .query(
        "SELECT id, filename, body, created_at FROM project_context WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId) as Array<{ id: string; filename: string; body: string; created_at: number }>;
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      lines: r.body.split("\n").length,
      chars: r.body.length,
      createdAt: r.created_at,
    }));
  }

  /** Full context files (with body) — for viewing and for prompt injection. */
  projectContextFiles(projectId: string): Array<{ id: string; filename: string; body: string }> {
    return this.db
      .query(
        "SELECT id, filename, body FROM project_context WHERE project_id = ? ORDER BY created_at ASC",
      )
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

  /**
   * Atomic append + sequence allocation. The sequence is allocated in SQLite,
   * not an actor-local counter, because the HTTP process may append a steer
   * while a standalone worker is writing the assistant stream.
   */
  appendAndBump(conversationId: string, eventName: string, data: unknown): number {
    return this.db.transaction(() => {
      if (this.isConversationDeleted(conversationId)) {
        throw new Error(`conversation "${conversationId}" was deleted`);
      }
      const row = this.upsertConversationStmt.get(conversationId, Date.now(), 1) as {
        last_seq: number;
      };
      const seq = row.last_seq;
      const id = `${conversationId}:${seq}`;
      this.insertEventStmt.run(
        id,
        conversationId,
        seq,
        eventName,
        JSON.stringify(data),
        Date.now(),
      );
      return seq;
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
  allEventsTimed(
    conversationId: string,
  ): Array<{ event: string; data: unknown; createdAt: number }> {
    const rows = this.db
      .query(
        "SELECT event, data, created_at FROM events WHERE conversation_id = ? ORDER BY seq ASC",
      )
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
        if (
          typeof d.runId === "string" &&
          typeof d.content === "string" &&
          typeof d.model === "string"
        ) {
          const msg: PendingMessage = { runId: d.runId, content: d.content, model: d.model };
          if (typeof d.effort === "string") msg.effort = d.effort;
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
