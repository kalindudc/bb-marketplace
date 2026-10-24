// Typed repository over the plugin database.
import type Database from "better-sqlite3";
import { DEFAULT_CONFIG, parseConfig, type Config, type WatchMode } from "../config";
import type { CheckState, LinkRole, PrState, Reason, ReviewState } from "../contract";
import { prKey, type PrRef } from "../keys";
import type { ActivityItem, PrSummary } from "../model";

export interface PrRow {
  id: number;
  key: string;
  server: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  state: PrState;
  checks: CheckState;
  review: ReviewState;
  head: string | null;
  head_ref: string | null;
  base: string | null;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  updated_at: number | null;
  mine: number;
  fetched_at: number;
  dismissed_at: number | null;
}

export interface ServerRow {
  id: string;
  ok: number | null;
  login: string | null;
  error: string | null;
  last_ok_at: number | null;
  last_sync_at: number | null;
  duration_ms: number | null;
  baseline_at: number | null;
}

export interface ReasonRow {
  pr_id: number;
  reason: Reason;
  teams: string;
  since: number;
}

export interface LinkRow {
  pr_id: number;
  thread_id: string;
  role: LinkRole;
  created_at: number;
  title: string | null;
  archived: number | null;
}

export interface WatchRow {
  pr_id: number;
  mode: WatchMode;
  baselined: number;
  created_at: number;
  checked_at: number | null;
  error: string | null;
}

export interface ReviewRow {
  id: number;
  pr_id: number;
  thread_id: string;
  preset: string;
  trigger: "auto" | "manual";
  head: string | null;
  state: "running" | "done" | "failed";
  created_at: number;
  finished_at: number | null;
}

export interface EventRow {
  id: number;
  at: number;
  kind: string;
  text: string;
  pr_id: number | null;
  thread_id: string | null;
  key: string | null;
}

export interface PendingRow {
  pr_id: number;
  item_id: string;
  item: ActivityItem;
  first_seen_at: number;
}

export class Store {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  config(): Config {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'config'").get() as { value: string } | undefined;
    return row ? parseConfig(JSON.parse(row.value)) : DEFAULT_CONFIG;
  }

  saveConfig(config: Config): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES ('config', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(config));
  }

  kv(key: string): string | null {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  server(id: string): ServerRow | null {
    return (this.db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined) ?? null;
  }

  saveServer(row: ServerRow): void {
    this.db
      .prepare(
        `INSERT INTO servers (id, ok, login, error, last_ok_at, last_sync_at, duration_ms, baseline_at) VALUES (@id, @ok, @login, @error, @last_ok_at, @last_sync_at, @duration_ms, @baseline_at)
         ON CONFLICT (id) DO UPDATE SET ok = excluded.ok, login = excluded.login, error = excluded.error, last_ok_at = excluded.last_ok_at,
         last_sync_at = excluded.last_sync_at, duration_ms = excluded.duration_ms, baseline_at = excluded.baseline_at`,
      )
      .run(row);
  }

  /** Inserts or refreshes a PR from its server's summary. `mine` only ever turns on. */
  upsertPr(server: string, summary: PrSummary, url: string, mine: boolean): PrRow {
    const key = prKey({ server, repo: summary.repo, number: summary.number });
    this.db
      .prepare(
        `INSERT INTO prs (key, server, repo, number, url, title, author, state, checks, review, head, head_ref, base, additions, deletions, files, updated_at, mine, fetched_at)
         VALUES (@key, @server, @repo, @number, @url, @title, @author, @state, @checks, @review, @head, @head_ref, @base, @additions, @deletions, @files, @updated_at, @mine, @fetched_at)
         ON CONFLICT (key) DO UPDATE SET url = excluded.url, title = excluded.title, author = excluded.author, state = excluded.state, checks = excluded.checks,
         review = excluded.review, head = excluded.head, head_ref = COALESCE(excluded.head_ref, prs.head_ref), base = COALESCE(excluded.base, prs.base),
         additions = COALESCE(excluded.additions, prs.additions), deletions = COALESCE(excluded.deletions, prs.deletions), files = COALESCE(excluded.files, prs.files),
         updated_at = COALESCE(excluded.updated_at, prs.updated_at), mine = MAX(prs.mine, excluded.mine), fetched_at = excluded.fetched_at`,
      )
      .run({
        key,
        server,
        repo: summary.repo,
        number: summary.number,
        url,
        title: summary.title,
        author: summary.author,
        state: summary.state,
        checks: summary.checks,
        review: summary.review,
        head: summary.head,
        head_ref: summary.headRef,
        base: summary.base,
        additions: summary.additions,
        deletions: summary.deletions,
        files: summary.files,
        updated_at: summary.updatedAt,
        mine: mine ? 1 : 0,
        fetched_at: this.now(),
      });
    return this.prByKey(key)!;
  }

  prByKey(key: string): PrRow | null {
    return (this.db.prepare("SELECT * FROM prs WHERE key = ?").get(key) as PrRow | undefined) ?? null;
  }

  prByRef(ref: PrRef): PrRow | null {
    return this.prByKey(prKey(ref));
  }

  prById(id: number): PrRow | null {
    return (this.db.prepare("SELECT * FROM prs WHERE id = ?").get(id) as PrRow | undefined) ?? null;
  }

  allPrs(): PrRow[] {
    return this.db.prepare("SELECT * FROM prs ORDER BY COALESCE(updated_at, fetched_at) DESC").all() as PrRow[];
  }

  setDismissed(prId: number, at: number | null): void {
    this.db.prepare("UPDATE prs SET dismissed_at = ? WHERE id = ?").run(at, prId);
  }

  /**
   * The full set of PRs a server listed for one reason. Rows that left the list lose the reason;
   * rows that stay keep their `since`.
   */
  replaceReasons(server: string, reason: Reason, rows: ReadonlyArray<{ prId: number; teams: string[] }>, complete = true): void {
    this.tx(() => {
      const keep = new Set(rows.map((r) => r.prId));
      if (!complete) for (const row of this.db.prepare("SELECT r.pr_id FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE p.server = ? AND r.reason = ?").all(server, reason) as Array<{ pr_id: number }>) keep.add(row.pr_id);
      const existing = this.db.prepare("SELECT r.pr_id FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE p.server = ? AND r.reason = ?").all(server, reason) as Array<{ pr_id: number }>;
      const drop = this.db.prepare("DELETE FROM reasons WHERE pr_id = ? AND reason = ?");
      for (const row of existing) if (!keep.has(row.pr_id)) drop.run(row.pr_id, reason);
      const upsert = this.db.prepare("INSERT INTO reasons (pr_id, reason, teams, since) VALUES (?, ?, ?, ?) ON CONFLICT (pr_id, reason) DO UPDATE SET teams = excluded.teams");
      for (const row of rows) upsert.run(row.prId, reason, JSON.stringify(row.teams), this.now());
    });
  }

  reasons(prId: number): ReasonRow[] {
    return this.db.prepare("SELECT * FROM reasons WHERE pr_id = ? ORDER BY reason").all(prId) as ReasonRow[];
  }

  reasonRows(reason: Reason): Array<ReasonRow & { server: string }> {
    return this.db.prepare("SELECT r.*, p.server FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE r.reason = ?").all(reason) as Array<ReasonRow & { server: string }>;
  }

  link(prId: number, threadId: string, role: LinkRole): void {
    this.db.prepare("INSERT INTO links (pr_id, thread_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (pr_id, thread_id) DO UPDATE SET role = excluded.role").run(prId, threadId, role, this.now());
  }

  unlink(prId: number, threadId: string): boolean {
    return this.db.prepare("DELETE FROM links WHERE pr_id = ? AND thread_id = ?").run(prId, threadId).changes > 0;
  }

  linksOf(prId: number): LinkRow[] {
    return this.db
      .prepare("SELECT l.*, t.title, t.archived FROM links l LEFT JOIN threads t ON t.id = l.thread_id WHERE l.pr_id = ? ORDER BY l.created_at, l.rowid")
      .all(prId) as LinkRow[];
  }

  linkRole(prId: number, threadId: string): LinkRole | null {
    return (this.db.prepare("SELECT role FROM links WHERE pr_id = ? AND thread_id = ?").get(prId, threadId) as { role: LinkRole } | undefined)?.role ?? null;
  }

  prsOfThread(threadId: string): PrRow[] {
    return this.db.prepare("SELECT p.* FROM prs p JOIN links l ON l.pr_id = p.id WHERE l.thread_id = ? ORDER BY l.created_at, l.rowid").all(threadId) as PrRow[];
  }

  linkedThreadIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT thread_id FROM links").all() as Array<{ thread_id: string }>).map((r) => r.thread_id);
  }

  saveThread(id: string, title: string, archived: boolean): void {
    this.db
      .prepare("INSERT INTO threads (id, title, archived, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title, archived = excluded.archived, updated_at = excluded.updated_at")
      .run(id, title, archived ? 1 : 0, this.now());
  }

  /** A deleted thread's links go; an archived thread keeps them, shown as archived. */
  forgetThread(id: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM links WHERE thread_id = ?").run(id);
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    });
  }

  threadTitle(id: string): string | null {
    return (this.db.prepare("SELECT title FROM threads WHERE id = ?").get(id) as { title: string } | undefined)?.title ?? null;
  }

  watch(prId: number): WatchRow | null {
    return (this.db.prepare("SELECT * FROM watches WHERE pr_id = ?").get(prId) as WatchRow | undefined) ?? null;
  }

  setWatch(prId: number, mode: WatchMode | null): void {
    this.tx(() => {
      if (mode === null) {
        this.db.prepare("DELETE FROM watches WHERE pr_id = ?").run(prId);
        this.db.prepare("DELETE FROM pending_items WHERE pr_id = ?").run(prId);
        this.db.prepare("DELETE FROM seen_items WHERE pr_id = ?").run(prId);
        this.db.prepare("DELETE FROM deliveries WHERE pr_id = ?").run(prId);
        return;
      }
      this.db.prepare("INSERT INTO watches (pr_id, mode, baselined, created_at) VALUES (?, ?, 0, ?) ON CONFLICT (pr_id) DO UPDATE SET mode = excluded.mode").run(prId, mode, this.now());
    });
  }

  watches(): WatchRow[] {
    return this.db.prepare("SELECT * FROM watches").all() as WatchRow[];
  }

  markWatchChecked(prId: number, error: string | null, baselined?: boolean): void {
    this.db.prepare("UPDATE watches SET checked_at = ?, error = ?, baselined = CASE WHEN ? THEN 1 ELSE baselined END WHERE pr_id = ?").run(this.now(), error, baselined ? 1 : 0, prId);
  }

  seenIds(prId: number): Set<string> {
    return new Set((this.db.prepare("SELECT item_id FROM seen_items WHERE pr_id = ?").all(prId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  markSeen(prId: number, itemIds: readonly string[]): void {
    this.tx(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO seen_items (pr_id, item_id, at) VALUES (?, ?, ?)");
      const drop = this.db.prepare("DELETE FROM pending_items WHERE pr_id = ? AND item_id = ?");
      for (const id of itemIds) {
        insert.run(prId, id, this.now());
        drop.run(prId, id);
      }
    });
  }

  addPending(prId: number, items: readonly ActivityItem[]): number {
    let added = 0;
    this.tx(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO pending_items (pr_id, item_id, item, first_seen_at) VALUES (?, ?, ?, ?)");
      for (const item of items) added += insert.run(prId, item.id, JSON.stringify(item), this.now()).changes;
    });
    return added;
  }

  pending(prId: number): PendingRow[] {
    const rows = this.db.prepare("SELECT * FROM pending_items WHERE pr_id = ? ORDER BY first_seen_at, item_id").all(prId) as Array<Omit<PendingRow, "item"> & { item: string }>;
    return rows.map((row) => ({ ...row, item: JSON.parse(row.item) as ActivityItem }));
  }

  delivered(prId: number, threadId: string): Set<string> {
    return new Set((this.db.prepare("SELECT item_id FROM deliveries WHERE pr_id = ? AND thread_id = ?").all(prId, threadId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  markDelivered(prId: number, threadId: string, itemIds: readonly string[]): void {
    this.tx(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO deliveries (pr_id, item_id, thread_id, at) VALUES (?, ?, ?, ?)");
      for (const id of itemIds) insert.run(prId, id, threadId, this.now());
    });
  }

  /** Items every owner received are seen; their per-thread delivery rows are no longer needed. */
  settleDeliveries(prId: number, itemIds: readonly string[]): void {
    this.tx(() => {
      this.markSeen(prId, itemIds);
      const drop = this.db.prepare("DELETE FROM deliveries WHERE pr_id = ? AND item_id = ?");
      for (const id of itemIds) drop.run(prId, id);
    });
  }

  pendingCount(prId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM pending_items WHERE pr_id = ?").get(prId) as { n: number }).n;
  }

  addReview(row: Omit<ReviewRow, "id" | "finished_at" | "state" | "created_at">): ReviewRow {
    const result = this.db
      .prepare("INSERT INTO reviews (pr_id, thread_id, preset, trigger, head, state, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
      .run(row.pr_id, row.thread_id, row.preset, row.trigger, row.head, this.now());
    return this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(result.lastInsertRowid) as ReviewRow;
  }

  lastReview(prId: number): ReviewRow | null {
    return (this.db.prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(prId) as ReviewRow | undefined) ?? null;
  }

  reviewsOf(prId: number): ReviewRow[] {
    return this.db.prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at, id").all(prId) as ReviewRow[];
  }

  runningReviewsOfThread(threadId: string): ReviewRow[] {
    return this.db.prepare("SELECT * FROM reviews WHERE thread_id = ? AND state = 'running'").all(threadId) as ReviewRow[];
  }

  finishReview(id: number, state: "done" | "failed"): void {
    this.db.prepare("UPDATE reviews SET state = ?, finished_at = ? WHERE id = ?").run(state, this.now(), id);
  }

  /** A follow-up turn in a review thread starts it again. */
  restartReview(id: number): void {
    this.db.prepare("UPDATE reviews SET state = 'running', finished_at = NULL WHERE id = ?").run(id);
  }

  autoReviewsSince(at: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE trigger = 'auto' AND created_at >= ?").get(at) as { n: number }).n;
  }

  addEvent(kind: string, text: string, prId: number | null = null, threadId: string | null = null): void {
    this.db.prepare("INSERT INTO events (at, kind, text, pr_id, thread_id) VALUES (?, ?, ?, ?, ?)").run(this.now(), kind, text, prId, threadId);
    this.db.prepare("DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)").run();
  }

  events(filter: { prId?: number; threadId?: string; kinds?: string[]; limit: number }): EventRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.prId !== undefined) (where.push("e.pr_id = ?"), args.push(filter.prId));
    if (filter.threadId !== undefined) (where.push("e.thread_id = ?"), args.push(filter.threadId));
    if (filter.kinds?.length) (where.push(`e.kind IN (${filter.kinds.map(() => "?").join(", ")})`), args.push(...filter.kinds));
    const sql = `SELECT e.*, p.key FROM events e LEFT JOIN prs p ON p.id = e.pr_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, filter.limit) as EventRow[];
  }
}
