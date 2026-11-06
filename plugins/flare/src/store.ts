import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Kind } from "./kinds";
import type { FlareDraft } from "./normalize";

export type FlareSource = "tool" | "cli";
export type RunOutcome = "running" | "done" | "failed" | "unknown";

export interface FlareRow {
  id: string;
  threadId: string;
  projectId: string | null;
  runId: string | null;
  kind: Kind;
  title: string;
  body: string;
  urgent: boolean;
  source: FlareSource;
  createdAt: number;
  threadTitle: string | null;
  pushedAt: number | null;
  forwardedAt: number | null;
}

export interface RunRow {
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome;
  error: string | null;
  prompt: string | null;
  isChild: boolean;
  nudges: number;
  lastNudgeAt: number | null;
}

// Append-only: bb records each statement's hash, so a shipped statement never changes.
export const MIGRATIONS = [
  `CREATE TABLE flares (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    urgent INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    thread_title TEXT,
    pushed_at INTEGER,
    forwarded_at INTEGER
  )`,
  `CREATE INDEX flares_by_thread ON flares (thread_id, created_at)`,
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT NOT NULL DEFAULT 'running',
    error TEXT,
    prompt TEXT,
    is_child INTEGER NOT NULL DEFAULT 0,
    nudges INTEGER NOT NULL DEFAULT 0,
    last_nudge_at INTEGER
  )`,
  `CREATE INDEX runs_by_thread ON runs (thread_id, started_at)`,
  // The threads above a flare's own thread, so a parent's banner and tab read its children's flares with one query.
  `CREATE TABLE audience (
    flare_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    PRIMARY KEY (flare_id, thread_id)
  )`,
  `CREATE INDEX audience_by_thread ON audience (thread_id)`,
  `CREATE TABLE dismissals (thread_id TEXT PRIMARY KEY, through INTEGER NOT NULL)`,
  // Each viewer thread's hidden companion on Flare's renderer, and which flares reached it.
  `CREATE TABLE companions (viewer_id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX companions_by_companion ON companions (companion_id)`,
  `CREATE TABLE shown (flare_id TEXT NOT NULL, viewer_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (flare_id, viewer_id))`,
  // A flare too old for a new companion's replay: it is not drawn there, and it is not waiting to be either.
  `ALTER TABLE shown ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0`,
];

type FlareRecord = {
  id: string;
  thread_id: string;
  project_id: string | null;
  run_id: string | null;
  kind: string;
  title: string;
  body: string;
  urgent: number;
  source: string;
  created_at: number;
  thread_title: string | null;
  pushed_at: number | null;
  forwarded_at: number | null;
};

type RunRecord = {
  id: string;
  thread_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string;
  error: string | null;
  prompt: string | null;
  is_child: number;
  nudges: number;
  last_nudge_at: number | null;
};

const flare = (row: FlareRecord): FlareRow => ({
  id: row.id,
  threadId: row.thread_id,
  projectId: row.project_id,
  runId: row.run_id,
  kind: row.kind as Kind,
  title: row.title,
  body: row.body,
  urgent: row.urgent === 1,
  source: row.source as FlareSource,
  createdAt: row.created_at,
  threadTitle: row.thread_title,
  pushedAt: row.pushed_at,
  forwardedAt: row.forwarded_at,
});

const run = (row: RunRecord): RunRow => ({
  id: row.id,
  threadId: row.thread_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  outcome: row.outcome as RunOutcome,
  error: row.error,
  prompt: row.prompt,
  isChild: row.is_child === 1,
  nudges: row.nudges,
  lastNudgeAt: row.last_nudge_at,
});

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Flares, the runs (turns) they belong to and banner dismissals, in the plugin's own SQLite database. */
export class FlareStore {
  constructor(private readonly db: Database.Database) {}

  insertFlare(input: { threadId: string; projectId: string | null; draft: FlareDraft; source: FlareSource; now: number }): FlareRow {
    const open = this.openRun(input.threadId);
    const record: FlareRecord = {
      id: newId("fl"),
      thread_id: input.threadId,
      project_id: input.projectId,
      run_id: open?.id ?? null,
      kind: input.draft.kind,
      title: input.draft.title,
      body: input.draft.body,
      urgent: input.draft.urgent ? 1 : 0,
      source: input.source,
      created_at: input.now,
      thread_title: null,
      pushed_at: null,
      forwarded_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO flares (id, thread_id, project_id, run_id, kind, title, body, urgent, source, created_at)
         VALUES (@id, @thread_id, @project_id, @run_id, @kind, @title, @body, @urgent, @source, @created_at)`,
      )
      .run(record);
    return flare(record);
  }

  /**
   * The same flare sent again in the same turn within the window, as an agent that retried a call would. A change of
   * kind or urgency is news, so it does not count as the same flare.
   */
  findDuplicate(threadId: string, draft: FlareDraft, since: number): FlareRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM flares WHERE thread_id = @threadId AND run_id IS @runId AND kind = @kind AND urgent = @urgent
           AND title = @title AND body = @body AND created_at >= @since
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get({
        threadId,
        runId: this.openRun(threadId)?.id ?? null,
        kind: draft.kind,
        urgent: draft.urgent ? 1 : 0,
        title: draft.title,
        body: draft.body,
        since,
      }) as FlareRecord | undefined;
    return row === undefined ? null : flare(row);
  }

  /** The newest flare a thread sent during one run. */
  latestInRun(runId: string): FlareRow | null {
    const row = this.db.prepare(`SELECT * FROM flares WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(runId) as
      | FlareRecord
      | undefined;
    return row === undefined ? null : flare(row);
  }

  getFlare(id: string): FlareRow | null {
    const row = this.db.prepare(`SELECT * FROM flares WHERE id = ?`).get(id) as FlareRecord | undefined;
    return row === undefined ? null : flare(row);
  }

  /** The thread's other flares from the same run, or from no run when it has none, sent since `since`. */
  turnmates(row: Pick<FlareRow, "id" | "threadId" | "runId">, since: number): FlareRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM flares WHERE thread_id = @threadId AND run_id IS @runId AND id != @id AND created_at >= @since`)
      .all({ threadId: row.threadId, runId: row.runId, id: row.id, since }) as FlareRecord[];
    return rows.map(flare);
  }

  countInRun(runId: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM flares WHERE run_id = ?`).get(runId) as { n: number }).n;
  }

  setThreadTitle(flareId: string, title: string): void {
    this.db.prepare(`UPDATE flares SET thread_title = ? WHERE id = ?`).run(title, flareId);
  }

  markPushed(flareId: string, at: number): void {
    this.db.prepare(`UPDATE flares SET pushed_at = ? WHERE id = ?`).run(at, flareId);
  }

  markForwarded(flareId: string, at: number): void {
    this.db.prepare(`UPDATE flares SET forwarded_at = ? WHERE id = ?`).run(at, flareId);
  }

  addAudience(flareId: string, threadIds: readonly string[]): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO audience (flare_id, thread_id) VALUES (?, ?)`);
    this.db.transaction(() => {
      for (const threadId of threadIds) insert.run(flareId, threadId);
    })();
  }

  /** A thread's own flares and, with `children`, those of every thread below it, newest first. */
  flaresFor(threadId: string, options: { since?: number; limit: number; children: boolean }): FlareRow[] {
    const since = options.since ?? 0;
    const rows = options.children
      ? this.db
          .prepare(
            `SELECT * FROM flares WHERE created_at >= @since AND (thread_id = @threadId
               OR id IN (SELECT flare_id FROM audience WHERE thread_id = @threadId))
             ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
          )
          .all({ threadId, since, limit: options.limit })
      : this.db
          .prepare(`SELECT * FROM flares WHERE thread_id = @threadId AND created_at >= @since ORDER BY created_at DESC, rowid DESC LIMIT @limit`)
          .all({ threadId, since, limit: options.limit });
    return (rows as FlareRecord[]).map(flare);
  }

  lastFlareAt(threadId: string): number | null {
    const row = this.db.prepare(`SELECT max(created_at) AS at FROM flares WHERE thread_id = ?`).get(threadId) as { at: number | null };
    return row.at;
  }

  openRun(threadId: string): RunRow | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .get(threadId) as RunRecord | undefined;
    return row === undefined ? null : run(row);
  }

  latestRun(threadId: string): RunRow | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(threadId) as
      | RunRecord
      | undefined;
    return row === undefined ? null : run(row);
  }

  getRun(id: string): RunRow | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRecord | undefined;
    return row === undefined ? null : run(row);
  }

  runsFor(threadId: string, limit: number): RunRow[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(threadId, limit) as RunRecord[]).map(run);
  }

  /** A thread's runs that were still going at or after `since`, newest first. */
  runsSince(threadId: string, since: number): RunRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM runs WHERE thread_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC, rowid DESC`)
        .all(threadId, since) as RunRecord[]
    ).map(run);
  }

  openRuns(): RunRow[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at`).all() as RunRecord[]).map(run);
  }

  /** Opens a run for a thread that started working, or returns the one already open. */
  startRun(threadId: string, now: number, isChild: boolean): { run: RunRow; started: boolean } {
    const open = this.openRun(threadId);
    if (open !== null) return { run: open, started: false };
    const record: RunRecord = {
      id: newId("run"),
      thread_id: threadId,
      started_at: now,
      ended_at: null,
      outcome: "running",
      error: null,
      prompt: null,
      is_child: isChild ? 1 : 0,
      nudges: 0,
      last_nudge_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, thread_id, started_at, outcome, is_child, nudges) VALUES (@id, @thread_id, @started_at, @outcome, @is_child, @nudges)`,
      )
      .run(record);
    return { run: run(record), started: true };
  }

  setRunPrompt(runId: string, prompt: string): void {
    this.db.prepare(`UPDATE runs SET prompt = ? WHERE id = ?`).run(prompt, runId);
  }

  /** Closes a thread's open run; null when none was open. */
  endRun(threadId: string, now: number, outcome: Exclude<RunOutcome, "running">, error: string | null = null): RunRow | null {
    const open = this.openRun(threadId);
    if (open === null) return null;
    this.db.prepare(`UPDATE runs SET ended_at = ?, outcome = ?, error = ? WHERE id = ?`).run(now, outcome, error, open.id);
    return { ...open, endedAt: now, outcome, error };
  }

  recordNudge(runId: string, at: number): void {
    this.db.prepare(`UPDATE runs SET nudges = nudges + 1, last_nudge_at = ? WHERE id = ?`).run(at, runId);
  }

  dismissedThrough(threadId: string): number | null {
    const row = this.db.prepare(`SELECT through FROM dismissals WHERE thread_id = ?`).get(threadId) as { through: number } | undefined;
    return row?.through ?? null;
  }

  dismiss(threadId: string, through: number): void {
    this.db
      .prepare(`INSERT INTO dismissals (thread_id, through) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET through = max(through, excluded.through)`)
      .run(threadId, through);
  }

  companionOf(viewerId: string): string | null {
    const row = this.db.prepare(`SELECT companion_id FROM companions WHERE viewer_id = ?`).get(viewerId) as { companion_id: string } | undefined;
    return row?.companion_id ?? null;
  }

  isCompanion(threadId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM companions WHERE companion_id = ?`).get(threadId) !== undefined;
  }

  setCompanion(viewerId: string, companionId: string, at: number): void {
    this.db
      .prepare(`INSERT INTO companions (viewer_id, companion_id, created_at) VALUES (?, ?, ?) ON CONFLICT (viewer_id) DO UPDATE SET companion_id = excluded.companion_id, created_at = excluded.created_at`)
      .run(viewerId, companionId, at);
  }

  forgetCompanion(viewerId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM companions WHERE viewer_id = ?`).run(viewerId);
      this.db.prepare(`DELETE FROM shown WHERE viewer_id = ?`).run(viewerId);
    })();
  }

  forgetCompanionById(companionId: string): void {
    const row = this.db.prepare(`SELECT viewer_id FROM companions WHERE companion_id = ?`).get(companionId) as { viewer_id: string } | undefined;
    if (row !== undefined) this.forgetCompanion(row.viewer_id);
  }

  markShown(flareId: string, viewerId: string, at: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO shown (flare_id, viewer_id, at) VALUES (?, ?, ?)`).run(flareId, viewerId, at);
  }

  viewerOf(companionId: string): string | null {
    const row = this.db.prepare(`SELECT viewer_id FROM companions WHERE companion_id = ?`).get(companionId) as { viewer_id: string } | undefined;
    return row?.viewer_id ?? null;
  }

  /** The newest `limit` flares a viewer's tab lists that its companion does not have yet, oldest first. */
  unshownFor(viewerId: string, limit: number): FlareRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flares WHERE (thread_id = @viewer OR id IN (SELECT flare_id FROM audience WHERE thread_id = @viewer))
           AND id NOT IN (SELECT flare_id FROM shown WHERE viewer_id = @viewer)
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ viewer: viewerId, limit }) as FlareRecord[];
    return rows.map(flare).reverse();
  }

  /** When the newest flare a viewer's companion shows was sent; null when it shows none. */
  lastShownAt(viewerId: string): number | null {
    const row = this.db
      .prepare(`SELECT max(f.created_at) AS at FROM shown s JOIN flares f ON f.id = s.flare_id WHERE s.viewer_id = ? AND s.skipped = 0`)
      .get(viewerId) as { at: number | null };
    return row.at;
  }

  /** Which of these flares a viewer's companion shows. */
  shownAmong(viewerId: string, flareIds: readonly string[]): Set<string> {
    if (flareIds.length === 0) return new Set();
    const rows = this.db
      .prepare(`SELECT flare_id FROM shown WHERE viewer_id = ? AND skipped = 0 AND flare_id IN (${flareIds.map(() => "?").join(",")})`)
      .all(viewerId, ...flareIds) as { flare_id: string }[];
    return new Set(rows.map((row) => row.flare_id));
  }

  /** Marks every flare older than `before` that a viewer's companion lacks as too old to replay. */
  skipUnshownBefore(viewerId: string, before: number, at: number): number {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO shown (flare_id, viewer_id, at, skipped)
         SELECT id, @viewer, @at, 1 FROM flares WHERE created_at < @before
           AND (thread_id = @viewer OR id IN (SELECT flare_id FROM audience WHERE thread_id = @viewer))`,
      )
      .run({ viewer: viewerId, before, at }).changes;
  }

  /** Other viewers whose companion shows a flare of `threadId`: deleting that thread leaves the companion stale. */
  viewersShowingThread(threadId: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT s.viewer_id AS viewer FROM shown s JOIN flares f ON f.id = s.flare_id WHERE f.thread_id = ? AND s.viewer_id != ? AND s.skipped = 0`)
      .all(threadId, threadId) as { viewer: string }[];
    return rows.map((row) => row.viewer);
  }

  /** Viewers whose companion shows a flare older than `before`: pruning that flare leaves the companion stale. */
  viewersShowingBefore(before: number): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT s.viewer_id AS viewer FROM shown s JOIN flares f ON f.id = s.flare_id WHERE f.created_at < ? AND s.skipped = 0`)
      .all(before) as { viewer: string }[];
    return rows.map((row) => row.viewer);
  }

  deleteThread(threadId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM shown WHERE viewer_id = ? OR flare_id IN (SELECT id FROM flares WHERE thread_id = ?)`).run(threadId, threadId);
      this.db.prepare(`DELETE FROM companions WHERE viewer_id = ? OR companion_id = ?`).run(threadId, threadId);
      this.db.prepare(`DELETE FROM audience WHERE thread_id = ? OR flare_id IN (SELECT id FROM flares WHERE thread_id = ?)`).run(threadId, threadId);
      this.db.prepare(`DELETE FROM flares WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`DELETE FROM runs WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`DELETE FROM dismissals WHERE thread_id = ?`).run(threadId);
    })();
  }

  /** Drops flares and finished runs older than `before`; returns how many flares went. */
  prune(before: number): number {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM audience WHERE flare_id IN (SELECT id FROM flares WHERE created_at < ?)`).run(before);
      this.db.prepare(`DELETE FROM shown WHERE flare_id IN (SELECT id FROM flares WHERE created_at < ?)`).run(before);
      const { changes } = this.db.prepare(`DELETE FROM flares WHERE created_at < ?`).run(before);
      this.db.prepare(`DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?`).run(before);
      return changes;
    })();
  }
}
