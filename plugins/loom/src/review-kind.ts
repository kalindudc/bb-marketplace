// What a review round and a finding are about: the change itself (code) or only the pull request's title and
// description (text). The engine, the metrics and Insights read rounds through these, so they agree.
import type { Store, TicketRow } from "./db/store";
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

/** A review round that sent the ticket back to its worker for its pull request's text alone. */
export const sentBackForText = (data: Record<string, unknown>) => data.from === "review" && data.to === "working" && data.textOnly === true;

/** Text rounds need a worker who proposes the text: the pr strategy with merge.describe = "worker". Elsewhere a text finding is an ordinary one. */
export const textRoundsOn = (spec: Spec) => spec.merge.strategy === "pr" && prSettings(spec).describe === "worker";

const movesOf = (store: Store, ticketId: number): Move[] =>
  store.ticketEvents(ticketId, ["ticket.state"]).map((event) => ({ ticketId: event.ticket_id, data: JSON.parse(event.data_json) as Record<string, unknown> }));

/** What the ticket's current review round judges: only the proposed text, or the code with it. */
export function roundKind(store: Store, ticket: TicketRow): FindingKind {
  return textRounds(movesOf(store, ticket.id)).has(roundKey(ticket.id, ticket.review_round)) ? "text" : "code";
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
