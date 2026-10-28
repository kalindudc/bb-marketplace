// What Loom last read about a pull request besides its checks: whether it is a draft, its review decision, the branch
// it targets and whether it merges without a conflict. GitHub reports all four; a command forge reports what its feedback
// command prints, and null where it prints nothing, so a forge that cannot tell never reads as approved or as ready.
// Beside them, Loom keeps its own count of how far the pushed commit is behind the remote base, on a repo that sets
// refresh_behind, which no forge read replaces.
import type { TicketRow } from "./db/store";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

/** How many commits of the repo's remote base branch the pushed commit lacked when Loom last counted them on the project's checkout. */
export interface Behind {
  commits: number;
  /** The pushed commit it counted, so a push makes the count stale. */
  sha: string;
  /** The remote base branch's tip it counted against. */
  tip: string;
  at: number;
}

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
  /** Whether it merges into its base without a conflict; null while the forge has not worked it out, or when it does not say; absent in a meta written before it was kept. */
  mergeable?: boolean | null;
  /** Loom's own count; absent until Loom counted, and on a repo that does not set refresh_behind. */
  behind?: Behind;
}

export const metaOf = (ticket: Pick<TicketRow, "pr_meta_json">): PrMeta | null => (ticket.pr_meta_json === null ? null : (JSON.parse(ticket.pr_meta_json) as PrMeta));

/** A forge read's meta, with the count Loom keeps itself. */
export function readMeta(ticket: Pick<TicketRow, "pr_meta_json">, read: Omit<PrMeta, "behind">): PrMeta {
  const behind = metaOf(ticket)?.behind;
  return behind === undefined ? read : { ...read, behind };
}
