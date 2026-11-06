// Every piece of state Loom keeps beside a ticket's state, in the tickets table's JSON columns (and a worker thread's
// resume_json): one schema per column, one reader that checks a stored value against it, and one writer. A value that
// does not match its schema is a bug or a damaged row; the reader names the ticket and the column instead of guessing.
import { z } from "zod";

const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value);

/** A message to the worker is plain text, or a short summary the human sees and detail only the agent reads. */
const workerMessageSchema = z.union([z.string(), z.object({ summary: z.string(), detail: z.string() })]);
export type WorkerMessage = z.output<typeof workerMessageSchema>;

/** PrAsk: Loom asked the worker to write the pull request for `head`. */
const prAskSchema = z.object({ head: z.string(), at: z.number(), fix: z.boolean(), nudged: z.boolean() });
export type PrAsk = z.output<typeof prAskSchema>;

/** PrText: what opens the pull request or names the fix commit: the worker's text, or Loom's template (`by: "loom"`). */
const prTextSchema = z.object({ head: z.string(), by: z.enum(["worker", "loom"]), title: z.string().nullable(), body: z.string().nullable(), commit: z.string() });
export type PrText = z.output<typeof prTextSchema>;

/** PrStatus: the pull request's checks when Loom last read them. */
const prStatusSchema = z.object({
  at: z.number(),
  head: z.string(),
  passed: z.number(),
  failed: z.number(),
  pending: z.number(),
  /** When Loom first saw each check that is still queued on this head, by check key. */
  queued: record(z.number()).optional(),
});
export type PrStatus = z.output<typeof prStatusSchema>;

/**
 * HandBack: work going back to a ticket's worker (a pull request's fix round, a review's changes, a merge that did not
 * land), stored with the ticket's move to working and sent after it, so a failed send or a restart sends it again.
 */
const handBackSchema = z.object({
  /** The worker thread it goes to. */
  thread: z.string(),
  text: workerMessageSchema,
  /** When it began waiting for a free worker slot; absent once it has one. */
  waiting: z.number().optional(),
  /** The ticket says it waits for a slot. */
  noticed: z.boolean().optional(),
});
export type HandBack = z.output<typeof handBackSchema>;

/** Stack: what the ticket's branch is built on when its project stacks pull requests. */
const stackSchema = z.object({
  /** The pull request commit of each dependency in the ticket's repo that its branch contains, by ticket key. */
  deps: record(z.string()),
  /** The commit the ticket's own changes are measured against; null for the repo's fresh base. */
  base: z.string().nullable(),
  /** When the ticket's branch last took the repo's base branch: its first start, or Loom's last merge of the base into it. */
  synced: z.number(),
  /** The pull request commit of each dependency in another repo that the worker knows of, by ticket key. */
  cross: record(z.string()),
  /** Dependencies' commits that conflicted with each other, by ticket key, so the ticket waits until one of them changes. */
  conflict: z.object({ on: record(z.string()), files: z.array(z.string()) }).optional(),
  /** The hold last posted on the ticket, so each hold is posted once. */
  held: z.string().optional(),
  /** Files Loom carried to the worker's machine with conflict markers, which a submit may not keep. */
  markers: z.array(z.string()).optional(),
});
export type Stack = z.output<typeof stackSchema>;

/** StartWait: the ticket waits to start its worker or a reviewer again after a failed start. */
const startWaitSchema = z.object({
  role: z.enum(["worker", "reviewer"]),
  /** The thread row the next try starts again, so a wait keeps one attempt and one claim on the ticket. */
  row: z.number().nullable(),
  /** Failed starts in a row. */
  tries: z.number(),
  /** When the first of them failed. */
  since: z.number(),
  /** The earliest time Loom tries again. */
  until: z.number(),
  kind: z.enum(["unavailable", "failed"]),
  reason: z.string(),
  /** Failures in a row, not counting the starts an unavailable provider refused. */
  failedInRow: z.number(),
  /** Whether this failed start counted as a failed attempt. */
  counted: z.boolean(),
  /** When the provider first said it was unavailable in this streak; null while it has not. */
  unavailableSince: z.number().nullable(),
  /** The provider has been unavailable for an hour, so the wait is over and the ticket blocks. */
  expired: z.boolean(),
});
export type StartWait = z.output<typeof startWaitSchema>;

/** RetryWait: a merge, a pull request edit, or another step worth waiting out, failed `failures` times in a row in a way worth waiting out, the first at `since`; it runs again at `until`. */
const retryWaitSchema = z.object({ failures: z.number(), since: z.number(), until: z.number(), message: z.string() });
export type RetryWait = z.output<typeof retryWaitSchema>;

/** PollWait: the ticket's pull request reads failed `failures` times in a row with server errors, the first at `since`. */
const pollWaitSchema = z.object({ failures: z.number(), since: z.number(), message: z.string() });
export type PollWait = z.output<typeof pollWaitSchema>;

const reviewDecisionSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);
export type ReviewDecision = z.output<typeof reviewDecisionSchema>;

/** How many commits of the repo's remote base branch the pushed commit lacked when Loom last counted them on the project's checkout. */
const behindSchema = z.object({
  commits: z.number(),
  /** The pushed commit it counted, so a push makes the count stale. */
  sha: z.string(),
  /** The remote base branch's tip it counted against. */
  tip: z.string(),
  at: z.number(),
});
export type Behind = z.output<typeof behindSchema>;

/** PrMeta: the pull request's draft flag, review decision and base branch when Loom last read them. */
const prMetaSchema = z.object({
  /** When Loom read it. */
  at: z.number(),
  draft: z.boolean().nullable(),
  /** GitHub's review decision; null when the forge does not say, or when the repository requires no review and none was given. */
  review: reviewDecisionSchema.nullable(),
  /** The branch the pull request targets, as the forge reports it; null when the forge does not say. */
  base: z.string().nullable(),
  /** The pull request's state in that read; absent in a meta written before it was kept. */
  state: z.enum(["OPEN", "MERGED", "CLOSED"]).optional(),
  /** Whether it merges into its base without a conflict; null while the forge has not worked it out, or when it does not say; absent in a meta written before it was kept. */
  mergeable: z.boolean().nullable().optional(),
  /** Loom's own count; absent until Loom counted, and on a repo that does not set refresh_behind. */
  behind: behindSchema.optional(),
});
export type PrMeta = z.output<typeof prMetaSchema>;

/** The ticket's place in the deploy order, as its spec's `rollout` table says, with ticket keys in requires_live. */
const ticketRolloutSchema = z.object({
  stage: z.string().optional(),
  requires_live: z.array(z.string()).optional(),
  release: z.string().optional(),
  dark: z.boolean().optional(),
  how: z.string().optional(),
  verify: z.string().optional(),
  rollback: z.string().optional(),
});
export type TicketRollout = z.output<typeof ticketRolloutSchema>;

/** PrProposal: the pull request's title and description as the worker proposed them with loom_submit, for review. */
const prProposalSchema = z.object({
  /** The commit the submit that last changed it passed its checks with; null while its checks run. */
  head: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  at: z.number(),
});
export type PrProposal = z.output<typeof prProposalSchema>;

/** A title and the worker's part of a description; a null body is Loom's template. */
const prWantSchema = z.object({ title: z.string(), body: z.string().nullable() });
export type PrWant = z.output<typeof prWantSchema>;

/** PrApplied: the text Loom last set on the ticket's pull request, and an edit of it still to make. */
const prAppliedSchema = prWantSchema.extend({
  /** Loom could not set it through the forge, so it posted it on the ticket for the human to set. */
  byHand: z.boolean().optional(),
  /** The Rollout requirements that were live when Loom last wrote the description's Rollout section. */
  live: z.array(z.string()),
  at: z.number(),
  /** The text an edit that failed in a way worth waiting out still has to set. */
  want: prWantSchema.optional(),
  /** When that edit, or a refresh of the Rollout section that failed the same way, is tried again. */
  wait: retryWaitSchema.optional(),
  /** Why Loom could not refresh the Rollout section, each reason said once on the ticket. */
  said: z.array(z.string()).optional(),
  /** A hash of the block Loom last wrote between its markers, or found there already, so a format refresh runs once per block. */
  block: z.string().optional(),
});
export type PrApplied = z.output<typeof prAppliedSchema>;

/**
 * MergeStep: a merge Loom put in, or is putting in, the ticket's worker's worktree to bring its branch up to date (a
 * restack) or to take commits someone else pushed to its pull request branch (a tip), with the checks that must pass on
 * it before it becomes the ticket's head. It is kept on the ticket until they finish, so a run of the merge after a
 * failure worth waiting out, a pause or a restart finishes the same merge instead of merging again from the older head,
 * and nothing is pushed or accounted for before its checks pass; then, checked, until Loom pushes it.
 */
const mergeStepSchema = z.object({
  kind: z.enum(["restack", "tip"]),
  /** The ticket's head when Loom merged; the step holds only while head_sha is still this. */
  from: z.string(),
  sha: z.string(),
  /** The merge's tree, which a worker on another machine is checked by; null for a merge made in a worker's own worktree. */
  tree: z.string().nullable(),
  /** The worker is on another machine, which gets the merge as linear commits. */
  remote: z.boolean(),
  /** What the merge took, for the posts. */
  what: z.string(),
  /** What it took by branch or remote ref, for the subject of the commit Loom pushes; none in a step from before 0.35.0. */
  sources: z.array(z.string()).optional(),
  /** What the checks measure the worktree against. */
  checkBase: z.string(),
  /** A restack's stack: what the ticket's branch is built on once the merge is in. */
  stack: stackSchema.optional(),
  /** A tip's pull request branch tip, which Loom accounts for as pushed once the worker's worktree builds on it. */
  tip: z.string().optional(),
  /** Refs on the checkout to point at the merge once it is in the worktree. */
  refs: z.array(z.string()),
  /** The restacked post's data, besides the sha and the runs. */
  data: record(z.unknown()),
  /** Its checks passed and it is the ticket's head; it stays until Loom pushes it, so a push that failed is made on the next run. */
  checked: z.boolean().optional(),
});
export type MergeStep = z.output<typeof mergeStepSchema>;

/** Resume: the work a worker on a new machine must carry in with loom_resume before it submits. */
const resumeSchema = z.object({
  sha: z.string(),
  tree: z.string(),
  /** The tree the worktree has now, which the carry may replace: the head Loom merged on the project's machine. */
  replaces: z.string().optional(),
});
export type Resume = z.output<typeof resumeSchema>;

const SCHEMAS = {
  pr_ask_json: prAskSchema,
  pr_text_json: prTextSchema,
  /** The ids of the pull request's checks, reviews and comments already sent to a worker. */
  pr_seen_json: z.array(z.string()),
  pr_status_json: prStatusSchema,
  handback_json: handBackSchema,
  stack_json: stackSchema,
  start_wait_json: startWaitSchema,
  /** The ticket's merge patch over its repo's environment inputs. */
  environment_json: record(z.unknown()),
  pr_poll_json: pollWaitSchema,
  /** The keys of the tickets whose pull requests merge before this one's. */
  merge_after_json: z.array(z.string()),
  pr_meta_json: prMetaSchema,
  rollout_json: ticketRolloutSchema,
  merge_wait_json: retryWaitSchema,
  merge_step_json: mergeStepSchema,
  pr_proposal_json: prProposalSchema,
  pr_applied_json: prAppliedSchema,
  resume_json: resumeSchema,
} as const;

export type SubColumn = keyof typeof SCHEMAS;
export type SubValue<C extends SubColumn> = z.output<(typeof SCHEMAS)[C]>;
/** The columns the tickets table declares NOT NULL, with an empty list for none. */
type ListColumn = "pr_seen_json" | "merge_after_json";
type Read<C extends SubColumn> = C extends ListColumn ? SubValue<C> : SubValue<C> | null;
type Stored<C extends SubColumn> = C extends ListColumn ? string : string | null;

/** The row a sub-state value is read from: the column, what names the row in an error, and its state. */
type SubRow<C extends SubColumn> = { [K in C]: string | null } & { id?: number; key?: string; state?: string; thread_id?: string | null; ticket_id?: number | null };

/** A stored value that does not match its schema: the row, the column and what is wrong, with the ticket it belongs to. */
export class SubStateError extends Error {
  constructor(
    readonly ticketId: number | null,
    readonly key: string | null,
    readonly column: SubColumn,
    readonly detail: string,
    readonly json: string | null,
    name: string,
  ) {
    super(`The ${column} of ${name} ${detail}`);
    this.name = "SubStateError";
  }
}

const rowName = (row: { id?: number; key?: string; thread_id?: string | null }) =>
  row.key !== undefined ? `ticket ${row.key}` : row.thread_id != null ? `thread ${row.thread_id}` : `row ${row.id ?? "(unknown)"}`;

// A blocked, done or cancelled ticket, and an ended thread, do no work that reads their own state; other tickets' scans
// still read them. A malformed value there reads as absent and is noticed, so one damaged row cannot stop the rest.
const resting = (row: { key?: string; state?: string; ticket_id?: number | null }) =>
  row.key !== undefined ? row.state === "blocked" || row.state === "done" || row.state === "cancelled" : row.ticket_id !== undefined && row.state === "ended";

const noticed = new Map<string, SubStateError>();
let displaying: SubStateError[] | null = null;

/** The malformed values reads let through as absent since the last call: on resting rows, and in reads that only display. */
export function takeNoticed(): SubStateError[] {
  const all = [...noticed.values()];
  noticed.clear();
  return all;
}

/** Runs a read that only displays: a malformed value reads as absent and is reported, instead of throwing. Synchronous code only. */
export function shown<T>(read: () => T): { value: T; unreadable: SubStateError[] } {
  const outer = displaying;
  const unreadable: SubStateError[] = [];
  displaying = unreadable;
  try {
    return { value: read(), unreadable };
  } finally {
    displaying = outer;
  }
}

function malformed<C extends SubColumn>(row: SubRow<C>, column: C, detail: string): Read<C> {
  const ticketId = row.key !== undefined ? (row.id ?? null) : (row.ticket_id ?? null);
  const error = new SubStateError(ticketId, row.key ?? null, column, detail, row[column], rowName(row));
  if (displaying === null && !resting(row)) throw error;
  displaying?.push(error);
  noticed.set(`${ticketId ?? rowName(row)}\u0000${column}\u0000${row[column]}`, error);
  return (column === "pr_seen_json" || column === "merge_after_json" ? [] : null) as Read<C>;
}

/**
 * The column's value, checked against its schema; null for none. Throws, naming the row and column, on a malformed value,
 * except on a resting row or inside `shown`, where it reads as absent and is noticed (takeNoticed).
 */
export function readSub<C extends SubColumn>(row: SubRow<C>, column: C): Read<C> {
  const json = row[column];
  if (json === null) {
    if (column === "pr_seen_json" || column === "merge_after_json") return malformed(row, column, "is null; it is never null.");
    return null as Read<C>;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return malformed(row, column, `is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = SCHEMAS[column].safeParse(value);
  if (!parsed.success) return malformed(row, column, `does not match its schema: ${z.prettifyError(parsed.error)}`);
  // The stored value, not zod's copy, which drops keys the schema does not name, such as one a newer Loom wrote.
  return value as Read<C>;
}

/** The patch that stores `value` in the column, or clears it for null. Throws on a value its schema refuses. */
export function writeSub<C extends SubColumn>(column: C, value: Read<C>): { [K in C]: Stored<C> } {
  if (value !== null) {
    const parsed = SCHEMAS[column].safeParse(value);
    if (!parsed.success) throw new Error(`Loom tried to store a malformed ${column}: ${z.prettifyError(parsed.error)}`);
  }
  return { [column]: value === null ? null : JSON.stringify(value) } as { [K in C]: Stored<C> };
}

/** Every sub-state column, for checks that walk a whole row. */
export const SUB_COLUMNS = Object.keys(SCHEMAS) as SubColumn[];
