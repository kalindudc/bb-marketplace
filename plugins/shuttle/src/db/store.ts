// Typed repository over the plugin database.
import type Database from "better-sqlite3";
import { DEFAULT_CONFIG, parseConfig, type Config, type WatchMode } from "../config";
import type { BoardArchived, CheckState, InboxRuleKind, LinkRole, PrState, Reason, ReviewState } from "../contract";
import { prKey, type PrRef } from "../keys";
import type { ActivityItem, PrSummary } from "../model";

/** Distinct query texts, not PRs: Shuttle has about 160, so this only bounds queries built with a varying shape. */
const MAX_STATEMENTS = 2000;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

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
  /** When a snooze started; null when the PR is not snoozed. */
  snoozed_at: number | null;
  /** The description, once a view fetched it; null while only lists have seen the PR. */
  body: string | null;
  /** JSON Label[], or null until a server's answer carried them. */
  labels: string | null;
  /** JSON Reviewer[], or null until a server's answer carried them. */
  reviewers: string | null;
  /** When a view (not a list) last read the PR. */
  viewed_at: number | null;
  tracked: number;
  /** With snoozed_at as its start: out of the Inbox until this time, or until the PR changes when null. */
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
  in_merge_queue: number | null;
  author_bot: number | null;
  requested_at: number | null;
  first_review_at: number | null;
  suggested_thread: string | null;
  suggested_why: string | null;
  /** When the user dismissed it from the Inbox, for good; null when not dismissed. */
  inbox_dismissed_at: number | null;
  /** When the user last opened it in Shuttle. */
  seen_at: number | null;
}

export interface InboxRuleRow {
  id: number;
  kind: InboxRuleKind;
  server: string;
  value: string;
  created_at: number;
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
  state: "ok" | "partial" | "failed" | null;
  /** Syncs in a row that did not pass in full. */
  failures: number;
  failing_since: number | null;
  /** JSON {step: epoch ms}: when each step last passed. */
  steps_ok_at: string | null;
  /** JSON step names that failed or did not run in the last sync. */
  failed_steps: string | null;
}

export interface SyncRunRow {
  id: number;
  server: string;
  at: number;
  duration_ms: number;
  state: "ok" | "partial" | "failed";
  /** JSON SyncStep[]. */
  steps: string;
}

const DAY_MS = 86_400_000;

/**
 * The updated_at of a change Shuttle made and could not read back: just past the server's last, in the
 * server's clock, so an older read cannot undo it and the server's next change always can. The host's
 * clock may run ahead of the server's.
 */
export const afterServer = (updatedAt: number | null): number | null => (updatedAt === null ? null : updatedAt + 1);

/**
 * An upsert's answer names another state than the stored row, from before the row's last change: a snapshot taken
 * before a merge, close or reopen, written after it. The newer state stays, whichever way it went.
 */
const STALE_STATE = `(excluded.state != prs.state AND excluded.updated_at IS NOT NULL
  AND prs.updated_at IS NOT NULL AND excluded.updated_at < prs.updated_at)`;

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
  /** Context for the user that is never posted, such as the PR's intent and whether it is worth doing. */
  notes: string | null;
  state: "draft" | "posted" | "discarded";
  created_at: number;
  posted_at: number | null;
  posted_findings: number | null;
  /** JSON Assessment: the reviewer's view of the PR as a whole. */
  assessment: string | null;
  /** JSON Gate: auto post's decision in shadow mode. */
  gate: string | null;
  /** JSON FindingOutcome[]: what the user did with each finding when they posted the draft. */
  outcome: string | null;
  /** Who discarded it: the user, or a newer draft or review that replaced it. */
  discard_reason: "user" | "superseded" | null;
  /** The verdict the user posted from it. */
  posted_verdict: "comment" | "approve" | "changes" | null;
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
  bots: string | null;
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
  /** The run is in a thread Shuttle started for this PR's reviews: Shuttle archives it when the review is done. */
  own_thread: number;
  /** When Shuttle archived the thread after this run; null while it has not. */
  archived_at: number | null;
  /** When Shuttle last saw its thread, or a child thread of it, at work; null on runs from before Shuttle kept it. */
  active_at: number | null;
  /** What ended it; null while it runs, and on runs that ended when a turn did, before Shuttle waited for child threads. */
  ended_by: ReviewEnd | null;
  /** The thread's words when it said the review was over. */
  note: string | null;
  /** JSON of the options it started with (ReviewOptions), so it can start again in a new thread; null on older runs. */
  input: string | null;
  /** Which try of the review it is: 1, or more when Shuttle started it again after a thread that could not set up its workspace. */
  attempt: number;
}

/**
 * A draft came back, the thread said so, the thread failed, its workspace could not be set up, nothing happened in it
 * for too long, or a newer review replaced it.
 */
export type ReviewEnd = "draft" | "thread" | "failed" | "setup" | "quiet" | "replaced";

export type PostState = "queued" | "posting" | "posted" | "failed" | "cancelled";

/** A review waiting to post, posting, or done; `findings` is the JSON of the comments to post. */
export interface PostRow {
  id: number;
  pr_id: number;
  server: string;
  draft_id: number | null;
  verdict: "comment" | "approve" | "changes";
  body: string;
  findings: string;
  stale_ok: number;
  state: PostState;
  error: string | null;
  placed: number | null;
  in_body: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** A failed post the user dismissed, or one a later post of the PR made moot. */
  cleared_at: number | null;
}

export type MergeRunState = "queued" | "merging" | "done" | "failed" | "cancelled";

/** A merge of one of the user's PRs waiting its turn, merging, or done; `auto` turns on the server's auto-merge instead. */
export interface MergeRow {
  id: number;
  pr_id: number;
  server: string;
  method: "squash" | "merge" | "rebase";
  /** It merges only while the PR is still at this commit. */
  head: string;
  auto: number;
  delete_branch: number;
  subject: string | null;
  state: MergeRunState;
  /** What a done merge did: merged, turned on auto-merge, or was taken by the server while the PR stayed open. */
  outcome: "merged" | "auto_merge" | "sent" | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** A failed merge the user dismissed, or one a later merge of the PR made moot. */
  cleared_at: number | null;
}

export interface ThreadRow {
  id: string;
  title: string;
  archived: number;
  status: string | null;
  waiting: number;
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

export interface BoardRow {
  id: string;
  name: string;
  name_key: string;
  description: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  created_by: string | null;
}

export interface BoardActivityRow {
  id: number;
  board_id: string;
  at: number;
  text: string;
  thread_id: string | null;
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

  /**
   * Every query, compiled once. A list read runs a dozen queries for each of a thousand PRs on bb's server thread, and
   * compiling each one again was a third of that time. Queries built with a varying shape are few; the cap bounds them.
   */
  private sql(text: string): Database.Statement {
    let statement = this.statements.get(text);
    if (statement === undefined) {
      if (this.statements.size >= MAX_STATEMENTS) this.statements.clear();
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    // Every query goes through here just before it runs, so a statement that returns no rows is about to write.
    if (!statement.reader) this.writes += 1;
    return statement;
  }
  private readonly statements = new Map<string, Database.Statement>();
  private writes = 0;
  /** The config as last parsed; dropped when it is written. */
  private parsedConfig: Config | null = null;

  /** Changes whenever anything is written, so what was read from the store can be kept until then. */
  get version(): number {
    return this.writes;
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Parsed once and kept until Shuttle writes it again: every PR in a list asks for its server's config, and reading and
   * parsing it each time was another third of a list read. It is frozen, since every caller shares it.
   */
  config(): Config {
    if (this.parsedConfig !== null) return this.parsedConfig;
    const row = this.sql("SELECT value FROM kv WHERE key = 'config'").get() as { value: string } | undefined;
    if (!row) return DEFAULT_CONFIG;
    this.parsedConfig = deepFreeze(parseConfig(JSON.parse(row.value)));
    return this.parsedConfig;
  }

  saveConfig(config: Config): void {
    this.parsedConfig = null;
    this.sql("INSERT INTO kv (key, value) VALUES ('config', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(config));
  }

  kv(key: string): string | null {
    return (this.sql("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  setKv(key: string, value: string): void {
    if (key === "config") this.parsedConfig = null;
    this.sql("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteKv(key: string): void {
    this.sql("DELETE FROM kv WHERE key = ?").run(key);
  }

  server(id: string): ServerRow | null {
    return (this.sql("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined) ?? null;
  }

  saveServer(row: ServerRow): void {
    this.sql(
        `INSERT INTO servers (id, ok, login, error, last_ok_at, last_sync_at, duration_ms, baseline_at, state, failures, failing_since, steps_ok_at, failed_steps)
         VALUES (@id, @ok, @login, @error, @last_ok_at, @last_sync_at, @duration_ms, @baseline_at, @state, @failures, @failing_since, @steps_ok_at, @failed_steps)
         ON CONFLICT (id) DO UPDATE SET ok = excluded.ok, login = excluded.login, error = excluded.error, last_ok_at = excluded.last_ok_at,
         last_sync_at = excluded.last_sync_at, duration_ms = excluded.duration_ms, baseline_at = excluded.baseline_at, state = excluded.state,
         failures = excluded.failures, failing_since = excluded.failing_since, steps_ok_at = excluded.steps_ok_at, failed_steps = excluded.failed_steps`,
      )
      .run(row);
  }

  /** Passing syncs stay a day and the others a week, enough for the Sync tab. */
  addSyncRun(run: Omit<SyncRunRow, "id">): void {
    this.sql("INSERT INTO sync_runs (server, at, duration_ms, state, steps) VALUES (@server, @at, @duration_ms, @state, @steps)").run(run);
    const now = this.now();
    this.sql("DELETE FROM sync_runs WHERE (state = 'ok' AND at < ?) OR at < ?").run(now - DAY_MS, now - 7 * DAY_MS);
    this.sql("DELETE FROM sync_runs WHERE id <= (SELECT MAX(id) - 5000 FROM sync_runs)").run();
  }

  /** Oldest first. */
  syncRuns(server: string, since: number): SyncRunRow[] {
    return this.sql("SELECT * FROM sync_runs WHERE server = ? AND at >= ? ORDER BY at, id").all(server, since) as SyncRunRow[];
  }

  /** Newest first: the syncs that did not pass in full. */
  failedSyncRuns(server: string, since: number, limit: number): SyncRunRow[] {
    return this.sql("SELECT * FROM sync_runs WHERE server = ? AND at >= ? AND state != 'ok' ORDER BY at DESC, id DESC LIMIT ?").all(server, since, limit) as SyncRunRow[];
  }

  lastSyncRun(server: string): SyncRunRow | null {
    return (this.sql("SELECT * FROM sync_runs WHERE server = ? ORDER BY at DESC, id DESC LIMIT 1").get(server) as SyncRunRow | undefined) ?? null;
  }

  /**
   * Inserts or refreshes a PR from its server's summary. `mine` only ever turns on. An answer read before the PR
   * merged or closed never makes it open again; a real reopen is newer, so it gets through. `viewed` says the PR
   * was read by itself, which brings what lists may lack, such as its reviewers; by default a read with a description is.
   */
  upsertPr(server: string, summary: PrSummary, url: string, mine: boolean, viewed = summary.body !== null): PrRow {
    const key = prKey({ server, repo: summary.repo, number: summary.number });
    this.sql(
        `INSERT INTO prs (key, server, repo, number, url, title, author, state, checks, review, head, head_ref, base, additions, deletions, files, updated_at, mine, fetched_at, body, labels, reviewers, viewed_at,
           created_at, closed_at, check_counts, my_review, auto_merge, in_merge_queue, author_bot, requested_at, first_review_at)
         VALUES (@key, @server, @repo, @number, @url, @title, @author, @state, @checks, @review, @head, @head_ref, @base, @additions, @deletions, @files, @updated_at, @mine, @fetched_at, @body,
           @labels, @reviewers, @viewed_at, @created_at, @closed_at, @check_counts, @my_review, @auto_merge, @in_merge_queue, @author_bot, @requested_at, @first_review_at)
         ON CONFLICT (key) DO UPDATE SET url = excluded.url, title = excluded.title, author = excluded.author,
         state = CASE WHEN ${STALE_STATE} THEN prs.state ELSE excluded.state END, checks = excluded.checks,
         review = excluded.review, head = excluded.head, head_ref = COALESCE(excluded.head_ref, prs.head_ref), base = COALESCE(excluded.base, prs.base),
         additions = COALESCE(excluded.additions, prs.additions), deletions = COALESCE(excluded.deletions, prs.deletions), files = COALESCE(excluded.files, prs.files),
         updated_at = CASE WHEN ${STALE_STATE} THEN prs.updated_at ELSE COALESCE(excluded.updated_at, prs.updated_at) END, mine = MAX(prs.mine, excluded.mine), fetched_at = excluded.fetched_at,
         body = COALESCE(excluded.body, prs.body), labels = COALESCE(excluded.labels, prs.labels), reviewers = COALESCE(excluded.reviewers, prs.reviewers),
         viewed_at = COALESCE(excluded.viewed_at, prs.viewed_at), created_at = COALESCE(excluded.created_at, prs.created_at),
         closed_at = CASE WHEN ${STALE_STATE} THEN prs.closed_at WHEN excluded.state IN ('merged', 'closed') THEN COALESCE(excluded.closed_at, prs.closed_at, excluded.fetched_at) ELSE NULL END,
         check_counts = excluded.check_counts, my_review = COALESCE(excluded.my_review, prs.my_review), auto_merge = COALESCE(excluded.auto_merge, prs.auto_merge),
         in_merge_queue = COALESCE(excluded.in_merge_queue, prs.in_merge_queue),
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
        viewed_at: viewed ? this.now() : null,
        created_at: summary.createdAt,
        closed_at: summary.state === "merged" || summary.state === "closed" ? summary.closedAt : null,
        check_counts: summary.checkCounts ? JSON.stringify(summary.checkCounts) : null,
        my_review: summary.myReview ? JSON.stringify(summary.myReview) : null,
        auto_merge: summary.autoMerge === null ? null : summary.autoMerge ? 1 : 0,
        in_merge_queue: summary.inMergeQueue === null ? null : summary.inMergeQueue ? 1 : 0,
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
    this.sql(`UPDATE prs SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
  }

  prByKey(key: string): PrRow | null {
    return (this.sql("SELECT * FROM prs WHERE key = ?").get(key) as PrRow | undefined) ?? null;
  }

  prByRef(ref: PrRef): PrRow | null {
    return this.prByKey(prKey(ref));
  }

  prById(id: number): PrRow | null {
    return (this.sql("SELECT * FROM prs WHERE id = ?").get(id) as PrRow | undefined) ?? null;
  }

  /** The PR on a server's repo whose head commit starts with `sha`, the most recently updated first. Heads shorter than 7 characters never match. */
  prByHead(server: string, repo: string, sha: string): PrRow | null {
    return (this.sql("SELECT * FROM prs WHERE server = ? AND repo = ? AND length(head) >= 7 AND (substr(head, 1, length(?)) = ? OR substr(?, 1, length(head)) = head) ORDER BY COALESCE(updated_at, fetched_at) DESC LIMIT 1")
      .get(server, repo, sha, sha, sha) as PrRow | undefined) ?? null;
  }

  /**
   * Every PR, the most recently updated first. Descriptions are most of the table's bytes and only search reads
   * them, so without `bodies` each row's body is null.
   */
  allPrs(options: { bodies: true }): PrRow[];
  allPrs(): Array<PrRow & { body: null }>;
  allPrs(options: { bodies?: boolean } = {}): PrRow[] {
    if (options.bodies) return this.sql("SELECT * FROM prs ORDER BY COALESCE(updated_at, fetched_at) DESC").all() as PrRow[];
    this.prColumns ??= (this.sql("SELECT name FROM pragma_table_info('prs')").all() as { name: string }[]).map((column) => (column.name === "body" ? "NULL AS body" : `"${column.name}"`)).join(", ");
    return this.sql(`SELECT ${this.prColumns} FROM prs ORDER BY COALESCE(updated_at, fetched_at) DESC`).all() as PrRow[];
  }
  private prColumns: string | undefined;

  /** `at` null brings the PR back; `until` null keeps it out until the PR changes. */
  setSnooze(prId: number, at: number | null, until: number | null): void {
    this.sql("UPDATE prs SET snoozed_at = ?, snoozed_until = ? WHERE id = ?").run(at, at === null ? null : until, prId);
  }

  /** `at` null restores the PRs to the Inbox. */
  setInboxDismissed(prIds: readonly number[], at: number | null): void {
    this.tx(() => {
      const update = this.sql("UPDATE prs SET inbox_dismissed_at = ? WHERE id = ?");
      for (const id of prIds) update.run(at, id);
    });
  }

  setSeenAt(prIds: readonly number[], at: number): void {
    this.tx(() => {
      const update = this.sql("UPDATE prs SET seen_at = ? WHERE id = ?");
      for (const id of prIds) update.run(at, id);
    });
  }

  /** Newest first. */
  inboxRules(): InboxRuleRow[] {
    return this.sql("SELECT * FROM inbox_rules ORDER BY created_at DESC, id DESC").all() as InboxRuleRow[];
  }

  inboxRule(id: number): InboxRuleRow | null {
    return (this.sql("SELECT * FROM inbox_rules WHERE id = ?").get(id) as InboxRuleRow | undefined) ?? null;
  }

  /** The same rule twice is one rule: the existing one comes back, with `created` false. */
  addInboxRule(kind: InboxRuleKind, server: string, value: string): InboxRuleRow & { created: boolean } {
    const created = this.sql("INSERT OR IGNORE INTO inbox_rules (kind, server, value, created_at) VALUES (?, ?, ?, ?)").run(kind, server, value, this.now()).changes > 0;
    const row = this.sql("SELECT * FROM inbox_rules WHERE kind = ? AND server = ? AND value = ?").get(kind, server, value) as InboxRuleRow;
    return { ...row, created };
  }

  removeInboxRule(id: number): boolean {
    return this.sql("DELETE FROM inbox_rules WHERE id = ?").run(id).changes > 0;
  }

  setTracked(prId: number, on: boolean): void {
    this.sql("UPDATE prs SET tracked = ? WHERE id = ?").run(on ? 1 : 0, prId);
  }

  setHandled(prId: number, sig: string | null): void {
    this.sql("UPDATE prs SET handled_sig = ? WHERE id = ?").run(sig, prId);
  }

  setSuggestion(prId: number, threadId: string | null, why: string | null): void {
    this.sql("UPDATE prs SET suggested_thread = ?, suggested_why = ? WHERE id = ?").run(threadId, threadId === null ? null : why, prId);
  }

  /**
   * The full set of PRs a server listed for one reason. Rows that left the list lose the reason;
   * rows that stay keep their `since`.
   */
  replaceReasons(server: string, reason: Reason, rows: ReadonlyArray<{ prId: number; teams: string[] }>, complete = true): void {
    this.tx(() => {
      const keep = new Set(rows.map((r) => r.prId));
      if (!complete) for (const row of this.sql("SELECT r.pr_id FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE p.server = ? AND r.reason = ?").all(server, reason) as Array<{ pr_id: number }>) keep.add(row.pr_id);
      const existing = this.sql("SELECT r.pr_id FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE p.server = ? AND r.reason = ?").all(server, reason) as Array<{ pr_id: number }>;
      const drop = this.sql("DELETE FROM reasons WHERE pr_id = ? AND reason = ?");
      for (const row of existing) if (!keep.has(row.pr_id)) drop.run(row.pr_id, reason);
      const had = new Set(existing.map((row) => row.pr_id));
      const upsert = this.sql("INSERT INTO reasons (pr_id, reason, teams, since) VALUES (?, ?, ?, ?) ON CONFLICT (pr_id, reason) DO UPDATE SET teams = excluded.teams");
      for (const row of rows) upsert.run(row.prId, reason, JSON.stringify(row.teams), this.now());
      if (reason === "requested" || reason === "team" || reason === "mentioned") {
        const open = this.sql("INSERT OR IGNORE INTO requests (pr_id, reason, first_seen) VALUES (?, ?, ?)");
        const close = this.sql("UPDATE requests SET gone_at = ? WHERE pr_id = ? AND reason = ? AND gone_at IS NULL");
        for (const row of rows) if (!had.has(row.prId)) open.run(row.prId, reason, this.now());
        for (const row of existing) if (!keep.has(row.pr_id)) close.run(this.now(), row.pr_id, reason);
      }
    });
  }

  requests(since: number): RequestRow[] {
    return this.sql("SELECT * FROM requests WHERE first_seen >= ? OR gone_at IS NULL OR gone_at >= ?").all(since, since) as RequestRow[];
  }

  reasons(prId: number): ReasonRow[] {
    return this.sql("SELECT * FROM reasons WHERE pr_id = ? ORDER BY reason").all(prId) as ReasonRow[];
  }

  reasonRows(reason: Reason): Array<ReasonRow & { server: string }> {
    return this.sql("SELECT r.*, p.server FROM reasons r JOIN prs p ON p.id = r.pr_id WHERE r.reason = ?").all(reason) as Array<ReasonRow & { server: string }>;
  }

  link(prId: number, threadId: string, role: LinkRole, auto = false): void {
    this.sql("INSERT INTO links (pr_id, thread_id, role, created_at, auto) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pr_id, thread_id) DO UPDATE SET role = excluded.role, auto = excluded.auto")
      .run(prId, threadId, role, this.now(), auto ? 1 : 0);
  }

  /** Every other owner of the PR becomes a reference link: a PR has one agent. */
  demoteOwners(prId: number, exceptThreadId: string | null): string[] {
    const others = (this.sql("SELECT thread_id FROM links WHERE pr_id = ? AND role = 'owner' AND thread_id IS NOT ?").all(prId, exceptThreadId) as Array<{ thread_id: string }>).map((r) => r.thread_id);
    this.sql("UPDATE links SET role = 'reference', auto = 0 WHERE pr_id = ? AND role = 'owner' AND thread_id IS NOT ?").run(prId, exceptThreadId);
    return others;
  }

  ownerLink(prId: number): LinkRow | null {
    return this.linksOf(prId).find((l) => l.role === "owner") ?? null;
  }

  unlink(prId: number, threadId: string): boolean {
    return this.sql("DELETE FROM links WHERE pr_id = ? AND thread_id = ?").run(prId, threadId).changes > 0;
  }

  linksOf(prId: number): LinkRow[] {
    return this.sql("SELECT l.*, t.title, t.archived, t.status, t.waiting FROM links l LEFT JOIN threads t ON t.id = l.thread_id WHERE l.pr_id = ? ORDER BY l.created_at, l.rowid")
      .all(prId) as LinkRow[];
  }

  linkRole(prId: number, threadId: string): LinkRole | null {
    return (this.sql("SELECT role FROM links WHERE pr_id = ? AND thread_id = ?").get(prId, threadId) as { role: LinkRole } | undefined)?.role ?? null;
  }

  prsOfThread(threadId: string): PrRow[] {
    return this.sql("SELECT p.* FROM prs p JOIN links l ON l.pr_id = p.id WHERE l.thread_id = ? ORDER BY l.created_at, l.rowid").all(threadId) as PrRow[];
  }

  linkedThreadIds(): string[] {
    return (this.sql("SELECT DISTINCT thread_id FROM links").all() as Array<{ thread_id: string }>).map((r) => r.thread_id);
  }

  saveThread(id: string, title: string, archived: boolean, status?: { status: string; waiting: boolean }): void {
    this.sql(
        `INSERT INTO threads (id, title, archived, updated_at, status, waiting) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title,
         archived = excluded.archived, updated_at = excluded.updated_at, status = COALESCE(excluded.status, threads.status), waiting = CASE WHEN excluded.status IS NULL THEN threads.waiting ELSE excluded.waiting END`,
      )
      .run(id, title, archived ? 1 : 0, this.now(), status?.status ?? null, status?.waiting ? 1 : 0);
  }

  /** From bb's thread events: only threads Shuttle already knows. */
  setThreadStatus(id: string, status: string | null, waiting: boolean | null): boolean {
    const result = this.sql("UPDATE threads SET status = COALESCE(?, status), waiting = COALESCE(?, waiting) WHERE id = ?")
      .run(status, waiting === null ? null : waiting ? 1 : 0, id);
    return result.changes > 0;
  }

  knowsThread(id: string): boolean {
    return this.sql("SELECT 1 FROM threads WHERE id = ?").get(id) !== undefined;
  }

  /** A deleted thread's links go; an archived thread keeps them, shown as archived. */
  forgetThread(id: string): void {
    this.tx(() => {
      this.sql("DELETE FROM links WHERE thread_id = ?").run(id);
      this.sql("DELETE FROM threads WHERE id = ?").run(id);
    });
  }

  thread(id: string): ThreadRow | null {
    return (this.sql("SELECT id, title, archived, status, waiting FROM threads WHERE id = ?").get(id) as ThreadRow | undefined) ?? null;
  }

  setThreadArchived(id: string, archived: boolean): void {
    this.sql("UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, this.now(), id);
  }

  threadTitle(id: string): string | null {
    return (this.sql("SELECT title FROM threads WHERE id = ?").get(id) as { title: string } | undefined)?.title ?? null;
  }

  board(id: string): BoardRow | null {
    return (this.sql("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined) ?? null;
  }

  boardByNameKey(nameKey: string): BoardRow | null {
    return (this.sql("SELECT * FROM boards WHERE name_key = ?").get(nameKey) as BoardRow | undefined) ?? null;
  }

  boards(filter: { archived: BoardArchived; prId?: number } = { archived: "include" }): BoardRow[] {
    const where = filter.archived === "exclude" ? "b.archived_at IS NULL" : filter.archived === "only" ? "b.archived_at IS NOT NULL" : "1 = 1";
    const join = filter.prId === undefined ? "" : "JOIN board_members m ON m.board_id = b.id AND m.pr_id = ?";
    return this.sql(`SELECT DISTINCT b.* FROM boards b ${join} WHERE ${where} ORDER BY b.created_at DESC, b.id DESC`).all(...(filter.prId === undefined ? [] : [filter.prId])) as BoardRow[];
  }

  addBoard(row: BoardRow): void {
    this.sql("INSERT INTO boards (id, name, name_key, description, created_at, updated_at, archived_at, created_by) VALUES (@id, @name, @name_key, @description, @created_at, @updated_at, @archived_at, @created_by)").run(row);
  }

  saveBoard(row: BoardRow): void {
    this.sql("UPDATE boards SET name = @name, name_key = @name_key, description = @description, updated_at = @updated_at, archived_at = @archived_at, created_by = @created_by WHERE id = @id").run(row);
  }

  boardPrIds(boardId: string): number[] {
    return (this.sql("SELECT pr_id FROM board_members WHERE board_id = ? ORDER BY position, rowid").all(boardId) as Array<{ pr_id: number }>).map((row) => row.pr_id);
  }

  boardPrs(boardId: string): PrRow[] {
    return this.sql("SELECT p.* FROM prs p JOIN board_members m ON m.pr_id = p.id WHERE m.board_id = ? ORDER BY m.position, m.rowid").all(boardId) as PrRow[];
  }

  maxBoardPosition(boardId: string): number {
    return (this.sql("SELECT COALESCE(MAX(position), 0) AS n FROM board_members WHERE board_id = ?").get(boardId) as { n: number }).n;
  }

  addBoardMember(boardId: string, prId: number, position: number): boolean {
    return this.sql("INSERT OR IGNORE INTO board_members (board_id, pr_id, position, added_at) VALUES (?, ?, ?, ?)").run(boardId, prId, position, this.now()).changes > 0;
  }

  removeBoardMember(boardId: string, prId: number): boolean {
    return this.sql("DELETE FROM board_members WHERE board_id = ? AND pr_id = ?").run(boardId, prId).changes > 0;
  }

  prInActiveBoard(prId: number): boolean {
    return this.sql("SELECT 1 FROM board_members m JOIN boards b ON b.id = m.board_id WHERE m.pr_id = ? AND b.archived_at IS NULL LIMIT 1").get(prId) !== undefined;
  }

  addBoardActivity(boardId: string, text: string, threadId: string | null = null): void {
    this.sql("INSERT INTO board_activity (board_id, at, text, thread_id) VALUES (?, ?, ?, ?)").run(boardId, this.now(), text, threadId);
  }

  boardActivity(boardId: string, limit: number): BoardActivityRow[] {
    return this.sql("SELECT * FROM board_activity WHERE board_id = ? ORDER BY id DESC LIMIT ?").all(boardId, limit) as BoardActivityRow[];
  }

  watch(prId: number): WatchRow | null {
    return (this.sql("SELECT * FROM watches WHERE pr_id = ?").get(prId) as WatchRow | undefined) ?? null;
  }

  setWatch(prId: number, mode: WatchMode | null, backlog = false): void {
    this.tx(() => {
      if (mode === null) {
        this.sql("DELETE FROM watches WHERE pr_id = ?").run(prId);
        this.sql("DELETE FROM pending_items WHERE pr_id = ?").run(prId);
        this.sql("DELETE FROM seen_items WHERE pr_id = ?").run(prId);
        this.sql("DELETE FROM deliveries WHERE pr_id = ?").run(prId);
        return;
      }
      this.sql("INSERT INTO watches (pr_id, mode, baselined, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (pr_id) DO UPDATE SET mode = excluded.mode, baselined = MAX(watches.baselined, excluded.baselined)")
        .run(prId, mode, backlog ? 1 : 0, this.now());
    });
  }

  /** The watch starts again from nothing seen; queued items stay queued. */
  forgetSeen(prId: number): void {
    this.tx(() => {
      this.sql("DELETE FROM seen_items WHERE pr_id = ?").run(prId);
      this.sql("DELETE FROM deliveries WHERE pr_id = ?").run(prId);
    });
  }

  watches(): WatchRow[] {
    return this.sql("SELECT * FROM watches").all() as WatchRow[];
  }

  markWatchChecked(prId: number, error: string | null, baselined?: boolean): void {
    this.sql("UPDATE watches SET checked_at = ?, error = ?, baselined = CASE WHEN ? THEN 1 ELSE baselined END WHERE pr_id = ?").run(this.now(), error, baselined ? 1 : 0, prId);
  }

  setWatchBots(prId: number, bots: string): void {
    this.sql("UPDATE watches SET bots = ? WHERE pr_id = ?").run(bots, prId);
  }

  seenIds(prId: number): Set<string> {
    return new Set((this.sql("SELECT item_id FROM seen_items WHERE pr_id = ?").all(prId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  markSeen(prId: number, itemIds: readonly string[]): void {
    this.tx(() => {
      const insert = this.sql("INSERT OR IGNORE INTO seen_items (pr_id, item_id, at) VALUES (?, ?, ?)");
      const drop = this.sql("DELETE FROM pending_items WHERE pr_id = ? AND item_id = ?");
      for (const id of itemIds) {
        insert.run(prId, id, this.now());
        drop.run(prId, id);
      }
    });
  }

  addPending(prId: number, items: readonly ActivityItem[]): number {
    let added = 0;
    this.tx(() => {
      const insert = this.sql("INSERT OR IGNORE INTO pending_items (pr_id, item_id, item, first_seen_at) VALUES (?, ?, ?, ?)");
      for (const item of items) added += insert.run(prId, item.id, JSON.stringify(item), this.now()).changes;
    });
    return added;
  }

  pending(prId: number): PendingRow[] {
    const rows = this.sql("SELECT * FROM pending_items WHERE pr_id = ? ORDER BY first_seen_at, item_id").all(prId) as Array<Omit<PendingRow, "item"> & { item: string }>;
    return rows.map((row) => ({ ...row, item: JSON.parse(row.item) as ActivityItem }));
  }

  delivered(prId: number, threadId: string): Set<string> {
    return new Set((this.sql("SELECT item_id FROM deliveries WHERE pr_id = ? AND thread_id = ?").all(prId, threadId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  markDelivered(prId: number, threadId: string, itemIds: readonly string[]): void {
    this.tx(() => {
      const insert = this.sql("INSERT OR IGNORE INTO deliveries (pr_id, item_id, thread_id, at) VALUES (?, ?, ?, ?)");
      const keep = this.sql("INSERT OR IGNORE INTO sent_items (pr_id, item_id, thread_id, at) VALUES (?, ?, ?, ?)");
      for (const id of itemIds) {
        insert.run(prId, id, threadId, this.now());
        keep.run(prId, id, threadId, this.now());
      }
    });
  }

  /** Every item ever sent to a thread for this PR, with when it was first sent. */
  sentItems(prId: number): Map<string, number> {
    // Rows at 0 came from 0.2's seen items: they stop a resend, but nobody knows they were sent.
    const rows = this.sql("SELECT item_id, MIN(at) AS at FROM sent_items WHERE pr_id = ? AND at > 0 GROUP BY item_id").all(prId) as Array<{ item_id: string; at: number }>;
    return new Map(rows.map((r) => [r.item_id, r.at]));
  }

  sentTo(prId: number, threadId: string): Set<string> {
    return new Set((this.sql("SELECT item_id FROM sent_items WHERE pr_id = ? AND thread_id = ?").all(prId, threadId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  sentSince(at: number): Array<{ pr_id: number; item_id: string; at: number }> {
    return this.sql("SELECT pr_id, item_id, MIN(at) AS at FROM sent_items GROUP BY pr_id, item_id HAVING MIN(at) >= ?").all(at) as Array<{ pr_id: number; item_id: string; at: number }>;
  }

  pendingIds(prId: number): Set<string> {
    return new Set((this.sql("SELECT item_id FROM pending_items WHERE pr_id = ?").all(prId) as Array<{ item_id: string }>).map((r) => r.item_id));
  }

  setOutcome(row: Omit<OutcomeRow, "at">): void {
    this.sql(
        `INSERT INTO outcomes (pr_id, item_id, outcome, note, commit_sha, thread_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_id, item_id) DO UPDATE SET outcome = excluded.outcome, note = excluded.note, commit_sha = excluded.commit_sha, thread_id = excluded.thread_id, at = excluded.at`,
      )
      .run(row.pr_id, row.item_id, row.outcome, row.note, row.commit_sha, row.thread_id, this.now());
  }

  outcomes(prId: number): Map<string, OutcomeRow> {
    const rows = this.sql("SELECT * FROM outcomes WHERE pr_id = ?").all(prId) as OutcomeRow[];
    return new Map(rows.map((r) => [r.item_id, r]));
  }

  outcomesSince(at: number): OutcomeRow[] {
    return this.sql("SELECT * FROM outcomes WHERE at >= ?").all(at) as OutcomeRow[];
  }

  addDraft(row: Pick<DraftRow, "pr_id" | "thread_id" | "review_id" | "head" | "summary" | "verdict" | "findings" | "notes"> & { assessment?: string | null }): DraftRow {
    return this.tx(() => {
      // One live draft per PR: a newer one from the same review replaces it, except one queued to post, which is the user's choice and still posts.
      this.sql(
        `UPDATE review_drafts SET state = 'discarded', discard_reason = 'superseded' WHERE pr_id = ? AND state = 'draft'
         AND id NOT IN (SELECT draft_id FROM review_posts WHERE draft_id IS NOT NULL AND state IN ('queued', 'posting'))`,
      ).run(row.pr_id);
      const result = this.sql("INSERT INTO review_drafts (pr_id, thread_id, review_id, head, summary, verdict, findings, notes, assessment, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)")
        .run(row.pr_id, row.thread_id, row.review_id, row.head, row.summary, row.verdict, row.findings, row.notes, row.assessment ?? null, this.now());
      return this.draftById(Number(result.lastInsertRowid))!;
    });
  }

  /** A draft a newer one replaced while it was queued to post stops being live once that post is cancelled or dismissed. */
  retireReplacedDraft(id: number): void {
    this.sql(
      `UPDATE review_drafts SET state = 'discarded', discard_reason = 'superseded' WHERE id = ? AND state = 'draft'
       AND EXISTS (SELECT 1 FROM review_drafts newer WHERE newer.pr_id = review_drafts.pr_id AND newer.state = 'draft' AND newer.id > review_drafts.id)`,
    ).run(id);
  }

  draftById(id: number): DraftRow | null {
    return (this.sql("SELECT * FROM review_drafts WHERE id = ?").get(id) as DraftRow | undefined) ?? null;
  }

  liveDraft(prId: number): DraftRow | null {
    return (this.sql("SELECT * FROM review_drafts WHERE pr_id = ? AND state = 'draft' ORDER BY id DESC LIMIT 1").get(prId) as DraftRow | undefined) ?? null;
  }

  /** A discard says who discarded it; any other state clears that. */
  setDraftState(id: number, state: DraftRow["state"], postedFindings: number | null = null, reason: "user" | "superseded" | null = null): void {
    this.sql("UPDATE review_drafts SET state = ?, posted_at = CASE WHEN ? = 'posted' THEN ? ELSE posted_at END, posted_findings = COALESCE(?, posted_findings), discard_reason = ? WHERE id = ?")
      .run(state, state, this.now(), postedFindings, state === "discarded" ? reason : null, id);
  }

  setDraftGate(id: number, gate: string): void {
    this.sql("UPDATE review_drafts SET gate = ? WHERE id = ?").run(gate, id);
  }

  setDraftOutcome(id: number, outcome: string | null, verdict: DraftRow["posted_verdict"]): void {
    this.sql("UPDATE review_drafts SET outcome = ?, posted_verdict = ? WHERE id = ?").run(outcome, verdict, id);
  }

  /** How many AI review drafts Shuttle holds for the PR, in any state. */
  draftCount(prId: number): number {
    return (this.sql("SELECT count(*) AS n FROM review_drafts WHERE pr_id = ?").get(prId) as { n: number }).n;
  }

  /** The PR's drafts, the live one too, newest first: what its reviews said, notes and all. */
  pastDrafts(prId: number, limit = 40): DraftRow[] {
    return this.sql("SELECT * FROM review_drafts WHERE pr_id = ? ORDER BY id DESC LIMIT ?").all(prId, limit) as DraftRow[];
  }

  /** Drafts auto post decided about, oldest first. */
  gatedDrafts(): DraftRow[] {
    return this.sql("SELECT * FROM review_drafts WHERE gate IS NOT NULL ORDER BY created_at, id").all() as DraftRow[];
  }

  hasDraftSince(prId: number, at: number): boolean {
    return this.sql("SELECT 1 FROM review_drafts WHERE pr_id = ? AND created_at >= ?").get(prId, at) !== undefined;
  }

  draftsSince(at: number): DraftRow[] {
    return this.sql("SELECT * FROM review_drafts WHERE created_at >= ?").all(at) as DraftRow[];
  }

  addPost(row: Pick<PostRow, "pr_id" | "server" | "draft_id" | "verdict" | "body" | "findings" | "stale_ok">): PostRow {
    const result = this.sql("INSERT INTO review_posts (pr_id, server, draft_id, verdict, body, findings, stale_ok, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)")
      .run(row.pr_id, row.server, row.draft_id, row.verdict, row.body, row.findings, row.stale_ok, this.now());
    return this.postById(Number(result.lastInsertRowid))!;
  }

  postById(id: number): PostRow | null {
    return (this.sql("SELECT * FROM review_posts WHERE id = ?").get(id) as PostRow | undefined) ?? null;
  }

  /** The post waiting longest on this server; one tried again waits from when it was queued again. */
  nextQueuedPost(server: string): PostRow | null {
    return (this.sql("SELECT * FROM review_posts WHERE server = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1").get(server) as PostRow | undefined) ?? null;
  }

  queuedPostServers(): string[] {
    return (this.sql("SELECT DISTINCT server FROM review_posts WHERE state = 'queued'").all() as Array<{ server: string }>).map((row) => row.server);
  }

  /** Posts waiting or posting, oldest first. */
  activePosts(): PostRow[] {
    return this.sql("SELECT * FROM review_posts WHERE state IN ('queued', 'posting') ORDER BY created_at, id").all() as PostRow[];
  }

  /** Posts that finished since a time, newest first. */
  postsFinishedSince(at: number): PostRow[] {
    return this.sql("SELECT * FROM review_posts WHERE state IN ('posted', 'failed') AND finished_at >= ? ORDER BY finished_at DESC, id DESC").all(at) as PostRow[];
  }

  /** The PR's oldest post still waiting or posting, else its newest failed post not cleared. */
  currentPost(prId: number): PostRow | null {
    return (this.sql("SELECT * FROM review_posts WHERE pr_id = ? AND (state IN ('queued', 'posting') OR (state = 'failed' AND cleared_at IS NULL)) ORDER BY CASE WHEN state = 'failed' THEN 1 ELSE 0 END, CASE WHEN state = 'failed' THEN -id ELSE id END LIMIT 1")
      .get(prId) as PostRow | undefined) ?? null;
  }

  activePostOfPr(prId: number): PostRow | null {
    return (this.sql("SELECT * FROM review_posts WHERE pr_id = ? AND state IN ('queued', 'posting') ORDER BY id LIMIT 1").get(prId) as PostRow | undefined) ?? null;
  }

  activePostOfDraft(draftId: number): PostRow | null {
    return (this.sql("SELECT * FROM review_posts WHERE draft_id = ? AND state IN ('queued', 'posting') LIMIT 1").get(draftId) as PostRow | undefined) ?? null;
  }

  startPost(id: number): void {
    this.sql("UPDATE review_posts SET state = 'posting', started_at = ? WHERE id = ?").run(this.now(), id);
  }

  finishPost(id: number, outcome: { state: "posted"; placed: number; inBody: number } | { state: "failed"; error: string } | { state: "cancelled" }): void {
    const placed = outcome.state === "posted" ? outcome.placed : null;
    const inBody = outcome.state === "posted" ? outcome.inBody : null;
    const error = outcome.state === "failed" ? outcome.error : null;
    this.sql("UPDATE review_posts SET state = ?, error = ?, placed = ?, in_body = ?, finished_at = ? WHERE id = ?").run(outcome.state, error, placed, inBody, this.now(), id);
  }

  /** A failed post goes back in the queue as it was. */
  requeuePost(id: number): void {
    this.sql("UPDATE review_posts SET state = 'queued', error = NULL, started_at = NULL, finished_at = NULL, cleared_at = NULL, created_at = ? WHERE id = ?").run(this.now(), id);
  }

  clearPost(id: number): void {
    this.sql("UPDATE review_posts SET cleared_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Failed posts of the PR before `beforeId`, or all of them, no longer need the user. */
  clearFailedPosts(prId: number, beforeId = Number.MAX_SAFE_INTEGER): void {
    this.sql("UPDATE review_posts SET cleared_at = ? WHERE pr_id = ? AND state = 'failed' AND cleared_at IS NULL AND id < ?").run(this.now(), prId, beforeId);
  }

  /** Posts a stopped Shuttle left posting; the server may or may not have them. */
  interruptedPosts(): PostRow[] {
    return this.sql("SELECT * FROM review_posts WHERE state = 'posting' ORDER BY id").all() as PostRow[];
  }

  addMerge(row: Pick<MergeRow, "pr_id" | "server" | "method" | "head" | "auto" | "delete_branch" | "subject">): MergeRow {
    const result = this.sql("INSERT INTO merges (pr_id, server, method, head, auto, delete_branch, subject, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)")
      .run(row.pr_id, row.server, row.method, row.head, row.auto, row.delete_branch, row.subject, this.now());
    return this.mergeById(Number(result.lastInsertRowid))!;
  }

  mergeById(id: number): MergeRow | null {
    return (this.sql("SELECT * FROM merges WHERE id = ?").get(id) as MergeRow | undefined) ?? null;
  }

  /** The merge waiting longest on this server; one tried again waits from when it was queued again. */
  nextQueuedMerge(server: string): MergeRow | null {
    return (this.sql("SELECT * FROM merges WHERE server = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1").get(server) as MergeRow | undefined) ?? null;
  }

  queuedMergeServers(): string[] {
    return (this.sql("SELECT DISTINCT server FROM merges WHERE state = 'queued'").all() as Array<{ server: string }>).map((row) => row.server);
  }

  /** Merges waiting or merging, oldest first. */
  activeMerges(): MergeRow[] {
    return this.sql("SELECT * FROM merges WHERE state IN ('queued', 'merging') ORDER BY created_at, id").all() as MergeRow[];
  }

  /** Merges that finished since a time, newest first. */
  mergesFinishedSince(at: number): MergeRow[] {
    return this.sql("SELECT * FROM merges WHERE state IN ('done', 'failed') AND finished_at >= ? ORDER BY finished_at DESC, id DESC").all(at) as MergeRow[];
  }

  /** The PR's oldest merge still waiting or merging, else its newest failed merge not cleared. */
  currentMerge(prId: number): MergeRow | null {
    return (this.sql("SELECT * FROM merges WHERE pr_id = ? AND (state IN ('queued', 'merging') OR (state = 'failed' AND cleared_at IS NULL)) ORDER BY CASE WHEN state = 'failed' THEN 1 ELSE 0 END, CASE WHEN state = 'failed' THEN -id ELSE id END LIMIT 1")
      .get(prId) as MergeRow | undefined) ?? null;
  }

  /** The PR's latest done merge, when the server took it and left the PR open, and it finished since `since`. */
  sentMerge(prId: number, since: number): MergeRow | null {
    const row = (this.sql("SELECT * FROM merges WHERE pr_id = ? AND state = 'done' ORDER BY finished_at DESC, id DESC LIMIT 1").get(prId) as MergeRow | undefined) ?? null;
    return row !== null && row.outcome === "sent" && (row.finished_at ?? 0) >= since ? row : null;
  }

  activeMergeOfPr(prId: number): MergeRow | null {
    return (this.sql("SELECT * FROM merges WHERE pr_id = ? AND state IN ('queued', 'merging') ORDER BY id LIMIT 1").get(prId) as MergeRow | undefined) ?? null;
  }

  startMerge(id: number): void {
    this.sql("UPDATE merges SET state = 'merging', started_at = ? WHERE id = ?").run(this.now(), id);
  }

  finishMerge(id: number, end: { state: "done"; outcome: NonNullable<MergeRow["outcome"]> } | { state: "failed"; error: string } | { state: "cancelled" }): void {
    const error = end.state === "failed" ? end.error : null;
    const outcome = end.state === "done" ? end.outcome : null;
    this.sql("UPDATE merges SET state = ?, outcome = ?, error = ?, finished_at = ? WHERE id = ?").run(end.state, outcome, error, this.now(), id);
  }

  /** A failed merge goes back in the queue as it was. */
  requeueMerge(id: number): void {
    this.sql("UPDATE merges SET state = 'queued', outcome = NULL, error = NULL, started_at = NULL, finished_at = NULL, cleared_at = NULL, created_at = ? WHERE id = ?").run(this.now(), id);
  }

  clearMerge(id: number): void {
    this.sql("UPDATE merges SET cleared_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Failed merges of the PR before `beforeId`, or all of them, no longer need the user. */
  clearFailedMerges(prId: number, beforeId = Number.MAX_SAFE_INTEGER): void {
    this.sql("UPDATE merges SET cleared_at = ? WHERE pr_id = ? AND state = 'failed' AND cleared_at IS NULL AND id < ?").run(this.now(), prId, beforeId);
  }

  /**
   * The user's open PRs on a server with a merge pending: auto-merge on, in the server's merge queue, a merge in
   * Shuttle's queue, or one the server took since `sentSince` while the PR stayed open. The least recently read first.
   */
  /** `own`: 1 when the merge pending is Shuttle's: queued, running, or sent since `sentSince`. */
  pendingMergePrs(server: string, sentSince: number): Array<PrRow & { own: number }> {
    return this.sql(`SELECT * FROM (SELECT p.*, EXISTS (SELECT 1 FROM merges m WHERE m.pr_id = p.id
        AND (m.state IN ('queued', 'merging') OR (m.state = 'done' AND m.outcome = 'sent' AND m.finished_at >= ?))) AS own
      FROM prs p WHERE p.server = ? AND p.mine = 1 AND p.state IN ('open', 'draft'))
      WHERE own = 1 OR auto_merge = 1 OR in_merge_queue = 1 ORDER BY id`).all(sentSince, server) as Array<PrRow & { own: number }>;
  }

  /** Merges a stopped Shuttle left merging; the server may or may not have merged them. */
  interruptedMerges(): MergeRow[] {
    return this.sql("SELECT * FROM merges WHERE state = 'merging' ORDER BY id").all() as MergeRow[];
  }

  addMyReview(row: Omit<MyReviewRow, "id" | "at">): void {
    this.sql("INSERT INTO my_reviews (pr_id, verdict, head, at, findings) VALUES (?, ?, ?, ?, ?)").run(row.pr_id, row.verdict, row.head, this.now(), row.findings);
  }

  latestMyReview(prId: number): MyReviewRow | null {
    return (this.sql("SELECT * FROM my_reviews WHERE pr_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(prId) as MyReviewRow | undefined) ?? null;
  }

  myReviewsSince(at: number): MyReviewRow[] {
    return this.sql("SELECT * FROM my_reviews WHERE at >= ?").all(at) as MyReviewRow[];
  }

  saveSnapshot(day: string, counts: Record<string, number>): void {
    this.sql("INSERT INTO snapshots (day, counts) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET counts = excluded.counts").run(day, JSON.stringify(counts));
  }

  snapshots(fromDay: string): Array<{ day: string; counts: Record<string, number> }> {
    const rows = this.sql("SELECT * FROM snapshots WHERE day >= ? ORDER BY day").all(fromDay) as Array<{ day: string; counts: string }>;
    return rows.map((r) => ({ day: r.day, counts: JSON.parse(r.counts) as Record<string, number> }));
  }

  /** Records the PR's phase; a change closes the one before. */
  notePhase(prId: number, phase: string | null): void {
    const open = this.sql("SELECT rowid, phase FROM phases WHERE pr_id = ? AND end_at IS NULL").get(prId) as { rowid: number; phase: string } | undefined;
    if (open?.phase === phase) return;
    this.tx(() => {
      if (open) this.sql("UPDATE phases SET end_at = ? WHERE rowid = ?").run(this.now(), open.rowid);
      if (phase) this.sql("INSERT INTO phases (pr_id, phase, start_at) VALUES (?, ?, ?)").run(prId, phase, this.now());
    });
  }

  phases(prIds: readonly number[]): PhaseRow[] {
    if (!prIds.length) return [];
    return this.sql(`SELECT * FROM phases WHERE pr_id IN (${prIds.map(() => "?").join(", ")}) ORDER BY start_at`).all(...prIds) as PhaseRow[];
  }

  /** Items every owner received are seen; their per-thread delivery rows are no longer needed. */
  settleDeliveries(prId: number, itemIds: readonly string[]): void {
    this.tx(() => {
      this.markSeen(prId, itemIds);
      const drop = this.sql("DELETE FROM deliveries WHERE pr_id = ? AND item_id = ?");
      for (const id of itemIds) drop.run(prId, id);
    });
  }

  pendingCount(prId: number): number {
    return (this.sql("SELECT COUNT(*) AS n FROM pending_items WHERE pr_id = ?").get(prId) as { n: number }).n;
  }

  addReview(row: Omit<ReviewRow, "id" | "finished_at" | "state" | "created_at" | "archived_at" | "active_at" | "ended_by" | "note" | "input" | "attempt"> & { input?: string | null; attempt?: number }): ReviewRow {
    const result = this.sql("INSERT INTO reviews (pr_id, thread_id, preset, trigger, head, state, created_at, own_thread, active_at, input, attempt) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
      .run(row.pr_id, row.thread_id, row.preset, row.trigger, row.head, this.now(), row.own_thread, this.now(), row.input ?? null, row.attempt ?? 1);
    return this.sql("SELECT * FROM reviews WHERE id = ?").get(result.lastInsertRowid) as ReviewRow;
  }

  /** The latest run in a review thread Shuttle started for this PR, while bb still has the thread. */
  reviewThreadOf(prId: number): ReviewRow | null {
    return (this.sql("SELECT r.* FROM reviews r JOIN threads t ON t.id = r.thread_id WHERE r.pr_id = ? AND r.own_thread = 1 ORDER BY r.created_at DESC, r.id DESC LIMIT 1")
      .get(prId) as ReviewRow | undefined) ?? null;
  }

  /** The last run of each of Shuttle's review threads that is not archived and that Shuttle has not archived since. */
  unarchivedReviewRuns(filter: { prId?: number; threadId?: string } = {}): ReviewRow[] {
    return this.sql(
        `SELECT r.* FROM reviews r JOIN threads t ON t.id = r.thread_id
         WHERE r.own_thread = 1 AND r.archived_at IS NULL AND t.archived = 0
           AND r.id = (SELECT MAX(id) FROM reviews WHERE pr_id = r.pr_id AND thread_id = r.thread_id)
           AND (? IS NULL OR r.pr_id = ?) AND (? IS NULL OR r.thread_id = ?)
         ORDER BY r.id`,
      )
      .all(filter.prId ?? null, filter.prId ?? null, filter.threadId ?? null, filter.threadId ?? null) as ReviewRow[];
  }

  setReviewArchived(id: number, at: number | null): void {
    this.sql("UPDATE reviews SET archived_at = ? WHERE id = ?").run(at, id);
  }

  /** Drafts this thread handed back for the PR since a time, newest first. */
  draftsOfThread(prId: number, threadId: string, since: number): DraftRow[] {
    return this.sql("SELECT * FROM review_drafts WHERE pr_id = ? AND thread_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC").all(prId, threadId, since) as DraftRow[];
  }

  lastReview(prId: number): ReviewRow | null {
    return (this.sql("SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(prId) as ReviewRow | undefined) ?? null;
  }

  reviewsOf(prId: number): ReviewRow[] {
    return this.sql("SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at, id").all(prId) as ReviewRow[];
  }

  /** A newer review of the PR is the one that counts, wherever the older ones run. */
  replaceRunningReviews(prId: number): number {
    return this.sql("UPDATE reviews SET state = 'done', finished_at = ?, ended_by = 'replaced' WHERE pr_id = ? AND state = 'running'").run(this.now(), prId).changes;
  }

  runningReviewsOfThread(threadId: string): ReviewRow[] {
    return this.sql("SELECT * FROM reviews WHERE thread_id = ? AND state = 'running'").all(threadId) as ReviewRow[];
  }

  finishReview(id: number, state: "done" | "failed", by: ReviewEnd, note: string | null = null): void {
    this.sql("UPDATE reviews SET state = ?, finished_at = ?, ended_by = ?, note = ? WHERE id = ?").run(state, this.now(), by, note, id);
  }

  /** A thread that failed or went quiet and then works again is reviewing again. */
  restartReview(id: number): void {
    this.sql("UPDATE reviews SET state = 'running', finished_at = NULL, ended_by = NULL, note = NULL, active_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** The thread, or a child thread of it, is at work: its running reviews are not quiet. */
  touchReviews(threadId: string): number {
    return this.sql("UPDATE reviews SET active_at = ? WHERE thread_id = ? AND state = 'running'").run(this.now(), threadId).changes;
  }

  /** Ends a run as gone quiet only if it still runs and nothing was seen at work in it since `before`; false when something was. */
  endQuietReview(id: number, before: number): boolean {
    return this.sql("UPDATE reviews SET state = 'failed', finished_at = ?, ended_by = 'quiet', note = NULL WHERE id = ? AND state = 'running' AND COALESCE(active_at, created_at) < ?")
      .run(this.now(), id, before).changes > 0;
  }

  /** Running reviews nothing has been seen at work in since `before`, oldest first. */
  quietReviews(before: number): ReviewRow[] {
    return this.sql("SELECT * FROM reviews WHERE state = 'running' AND COALESCE(active_at, created_at) < ? ORDER BY id").all(before) as ReviewRow[];
  }

  /** The runs in this thread that are still their PR's latest review. */
  latestRunsOfThread(threadId: string): ReviewRow[] {
    return this.sql("SELECT r.* FROM reviews r WHERE r.thread_id = ? AND r.id = (SELECT MAX(id) FROM reviews WHERE pr_id = r.pr_id) ORDER BY r.id").all(threadId) as ReviewRow[];
  }

  reviewsSince(at: number): ReviewRow[] {
    return this.sql("SELECT * FROM reviews WHERE created_at >= ?").all(at) as ReviewRow[];
  }

  /** A run whose thread could not set up its workspace never reviewed anything, so the daily limit leaves it out. */
  autoReviewsSince(at: number): number {
    return (this.sql("SELECT COUNT(*) AS n FROM reviews WHERE trigger = 'auto' AND created_at >= ? AND ended_by IS NOT 'setup'").get(at) as { n: number }).n;
  }

  addEvent(kind: string, text: string, prId: number | null = null, threadId: string | null = null): void {
    this.sql("INSERT INTO events (at, kind, text, pr_id, thread_id) VALUES (?, ?, ?, ?, ?)").run(this.now(), kind, text, prId, threadId);
    this.sql("DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)").run();
  }

  countEvents(kinds: readonly string[], since: number): number {
    if (!kinds.length) return 0;
    return (this.sql(`SELECT COUNT(*) AS n FROM events WHERE at >= ? AND kind IN (${kinds.map(() => "?").join(", ")})`).get(since, ...kinds) as { n: number }).n;
  }

  events(filter: { prId?: number; threadId?: string; kinds?: string[]; limit: number }): EventRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.prId !== undefined) (where.push("e.pr_id = ?"), args.push(filter.prId));
    if (filter.threadId !== undefined) (where.push("e.thread_id = ?"), args.push(filter.threadId));
    if (filter.kinds?.length) (where.push(`e.kind IN (${filter.kinds.map(() => "?").join(", ")})`), args.push(...filter.kinds));
    const sql = `SELECT e.*, p.key FROM events e LEFT JOIN prs p ON p.id = e.pr_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`;
    return this.sql(sql).all(...args, filter.limit) as EventRow[];
  }
}
