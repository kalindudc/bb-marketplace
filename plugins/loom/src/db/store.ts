// Typed repository over the plugin database. Every project, spec, ticket and
// post change appends an event in the same transaction.
import type Database from "better-sqlite3";
import type { Finding } from "../review";
import { canMoveProject, canMoveTicket, type AuthorKind, type PostKind, type ProjectState, type Role, type ReviewVerdict, type ThreadState, type TicketState } from "../states";

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  key: string;
  bb_project_id: string;
  host_id: string | null;
  state: ProjectState;
  approved_version: number | null;
  pending_version: number | null;
  section_id: string | null;
  planner_thread_id: string | null;
  system_reason: string | null;
  hold_until: number | null;
  triage_pending: number;
  triage_round: number;
  triage_sent_at: number | null;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
}

export type NewProject = Pick<ProjectRow, "slug" | "name" | "key" | "bb_project_id"> & Partial<Pick<ProjectRow, "host_id" | "section_id" | "planner_thread_id">>;

export interface SpecVersionRow {
  project_id: number;
  version: number;
  toml: string;
  spec_json: string;
  hash: string;
  proposed_by: string;
  created_at: number;
}

export interface TicketRow {
  id: number;
  project_id: number;
  seq: number;
  key: string;
  ref: string;
  title: string;
  body: string;
  acceptance_json: string;
  verify_json: string;
  scope_json: string;
  deps_json: string;
  priority: number;
  state: TicketState;
  attempt: number;
  failures: number;
  check_failures: number;
  review_round: number;
  branch: string | null;
  environment_id: string | null;
  worker_thread_id: string | null;
  head_sha: string | null;
  merge_before: string | null;
  pr_url: string | null;
  pr_checked_at: number | null;
  blocked_reason: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  state_at: number;
}

export type NewTicket = Pick<TicketRow, "project_id" | "seq" | "key" | "ref" | "title" | "body" | "acceptance_json" | "verify_json" | "scope_json" | "deps_json" | "priority">;

export interface PostRow {
  id: number;
  project_id: number;
  ticket_id: number;
  parent_id: number | null;
  author_kind: AuthorKind;
  author_thread_id: string | null;
  kind: PostKind;
  body: string;
  data_json: string;
  at: number;
}

export type NewPost = Pick<PostRow, "project_id" | "ticket_id" | "parent_id" | "author_kind" | "author_thread_id" | "kind" | "body"> & Partial<Pick<PostRow, "data_json">>;

export interface ThreadRow {
  id: number;
  thread_id: string | null;
  spawn_token: string | null;
  project_id: number;
  ticket_id: number | null;
  role: Role;
  state: ThreadState;
  environment_id: string | null;
  idle_count: number;
  rate_limit_retries: number;
  tokens: number | null;
  tokens_at: number | null;
  review_round: number;
  /** The worker's attempt; null for a reviewer and for rows from before Loom recorded it. */
  attempt: number | null;
  started_at: number;
  clock_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

export type NewThread = Pick<ThreadRow, "project_id" | "role" | "state"> & Partial<Pick<ThreadRow, "thread_id" | "spawn_token" | "ticket_id" | "environment_id">>;

export interface ReviewRow {
  id: number;
  ticket_id: number;
  round: number;
  thread_row_id: number | null;
  verdict: ReviewVerdict;
  summary: string | null;
  findings_json: string;
  at: number;
}

export type NewReview = Pick<ReviewRow, "ticket_id" | "round" | "thread_row_id">;

export interface EventRow {
  id: number;
  project_id: number;
  ticket_id: number | null;
  at: number;
  kind: string;
  actor: string;
  data_json: string;
}

/** A planning conversation started from the Loom page, before or after its thread proposed a spec. */
export interface PlanningRow {
  id: number;
  thread_id: string;
  bb_project_id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

/** One call Loom made to the machine for a ticket's checks or merge. `output_chars` measures the output, which `runs` leaves out. */
export interface RunRow {
  id: number;
  project_id: number;
  ticket_id: number;
  stage: "check" | "merge";
  kind: "command" | "git";
  label: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  ok: number | null;
  exit_code: number | null;
  timed_out: number;
  output_chars: number;
}

export type RecordState = "pending" | "summarizing" | "sending" | "sent" | "failed" | "skipped";

/** Whether a finished project's record reached the done hook; one row per project. */
export interface RecordRow {
  id: number;
  project_id: number;
  state: RecordState;
  /** The summary agent's thread, once bb started it. */
  thread_id: string | null;
  /** When the summary agent was asked for, for its time limit. */
  started_at: number | null;
  created_at: number;
  updated_at: number;
}

export class StoreError extends Error {}

export class Store {
  private onEvent: ((projectId: number | null) => void) | null = null;
  private txDepth = 0;
  private queued: Array<number | null> = [];

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {}

  /** Calls `fn` with the project id (null for a change outside any project) after each event row is committed and after each `changed` call; inside a transaction it waits for the outermost commit and is dropped when the transaction that made it rolls back. */
  setOnEvent(fn: ((projectId: number | null) => void) | null): void {
    this.onEvent = fn;
  }

  tx<T>(fn: () => T): T {
    this.txDepth += 1;
    const queuedOnEntry = this.queued.length;
    let result: T;
    try {
      result = this.db.transaction(fn)();
    } catch (error) {
      this.txDepth -= 1;
      this.queued.length = queuedOnEntry;
      throw error;
    }
    this.txDepth -= 1;
    if (this.txDepth === 0) {
      const committed = this.queued;
      this.queued = [];
      for (const projectId of committed) this.onEvent?.(projectId);
    }
    return result;
  }

  event(projectId: number, ticketId: number | null, kind: string, actor: string, data: object = {}): void {
    this.db.prepare("INSERT INTO events (project_id, ticket_id, at, kind, actor, data_json) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, ticketId, this.now(), kind, actor, JSON.stringify(data));
    this.changed(projectId);
  }

  /** Tells the hook that something the page shows changed in the project, for changes that write no event row, such as binding a worker's thread. */
  /** `null` is a change outside any project, such as a planning conversation. */
  changed(projectId: number | null): void {
    if (this.txDepth > 0) this.queued.push(projectId);
    else this.onEvent?.(projectId);
  }

  events(projectId: number, afterId = 0, limit = 200): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?").all(projectId, afterId, limit) as EventRow[];
  }

  /** Every event of the project, oldest first. The metrics replay all of them. */
  projectEvents(projectId: number): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY id").all(projectId) as EventRow[];
  }

  /** A project's events of one kind, oldest first. */
  eventsOfKind(projectId: number, kind: string): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? AND kind = ? ORDER BY id").all(projectId, kind) as EventRow[];
  }

  /** The newest events first, optionally only those before an event id. */
  eventsNewest(projectId: number, limit: number, beforeId?: number): EventRow[] {
    if (beforeId === undefined) return this.db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as EventRow[];
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(projectId, beforeId, limit) as EventRow[];
  }

  // ---- projects

  createProject(row: NewProject, actor: string): ProjectRow {
    return this.tx(() => {
      const now = this.now();
      const result = this.db
        .prepare("INSERT INTO projects (slug, name, key, bb_project_id, host_id, section_id, planner_thread_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)")
        .run(row.slug, row.name, row.key, row.bb_project_id, row.host_id ?? null, row.section_id ?? null, row.planner_thread_id ?? null, now, now);
      const project = this.requireProject(Number(result.lastInsertRowid));
      this.event(project.id, null, "project.created", actor, { slug: project.slug, key: project.key, planner: project.planner_thread_id });
      return project;
    });
  }

  project(id: number): ProjectRow | null {
    return (this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined) ?? null;
  }

  projectBySlug(slug: string): ProjectRow | null {
    return (this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRow | undefined) ?? null;
  }

  projectByKey(key: string): ProjectRow | null {
    return (this.db.prepare("SELECT * FROM projects WHERE key = ?").get(key) as ProjectRow | undefined) ?? null;
  }

  projects(): ProjectRow[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY id").all() as ProjectRow[];
  }

  setProjectState(id: number, to: ProjectState, actor: string, reason?: string): ProjectRow {
    return this.tx(() => {
      const before = this.requireProject(id);
      if (!canMoveProject(before.state, to)) throw new StoreError(`Project ${before.slug} is ${before.state}; it cannot move to ${to}.`);
      this.updateProject(id, { state: to, system_reason: reason ?? null });
      this.event(id, null, "project.state", actor, { from: before.state, to, ...(reason === undefined ? {} : { reason }) });
      return this.requireProject(id);
    });
  }

  updateProject(id: number, patch: Partial<Omit<ProjectRow, "id">>): void {
    this.patch("projects", id, patch);
  }

  // ---- spec versions

  addSpecVersion(projectId: number, toml: string, specJson: string, hash: string, proposedBy: string): number {
    return this.tx(() => {
      const last = this.db.prepare("SELECT MAX(version) AS version FROM spec_versions WHERE project_id = ?").get(projectId) as { version: number | null };
      const version = (last.version ?? 0) + 1;
      this.db.prepare("INSERT INTO spec_versions (project_id, version, toml, spec_json, hash, proposed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(projectId, version, toml, specJson, hash, proposedBy, this.now());
      this.event(projectId, null, "spec.proposed", proposedBy, { version, hash });
      return version;
    });
  }

  specVersion(projectId: number, version: number): SpecVersionRow | null {
    return (this.db.prepare("SELECT * FROM spec_versions WHERE project_id = ? AND version = ?").get(projectId, version) as SpecVersionRow | undefined) ?? null;
  }

  latestSpecVersion(projectId: number): SpecVersionRow | null {
    return (this.db.prepare("SELECT * FROM spec_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1").get(projectId) as SpecVersionRow | undefined) ?? null;
  }

  // ---- tickets

  createTicket(row: NewTicket, actor: string): TicketRow {
    return this.tx(() => {
      const now = this.now();
      const result = this.db
        .prepare(
          `INSERT INTO tickets (project_id, seq, key, ref, title, body, acceptance_json, verify_json, scope_json, deps_json, priority, state, created_by, created_at, updated_at, state_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(row.project_id, row.seq, row.key, row.ref, row.title, row.body, row.acceptance_json, row.verify_json, row.scope_json, row.deps_json, row.priority, actor, now, now, now);
      const ticket = this.requireTicket(Number(result.lastInsertRowid));
      this.event(ticket.project_id, ticket.id, "ticket.created", actor, { key: ticket.key, ref: ticket.ref });
      return ticket;
    });
  }

  ticket(id: number): TicketRow | null {
    return (this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined) ?? null;
  }

  ticketByKey(key: string): TicketRow | null {
    return (this.db.prepare("SELECT * FROM tickets WHERE key = ?").get(key) as TicketRow | undefined) ?? null;
  }

  tickets(projectId: number, states?: readonly TicketState[]): TicketRow[] {
    if (states === undefined) return this.db.prepare("SELECT * FROM tickets WHERE project_id = ? ORDER BY seq").all(projectId) as TicketRow[];
    const marks = states.map(() => "?").join(", ");
    return this.db.prepare(`SELECT * FROM tickets WHERE project_id = ? AND state IN (${marks}) ORDER BY seq`).all(projectId, ...states) as TicketRow[];
  }

  setTicketState(id: number, to: TicketState, actor: string, data: object = {}): TicketRow {
    return this.tx(() => {
      const before = this.requireTicket(id);
      if (!canMoveTicket(before.state, to)) throw new StoreError(`Ticket ${before.key} is ${before.state}; it cannot move to ${to}.`);
      const now = this.now();
      this.updateTicket(id, { state: to, state_at: now });
      this.event(before.project_id, id, "ticket.state", actor, { from: before.state, to, ...data });
      return this.requireTicket(id);
    });
  }

  updateTicket(id: number, patch: Partial<Omit<TicketRow, "id">>): void {
    this.patch("tickets", id, patch);
  }

  // ---- posts

  addPost(row: NewPost): PostRow {
    return this.tx(() => {
      if (row.parent_id !== null) {
        const parent = this.db.prepare("SELECT ticket_id FROM posts WHERE id = ?").get(row.parent_id) as { ticket_id: number } | undefined;
        if (parent?.ticket_id !== row.ticket_id) throw new StoreError(`Post #${row.parent_id} is on another ticket or does not exist; a reply must answer a post on the same ticket.`);
      }
      const result = this.db
        .prepare("INSERT INTO posts (project_id, ticket_id, parent_id, author_kind, author_thread_id, kind, body, data_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.project_id, row.ticket_id, row.parent_id, row.author_kind, row.author_thread_id, row.kind, row.body, row.data_json ?? "{}", this.now());
      const post = this.db.prepare("SELECT * FROM posts WHERE id = ?").get(Number(result.lastInsertRowid)) as PostRow;
      this.event(post.project_id, post.ticket_id, "post.added", post.author_thread_id ?? post.author_kind, { post: post.id, kind: post.kind, author: post.author_kind, parent: post.parent_id });
      return post;
    });
  }

  posts(ticketId: number): PostRow[] {
    return this.db.prepare("SELECT * FROM posts WHERE ticket_id = ? ORDER BY id").all(ticketId) as PostRow[];
  }

  postsForProject(projectId: number): PostRow[] {
    return this.db.prepare("SELECT * FROM posts WHERE project_id = ? ORDER BY id").all(projectId) as PostRow[];
  }

  // ---- threads

  addThread(row: NewThread): ThreadRow {
    const result = this.db
      .prepare("INSERT INTO threads (thread_id, spawn_token, project_id, ticket_id, role, state, environment_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.thread_id ?? null, row.spawn_token ?? null, row.project_id, row.ticket_id ?? null, row.role, row.state, row.environment_id ?? null, this.now());
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(result.lastInsertRowid)) as ThreadRow;
  }

  thread(id: number): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined) ?? null;
  }

  threads(q: { projectId?: number; ticketId?: number; role?: Role; states?: readonly ThreadState[] } = {}): ThreadRow[] {
    const filters: Array<[string, Array<number | string>]> = [];
    if (q.projectId !== undefined) filters.push(["project_id = ?", [q.projectId]]);
    if (q.ticketId !== undefined) filters.push(["ticket_id = ?", [q.ticketId]]);
    if (q.role !== undefined) filters.push(["role = ?", [q.role]]);
    if (q.states !== undefined) filters.push([`state IN (${q.states.map(() => "?").join(", ")})`, [...q.states]]);
    const where = filters.length > 0 ? ` WHERE ${filters.map(([clause]) => clause).join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM threads${where} ORDER BY id`).all(...filters.flatMap(([, values]) => values)) as ThreadRow[];
  }

  threadsForProject(projectId: number): ThreadRow[] {
    return this.threads({ projectId });
  }

  threadsForTicket(ticketId: number): ThreadRow[] {
    return this.threads({ ticketId });
  }

  // ---- reviews

  addReview(row: NewReview): ReviewRow {
    const result = this.db.prepare("INSERT INTO reviews (ticket_id, round, thread_row_id, verdict, at) VALUES (?, ?, ?, 'pending', ?)").run(row.ticket_id, row.round, row.thread_row_id, this.now());
    return this.review(Number(result.lastInsertRowid))!;
  }

  review(id: number): ReviewRow | null {
    return (this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as ReviewRow | undefined) ?? null;
  }

  reviews(ticketId: number, round?: number): ReviewRow[] {
    if (round === undefined) return this.db.prepare("SELECT * FROM reviews WHERE ticket_id = ? ORDER BY id").all(ticketId) as ReviewRow[];
    return this.db.prepare("SELECT * FROM reviews WHERE ticket_id = ? AND round = ? ORDER BY id").all(ticketId, round) as ReviewRow[];
  }

  reviewsForProject(projectId: number): ReviewRow[] {
    return this.db.prepare("SELECT reviews.* FROM reviews JOIN tickets ON tickets.id = reviews.ticket_id WHERE tickets.project_id = ? ORDER BY reviews.id").all(projectId) as ReviewRow[];
  }

  /** Stores a verdict on a pending review, with an event the round limit counts. Throws when the review is not pending. */
  setVerdict(reviewId: number, verdict: "approved" | "changes_requested", summary: string, findings: Finding[]): ReviewRow {
    return this.tx(() => {
      const before = this.review(reviewId);
      if (before === null) throw new StoreError(`Review ${reviewId} does not exist.`);
      const result = this.db.prepare("UPDATE reviews SET verdict = ?, summary = ?, findings_json = ? WHERE id = ? AND verdict = 'pending'").run(verdict, summary, JSON.stringify(findings), reviewId);
      if (result.changes === 0) throw new StoreError(`Review ${reviewId} is not pending; it already has a verdict.`);
      const ticket = this.requireTicket(before.ticket_id);
      this.event(ticket.project_id, ticket.id, "review.verdict", "reviewer", { review: reviewId, round: before.round, verdict });
      return this.review(reviewId)!;
    });
  }

  /** A ticket's events in order, optionally only some kinds. */
  ticketEvents(ticketId: number, kinds?: readonly string[]): EventRow[] {
    if (kinds === undefined) return this.db.prepare("SELECT * FROM events WHERE ticket_id = ? ORDER BY id").all(ticketId) as EventRow[];
    const marks = kinds.map(() => "?").join(", ");
    return this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND kind IN (${marks}) ORDER BY id`).all(ticketId, ...kinds) as EventRow[];
  }

  /** The compare-and-set that gives one path the right to end a row. ended_at marks when the end began; finishing sets it again. */
  claimThread(id: number, endReason: string): boolean {
    const result = this.db.prepare("UPDATE threads SET state = 'ending', end_reason = ?, ended_at = ? WHERE id = ? AND state = 'active'").run(endReason, this.now(), id);
    return result.changes === 1;
  }

  threadByThreadId(threadId: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as ThreadRow | undefined) ?? null;
  }

  threadBySpawnToken(token: string): ThreadRow | null {
    return (this.db.prepare("SELECT * FROM threads WHERE spawn_token = ?").get(token) as ThreadRow | undefined) ?? null;
  }

  updateThread(id: number, patch: Partial<Omit<ThreadRow, "id">>): void {
    this.patch("threads", id, patch, false);
  }

  // ---- planning conversations

  addPlanning(row: Pick<PlanningRow, "thread_id" | "bb_project_id" | "title">): PlanningRow {
    const result = this.db.prepare("INSERT INTO planning (thread_id, bb_project_id, title, started_at) VALUES (?, ?, ?, ?)").run(row.thread_id, row.bb_project_id, row.title, this.now());
    const added = this.db.prepare("SELECT * FROM planning WHERE id = ?").get(Number(result.lastInsertRowid)) as PlanningRow;
    this.changed(null);
    return added;
  }

  planning(threadId: string): PlanningRow | null {
    return (this.db.prepare("SELECT * FROM planning WHERE thread_id = ?").get(threadId) as PlanningRow | undefined) ?? null;
  }

  openPlanning(): PlanningRow[] {
    return this.db.prepare("SELECT * FROM planning WHERE ended_at IS NULL ORDER BY id DESC").all() as PlanningRow[];
  }

  /** True when this call ended the session; false when it had already ended or never existed. */
  endPlanning(threadId: string, reason: string): boolean {
    const result = this.db.prepare("UPDATE planning SET ended_at = ?, end_reason = ? WHERE thread_id = ? AND ended_at IS NULL").run(this.now(), reason, threadId);
    if (result.changes === 0) return false;
    this.changed(null);
    return true;
  }

  // ---- runs

  startRun(row: Pick<RunRow, "project_id" | "ticket_id" | "stage" | "kind" | "label">): number {
    const result = this.db.prepare("INSERT INTO runs (project_id, ticket_id, stage, kind, label, started_at) VALUES (?, ?, ?, ?, ?, ?)").run(row.project_id, row.ticket_id, row.stage, row.kind, row.label, this.now());
    this.changed(row.project_id);
    return Number(result.lastInsertRowid);
  }

  /** `durationMs` defaults to the time since the run started. */
  finishRun(id: number, r: { ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean; durationMs?: number }): void {
    const ended = this.now();
    const row = this.db
      .prepare("UPDATE runs SET ended_at = ?, duration_ms = COALESCE(?, ? - started_at), ok = ?, exit_code = ?, timed_out = ?, output = ? WHERE id = ? RETURNING project_id")
      .get(ended, r.durationMs ?? null, ended, r.ok ? 1 : 0, r.exitCode ?? null, r.timedOut === true ? 1 : 0, r.output, id) as { project_id: number } | undefined;
    if (row !== undefined) this.changed(row.project_id);
  }

  runs(ticketId: number): RunRow[] {
    return this.db
      .prepare("SELECT id, project_id, ticket_id, stage, kind, label, started_at, ended_at, duration_ms, ok, exit_code, timed_out, length(output) AS output_chars FROM runs WHERE ticket_id = ? ORDER BY id")
      .all(ticketId) as RunRow[];
  }

  runOutput(id: number): string | null {
    return (this.db.prepare("SELECT output FROM runs WHERE id = ?").get(id) as { output: string } | undefined)?.output ?? null;
  }

  /** Ends every run that has not ended, with `note` as its output and no result; returns how many it ended. */
  endOpenRuns(note: string): number {
    return this.db.prepare("UPDATE runs SET ended_at = ?, output = ? WHERE ended_at IS NULL").run(this.now(), note).changes;
  }

  // ---- records

  /** Queues the project's record for the done hook, replacing an earlier row. */
  queueRecord(projectId: number): void {
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO records (project_id, state, created_at, updated_at) VALUES (?, 'pending', ?, ?) ON CONFLICT (project_id) DO UPDATE SET state = 'pending', thread_id = NULL, started_at = NULL, updated_at = excluded.updated_at",
      )
      .run(projectId, now, now);
    this.changed(projectId);
  }

  record(projectId: number): RecordRow | null {
    return (this.db.prepare("SELECT * FROM records WHERE project_id = ?").get(projectId) as RecordRow | undefined) ?? null;
  }

  /** Rows still on their way (pending, summarizing, sending), oldest first. */
  openRecords(): RecordRow[] {
    return this.db.prepare("SELECT * FROM records WHERE state IN ('pending', 'summarizing', 'sending') ORDER BY id").all() as RecordRow[];
  }

  updateRecord(id: number, patch: Partial<Pick<RecordRow, "state" | "thread_id" | "started_at">>): void {
    this.patch("records", id, patch);
  }

  // ----

  private requireProject(id: number): ProjectRow {
    const project = this.project(id);
    if (project === null) throw new StoreError(`Project ${id} does not exist.`);
    return project;
  }

  private requireTicket(id: number): TicketRow {
    const ticket = this.ticket(id);
    if (ticket === null) throw new StoreError(`Ticket ${id} does not exist.`);
    return ticket;
  }

  private patch(table: "projects" | "tickets" | "threads" | "records", id: number, patch: Record<string, unknown>, touch = true): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (touch) entries.push(["updated_at", this.now()]);
    if (entries.length === 0) return;
    const sets = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  }
}
