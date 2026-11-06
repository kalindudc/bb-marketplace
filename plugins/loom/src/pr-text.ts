// The text a ticket's next push uses for its pull request and commit: the worker's for the reviewed head, or Loom's
// template. Pure functions over the ticket row, so the merge queue and the release of idle workers can read them.
import type { TicketRow } from "./db/store";
import { prSettings } from "./repos";
import type { Spec } from "./spec";
import { readSub, type PrText } from "./sub-state";

/** A ticket whose pull request branch Loom pushed before: its next push is a fix round, one more commit on that branch. */
export const inFixRound = (ticket: TicketRow) => ticket.pr_branch !== null && ticket.pushed_sha !== null;

/** The text the next push uses, when it is ready: the worker's for this head, or the template when the spec says so. */
export function prTextFor(spec: Spec, ticket: TicketRow): PrText | null {
  if (prSettings(spec).describe === "loom") return templateText(ticket, null);
  const text = readSub(ticket, "pr_text_json");
  return text !== null && text.head === ticket.head_sha ? text : null;
}

/** On the pr strategy, an approved ticket merges only once its pull request's text is ready. */
export const prTextReady = (spec: Spec, ticket: TicketRow) => spec.merge.strategy !== "pr" || prTextFor(spec, ticket) !== null;

/** Loom's template text for the next push: the ticket's title as the commit's subject, or a fix round's plain one. No ticket key. */
export function templateText(ticket: TicketRow, body: string | null): PrText {
  const commit = inFixRound(ticket) ? "Address review feedback" : ticket.title;
  return { head: ticket.head_sha!, by: "loom", title: null, body, commit };
}
