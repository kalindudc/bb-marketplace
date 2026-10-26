// What Loom last read about a pull request besides its checks: whether it is a draft, its review decision and the branch
// it targets. GitHub reports all three; a command forge reports what its feedback command prints, and null where it
// prints nothing, so a forge that cannot tell never reads as approved or as ready.
import type { TicketRow } from "./db/store";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface PrMeta {
  /** When Loom read it. */
  at: number;
  draft: boolean | null;
  /** GitHub's review decision; null when the forge does not say, or when the repository requires no review and none was given. */
  review: ReviewDecision | null;
  /** The branch the pull request targets, as the forge reports it; null when the forge does not say. */
  base: string | null;
  /** The pull request's state in that read; absent in a meta written before it was kept. */
  state?: "OPEN" | "MERGED" | "CLOSED";
}

export const metaOf = (ticket: Pick<TicketRow, "pr_meta_json">): PrMeta | null => (ticket.pr_meta_json === null ? null : (JSON.parse(ticket.pr_meta_json) as PrMeta));
