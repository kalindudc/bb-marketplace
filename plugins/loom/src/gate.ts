// The phase gate, read in one pass: what the finished phase recorded under the version in force (each ticket's pull
// request, merge commit, last checks read, last review verdict, or why it was cancelled), beside what the pending version
// proposes for the next phase (its tickets with the keys approval gives them, which start at once and which wait), and
// every other change the version makes. Read-only: it never writes, and a rewound view has no gate.
import type { ProjectRow, Store, TicketRow } from "./db/store";
import { phaseMergeCommits, phasesOf } from "./phases";
import { statusOf } from "./pull-requests";
import { readyTickets, spawnable, toLite, type TicketLite } from "./scheduler";
import type { Spec } from "./spec";
import { specDiff, type SpecChange } from "./spec-diff";
import type { ReviewVerdict, TicketState } from "./states";

export interface GateRecordedTicket {
  key: string;
  title: string;
  repo: string | null;
  state: TicketState;
  prUrl: string | null;
  /** The commit its merge made, when Loom recorded one; null shows "not recorded". */
  mergeSha: string | null;
  /** The checks on its pull request's head when Loom last read them; null when it never read any. */
  checks: { passed: number; failed: number; pending: number; at: number } | null;
  /** Its last review: the verdict, the round and the reviewer's thread. */
  review: { verdict: ReviewVerdict; round: number; threadId: string | null; at: number } | null;
  /** Why it was cancelled, quoted from its post, and by whom. */
  cancel: { reason: string; by: "human" | "planner" | "loom"; at: number } | null;
}

export interface GateProposedTicket {
  ref: string;
  /** The key approval gives it; provisional until then. */
  key: string;
  title: string;
  repo: string | null;
  /** Prerequisites by kind, as keys: a board ticket's key, or another proposed ticket's provisional key. `live` may name a milestone. */
  dependsOn: string[];
  mergeAfter: string[];
  requiresLive: string[];
  /** Its prerequisites and scope let a worker take it, by the scheduler's own pick; it may still wait for the project to run or for a free slot. */
  ready: boolean;
  /** It starts once the version is approved: ready, the project running, and a worker slot free for it in the scheduler's order. */
  starts: boolean;
}

export interface GateView {
  /** The pending version, and the version in force it is compared with. */
  version: number;
  inForce: number;
  proposedAt: number;
  /** The phase that closed, as Loom recorded it; null when the version fills the first phase. */
  finished: {
    index: number;
    ref: string;
    title: string;
    goal: string;
    doneWhen: string[];
    /** The planner's report, from the pending version; Loom does not check its claims. */
    report: string | null;
    closedAt: number | null;
    tickets: GateRecordedTicket[];
  } | null;
  proposed: {
    index: number;
    ref: string;
    title: string;
    goal: string;
    doneWhen: string[];
    maxTickets: number;
    tickets: GateProposedTicket[];
  };
  /** How many tickets start once approved (those with `starts`), and how many wait: none start while the project is paused or held. */
  startNow: number;
  wait: number;
  maxWorkers: { before: number; after: number };
  /** When a rate-limit hold on the project ends, while it is still in the future: the engine starts nothing until then. Null when there is none. */
  holdUntil: number | null;
  /** Every other change in the version: outlines, later phases, settings. The proposed phase and its tickets are on their own. */
  changes: SpecChange[];
}

const cancelOf = (store: Store, ticket: TicketRow): GateRecordedTicket["cancel"] => {
  if (ticket.state !== "cancelled") return null;
  const post = store.posts(ticket.id).filter((one) => one.kind === "system" && one.body.startsWith("Cancelled:")).at(-1);
  if (post === undefined) return { reason: "", by: "loom", at: ticket.state_at };
  return { reason: post.body.slice("Cancelled:".length).trim(), by: post.author_kind === "human" ? "human" : post.author_kind === "planner" ? "planner" : "loom", at: post.at };
};

const reviewOf = (store: Store, ticket: TicketRow): GateRecordedTicket["review"] => {
  const last = store.reviews(ticket.id).at(-1);
  if (last === undefined) return null;
  const thread = last.thread_row_id === null ? null : store.thread(last.thread_row_id);
  return { verdict: last.verdict, round: last.round, threadId: thread?.thread_id ?? null, at: last.at };
};

/** A merge commit from the ticket's done move, or the integration merge's post. */
const mergeShaOf = (store: Store, ticket: TicketRow, recorded: ReadonlyMap<string, string>): string | null => {
  const known = recorded.get(ticket.key);
  if (known !== undefined) return known;
  const merged = store.posts(ticket.id).filter((post) => post.kind === "merge").map((post) => JSON.parse(post.data_json) as { outcome?: string; sha?: string }).filter((data) => data.outcome === "merged" && typeof data.sha === "string").at(-1);
  return merged?.sha ?? null;
};

/**
 * The gate for a pending version that fills the next planned phase; null for any other pending version. `inForce` is the
 * approved spec, `pending` the version waiting for approval.
 */
export function gateOf(store: Store, project: ProjectRow, inForce: Spec, pending: Spec, tickets: readonly TicketRow[], now: number): GateView | null {
  if (project.pending_version === null) return null;
  const pendingPhases = phasesOf(pending, tickets);
  const proposedIndex = pendingPhases?.findIndex((phase) => phase.state === "planned" && pending.ticket.some((ticket) => ticket.phase === phase.ref)) ?? -1;
  if (pendingPhases === null || proposedIndex < 0) return null;
  const proposedPhase = pending.phase![proposedIndex]!;
  const batch = pending.ticket.filter((ticket) => ticket.phase === proposedPhase.ref);

  const first = tickets.reduce((max, ticket) => Math.max(max, ticket.seq), 0) + 1;
  const keyOf = new Map<string, string>([...tickets.map((ticket) => [ticket.ref, ticket.key] as const), ...batch.map((ticket, index) => [ticket.ref, `${project.key}-${first + index}`] as const)]);
  const key = (ref: string) => keyOf.get(ref) ?? ref;

  // The scheduler's own pick, as if the version were approved now: the board as it is, and the batch queued.
  const lites: TicketLite[] = [
    ...tickets.map(toLite),
    ...batch.map((ticket, index) => ({ id: -1 - index, key: key(ticket.ref), state: "queued" as const, priority: ticket.priority, seq: first + index, deps: ticket.depends_on.map(key), scope: ticket.scope, repo: ticket.repo ?? null, pushed: false, holds: false, waitsSince: null })),
  ];
  const batchKeys = new Set(batch.map((ticket) => key(ticket.ref)));
  const stack = pending.merge.stack === true;
  const ready = new Set(readyTickets(lites, stack).filter((lite) => batchKeys.has(lite.key)).map((lite) => lite.key));
  // The engine spawns the ready tickets in pick order into the free slots; board tickets ahead of the batch take theirs first.
  // The engine's own condition (engine.ts, spawnReady): a project held past now starts nothing until the hold ends.
  const holdUntil = project.hold_until !== null && project.hold_until > now ? project.hold_until : null;
  const starts = new Set(project.state === "running" && holdUntil === null ? spawnable(pending.agents.max_workers, lites, undefined, stack).filter((lite) => batchKeys.has(lite.key)).map((lite) => lite.key) : []);
  const startNow = starts.size;

  const finishedIndex = proposedIndex - 1;
  const finishedPhase = finishedIndex >= 0 ? (inForce.phase?.find((phase) => phase.ref === pending.phase![finishedIndex]!.ref) ?? pending.phase![finishedIndex]!) : null;
  const recordedRows = finishedPhase === null ? [] : [...tickets].filter((ticket) => ticket.phase === finishedPhase.ref).sort((a, b) => a.seq - b.seq);
  const merges = phaseMergeCommits(store, recordedRows);
  const closed = finishedPhase === null ? undefined : store.eventsOfKind(project.id, "phase.done").filter((event) => (JSON.parse(event.data_json) as { ref?: string }).ref === finishedPhase.ref).at(-1);

  const proposedPath = `phase[${proposedIndex}]`;
  const changes = specDiff(inForce, pending)
    .filter((change) => {
      if (change.kind === "ticket-added" && batch.some((ticket) => ticket.ref === change.ref)) return false;
      if (change.path === proposedPath || change.path.startsWith(`${proposedPath}.`)) return false;
      return true;
    })
    // A value that was not set, or is no longer, is undefined, which is not JSON: the page reads null as "not set" too.
    .map((change) => (change.kind === "value" ? { ...change, before: change.before ?? null, after: change.after ?? null } : change));

  return {
    version: project.pending_version,
    inForce: project.approved_version ?? project.pending_version,
    proposedAt: store.specVersion(project.id, project.pending_version)?.created_at ?? 0,
    finished:
      finishedPhase === null
        ? null
        : {
            index: finishedIndex,
            ref: finishedPhase.ref,
            title: finishedPhase.title,
            goal: finishedPhase.goal,
            doneWhen: finishedPhase.done_when,
            report: pending.phase![finishedIndex]!.report ?? null,
            closedAt: closed?.at ?? (recordedRows.length === 0 ? null : Math.max(...recordedRows.map((ticket) => ticket.state_at))),
            tickets: recordedRows.map((ticket) => {
              const status = statusOf(ticket);
              return {
                key: ticket.key,
                title: ticket.title,
                repo: ticket.repo,
                state: ticket.state,
                prUrl: ticket.pr_url,
                mergeSha: ticket.state === "done" ? mergeShaOf(store, ticket, merges) : null,
                checks: status === null || status.head === null ? null : { passed: status.passed, failed: status.failed, pending: status.pending, at: status.at },
                review: reviewOf(store, ticket),
                cancel: cancelOf(store, ticket),
              };
            }),
          },
    proposed: {
      index: proposedIndex,
      ref: proposedPhase.ref,
      title: proposedPhase.title,
      goal: proposedPhase.goal,
      doneWhen: proposedPhase.done_when,
      maxTickets: proposedPhase.max_tickets ?? 8,
      tickets: batch.map((ticket) => ({
        ref: ticket.ref,
        key: key(ticket.ref),
        title: ticket.title,
        repo: ticket.repo ?? null,
        dependsOn: ticket.depends_on.map(key),
        mergeAfter: (ticket.merge_after ?? []).map(key),
        requiresLive: (ticket.rollout?.requires_live ?? []).map(key),
        ready: ready.has(key(ticket.ref)),
        starts: starts.has(key(ticket.ref)),
      })),
    },
    startNow,
    wait: batch.length - startNow,
    maxWorkers: { before: inForce.agents.max_workers, after: pending.agents.max_workers },
    holdUntil,
    changes,
  };
}
