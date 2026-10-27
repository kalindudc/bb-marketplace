// Rows for the Insights tests: a project built event by event, as the store would write them.
import type { EventRow, PostRow, ProjectRow, ReviewRow, ThreadRow, TicketRow } from "../src/db/store";
import type { ProjectRows } from "../src/replay";
import type { ProjectState, TicketState } from "../src/states";

export const MIN = 60_000;
export const T0 = Date.UTC(2026, 0, 1, 9);
export const at = (minutes: number) => T0 + minutes * MIN;

/** A project's rows built event by event, as the store would write them. */
export class Rows {
  private id = 0;
  events: EventRow[] = [];
  posts: PostRow[] = [];
  reviews: ReviewRow[] = [];
  tickets: TicketRow[] = [];
  threads: ThreadRow[] = [];
  state: ProjectState = "draft";

  event(minutes: number, kind: string, ticket: number | null, data: object = {}, actor = "loom"): this {
    this.events.push({ id: ++this.id, project_id: 1, ticket_id: ticket, at: at(minutes), kind, actor, data_json: JSON.stringify(data) });
    return this;
  }
  project(minutes: number, to: ProjectState, actor = "human", reason?: string): this {
    this.event(minutes, "project.state", null, { from: this.state, to, ...(reason === undefined ? {} : { reason }) }, actor);
    this.state = to;
    return this;
  }
  you(minutes: number, action: string, data: object = {}, ticket: number | null = null): this {
    return this.event(minutes, "human.action", ticket, { action, slug: "csv", ...data }, "human");
  }
  ticket(n: number, minutes: number, title = `Ticket ${n}`): this {
    this.tickets.push({ ...TICKET, id: n, seq: n, key: `CSV-${n}`, ref: `t${n}`, title, created_at: at(minutes) });
    return this.event(minutes, "ticket.created", n, { key: `CSV-${n}`, ref: `t${n}` }, "human");
  }
  move(n: number, minutes: number, from: TicketState, to: TicketState, data: object = {}): this {
    const ticket = this.tickets.find((row) => row.id === n)!;
    ticket.state = to;
    return this.event(minutes, "ticket.state", n, { from, to, ...data });
  }
  post(n: number, minutes: number, kind: PostRow["kind"], body: string, data: object = {}, author: PostRow["author_kind"] = "loom"): this {
    const post = { id: this.posts.length + 1, project_id: 1, ticket_id: n, parent_id: null, author_kind: author, author_thread_id: null, kind, body, data_json: JSON.stringify(data), at: at(minutes) };
    this.posts.push(post);
    return this.event(minutes, "post.added", n, { post: post.id, kind, author, parent: null }, author === "loom" ? "loom" : "thr_x");
  }
  verdict(n: number, minutes: number, round: number, verdict: "approved" | "changes_requested", findings: object[] = []): this {
    this.reviews.push({ id: this.reviews.length + 1, ticket_id: n, round, thread_row_id: null, verdict, summary: null, findings_json: JSON.stringify(findings), at: at(minutes) });
    return this.event(minutes, "review.verdict", n, { review: this.reviews.length, round, verdict }, "reviewer");
  }
  check(n: number, minutes: number, passed: boolean): this {
    const runs = [{ command: "npm test", exitCode: passed ? 0 : 1, timedOut: false, durationMs: 30_000 }];
    return this.post(n, minutes, "check", passed ? "Checks passed." : "Checks failed.", { passed, runs });
  }
  rows(): ProjectRows {
    const project = { ...PROJECT, state: this.state } as ProjectRow;
    return { project, tickets: this.tickets, threads: this.threads, events: this.events, posts: this.posts, reviews: this.reviews, runs: [] };
  }
}

const TICKET: TicketRow = {
  id: 0, project_id: 1, seq: 0, key: "", ref: "", title: "", body: "", acceptance_json: "[]", verify_json: "[]", scope_json: "[]", deps_json: "[]", priority: 2, state: "queued", attempt: 0, failures: 0, check_failures: 0, review_round: 0,
  branch: null, environment_id: null, worker_thread_id: null, head_sha: null, merge_before: null, pr_url: null, pr_checked_at: null, blocked_reason: null, repo: null, pr_branch: null, pushed_sha: null, pushed_at: null, pr_ask_json: null, pr_text_json: null,
  pr_seen_json: "[]", pr_rounds: 0, pr_status_json: null, handback_json: null, stack_json: null, pr_base: null, start_wait_json: null, environment_json: null, pr_poll_json: null, merge_after_json: "[]", pr_meta_json: null, head_tree: null, created_by: "human", created_at: T0, updated_at: T0, state_at: T0,
};
const PROJECT = { id: 1, slug: "csv", name: "CSV export", key: "CSV", bb_project_id: "proj_1", host_id: null, state: "draft", approved_version: 1, pending_version: null, section_id: null, planner_thread_id: null, system_reason: null, hold_until: null, triage_pending: 0, triage_round: 0, triage_sent_at: null, pr_url: null, created_at: T0, updated_at: T0 };

/** Two tickets: CSV-1 ships after one round of changes; CSV-2 fails its checks and then blocks. A pause splits two runs. */
export function story(): Rows {
  const r = new Rows();
  r.event(0, "project.created", null, { slug: "csv" }, "thr_plan").event(1, "spec.proposed", null, { version: 1 }, "thr_plan");
  r.event(5, "spec.approved", null, { version: 1 }, "human").ticket(1, 5, "Order rows").ticket(2, 5, "Quote cells").you(5, "approve", { pending: false }).project(5, "ready");
  r.project(6, "running").you(6, "start");
  r.move(1, 7, "queued", "working", { attempt: 1 }).post(1, 7, "claim", "Worker attempt 1 is starting.");
  r.move(2, 7, "queued", "working", { attempt: 1 });
  r.post(1, 20, "submit", "Sorted the rows.", {}, "worker").move(1, 20, "working", "checking").check(1, 21, true).move(1, 21, "checking", "review", { round: 1 });
  r.verdict(1, 25, 1, "changes_requested", [{ severity: "blocking", title: "Sort is not stable", detail: "" }]).post(1, 25, "review", "Changes requested (round 1).", {}, "reviewer").move(1, 25, "review", "working", { round: 1 });
  r.post(2, 26, "submit", "Quoted the cells.", {}, "worker").move(2, 26, "working", "checking").check(2, 27, false).move(2, 27, "checking", "working", { checkFailures: 1 });
  r.project(30, "paused").you(30, "pause");
  r.project(40, "running").you(40, "resume");
  r.move(1, 45, "working", "checking").check(1, 46, true).move(1, 46, "checking", "review", { round: 2 });
  r.verdict(1, 50, 2, "approved").move(1, 50, "review", "approved", { round: 2 }).move(1, 50, "approved", "merging");
  r.move(1, 51, "merging", "done").post(1, 51, "merge", "Merged abc into loom/csv.", { outcome: "merged", sha: "abcdef1234567", branch: "loom/csv" });
  r.move(2, 55, "working", "blocked", { reason: "The fixture file is missing" });
  r.tickets[1]!.blocked_reason = "The fixture file is missing";
  return r;
}

