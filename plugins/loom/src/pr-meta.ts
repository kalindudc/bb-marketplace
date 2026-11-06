// What Loom last read about a pull request besides its checks: whether it is a draft, its review decision, the branch
// it targets and whether it merges without a conflict. GitHub reports all four; a command forge reports what its feedback
// command prints, and null where it prints nothing, so a forge that cannot tell never reads as approved or as ready.
// Beside them, Loom keeps its own count of how far the pushed commit is behind the remote base, on a repo that sets
// refresh_behind, which no forge read replaces.
import type { TicketRow } from "./db/store";
import { readSub, type PrMeta } from "./sub-state";

export const metaOf = (ticket: Pick<TicketRow, "pr_meta_json">): PrMeta | null => readSub(ticket, "pr_meta_json");

/** A forge read's meta, with the count Loom keeps itself. */
export function readMeta(ticket: Pick<TicketRow, "pr_meta_json">, read: Omit<PrMeta, "behind">): PrMeta {
  const behind = metaOf(ticket)?.behind;
  return behind === undefined ? read : { ...read, behind };
}
