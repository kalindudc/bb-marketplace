import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Decision } from "./decide";

/**
 * The decision log and the one compaction history, in the plugin's own SQLite database.
 * A `decisions` row is written when a thread's decision changes; `outcome` is filled in when the
 * compaction that decision caused lands (`ok`), fails (`failed`) or is given up (`cancelled`).
 * Every landing bb reports is exactly one `compactions` row: a Press request settles to the first
 * landing after it, any other landing is a `native` row, and a composer report attaches to one row.
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
  // One history: every landing is one row, whoever ran it, carrying what the composer reported.
  `ALTER TABLE compactions ADD COLUMN reason TEXT`,
  `ALTER TABLE compactions ADD COLUMN model TEXT`,
  `ALTER TABLE compactions ADD COLUMN summary_path TEXT`,
  `ALTER TABLE compactions ADD COLUMN composer_id TEXT`,
  `ALTER TABLE compactions ADD COLUMN ms INTEGER`,
  `CREATE UNIQUE INDEX compactions_by_composer ON compactions (thread_id, composer_id) WHERE composer_id IS NOT NULL`,
  `CREATE INDEX decisions_by_at ON decisions (at)`,
];

/** Two reports of one landing (bb's event and its timeline row) are at most this far apart. */
export const LANDING_MATCH_MS = 60_000;
/**
 * A report of a landing already recorded cannot start more than this after that landing finished:
 * a report that does is a second compaction, which can only start once the first one ended.
 */
export const LANDING_START_SLACK_MS = 5_000;
/** A composer report attaches to the first landing at most this long after it finished. */
export const COMPOSER_ATTACH_MAX_MS = 10 * 60_000;
/** Clock slack between the composer's host and the bb server. */
export const COMPOSER_CLOCK_SLACK_MS = 30_000;

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
  /** When Press requested it, or when a compaction Press did not request started. */
  requestedAt: number;
  point: string | null;
  reason: string | null;
  mode: string | null;
  provider: string | null;
  method: "compact" | "native";
  tokensBefore: number | null;
  boundaryAt: number | null;
  boundaryMessageId: string | null;
  status: "requested" | "settled";
  outcome: "ok" | "failed" | "cancelled" | null;
  error: string | null;
  landedAt: number | null;
  tokensAfter: number | null;
  model: string | null;
  /** The validated absolute path of the composer's summary on the workspace host. */
  summaryPath: string | null;
  composerId: string | null;
  /** How long the composer took; null when it did not report. */
  ms: number | null;
}

export interface ThreadState {
  threadId: string;
  turnsSince: number;
  /** The latest attempt, landed or failed. */
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

export interface ComposerReport {
  id: string;
  /** When the composer finished (or started, when it did not say). */
  at: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  model: string | null;
  ms: number | null;
  summaryPath: string | null;
}

export interface LandingResult {
  id: string;
  kind: "known" | "settled" | "native";
  /** Whether the store changed. */
  changed: boolean;
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
  reason: string | null;
  mode: string | null;
  provider: string | null;
  method: string;
  tokens_before: number | null;
  status: string;
  outcome: string | null;
  error: string | null;
  landed_at: number | null;
  tokens_after: number | null;
  boundary_at: number | null;
  boundary_message_id: string | null;
  model: string | null;
  summary_path: string | null;
  composer_id: string | null;
  ms: number | null;
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
  reason: row.reason ?? null,
  mode: row.mode,
  provider: row.provider,
  method: row.method === "native" ? "native" : "compact",
  tokensBefore: row.tokens_before,
  boundaryAt: row.boundary_at,
  boundaryMessageId: row.boundary_message_id,
  status: row.status as CompactionRow["status"],
  outcome: (row.outcome as CompactionRow["outcome"]) ?? null,
  error: row.error,
  landedAt: row.landed_at,
  tokensAfter: row.tokens_after,
  model: row.model ?? null,
  summaryPath: row.summary_path ?? null,
  composerId: row.composer_id ?? null,
  ms: row.ms ?? null,
});

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

export class PressStore {
  constructor(private readonly db: Database.Database) {}

  recordDecision(input: { at: number; threadId: string; decision: Decision; mode: string; origin: string }): DecisionRow {
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

  /**
   * Record a decision only when its decision, point or reason differs from the thread's previous
   * row, so a thread that keeps saying the same thing writes one row, not one a minute.
   */
  noteDecision(input: { at: number; threadId: string; decision: Decision; mode: string; origin: string }): { row: DecisionRow; inserted: boolean } {
    const [previous] = this.decisions({ threadId: input.threadId, limit: 1 });
    if (
      previous !== undefined &&
      previous.decision === input.decision.decision &&
      previous.point === input.decision.point &&
      previous.reason === input.decision.reason
    ) {
      return { row: previous, inserted: false };
    }
    return { row: this.recordDecision(input), inserted: true };
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

  /** Fill in a decision's outcome once the compaction it caused landed, failed or was cancelled. */
  setDecisionOutcome(id: string, outcome: "ok" | "failed" | "cancelled", at: number, error: string | null): void {
    this.db.prepare(`UPDATE decisions SET outcome = ?, outcome_error = ?, outcome_at = ? WHERE id = ?`).run(outcome, error, at, id);
  }

  pruneDecisions(olderThan: number): number {
    return this.db.prepare(`DELETE FROM decisions WHERE at < ?`).run(olderThan).changes;
  }

  insertCompaction(input: {
    threadId: string;
    decisionId: string | null;
    requestedAt: number;
    point: string | null;
    reason: string | null;
    mode: string;
    provider: string;
    tokensBefore: number | null;
  }): CompactionRow {
    const id = newId("cmp");
    this.db
      .prepare(
        `INSERT INTO compactions (id, thread_id, decision_id, requested_at, point, reason, mode, provider, method, tokens_before, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'compact', ?, 'requested')`,
      )
      .run(id, input.threadId, input.decisionId, input.requestedAt, input.point, input.reason, input.mode, input.provider, input.tokensBefore);
    return this.compaction(id) as CompactionRow;
  }

  compaction(id: string): CompactionRow | null {
    const row = this.db.prepare(`SELECT * FROM compactions WHERE id = ?`).get(id) as CompactionRecord | undefined;
    return row === undefined ? null : compaction(row);
  }

  /** The compactions of a thread still awaiting their outcome, oldest first. */
  pendingCompactions(threadId: string): CompactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? AND status = 'requested' ORDER BY requested_at, rowid`)
      .all(threadId) as CompactionRecord[];
    return rows.map(compaction);
  }

  compactionsOf(threadId: string, limit: number): CompactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?`)
      .all(threadId, limit) as CompactionRecord[];
    return rows.map(compaction);
  }

  /**
   * A compaction bb reports as landed. The same landing reported twice (its event and its timeline
   * row) matches the row already recorded; otherwise the oldest pending Press request made before it
   * settles to it, and with none it is a `native` row. A report that started after the recorded
   * landing finished, or after a request made since, is a new landing however close the two are. Any landing restarts the turn counter, clears
   * the failure flag and consumes the hints it answered.
   */
  recordLanding(threadId: string, landing: { startedAt: number; finishedAt: number; tokensAfter?: number | null }): LandingResult {
    return this.db.transaction((): LandingResult => {
      const { startedAt, finishedAt } = landing;
      const tokensAfter = landing.tokensAfter ?? null;
      const known = this.db
        .prepare(
          `SELECT * FROM compactions WHERE thread_id = ? AND outcome = 'ok' AND landed_at IS NOT NULL AND ABS(landed_at - ?) <= ?
           ORDER BY ABS(landed_at - ?) LIMIT 1`,
        )
        .get(threadId, finishedAt, LANDING_MATCH_MS, finishedAt) as CompactionRecord | undefined;
      const requestedSince = known?.landed_at != null && this.db
        .prepare(`SELECT 1 FROM compactions WHERE thread_id = ? AND status = 'requested' AND requested_at > ? AND requested_at <= ?`)
        .get(threadId, known.landed_at, startedAt) !== undefined;
      if (known !== undefined && known.landed_at !== null && startedAt <= known.landed_at + LANDING_START_SLACK_MS && !requestedSince) {
        const { changes } = this.db
          .prepare(`UPDATE compactions SET requested_at = ? WHERE id = ? AND method = 'native' AND requested_at > ?`)
          .run(startedAt, known.id, startedAt);
        return { id: known.id, kind: "known", changed: changes > 0 };
      }
      const pending = this.db
        .prepare(`SELECT * FROM compactions WHERE thread_id = ? AND status = 'requested' AND requested_at <= ? ORDER BY requested_at, rowid LIMIT 1`)
        .get(threadId, finishedAt) as CompactionRecord | undefined;
      let result: LandingResult;
      if (pending !== undefined) {
        this.db
          .prepare(`UPDATE compactions SET status = 'settled', outcome = 'ok', error = NULL, landed_at = ?, tokens_after = COALESCE(tokens_after, ?) WHERE id = ?`)
          .run(finishedAt, tokensAfter, pending.id);
        if (pending.decision_id !== null) this.setDecisionOutcome(pending.decision_id, "ok", finishedAt, null);
        result = { id: pending.id, kind: "settled", changed: true };
      } else {
        const id = newId("nat");
        this.db
          .prepare(
            `INSERT INTO compactions (id, thread_id, requested_at, point, method, status, outcome, landed_at, tokens_after)
             VALUES (?, ?, ?, 'native', 'native', 'settled', 'ok', ?, ?)`,
          )
          .run(id, threadId, Math.min(startedAt, finishedAt), finishedAt, tokensAfter);
        result = { id, kind: "native", changed: true };
      }
      this.recordAttempt(threadId, finishedAt, false);
      this.db.prepare(`UPDATE hints SET consumed = 1 WHERE thread_id = ? AND consumed = 0 AND at <= ?`).run(threadId, finishedAt);
      return result;
    })();
  }

  /** A pending request failed or was given up: settle it, its decision and the thread's attempt. */
  failCompaction(id: string, outcome: "failed" | "cancelled", at: number, error: string | null): boolean {
    return this.db.transaction((): boolean => {
      const row = this.compaction(id);
      if (row === null || row.status !== "requested") return false;
      this.db
        .prepare(`UPDATE compactions SET status = 'settled', outcome = ?, error = ?, landed_at = ? WHERE id = ? AND status = 'requested'`)
        .run(outcome, error, at, id);
      if (row.decisionId !== null) this.setDecisionOutcome(row.decisionId, outcome, at, error);
      this.recordAttempt(row.threadId, at, true);
      return true;
    })();
  }

  /** Settle a request that never reached the provider (a provider disabled by policy): no attempt. */
  cancelUnsent(id: string, at: number, error: string): void {
    this.db
      .prepare(`UPDATE compactions SET status = 'settled', outcome = 'cancelled', error = ?, landed_at = ? WHERE id = ? AND status = 'requested'`)
      .run(error, at, id);
  }

  /** For each reason a compact decision of the thread gave (the signal that fired it), when it last did. */
  lastCompactDecisions(threadId: string): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT reason, MAX(at) AS at FROM decisions WHERE thread_id = ? AND decision = 'compact' AND reason IS NOT NULL GROUP BY reason`)
      .all(threadId) as Array<{ reason: string; at: number }>;
    return new Map(rows.map((row) => [row.reason, row.at]));
  }

  /** When the thread's newest recorded landing finished, or null. */
  lastLandedAt(threadId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(landed_at) AS at FROM compactions WHERE thread_id = ? AND outcome = 'ok'`)
      .get(threadId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  /** Fill `tokensAfter` from the thread's usage when nothing better (the composer) reported it. */
  fillTokensAfter(id: string, tokens: number): boolean {
    const { changes } = this.db
      .prepare(`UPDATE compactions SET tokens_after = ? WHERE id = ? AND tokens_after IS NULL AND (tokens_before IS NULL OR tokens_before > ?)`)
      .run(tokens, id, tokens);
    return changes > 0;
  }

  /** Landed rows since `since` whose size after the compaction nobody has reported yet, oldest first. */
  missingTokensAfter(threadId: string, since: number): CompactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? AND outcome = 'ok' AND tokens_after IS NULL AND landed_at >= ? ORDER BY landed_at`)
      .all(threadId, since) as CompactionRecord[];
    return rows.map(compaction);
  }

  /** Landed rows of a thread since `since` that have no in-chat boundary yet, newest first. */
  unanchoredCompactions(threadId: string, since: number): CompactionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM compactions WHERE thread_id = ? AND outcome = 'ok' AND boundary_at IS NULL AND landed_at >= ?
         ORDER BY landed_at DESC`,
      )
      .all(threadId, since) as CompactionRecord[];
    return rows.map(compaction);
  }

  setBoundary(id: string, boundary: { createdAt: number; id: string | null }): boolean {
    const { changes } = this.db
      .prepare(`UPDATE compactions SET boundary_at = ?, boundary_message_id = ? WHERE id = ? AND boundary_at IS NULL`)
      .run(boundary.createdAt, boundary.id, id);
    return changes > 0;
  }

  /** Landed rows since `since` that no composer report has attached to yet. */
  awaitingComposer(threadId: string, since: number): CompactionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compactions WHERE thread_id = ? AND outcome = 'ok' AND composer_id IS NULL AND landed_at >= ? ORDER BY landed_at`)
      .all(threadId, since) as CompactionRecord[];
    return rows.map(compaction);
  }

  /**
   * Attach a composer report to the landing it precedes: the first landed row without a report,
   * at or after the report's time (less the clock slack) and at most `COMPOSER_ATTACH_MAX_MS` after.
   * A report attaches once; returns the row id it attached to, or null.
   */
  attachComposer(threadId: string, report: ComposerReport): string | null {
    return this.db.transaction((): string | null => {
      const attached = this.db.prepare(`SELECT 1 FROM compactions WHERE thread_id = ? AND composer_id = ?`).get(threadId, report.id);
      if (attached !== undefined) return null;
      const target = this.db
        .prepare(
          `SELECT id FROM compactions WHERE thread_id = ? AND outcome = 'ok' AND composer_id IS NULL AND landed_at >= ? AND landed_at <= ?
           ORDER BY landed_at LIMIT 1`,
        )
        .get(threadId, report.at - COMPOSER_CLOCK_SLACK_MS, report.at + COMPOSER_ATTACH_MAX_MS) as { id: string } | undefined;
      if (target === undefined) return null;
      this.db
        .prepare(
          `UPDATE compactions SET composer_id = ?, model = ?, summary_path = ?, tokens_after = COALESCE(?, tokens_after),
           ms = COALESCE(?, ms), tokens_before = COALESCE(tokens_before, ?) WHERE id = ?`,
        )
        .run(report.id, report.model, report.summaryPath, report.tokensAfter, report.ms, report.tokensBefore, target.id);
      return target.id;
    })();
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

  /**
   * A compaction attempt ended. A landing restarts the turn counter and clears the failure flag; a
   * failure sets the flag and keeps the count. An attempt older than the one recorded changes nothing.
   */
  recordAttempt(threadId: string, at: number, failed: boolean): void {
    const flag = failed ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, turns_since, last_compaction_at, last_compaction_failed) VALUES (?, 0, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           turns_since = CASE WHEN ? = 1 THEN turns_since ELSE 0 END,
           last_compaction_at = excluded.last_compaction_at,
           last_compaction_failed = excluded.last_compaction_failed
         WHERE last_compaction_at IS NULL OR last_compaction_at <= excluded.last_compaction_at`,
      )
      .run(threadId, at, flag, flag);
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
