export const PROJECT_STATES = ["draft", "ready", "running", "paused", "done", "archived"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const TICKET_STATES = ["queued", "working", "checking", "review", "approved", "merging", "pr_open", "done", "blocked", "cancelled"] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const ROLES = ["planner", "worker", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const THREAD_STATES = ["spawning", "active", "ending", "ended"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const POST_KINDS = ["brief", "note", "claim", "submit", "check", "review", "block", "reply", "merge", "system"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const AUTHOR_KINDS = ["human", "planner", "worker", "reviewer", "loom"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const REVIEW_VERDICTS = ["pending", "approved", "changes_requested"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** The New project screen's merge answer: leave it to the planner's interview, or settle it now. */
export const MERGE_CHOICES = ["ask", "integration", "pr"] as const;
export type MergeChoice = (typeof MERGE_CHOICES)[number];

/** The Metrics tab's windows, in days, for throughput and cumulative flow. */
export const WINDOW_DAYS = [7, 14, 30] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

export const HUMAN_ACTOR = "human";
/** The actor on every change the plugin makes by itself. */
export const LOOM_ACTOR = "loom";
/** The system_reason of a project paused with `--now`: its worker threads were stopped and need a continue message on resume. */
export const PAUSE_NOW_REASON = "pause --now";

const PROJECT_MOVES: Record<ProjectState, readonly ProjectState[]> = {
  draft: ["ready", "archived"],
  ready: ["running", "archived"],
  running: ["paused", "done", "archived"],
  paused: ["running", "done", "archived"],
  done: ["archived"],
  archived: [],
};

export function canMoveProject(from: ProjectState, to: ProjectState): boolean {
  return PROJECT_MOVES[from].includes(to);
}

const TICKET_MOVES: Record<TicketState, readonly TicketState[]> = {
  queued: ["working"],
  working: ["checking", "queued"],
  checking: ["working", "review", "queued"],
  review: ["working", "approved", "queued"],
  approved: ["merging"],
  merging: ["done", "pr_open", "working", "queued"],
  pr_open: ["done"],
  done: [],
  // Back to review only when bb refused the reviewer: the work already passed its checks (Engine.approve).
  blocked: ["queued", "review"],
  cancelled: [],
};

export function canMoveTicket(from: TicketState, to: TicketState): boolean {
  if (to === "cancelled") return from !== "done" && from !== "cancelled";
  if (to === "blocked") return from !== "done" && from !== "cancelled" && from !== "blocked";
  return TICKET_MOVES[from].includes(to);
}
