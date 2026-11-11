// When a step Loom retries by itself makes a ticket a failed one. One failed read of a pull request, such as the one every
// open ticket makes while a plugin reload retires the host process, is not: the ticket keeps its own state and shows the
// retry as a fact. A read that keeps failing, a failure someone has to put right, or any other step that failed is. Work's
// Failed group and Home's queue both read it here, so they agree. A leaf module: the page imports it.
import type { BoardCard, RetryView } from "./contract";

/** Failed reads of a pull request in a row before its ticket counts as failed. */
export const READ_FAILURES = 3;

const READS: ReadonlyArray<RetryView["step"]> = ["read", "settle"];
export const STEP_WORDS: Record<RetryView["step"], string> = { merge: "merge", diff: "diff", read: "PR read", settle: "PR settle" };

/** Whether a step's failure makes its ticket a failed one, rather than a fact on its row. */
export function retryFails(retry: Pick<RetryView, "step" | "failures" | "kind">): boolean {
  if (!READS.includes(retry.step)) return true;
  return retry.failures >= READ_FAILURES || retry.kind === "lasting";
}

/** What failed and when Loom tries again ("retry") or asks bb again ("asks"); `until` is null when Loom does not retry by itself. */
export interface CardFailure {
  what: string;
  verb: "retry" | "asks";
  until: number | null;
  /** When the failing began, where Loom records it. */
  since: number | null;
}

/** Why a ticket is a failed one; null when it is not. `finalReview` is its merge order entry's final review, if any. */
export function cardFailure(card: Pick<BoardCard, "retry" | "startWait" | "reviewerLookup">, finalReview?: { state: string } | null): CardFailure | null {
  if (card.retry !== null && retryFails(card.retry)) return { what: `${STEP_WORDS[card.retry.step]} failed`, verb: "retry", until: card.retry.until, since: card.retry.since };
  if (card.startWait !== null && !card.startWait.unavailable) return { what: `${card.startWait.role} did not start`, verb: "retry", until: card.startWait.until, since: null };
  if (card.reviewerLookup !== null) return { what: "reviewer unknown", verb: "asks", until: card.reviewerLookup.until, since: null };
  if (finalReview?.state === "failed" || finalReview?.state === "held") return { what: `final review ${finalReview.state}`, verb: "retry", until: null, since: null };
  return null;
}
