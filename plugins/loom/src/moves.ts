// Every change of a ticket's state, by name: which states it leaves, where it goes, and which of the ticket's columns it
// resets, so no move can leave the sub-state of the state it left behind. canMoveTicket still guards each move.
import { StoreError, type Store, type TicketRow } from "./db/store";
import { LOOM_ACTOR, TICKET_STATES, canMoveTicket, type TicketState } from "./states";

/** The value each column a move can reset goes back to. */
const RESET = {
  worker_thread_id: null,
  environment_id: null,
  failures: 0,
  check_failures: 0,
  blocked_reason: null,
  pr_ask_json: null,
  pr_text_json: null,
  handback_json: null,
  start_wait_json: null,
  retry_json: null,
  push_json: null,
  merge_step_json: null,
  merge_before: null,
  pr_checked_at: null,
  pr_branch: null,
  pushed_sha: null,
  pushed_at: null,
  pr_seen_json: "[]",
  pr_rounds: 0,
  pr_status_json: null,
  pr_base: null,
  pr_applied_json: null,
} as const satisfies Partial<TicketRow>;

type Column = keyof typeof RESET;

/** The ticket lets go of its worker thread and environment. */
const RELEASED = ["worker_thread_id", "environment_id"] as const satisfies readonly Column[];
/** What a merge Loom started keeps until it finishes. */
const MERGE = ["merge_step_json", "retry_json", "merge_before"] as const satisfies readonly Column[];
/** A closed pull request: a requeue opens a new one, one commit on a new branch, with fresh rounds. */
const CLOSED_PR = ["pr_branch", "pushed_sha", "pushed_at", "push_json", "pr_ask_json", "pr_text_json", "pr_seen_json", "pr_rounds", "pr_status_json", "handback_json", "pr_base", "pr_applied_json"] as const satisfies readonly Column[];
/** A human sends a blocked ticket on: its counts start again and nothing a worker was doing is waiting. */
const SENT_ON = ["failures", "check_failures", "blocked_reason", ...RELEASED, "pr_ask_json", "handback_json", "start_wait_json", "retry_json"] as const satisfies readonly Column[];

const ANY = "any";

interface MoveRule {
  /** The states it leaves; "any" for every state canMoveTicket lets go to `to`. */
  from: readonly TicketState[] | typeof ANY;
  to: TicketState;
  resets: readonly Column[];
  /** A block the planner's triage hears of. */
  triage?: true;
}

export const MOVES = {
  /** A worker starts on a queued ticket. */
  start: { from: ["queued"], to: "working", resets: RELEASED },
  /** The project stopped running between the claim and the spawn. */
  start_undone: { from: ["working"], to: "queued", resets: [] },
  /** The worker did not start; the next try waits or starts again. */
  start_failed: { from: ["working"], to: "queued", resets: [...RELEASED, "start_wait_json"] },
  /** The worker did not start, and the ticket cannot wait any longer. */
  start_blocked: { from: ["working"], to: "blocked", resets: [...RELEASED, "start_wait_json"], triage: true },
  /** The worker hands in its work for the checks. */
  submit: { from: ["working"], to: "checking", resets: [] },
  /** The checks passed, so reviewers judge the work. */
  checked: { from: ["checking"], to: "review", resets: [] },
  /** A fix round changed nothing, so there is nothing to check, review or push. */
  unchanged_fix: { from: ["checking"], to: "pr_open", resets: [] },
  /** Work goes back to the ticket's worker: failed checks, a review's changes, a merge that did not land, a fix round. */
  to_worker: { from: ["checking", "review", "merging", "pr_open"], to: "working", resets: ["retry_json"] },
  /** The worker is gone, so a new one takes the ticket from its branch. */
  worker_gone: { from: ["working", "checking", "review", "merging", "pr_open"], to: "queued", resets: RELEASED },
  /** A released worker cannot come back, so a new one takes the ticket, and nothing waits for the old one. */
  worker_lost: { from: ["working", "pr_open"], to: "queued", resets: [...RELEASED, "handback_json", "start_wait_json"] },
  /** Loom blocks the ticket: failures, rounds or a merge it cannot finish. */
  block: { from: ANY, to: "blocked", resets: RELEASED, triage: true },
  /** A released worker's provider stayed unavailable. */
  block_unavailable: { from: ANY, to: "blocked", resets: [...RELEASED, "handback_json", "start_wait_json"], triage: true },
  /** Its worker can no longer be reached, so the work waiting for it stays on the ticket's feed for the next one. */
  block_unreachable: { from: ANY, to: "blocked", resets: [...RELEASED, "handback_json"], triage: true },
  /** Its pull request closed without merging, or merged somewhere else; Loom lets go of it. */
  block_pr_closed: { from: ANY, to: "blocked", resets: [...RELEASED, ...CLOSED_PR], triage: true },
  /** The human blocks the ticket; its threads end after. */
  human_block: { from: ANY, to: "blocked", resets: [] },
  /** The ticket is cancelled and its threads end. */
  cancel: { from: ANY, to: "cancelled", resets: RELEASED },
  /** The project is archived. */
  archive: { from: ANY, to: "cancelled", resets: [] },
  /** The reviewers approved. */
  approve: { from: ["review"], to: "approved", resets: [] },
  /** The merge queue takes the ticket: a first merge, or a restack or refresh of its open pull request. */
  merge: { from: ["approved", "pr_open"], to: "merging", resets: MERGE },
  /** Merged into the integration branch, or its pull request merged. */
  merged: { from: ["merging", "pr_open"], to: "done", resets: RELEASED },
  /** Loom opened or pushed its pull request. */
  pr_pushed: { from: ["merging"], to: "pr_open", resets: ["merge_step_json"] },
  /** A first merge needs the worker's worktree and bb shows none: the ticket waits outside the queue. */
  merge_left: { from: ["merging"], to: "approved", resets: [...MERGE, "environment_id"] },
  /** A restack or refresh needs the worker's worktree and bb shows none: the ticket waits outside the queue. */
  restack_left: { from: ["merging"], to: "pr_open", resets: [...MERGE, "environment_id"] },
  /** The human or the planner requeues a blocked ticket. */
  requeue: { from: ["blocked"], to: "queued", resets: [...SENT_ON, "pr_text_json"] },
  /** The human sends a blocked ticket back to review as it is. */
  review_again: { from: ["blocked"], to: "review", resets: SENT_ON },
  /** The human sends a blocked ticket back to its open pull request as it is; the next read starts afresh. */
  pr_again: { from: ["blocked"], to: "pr_open", resets: [...SENT_ON, "pr_text_json", "pr_checked_at"] },
  /** A ticket blocked at review goes back to it for the same head. */
  back_to_review: { from: ["blocked"], to: "review", resets: ["blocked_reason"] },
} as const satisfies Record<string, MoveRule>;

export type MoveName = keyof typeof MOVES;

/** A move and what it stores beside its resets, which may set a column it resets. */
export interface TicketMove {
  name: MoveName;
  set?: Partial<TicketRow>;
}

export const movesFrom = (name: MoveName): readonly TicketState[] => {
  const rule: MoveRule = MOVES[name];
  return rule.from === ANY ? TICKET_STATES.filter((state) => canMoveTicket(state, rule.to)) : rule.from;
};

/** Whether the ticket, in `from`, may take the move. */
export const canTake = (name: MoveName, from: TicketState): boolean => movesFrom(name).includes(from) && canMoveTicket(from, MOVES[name].to);

/** The columns the move writes: its resets, then what it sets. */
export function patchOf(move: TicketMove): Partial<TicketRow> {
  const resets = Object.fromEntries(MOVES[move.name].resets.map((column) => [column, RESET[column]]));
  return { ...resets, ...move.set };
}

/**
 * Moves the ticket and writes the move's patch in one transaction, with the ticket.state event; the event also carries
 * the failures the move counts. False, with nothing written, when the ticket is gone or the move cannot leave its state.
 */
export function tryMoveTicket(store: Store, ticketId: number, move: TicketMove, actor: string = LOOM_ACTOR, data: object = {}): boolean {
  return store.tx(() => {
    const current = store.ticket(ticketId);
    if (current === null || !canTake(move.name, current.state)) return false;
    apply(store, current, move, actor, data);
    return true;
  });
}

/** As tryMoveTicket, but a move the ticket's state refuses throws, as a direct change of state did. */
export function moveTicket(store: Store, ticketId: number, move: TicketMove, actor: string = LOOM_ACTOR, data: object = {}): TicketRow {
  return store.tx(() => {
    const current = store.ticket(ticketId);
    if (current === null) throw new StoreError(`No ticket ${ticketId}.`);
    const { to } = MOVES[move.name];
    if (!canTake(move.name, current.state)) throw new StoreError(`Ticket ${current.key} is ${current.state}; it cannot move to ${to}.`);
    apply(store, current, move, actor, data);
    return store.ticket(ticketId)!;
  });
}

function apply(store: Store, current: TicketRow, move: TicketMove, actor: string, data: object): void {
  const rule: MoveRule = MOVES[move.name];
  const patch = patchOf(move);
  store.setTicketState(current.id, rule.to, actor, patch.failures === undefined ? data : { ...data, failures: patch.failures });
  store.updateTicket(current.id, patch);
  if (rule.triage === true) store.updateProject(current.project_id, { triage_pending: 1 });
}
