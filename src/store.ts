import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface JobRow {
  id: string;
  conversation_id: string;
  status: "queued" | "running" | "done" | "failed";
  lease_until: number;
  checkpoint_seq: number;
  params: string;
}

export interface EnqueueParams {
  conversationId: string;
  runId: string;
  messageId: string;
  prompt: string;
  model: string;
}

export interface StoredEvent {
  seq: number;
  event: string;
  data: unknown;
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
  last_seq INTEGER NOT NULL DEFAULT 0
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
  params TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS model_settings (
  model_ref TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
`;

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
  private claimStmt: ReturnType<Database["prepare"]>;
  private heartbeatStmt: ReturnType<Database["prepare"]>;
  private checkpointStmt: ReturnType<Database["prepare"]>;
  private reapStmt: ReturnType<Database["prepare"]>;
  private finishStmt: ReturnType<Database["prepare"]>;
  private listSettingsStmt: ReturnType<Database["prepare"]>;
  private getSettingStmt: ReturnType<Database["prepare"]>;
  private upsertSettingStmt: ReturnType<Database["prepare"]>;

  constructor(databasePath: string = process.env.KLOE_DB ?? "data/kloe.db") {
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
      `INSERT INTO jobs (id, conversation_id, status, params) VALUES (?, ?, 'queued', ?)`,
    );
    this.claimStmt = this.db.prepare(
      `UPDATE jobs
       SET status = 'running', lease_until = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
       RETURNING id, conversation_id, status, lease_until, checkpoint_seq, params`,
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
    this.finishStmt = this.db.prepare(
      `UPDATE jobs SET status = ?, lease_until = 0 WHERE id = ?`,
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

  append(
    conversationId: string,
    seq: number,
    eventName: string,
    data: unknown,
  ): void {
    const id = `${conversationId}:${seq}`;
    this.insertEventStmt.run(
      id,
      conversationId,
      seq,
      eventName,
      JSON.stringify(data),
      Date.now(),
    );
  }

  /** Marks a delta against `conversation_id`; called when a delta batch flushes. */
  bumpSeq(conversationId: string, seq: number): void {
    this.upsertConversationStmt.run(conversationId, Date.now(), seq);
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

  enqueue(jobId: string, conversationId: string, params: EnqueueParams): void {
    this.enqueueStmt.run(jobId, conversationId, JSON.stringify(params));
  }

  /** Atomic race-free claim; returns the job or null. */
  claim(now: number): JobRow | null {
    return this.claimStmt.get(now) as JobRow | null;
  }

  /**
   * Returns a job that needs running (queued, or an expired running lease the
   * original worker may have died with), claiming it atomically.
   */
  claimExpired(now: number): JobRow | null {
    return this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running', lease_until = ?
         WHERE id = (SELECT id FROM jobs
                     WHERE status = 'queued'
                        OR (status = 'running' AND lease_until < ?)
                     ORDER BY id LIMIT 1)
         RETURNING id, conversation_id, status, lease_until, checkpoint_seq, params`,
      )
      .get(now, now) as JobRow | null;
  }

  /**
   * Like claimExpired, but only for conversations with no other running job.
   * Enforces the single-writer invariant: one active run per conversation.
   */
  claimExpiredExclusive(now: number): JobRow | null {
    return this.db
      .prepare(
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
           ORDER BY j.id LIMIT 1
         )
         RETURNING id, conversation_id, status, lease_until, checkpoint_seq, params`,
      )
      .get(now, now, now) as JobRow | null;
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

  markDone(id: string): void {
    this.finishStmt.run("done", id);
  }

  markFailed(id: string): void {
    this.finishStmt.run("failed", id);
  }
}
