import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Decision } from "./decide";

/**
 * The decision log and compaction record, in the plugin's own SQLite database.
 * One `decisions` row per evaluation that reaches a trigger or a veto; `outcome` is filled in when the
 * compaction that decision caused lands (`ok`), fails (`failed`) or is given up (`cancelled`).
 */

// Append-only: bb records each statement's hash, so a shipped statement never changes.
export const MIGRATIONS = [
  `CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    point TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    percent REAL,
    tokens INTEGER,
    context_window INTEGER,
    est_ms INTEGER,
    est_cost_usd REAL,
    mode TEXT NOT NULL,
    origin TEXT NOT NULL,
    outcome TEXT,
    outcome_error TEXT,
    outcome_at INTEGER
  )`,
  `CREATE INDEX decisions_by_thread ON decisions (thread_id, at)`,
  `CREATE TABLE compactions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    decision_id TEXT,
    requested_at INTEGER NOT NULL,
    point TEXT,
    mode TEXT,
    provider TEXT,
    method TEXT,
    instructions_hash TEXT,
    tokens_before INTEGER,
    status TEXT NOT NULL,
    outcome TEXT,
    error TEXT,
    landed_at INTEGER,
    tokens_after INTEGER
  )`,
  `CREATE INDEX compactions_by_thread ON compactions (thread_id, requested_at)`,
  // Per-thread bookkeeping the decision needs: the turn counter and the last compaction's fate.
  `CREATE TABLE thread_state (
    thread_id TEXT PRIMARY KEY,
    turns_since INTEGER NOT NULL DEFAULT 0,
    last_compaction_at INTEGER,
    last_compaction_failed INTEGER NOT NULL DEFAULT 0,
    policy_override_json TEXT
  )`,
  // Agent hints: `bb press point` records one, the next evaluation consumes it so `agentHint` fires once.
  `CREATE TABLE hints (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX hints_by_thread ON hints (thread_id, at)`,
  `ALTER TABLE compactions ADD COLUMN boundary_at INTEGER`,
  `ALTER TABLE compactions ADD COLUMN boundary_message_id TEXT`,
];

export interface DecisionRow {
  id: string;
  at: number;
  threadId: string;
  point: string | null;
  decision: "compact" | "veto" | "skip";
  reason: string | null;
  percent: number | null;
  tokens: number | null;
  window: number | null;
  estMs: number;
  estCostUsd: number;
  mode: string;
  origin: string;
  outcome: "ok" | "failed" | "cancelled" | null;
  outcomeError: string | null;
  outcomeAt: number | null;
}

export interface CompactionRow {
  id: string;
  threadId: string;
  decisionId: string | null;
  requestedAt: number;
  point: string | null;
  mode: string | null;
  provider: string | null;
  method: "send" | "compact" | "native";
  instructionsHash: string | null;
  tokensBefore: number | null;
  boundaryAt: number | null;
  boundaryMessageId: string | null;
  status: "requested" | "settled";
  outcome: "ok" | "failed" | "cancelled" | null;
  error: string | null;
  landedAt: number | null;
  tokensAfter: number | null;
}

export interface ThreadState {
  threadId: string;
  turnsSince: number;
  lastCompactionAt: number | null;
  lastCompactionFailed: boolean;
}

export interface HintRow {
  id: string;
  threadId: string;
  at: number;
  reason: string;
  consumed: boolean;
}

type DecisionRecord = {
  id: string;
  at: number;
  thread_id: string;
  point: string | null;
  decision: string;
  reason: string | null;
  percent: number | null;
  tokens: number | null;
  context_window: number | null;
  est_ms: number;
  est_cost_usd: number;
  mode: string;
  origin: string;
  outcome: string | null;
  outcome_error: string | null;
  outcome_at: number | null;
};

type CompactionRecord = {
  id: string;
  thread_id: string;
  decision_id: string | null;
  requested_at: number;
  point: string | null;
  mode: string | null;
  provider: string | null;
  method: string;
  instructions_hash: string | null;
  tokens_before: number | null;
  status: string;
  outcome: string | null;
  error: string | null;
  landed_at: number | null;
  tokens_after: number | null;
  boundary_at: number | null;
  boundary_message_id: string | null;
};

const decision = (row: DecisionRecord): DecisionRow => ({
  id: row.id,
  at: row.at,
  threadId: row.thread_id,
  point: row.point,
  decision: row.decision as DecisionRow["decision"],
  reason: row.reason,
  percent: row.percent,
  tokens: row.tokens,
  window: row.context_window,
  estMs: row.est_ms,
  estCostUsd: row.est_cost_usd,
  mode: row.mode,
  origin: row.origin,
  outcome: (row.outcome as DecisionRow["outcome"]) ?? null,
  outcomeError: row.outcome_error,
  outcomeAt: row.outcome_at,
});

const compaction = (row: CompactionRecord): CompactionRow => ({
  id: row.id,
  threadId: row.thread_id,
  decisionId: row.decision_id,
  requestedAt: row.requested_at,
  point: row.point,
  mode: row.mode,
  provider: row.provider,
  method: row.method as CompactionRow["method"],
  instructionsHash: row.instructions_hash,
  tokensBefore: row.tokens_before,
  boundaryAt: row.boundary_at,
  boundaryMessageId: row.boundary_message_id,
  status: row.status as CompactionRow["status"],
  outcome: (row.outcome as CompactionRow["outcome"]) ?? null,
  error: row.error,
  landedAt: row.landed_at,
  tokensAfter: row.tokens_after,
});

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

export class PressStore {
  constructor(private readonly db: Database.Database) {}

  recordDecision(input: {
    at: number;
    threadId: string;
    decision: Decision;
    mode: string;
    origin: string;
  }): DecisionRow {
    const record: DecisionRecord = {
      id: newId("dec"),
      at: input.at,
      thread_id: input.threadId,
      point: input.decision.point,
      decision: input.decision.decision,
      reason: input.decision.reason,
      percent: input.decision.percent,
      tokens: input.decision.tokens,
      context_window: input.decision.window,
      est_ms: input.decision.estMs,
      est_cost_usd: input.decision.estCostUsd,
      mode: input.mode,
      origin: input.origin,
      outcome: null,
      outcome_error: null,
      outcome_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO decisions (id, at, thread_id, point, decision, reason, percent, tokens, context_window, est_ms, est_cost_usd, mode, origin)
         VALUES (@id, @at, @thread_id, @point, @decision, @reason, @percent, @tokens, @context_window, @est_ms, @est_cost_usd, @mode, @origin)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return decision(record);
  }

  decisions(options: { threadId?: string; limit: number }): DecisionRow[] {
    const rows = (
      options.threadId !== undefined
        ? this.db
            .prepare(`SELECT * FROM decisions WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
            .all(options.threadId, options.limit)
        : this.db.prepare(`SELECT * FROM decisions ORDER BY at DESC, rowid DESC LIMIT ?`).all(options.limit)
    ) as DecisionRecord[];
    return rows.map(decision);
  }

  decisionOf(id: string): DecisionRow | null {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRecord | undefined;
    return row === undefined ? null : decision(row);
  }

  /** Fill in a decision's outcome once the compaction it caused landed, failed or was cancelled. */
  setDecisionOutcome(id: string, outcome: "ok" | "failed" | "cancelled", at: number, error: string | null): void {
    this.db.prepare(`UPDATE decisions SET outcome = ?, outcome_error = ?, outcome_at = ? WHERE id = ?`).run(outcome, error, at, id);
  }

  insertCompaction(input: {
    threadId: string;
    decisionId: string | null;
    requestedAt: number;
    point: string | null;
    mode: string;
    provider: string;
    method: "send" | "compact";
    instructionsHash: string | null;
    tokensBefore: number | null;
  }): CompactionRow {
    const record: CompactionRecord = {
      id: newId("cmp"),
      thread_id: input.threadId,
      decision_id: input.decisionId,
      requested_at: input.requestedAt,
      point: input.point,
      mode: input.mode,
      provider: input.provider,
      method: input.method,
      instructions_hash: input.instructionsHash,
      tokens_before: input.tokensBefore,
      status: "requested",
      outcome: null,
      error: null,
      landed_at: null,
      tokens_after: null,
      boundary_at: null,
      boundary_message_id: null,
    };
    this.db
      .prepare(
        `INSERT INTO compactions (id, thread_id, decision_id, requested_at, point, mode, provider, method, instructions_hash, tokens_before, status)
         VALUES (@id, @thread_id, @decision_id, @requested_at, @point, @mode, @provider, @method, @instructions_hash, @tokens_before, @status)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return compaction(record);
  }

  compaction(id: string): CompactionRow | null {
    const row = this.db.prepare(`SELECT * FROM compactions WHERE id = ?`).get(id) as CompactionRecord | undefined;
    return row === undefined ? null : compaction(row);
  }

  /** The compactions of a thread still awaiting their outcome, oldest first. */
  pendingCompactions(threadId: string): CompactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? AND status = 'requested' ORDER BY requested_at`)
      .all(threadId) as CompactionRecord[];
    return rows.map(compaction);
  }

  lastCompaction(threadId: string): CompactionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as CompactionRecord | undefined;
    return row === undefined ? null : compaction(row);
  }

  compactionsOf(threadId: string, limit: number): CompactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?`)
      .all(threadId, limit) as CompactionRecord[];
    return rows.map(compaction);
  }

  recordNativeCompaction(threadId: string, operation: { sequence: number; startedAt: number; finishedAt: number }): boolean {
    const { sequence, startedAt, finishedAt } = operation;
    const { changes } = this.db.prepare(
      `INSERT OR IGNORE INTO compactions (id, thread_id, requested_at, point, method, status, outcome, landed_at)
       SELECT ?, ?, ?, 'native', 'native', 'settled', 'ok', ?
       WHERE NOT EXISTS (SELECT 1 FROM compactions WHERE thread_id = ? AND outcome = 'ok' AND landed_at = ? AND method != 'native')`,
    ).run(`native_${threadId}_${sequence}`, threadId, startedAt, finishedAt, threadId, finishedAt);
    return changes > 0;
  }

  unanchoredNativeCompaction(threadId: string, cutoff: number): CompactionRow | null {
    const row = this.db.prepare(
      `SELECT * FROM compactions WHERE thread_id = ? AND method = 'native' AND boundary_at IS NULL AND landed_at >= ?
       ORDER BY landed_at DESC LIMIT 1`,
    ).get(threadId, cutoff) as CompactionRecord | undefined;
    return row === undefined ? null : compaction(row);
  }

  setNativeBoundary(id: string, boundary: { createdAt: number; id: string | null }): boolean {
    const { changes } = this.db.prepare(
      `UPDATE compactions SET boundary_at = ?, boundary_message_id = ? WHERE id = ? AND method = 'native' AND boundary_at IS NULL`,
    ).run(boundary.createdAt, boundary.id, id);
    return changes > 0;
  }

  settleCompaction(
    id: string,
    outcome: "ok" | "failed" | "cancelled",
    at: number,
    error: string | null,
    tokensAfter: number | null,
  ): void {
    this.db
      .prepare(
        `UPDATE compactions SET status = 'settled', outcome = ?, error = ?, landed_at = ?, tokens_after = ?
         WHERE id = ? AND status = 'requested'`,
      )
      .run(outcome, error, at, tokensAfter, id);
  }

  threadState(threadId: string): ThreadState {
    const row = this.db
      .prepare(`SELECT turns_since, last_compaction_at, last_compaction_failed FROM thread_state WHERE thread_id = ?`)
      .get(threadId) as { turns_since: number; last_compaction_at: number | null; last_compaction_failed: number } | undefined;
    if (row === undefined) return { threadId, turnsSince: 0, lastCompactionAt: null, lastCompactionFailed: false };
    return {
      threadId,
      turnsSince: row.turns_since,
      lastCompactionAt: row.last_compaction_at,
      lastCompactionFailed: row.last_compaction_failed === 1,
    };
  }

  /** One more turn finished without a compaction landing. */
  bumpTurns(threadId: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, turns_since) VALUES (?, 1)
         ON CONFLICT (thread_id) DO UPDATE SET turns_since = turns_since + 1`,
      )
      .run(threadId);
  }

  /** A compaction landed (or failed): the turn counter restarts from it. */
  resetTurns(threadId: string, at: number, failed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, turns_since, last_compaction_at, last_compaction_failed) VALUES (?, 0, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET turns_since = 0, last_compaction_at = ?, last_compaction_failed = ?`,
      )
      .run(threadId, at, failed ? 1 : 0, at, failed ? 1 : 0);
  }

  /** The per-thread policy override from the resolution order, as raw JSON, or null. */
  threadPolicyOverride(threadId: string): string | null {
    const row = this.db.prepare(`SELECT policy_override_json FROM thread_state WHERE thread_id = ?`).get(threadId) as
      | { policy_override_json: string | null }
      | undefined;
    return row?.policy_override_json ?? null;
  }

  setThreadPolicyOverride(threadId: string, json: string | null): void {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, policy_override_json) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET policy_override_json = ?`,
      )
      .run(threadId, json, json);
  }

  recordHint(input: { threadId: string; at: number; reason: string }): HintRow {
    const id = newId("hint");
    this.db
      .prepare(`INSERT INTO hints (id, thread_id, at, reason, consumed) VALUES (?, ?, ?, ?, 0)`)
      .run(id, input.threadId, input.at, input.reason);
    return { id, threadId: input.threadId, at: input.at, reason: input.reason, consumed: false };
  }

  /** The thread's unconsumed hints, oldest first. Each fires the `agentHint` signal once. */
  pendingHints(threadId: string): HintRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM hints WHERE thread_id = ? AND consumed = 0 ORDER BY at`)
      .all(threadId) as Array<{ id: string; thread_id: string; at: number; reason: string; consumed: number }>;
    return rows.map((row) => ({ id: row.id, threadId: row.thread_id, at: row.at, reason: row.reason, consumed: row.consumed === 1 }));
  }

  consumeHints(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`UPDATE hints SET consumed = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }

  /** Drop consumed hints and stale unconsumed ones, so the table cannot grow without bound. */
  pruneHints(olderThan: number): number {
    const { changes } = this.db.prepare(`DELETE FROM hints WHERE consumed = 1 OR at < ?`).run(olderThan);
    return changes;
  }
}