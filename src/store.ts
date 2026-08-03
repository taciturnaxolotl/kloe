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

/** A conversation as shown in the chat rail: id, age, and a derived title. */
export interface ConversationSummary {
  id: string;
  createdAt: number;
  lastSeq: number;
  /** First user message, truncated — null for a conversation with no prompt yet. */
  title: string | null;
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
  private claimExclusiveStmt: ReturnType<Database["prepare"]>;
  private heartbeatStmt: ReturnType<Database["prepare"]>;
  private checkpointStmt: ReturnType<Database["prepare"]>;
  private reapStmt: ReturnType<Database["prepare"]>;
  private requeueStmt: ReturnType<Database["prepare"]>;
  private finishStmt: ReturnType<Database["prepare"]>;
  private listConversationsStmt: ReturnType<Database["prepare"]>;
  private listSettingsStmt: ReturnType<Database["prepare"]>;
  private getSettingStmt: ReturnType<Database["prepare"]>;
  private upsertSettingStmt: ReturnType<Database["prepare"]>;
  private pendingQueueStmt: ReturnType<Database["prepare"]>;
  private hasPendingFlushStmt: ReturnType<Database["prepare"]>;

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
    this.requeueStmt = this.db.prepare(
      `UPDATE jobs SET status = 'queued', lease_until = 0 WHERE id = ?`,
    );
    this.finishStmt = this.db.prepare(
      `UPDATE jobs SET status = ?, lease_until = 0 WHERE id = ?`,
    );

    this.listConversationsStmt = this.db.prepare(
      `SELECT c.id AS id, c.created_at AS created_at, c.last_seq AS last_seq,
              (SELECT e.data FROM events e
               WHERE e.conversation_id = c.id AND e.event = 'user-message'
               ORDER BY e.seq ASC LIMIT 1) AS first_user,
              COALESCE((SELECT MAX(e.created_at) FROM events e
                        WHERE e.conversation_id = c.id), c.created_at) AS last_activity
       FROM conversations c
       ORDER BY last_activity DESC`,
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
           WHERE u.conversation_id = e.conversation_id AND u.event = 'user-message'
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
  }

  /**
   * All conversations, most recently active first (by newest event, so a
   * conversation that gets activity again rises to the top), each with a title
   * derived from its first user message. Used by the chat rail. The title
   * subquery pulls the earliest `user-message` event's content per conversation.
   */
  listConversations(): ConversationSummary[] {
    const rows = this.listConversationsStmt.all() as Array<{
      id: string;
      created_at: number;
      last_seq: number;
      first_user: string | null;
    }>;
    return rows.map((r) => {
      let title: string | null = null;
      if (r.first_user) {
        try {
          const content = (JSON.parse(r.first_user) as { content?: string }).content;
          if (typeof content === "string") title = content.slice(0, 80);
        } catch {
          // malformed row: leave title null rather than crash the list
        }
      }
      return { id: r.id, createdAt: r.created_at, lastSeq: r.last_seq, title };
    });
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

  enqueue(jobId: string, conversationId: string, params: JobParams): void {
    this.enqueueStmt.run(jobId, conversationId, JSON.stringify(params));
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
   * with the same runId promotes it. Malformed rows are skipped, never fatal.
   */
  pendingQueue(conversationId: string): PendingMessage[] {
    const rows = this.pendingQueueStmt.all(conversationId) as Array<{ data: string }>;
    const out: PendingMessage[] = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as Record<string, unknown>;
        if (typeof d.runId === "string" && typeof d.content === "string" && typeof d.model === "string") {
          out.push({ runId: d.runId, content: d.content, model: d.model });
        }
      } catch {
        // malformed row: skip it rather than poison the flush
      }
    }
    return out;
  }
}
