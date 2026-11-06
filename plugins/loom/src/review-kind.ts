// What a review round and a finding are about: the change itself (code) or only the pull request's title and
// description (text). The engine, the metrics and Insights read rounds through these, so they agree. A text review starts
// in a scratch directory of its own, which its reviewer row owns.
import type { EngineCtx } from "./ctx";
import type { Store, ThreadRow, TicketRow } from "./db/store";
import { prSettings } from "./repos";
import type { Finding } from "./review";
import type { Spec } from "./spec";

export const FINDING_KINDS = ["code", "text"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const isTextFinding = (finding: Finding) => finding.kind === "text";

/** Findings that ask only for new pull request text, which a worker gives with loom_submit's pr and no file change. */
export const onlyText = (findings: readonly Finding[]) => findings.length > 0 && findings.every(isTextFinding);

const roundKey = (ticketId: number, round: number) => `${ticketId}:${round}`;

interface Move {
  ticketId: number | null;
  data: Record<string, unknown>;
}

/** The review rounds a submit that changed only the proposed text started, which a text review judges, as `ticketId:round`. */
export function textRounds(moves: Iterable<Move>): Set<string> {
  const rounds = new Set<string>();
  for (const { ticketId, data } of moves) {
    if (ticketId !== null && data.to === "review" && data.textOnly === true && typeof data.round === "number") rounds.add(roundKey(ticketId, data.round));
  }
  return rounds;
}

export const inTextRound = (rounds: ReadonlySet<string>, review: { ticket_id: number; round: number }) => rounds.has(roundKey(review.ticket_id, review.round));

/** A review round that sent the ticket back to its worker for its pull request's text alone. */
export const sentBackForText = (data: Record<string, unknown>) => data.from === "review" && data.to === "working" && data.textOnly === true;

/** Text rounds need a worker who proposes the text: the pr strategy with merge.describe = "worker". Elsewhere a text finding is an ordinary one. */
export const textRoundsOn = (spec: Spec) => spec.merge.strategy === "pr" && prSettings(spec).describe === "worker";

const movesOf = (store: Store, ticketId: number): Move[] =>
  store.ticketEvents(ticketId, ["ticket.state"]).map((event) => ({ ticketId: event.ticket_id, data: JSON.parse(event.data_json) as Record<string, unknown> }));

const isTextRound = (store: Store, ticketId: number, round: number) => textRounds(movesOf(store, ticketId)).has(roundKey(ticketId, round));

/** What the ticket's current review round judges: only the proposed text, or the code with it. */
export function roundKind(store: Store, ticket: TicketRow): FindingKind {
  return isTextRound(store, ticket.id, ticket.review_round) ? "text" : "code";
}

/**
 * The scratch directory a text reviewer starts in, under the final review's scratch root on the project's machine, named
 * by its reviewer row: the row exists before the directory is made, so the directory always has an owner on record.
 */
export const textReviewScratch = (rowId: number) => `loom-text-review-${rowId}`;

/** A reviewer thread row of a text round, which owns a scratch directory until it has ended. */
export const isTextReviewer = (store: Store, row: ThreadRow) => row.role === "reviewer" && row.ticket_id !== null && isTextRound(store, row.ticket_id, row.review_round);

/** The scratch directories of the text reviewers that have not ended, which the scratch sweep keeps. */
export function liveTextReviewScratches(store: Store): string[] {
  return store.threads({ role: "reviewer", states: ["spawning", "active", "ending"] }).flatMap((row) => (isTextReviewer(store, row) ? [textReviewScratch(row.id)] : []));
}

/** Removes a text reviewer's scratch directory once its thread has stopped; one that stays is left to the sweep. */
export async function removeTextReviewScratch(ctx: EngineCtx, row: ThreadRow): Promise<void> {
  const host = ctx.store.project(row.project_id)?.host_id ?? null;
  if (host === null || !isTextReviewer(ctx.store, row)) return;
  await ctx.host.call(host, "finalScratch", { key: textReviewScratch(row.id), action: "remove" }).catch((error: unknown) => {
    ctx.bb.log("warn", `Could not remove the text review's scratch directory ${textReviewScratch(row.id)}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Whether the ticket's worker is in a text-only round: the move that last gave it the ticket sent it back for its text,
 * and only its own submits and their checks happened since. A requeue, a block or a new worker ends it.
 */
export function textRoundOpen(store: Store, ticket: TicketRow): boolean {
  const moves = movesOf(store, ticket.id);
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const { data } = moves[index]!;
    if ((data.from === "working" && data.to === "checking") || (data.from === "checking" && data.to === "working")) continue;
    return sentBackForText(data);
  }
  return false;
}
