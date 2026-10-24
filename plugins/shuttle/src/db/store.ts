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
  /** The description, once a view fetched it; null while only lists have seen the PR. */
  body: string | null;
  /** JSON Label[], or null until a server's answer carried them. */
  labels: string | null;
  /** JSON Reviewer[], or null until a server's answer carried them. */
  reviewers: string | null;
  /** When a view (not a list) last read the PR. */
  viewed_at: number | null;
  tracked: number;
  /** With dismissed_at as its start: out of the Inbox until this time, or until the PR changes when null. */
  snoozed_until: number | null;
  /** The feedback the user said they would handle ("I'll do it"), as a signature; null when they did not. */
  handled_sig: string | null;
  created_at: number | null;
  closed_at: number | null;
  /** JSON CheckCounts. */
  check_counts: string | null;
  /** JSON MyReview, as the server last said. */
  my_review: string | null;
  auto_merge: number | null;
  author_bot: number | null;
  requested_at: number | null;
  first_review_at: number | null;
  suggested_thread: string | null;
  suggested_why: string | null;
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
  auto: number;
  title: string | null;
  archived: number | null;
  status: string | null;
  waiting: number | null;
}

export interface DraftRow {
  id: number;
  pr_id: number;
  thread_id: string;
  review_id: number | null;
  head: string | null;
  summary: string;
  verdict: "comment" | "approve" | "changes";
  /** JSON Finding[]. */
  findings: string;
  state: "draft" | "posted" | "discarded";
  created_at: number;
  posted_at: number | null;
  posted_findings: number | null;
}

export interface MyReviewRow {
  id: number;
  pr_id: number;
  verdict: string;
  head: string | null;
  at: number;
  findings: number;
}

export interface OutcomeRow {
  pr_id: number;
  item_id: string;
  outcome: "fixed" | "replied" | "declined" | "question";
  note: string | null;
  commit_sha: string | null;
  thread_id: string | null;
  at: number;
}

export interface RequestRow {
  pr_id: number;
  reason: Reason;
  first_seen: number;
  gone_at: number | null;
}

export interface PhaseRow {
  pr_id: number;
  phase: string;
  start_at: number;
  end_at: number | null;
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
        `INSERT INTO prs (key, server, repo, number, url, title, author, state, checks, review, head, head_ref, base, additions, deletions, files, updated_at, mine, fetched_at, body, labels, reviewers, viewed_at,
           created_at, closed_at, check_counts, my_review, auto_merge, author_bot, requested_at, first_review_at)
         VALUES (@key, @server, @repo, @number, @url, @title, @author, @state, @checks, @review, @head, @head_ref, @base, @additions, @deletions, @files, @updated_at, @mine, @fetched_at, @body,
           @labels, @reviewers, @viewed_at, @created_at, @closed_at, @check_counts, @my_review, @auto_merge, @author_bot, @requested_at, @first_review_at)
         ON CONFLICT (key) DO UPDATE SET url = excluded.url, title = excluded.title, author = excluded.author, state = excluded.state, checks = excluded.checks,
         review = excluded.review, head = excluded.head, head_ref = COALESCE(excluded.head_ref, prs.head_ref), base = COALESCE(excluded.base, prs.base),
         additions = COALESCE(excluded.additions, prs.additions), deletions = COALESCE(excluded.deletions, prs.deletions), files = COALESCE(excluded.files, prs.files),
         updated_at = COALESCE(excluded.updated_at, prs.updated_at), mine = MAX(prs.mine, excluded.mine), fetched_at = excluded.fetched_at,
         body = COALESCE(excluded.body, prs.body), labels = COALESCE(excluded.labels, prs.labels), reviewers = COALESCE(excluded.reviewers, prs.reviewers),
         viewed_at = COALESCE(excluded.viewed_at, prs.viewed_at), created_at = COALESCE(excluded.created_at, prs.created_at),
         closed_at = CASE WHEN excluded.state IN ('merged', 'closed') THEN COALESCE(excluded.closed_at, prs.closed_at, excluded.fetched_at) ELSE NULL END,
         check_counts = excluded.check_counts, my_review = COALESCE(excluded.my_review, prs.my_review), auto_merge = COALESCE(excluded.auto_merge, prs.auto_merge),
         author_bot = COALESCE(excluded.author_bot, prs.author_bot), requested_at = COALESCE(excluded.requested_at, prs.requested_at),
         first_review_at = COALESCE(excluded.first_review_at, prs.first_review_at)`,
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
        body: summary.body,
        labels: summary.labels ? JSON.stringify(summary.labels) : null,
        reviewers: summary.reviewers ? JSON.stringify(summary.reviewers) : null,
        // Only a view carries the description, so it marks the read as a full one.
        viewed_at: summary.body !== null ? this.now() : null,
        created_at: summary.createdAt,
        closed_at: summary.state === "merged" || summary.state === "closed" ? summary.closedAt : null,
        check_counts: summary.checkCounts ? JSON.stringify(summary.checkCounts) : null,
        my_review: summary.myReview ? JSON.stringify(summary.myReview) : null,
        auto_merge: summary.autoMerge === null ? null : summary.autoMerge ? 1 : 0,
        author_bot: summary.authorBot === null ? null : summary.authorBot ? 1 : 0,
        requested_at: summary.requestedAt,
        first_review_at: summary.firstReviewAt,
      });
    return this.prByKey(key)!;
  }

  /** Records a change Shuttle made on the server, until the next read brings the server's own copy. */
  patchPr(id: number, patch: Partial<Pick<PrRow, "state" | "labels" | "reviewers" | "updated_at" | "auto_merge" | "closed_at">>): void {
    const cols = Object.keys(patch).filter((c) => ["state", "labels", "reviewers", "updated_at", "auto_merge", "closed_at"].includes(c));
    if (!cols.length) return;
    this.db.prepare(`UPDATE prs SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
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
    this.db.prepare("UPDATE prs SET dismissed_at = ?, snoozed_until = NULL WHERE id = ?").run(at, prId);
  }

  /** `at` null brings the PR back; `until` null keeps it out until the PR changes. */
  setSnooze(prId: number, at: number | null, until: number | null): void {
    this.db.prepare("UPDATE prs SET dismissed_at = ?, snoozed_until = ? WHERE id = ?").run(at, at === null ? null : until, prId);
  }

  setTracked(prId: number, on: boolean): void {
    this.db.prepare("UPDATE prs SET tracked = ? WHERE id = ?").run(on ? 1 : 0, prId);
  }

  setHandled(prId: number, sig: string | null): void {
    this.db.prepare("UPDATE prs SET handled_sig = ? WHERE id = ?").run(sig, prId);
  }

  setSuggestion(prId: number, threadId: string | null, why: string | null): void {
    this.db.prepare("UPDATE prs SET suggested_thread = ?, suggested_why = ? WHERE id = ?").run(threadId, threadId === null ? null : why, prId);
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
      const had = new Set(existing.map((row) => row.pr_id));
      const upsert = this.db.prepare("INSERT INTO reasons (pr_id, reason, teams, since) VALUES (?, ?, ?, ?) ON CONFLICT (pr_id, reason) DO UPDATE SET teams = excluded.teams");
      for (const row of rows) upsert.run(row.prId, reason, JSON.stringify(row.teams), this.now());
      if (reason === "requested" || reason === "team" || reason === "mentioned") {
        const open = this.db.prepare("INSERT OR IGNORE INTO requests (pr_id, reason, first_seen) VALUES (?, ?, ?)");
        const close = this.db.prepare("UPDATE requests SET gone_at = ? WHERE pr_id = ? AND reason = ? AND gone_at IS NULL");
        for (const row of rows) if (!had.has(row.prId)) open.run(row.prId, reason, this.now());
        for (const row of existing) if (!keep.has(row.pr_id)) close.run(this.now(), row.pr_id, reason);
      }
    });
  }

  requests(since: number): RequestRow[] {
    return this.db.prepare("SELECT * FROM requests WHERE first_seen >= ? OR gone_at IS NULL OR gone_at >= ?").all(since, since) as RequestRow[];
  }

  reasons(prId: number): ReasonRow[] {
    return this.db.prepare("SELECT * FROM reasons WHERE pr_id = ? ORDER BY reason").all(prId) as ReasonRow[];
  }

  reasonRows(reason: Reason): Array<ReasonRow & { server: string }> {
    return this.db.prepare("SELECT r.*, p.server FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE r.reason = ?").all(reason) as Array<ReasonRow & { server: string }>;
  }

  link(prId: number, threadId: string, role: LinkRole, auto = false): void {
    this.db
      .prepare("INSERT INTO links (pr_id, thread_id, role, created_at, auto) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pr_id, thread_id) DO UPDATE SET role = excluded.role, auto = excluded.auto")
      .run(prId, threadId, role, this.now(), auto ? 1 : 0);
  }

  /** Every other owner of the PR becomes a reference link: a PR has one agent. */
  demoteOwners(prId: number, exceptThreadId: string | null): string[] {
    const others = (this.db.prepare("SELECT thread_id FROM links WHERE pr_id = ? AND role = 'owner' AND thread_id IS NOT ?").all(prId, exceptThreadId) as Array<{ thread_id: string }>).map((r) => r.thread_id);
    this.db.prepare("UPDATE links SET role = 'reference', auto = 0 WHERE pr_id = ? AND role = 'owner' AND thread_id IS NOT ?").run(prId, exceptThreadId);
    return others;
  }

  ownerLink(prId: number): LinkRow | null {
    return this.linksOf(prId).find((l) => l.role === "owner") ?? null;
  }

  unlink(prId: number, threadId: string): boolean {
    return this.db.prepare("DELETE FROM links WHERE pr_id = ? AND thread_id = ?").run(prId, threadId).changes > 0;
  }

  linksOf(prId: number): LinkRow[] {
    return this.db
      .prepare("SELECT l.*, t.title, t.archived, t.status, t.waiting FROM links l LEFT JOIN threads t ON t.id = l.thread_id WHERE l.pr_id = ? ORDER BY l.created_at, l.rowid")
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

  saveThread(id: string, title: string, archived: boolean, status?: { status: string; waiting: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO threads (id, title, archived, updated_at, status, waiting) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title,
         archived = excluded.archived, updated_at = excluded.updated_at, status = COALESCE(excluded.status, threads.status), waiting = CASE WHEN excluded.status IS NULL THEN threads.waiting ELSE excluded.waiting END`,
      )
      .run(id, title, archived ? 1 : 0, this.now(), status?.status ?? null, status?.waiting ? 1 : 0);
  }

  /** From bb's thread events: only threads Shuttle already knows. */
  setThreadStatus(id: string, status: string | null, waiting: boolean | null): boolean {
    const result = this.db
      .prepare("UPDATE threads SET status = COALESCE(?, status), waiting = COALESCE(?, waiting) WHERE id = ?")
      .run(status, waiting === null ? null : waiting ? 1 : 0, id);
    return result.changes > 0;
  }

  knowsThread(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(id) !== undefined;
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

  setWatch(prId: number, mode: WatchMode | null, backlog = false): void {
    this.tx(() => {
      if (mode === null) {
        this.db.prepare("DELETE FROM watches WHERE pr_id = ?").run(prId);
        this.db.prepare("DELETE FROM pending_items WHERE pr_id = ?").run(prId);
        this.db.prepare("DELETE FROM seen_items WHERE pr_id = ?").run(prId);
        this.db.prepare("DELETE FROM deliveries WHERE pr_id = ?").run(prId);
        return;
      }
      this.db
        .prepare("INSERT INTO watches (pr_id, mode, baselined, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (pr_id) DO UPDATE SET mode = excluded.mode, baselined = MAX(watches.baselined, excluded.baselined)")
        .run(prId, mode, backlog ? 1 : 0, this.now());
    });
  }

  /** The watch starts again from nothing seen; queued items stay queued. */
  forgetSeen(prId: number): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM seen_items WHERE pr_id = ?").run(prId);
      this.db.prepare("DELETE FROM deliveries WHERE pr_id = ?").run(prId);
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
      const keep = this.db.prepare("INSERT OR IGNORE INTO sent_items (pr_id, item_id, thread_id, at) VALUES (?, ?, ?, ?)");
      for (const id of itemIds) {
        insert.run(prId, id, threadId, this.now());
        keep.run(prId, id, threadId, this.now());
      }
    });
  }

  /** Every item ever sent to a thread for this PR, with when it was first sent. */
  sentItems(prId: number): Map<string, number> {
    // Rows at 0 came from 0.2's seen items: they stop a resend, but nobody knows they were sent.
    const rows = this.db.prepare("SELECT item_id, MIN(at) AS at FROM sent_items WHERE pr_id = ? AND at > 0 GROUP BY item_id").all(prId) as Array<{ item_id: string; at: number }>;
    return new Map(rows.map((r) => [r.item_id, r.at]));
  }

  sentTo(prId: number, threadId: string): Set<string> {
    return new Set((this.db.prepare("SELECT item_id FROM sent_items WHERE pr_id = ? AND thread_id = ?").all(prId, threadId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  sentSince(at: number): Array<{ pr_id: number; item_id: string; at: number }> {
    return this.db.prepare("SELECT pr_id, item_id, MIN(at) AS at FROM sent_items GROUP BY pr_id, item_id HAVING MIN(at) >= ?").all(at) as Array<{ pr_id: number; item_id: string; at: number }>;
  }

  pendingIds(prId: number): Set<string> {
    return new Set((this.db.prepare("SELECT item_id FROM pending_items WHERE pr_id = ?").all(prId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  setOutcome(row: Omit<OutcomeRow, "at">): void {
    this.db
      .prepare(
        `INSERT INTO outcomes (pr_id, item_id, outcome, note, commit_sha, thread_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_id, item_id) DO UPDATE SET outcome = excluded.outcome, note = excluded.note, commit_sha = excluded.commit_sha, thread_id = excluded.thread_id, at = excluded.at`,
      )
      .run(row.pr_id, row.item_id, row.outcome, row.note, row.commit_sha, row.thread_id, this.now());
  }

  outcomes(prId: number): Map<string, OutcomeRow> {
    const rows = this.db.prepare("SELECT * FROM outcomes WHERE pr_id = ?").all(prId) as OutcomeRow[];
    return new Map(rows.map((r) => [r.item_id, r]));
  }

  outcomesSince(at: number): OutcomeRow[] {
    return this.db.prepare("SELECT * FROM outcomes WHERE at >= ?").all(at) as OutcomeRow[];
  }

  addDraft(row: Pick<DraftRow, "pr_id" | "thread_id" | "review_id" | "head" | "summary" | "verdict" | "findings">): DraftRow {
    return this.tx(() => {
      // One live draft per PR: a newer one from the same review replaces it.
      this.db.prepare("UPDATE review_drafts SET state = 'discarded' WHERE pr_id = ? AND state = 'draft'").run(row.pr_id);
      const result = this.db
        .prepare("INSERT INTO review_drafts (pr_id, thread_id, review_id, head, summary, verdict, findings, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)")
        .run(row.pr_id, row.thread_id, row.review_id, row.head, row.summary, row.verdict, row.findings, this.now());
      return this.draftById(Number(result.lastInsertRowid))!;
    });
  }

  draftById(id: number): DraftRow | null {
    return (this.db.prepare("SELECT * FROM review_drafts WHERE id = ?").get(id) as DraftRow | undefined) ?? null;
  }

  liveDraft(prId: number): DraftRow | null {
    return (this.db.prepare("SELECT * FROM review_drafts WHERE pr_id = ? AND state = 'draft' ORDER BY id DESC LIMIT 1").get(prId) as DraftRow | undefined) ?? null;
  }

  setDraftState(id: number, state: DraftRow["state"], postedFindings: number | null = null): void {
    this.db.prepare("UPDATE review_drafts SET state = ?, posted_at = CASE WHEN ? = 'posted' THEN ? ELSE posted_at END, posted_findings = COALESCE(?, posted_findings) WHERE id = ?")
      .run(state, state, this.now(), postedFindings, id);
  }

  hasDraftSince(prId: number, at: number): boolean {
    return this.db.prepare("SELECT 1 FROM review_drafts WHERE pr_id = ? AND created_at >= ?").get(prId, at) !== undefined;
  }

  draftsSince(at: number): DraftRow[] {
    return this.db.prepare("SELECT * FROM review_drafts WHERE created_at >= ?").all(at) as DraftRow[];
  }

  addMyReview(row: Omit<MyReviewRow, "id" | "at">): void {
    this.db.prepare("INSERT INTO my_reviews (pr_id, verdict, head, at, findings) VALUES (?, ?, ?, ?, ?)").run(row.pr_id, row.verdict, row.head, this.now(), row.findings);
  }

  latestMyReview(prId: number): MyReviewRow | null {
    return (this.db.prepare("SELECT * FROM my_reviews WHERE pr_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(prId) as MyReviewRow | undefined) ?? null;
  }

  myReviewsSince(at: number): MyReviewRow[] {
    return this.db.prepare("SELECT * FROM my_reviews WHERE at >= ?").all(at) as MyReviewRow[];
  }

  saveSnapshot(day: string, counts: Record<string, number>): void {
    this.db.prepare("INSERT INTO snapshots (day, counts) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET counts = excluded.counts").run(day, JSON.stringify(counts));
  }

  snapshots(fromDay: string): Array<{ day: string; counts: Record<string, number> }> {
    const rows = this.db.prepare("SELECT * FROM snapshots WHERE day >= ? ORDER BY day").all(fromDay) as Array<{ day: string; counts: string }>;
    return rows.map((r) => ({ day: r.day, counts: JSON.parse(r.counts) as Record<string, number> }));
  }

  /** Records the PR's phase; a change closes the one before. */
  notePhase(prId: number, phase: string | null): void {
    const open = this.db.prepare("SELECT rowid, phase FROM phases WHERE pr_id = ? AND end_at IS NULL").get(prId) as { rowid: number; phase: string } | undefined;
    if (open?.phase === phase) return;
    this.tx(() => {
      if (open) this.db.prepare("UPDATE phases SET end_at = ? WHERE rowid = ?").run(this.now(), open.rowid);
      if (phase) this.db.prepare("INSERT INTO phases (pr_id, phase, start_at) VALUES (?, ?, ?)").run(prId, phase, this.now());
    });
  }

  phases(prIds: readonly number[]): PhaseRow[] {
    if (!prIds.length) return [];
    return this.db.prepare(`SELECT * FROM phases WHERE pr_id IN (${prIds.map(() => "?").join(", ")}) ORDER BY start_at`).all(...prIds) as PhaseRow[];
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

  reviewsSince(at: number): ReviewRow[] {
    return this.db.prepare("SELECT * FROM reviews WHERE created_at >= ?").all(at) as ReviewRow[];
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
