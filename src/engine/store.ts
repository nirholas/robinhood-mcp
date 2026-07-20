/**
 * Durable job storage.
 *
 * Jobs outlive the agent that started them, the MCP process, and the machine.
 * That is the entire reason this layer exists: a trailing stop that vanishes
 * when a tool call returns is not a trailing stop.
 *
 * Persistence is SQLite via `node:sqlite`, so the package keeps a zero
 * native-dependency install. An in-memory database (`:memory:`) is used by the
 * tests, exercising the same code paths as production rather than a mock.
 *
 * @see docs/architecture.md - "Crash safety"
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';


import {
  assertTransition,
  type Job,
  type JobEvent,
  type JobStatus,
  type IntentStatus,
  type OrderIntentRecord,
} from './job.js';

/**
 * Loaded through `createRequire` rather than a static import because bundlers
 * rewrite `node:sqlite` to a bare `sqlite` specifier: esbuild's builtin list
 * predates the module, so it strips the `node:` prefix and the built artifact
 * fails to resolve at runtime. A require call is opaque to that rewriting.
 *
 * Requires Node >= 22.5, which package.json declares.
 */
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

type DatabaseSync = InstanceType<typeof DatabaseSync>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  strategy     TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  status       TEXT NOT NULL,
  state        TEXT NOT NULL,
  params       TEXT NOT NULL,
  next_run_at  INTEGER NOT NULL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, next_run_at);

CREATE TABLE IF NOT EXISTS order_intents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT,
  client_order_id TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL,
  body            TEXT NOT NULL,
  notional_usd    REAL,
  order_id        TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON order_intents (status);
CREATE INDEX IF NOT EXISTS idx_intents_job ON order_intents (job_id);

CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events (job_id, id);
`;

export interface CreateJobInput {
  strategy: string;
  symbol: string;
  state: Record<string, unknown>;
  params: Record<string, unknown>;
  nextRunAt: number;
}

export class JobStore {
  private readonly db: DatabaseSync;

  /**
   * The underlying database, for sibling subsystems that must share this file.
   *
   * The kill switch lives next to the jobs it halts on purpose: one file, one
   * lock, and no way for the switch and the job rows to disagree about which
   * database is authoritative. Exposed deliberately rather than reached for by
   * casting past `private`, so the coupling is visible.
   */
  get database(): DatabaseSync {
    return this.db;
  }

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // WAL keeps a reader (an agent listing jobs) from blocking the supervisor.
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createJob(input: CreateJobInput, now = Date.now()): Job {
    const job: Job = {
      id: randomUUID(),
      strategy: input.strategy,
      symbol: input.symbol.toUpperCase(),
      status: 'pending',
      state: input.state,
      params: input.params,
      nextRunAt: input.nextRunAt,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO jobs (id, strategy, symbol, status, state, params, next_run_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.strategy,
        job.symbol,
        job.status,
        JSON.stringify(job.state),
        JSON.stringify(job.params),
        job.nextRunAt,
        null,
        job.createdAt,
        job.updatedAt,
      );

    return job;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToJob(row) : null;
  }

  listJobs(filter: { status?: JobStatus; strategy?: string; symbol?: string } = {}): Job[] {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    if (filter.strategy) {
      clauses.push('strategy = ?');
      values.push(filter.strategy);
    }
    if (filter.symbol) {
      clauses.push('symbol = ?');
      values.push(filter.symbol.toUpperCase());
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC`)
      .all(...(values as never[])) as Array<Record<string, unknown>>;

    return rows.map(rowToJob);
  }

  /** Jobs that are due to advance. */
  dueJobs(now = Date.now(), limit = 25): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('pending', 'running') AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`,
      )
      .all(now, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToJob);
  }

  /**
   * Persist a job's advance.
   *
   * @throws {JobTransitionError} If the status change is illegal, so a strategy
   *   bug cannot resurrect a cancelled job and start spending again.
   */
  updateJob(
    id: string,
    update: {
      status?: JobStatus;
      state?: Record<string, unknown>;
      nextRunAt?: number;
      lastError?: string | null;
    },
    now = Date.now(),
  ): Job {
    const current = this.getJob(id);
    if (!current) throw new Error(`No such job: ${id}`);

    if (update.status && update.status !== current.status) {
      assertTransition(current.status, update.status);
    }

    const next: Job = {
      ...current,
      status: update.status ?? current.status,
      state: update.state ?? current.state,
      nextRunAt: update.nextRunAt ?? current.nextRunAt,
      lastError: update.lastError === undefined ? current.lastError : update.lastError,
      updatedAt: now,
    };

    this.db
      .prepare(
        `UPDATE jobs SET status = ?, state = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        JSON.stringify(next.state),
        next.nextRunAt,
        next.lastError,
        next.updatedAt,
        id,
      );

    return next;
  }

  /**
   * Reserve an order before it is submitted.
   *
   * This is the write that makes crash recovery possible. The `clientOrderId`
   * is persisted BEFORE the network call, so a crash between submit and record
   * leaves a `pending` row that reconciliation can look up upstream instead of
   * blindly resubmitting and double-filling.
   */
  reserveIntent(
    input: {
      jobId: string | null;
      clientOrderId: string;
      body: Record<string, unknown>;
      notionalUsd: number | null;
    },
    now = Date.now(),
  ): OrderIntentRecord {
    this.db
      .prepare(
        `INSERT INTO order_intents (job_id, client_order_id, status, body, notional_usd, order_id, error, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.jobId,
        input.clientOrderId,
        JSON.stringify(input.body),
        input.notionalUsd,
        now,
        now,
      );

    const record = this.getIntentByClientOrderId(input.clientOrderId);
    if (!record) throw new Error('Failed to reserve order intent.');
    return record;
  }

  settleIntent(
    clientOrderId: string,
    update: { status: IntentStatus; orderId?: string | null; error?: string | null },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE order_intents SET status = ?, order_id = ?, error = ?, updated_at = ? WHERE client_order_id = ?`,
      )
      .run(
        update.status,
        update.orderId ?? null,
        update.error ?? null,
        now,
        clientOrderId,
      );
  }

  getIntentByClientOrderId(clientOrderId: string): OrderIntentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM order_intents WHERE client_order_id = ?')
      .get(clientOrderId) as Record<string, unknown> | undefined;
    return row ? rowToIntent(row) : null;
  }

  /** Intents reserved but never settled: the crash-recovery work list. */
  pendingIntents(): OrderIntentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM order_intents WHERE status = 'pending' ORDER BY id ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToIntent);
  }

  intentsForJob(jobId: string): OrderIntentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM order_intents WHERE job_id = ? ORDER BY id ASC')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map(rowToIntent);
  }

  appendEvent(
    jobId: string,
    kind: string,
    detail: Record<string, unknown> = {},
    now = Date.now(),
  ): void {
    this.db
      .prepare('INSERT INTO job_events (job_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(jobId, kind, JSON.stringify(detail), now);
  }

  events(jobId: string, limit = 100): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      jobId: String(row.job_id),
      kind: String(row.kind),
      detail: parseJson(row.detail),
      createdAt: Number(row.created_at),
    }));
  }

  /** Run a function inside a transaction, so state and intent commit together. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    strategy: String(row.strategy),
    symbol: String(row.symbol),
    status: String(row.status) as JobStatus,
    state: parseJson(row.state),
    params: parseJson(row.params),
    nextRunAt: Number(row.next_run_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToIntent(row: Record<string, unknown>): OrderIntentRecord {
  return {
    id: Number(row.id),
    jobId: row.job_id === null ? null : String(row.job_id),
    clientOrderId: String(row.client_order_id),
    status: String(row.status) as IntentStatus,
    body: parseJson(row.body),
    notionalUsd: row.notional_usd === null ? null : Number(row.notional_usd),
    orderId: row.order_id === null ? null : String(row.order_id),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
