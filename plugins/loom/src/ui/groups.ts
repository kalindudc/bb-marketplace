// Work's list groups tickets by whose move it is, in a fixed order, and gives each row Loom's own state word and at most
// three short facts. Pure: the list, the keys and the tests read the same grouping.
import type { BoardCard, MergeEntry, ProjectSummary } from "../contract";
import { cardFailure, retryFails, STEP_WORDS } from "../failing";
import { clockTime, formatDuration } from "../format";
import type { TicketState } from "../states";

export type Group = "need" | "failed" | "ready" | "working" | "waiting" | "paused" | "done";
export const GROUP_ORDER: readonly Group[] = ["need", "failed", "ready", "working", "waiting", "paused", "done"];

export const STATE_WORDS: Record<TicketState, string> = { queued: "queued", working: "working", checking: "checking", review: "in review", approved: "approved", merging: "merging", pr_open: "PR open", done: "done", blocked: "blocked", cancelled: "cancelled" };

/** The words of each group's heading; queued tickets of a project that is not running say why they wait. */
export function groupName(group: Group, projectState: ProjectSummary["state"]): string {
  switch (group) {
    case "need":
      return "Needs you";
    case "failed":
      return "Failed";
    case "ready":
      return "Ready for you";
    case "working":
      return "Working";
    case "waiting":
      return "Waiting on others";
    case "paused":
      return projectState === "draft" ? "Proposed" : projectState === "ready" ? "Not started" : "Paused";
    case "done":
      return "Done";
  }
}

const WORKING: readonly TicketState[] = ["working", "checking", "review", "approved", "merging"];

/** A failure Loom retries by itself that the person may want to step in on (failing.ts): any step but a read, or a read that persists or needs the person. */
function failure(card: BoardCard, entry: MergeEntry | undefined): string | null {
  const failed = cardFailure(card, entry?.finalReview);
  return failed === null ? null : failed.until === null ? failed.what : `${failed.what} · ${failed.verb} ${clockTime(failed.until)}`;
}

/** A read Loom retries that is not yet a failure: the ticket keeps its state word and group, and the retry is a fact on its row. */
export const retryFact = (card: BoardCard): string | null => (card.retry !== null && !retryFails(card.retry) ? `${STEP_WORDS[card.retry.step]} retry ${clockTime(card.retry.until)}` : null);

export function groupOf(card: BoardCard, projectState: ProjectSummary["state"], entry?: MergeEntry): Group {
  if (card.state === "done" || card.state === "cancelled") return "done";
  if (card.state === "blocked") return "need";
  if (failure(card, entry) !== null) return "failed";
  if (card.mergeConfirm?.ready === true || card.draft === "held" || entry?.verdict === "ready") return "ready";
  if (WORKING.includes(card.state)) return "working";
  if (card.state === "queued" && projectState !== "running") return "paused";
  return "waiting";
}

/** "#2324431" from a pull request URL. */
export const prNumber = (url: string | null) => (url === null ? null : (/\/(\d+)\/?$/u.exec(url)?.[1] ?? null));

const shortList = (keys: readonly string[]) => (keys.length <= 2 ? keys.join(", ") : `${keys.slice(0, 2).join(", ")} +${keys.length - 2}`);

/** A row's state word, and at most three short facts after it, none of which repeats the state. */
export function rowFacts(card: BoardCard, group: Group, entry?: MergeEntry): { word: string; facts: string[] } {
  const number = prNumber(card.prUrl);
  const pr = number === null ? null : `#${number}`;
  const fail = group === "failed" ? failure(card, entry) : null;
  const word = fail !== null ? "Failed" : STATE_WORDS[card.state];
  const facts: Array<string | null> = [];
  switch (card.state) {
    case "blocked":
      facts.push(card.ask === null ? "asks" : card.ask.options > 0 ? `asks · ${card.ask.options} options` : "asks", card.attempt > 0 ? `attempt ${card.attempt}` : null);
      break;
    case "queued": {
      const after = card.waitingOn.length > 0 ? card.waitingOn : [];
      const deps = card.prereqs.filter((prereq) => prereq.kind === "work").map((prereq) => prereq.key);
      facts.push(after.length > 0 ? `after ${shortList(after.filter((key) => deps.includes(key)).concat(after.filter((key) => !deps.includes(key))))}` : card.waitsForSlot || card.ready ? "next up" : null);
      break;
    }
    case "working":
      facts.push(card.attempt > 0 ? `attempt ${card.attempt}` : null, card.waitsForSlot ? "waits for a slot" : null);
      break;
    case "checking":
      facts.push(card.attempt > 0 ? `attempt ${card.attempt}` : null);
      break;
    case "review":
      facts.push(card.reviewRound > 0 ? `round ${card.reviewRound}` : null);
      break;
    case "approved":
      facts.push(card.reviewRound > 0 ? `round ${card.reviewRound} approved` : null, card.holding !== null ? "waits to open" : "push queued");
      break;
    case "merging":
      facts.push(pr);
      break;
    case "pr_open":
      facts.push(pr, card.mergeConfirm?.ready === true ? "confirm merge" : card.draft === "held" ? "held draft" : entry?.verdict === "ready" ? "ready to merge" : entry?.review === "APPROVED" ? "approved" : "in review");
      if (card.ci !== null && card.ci.failed > 0) facts.push(`${card.ci.failed} failing`);
      else if (entry?.checks != null) facts.push(`checks ${entry.checks.passed} of ${entry.checks.passed + entry.checks.failed + entry.checks.pending}`);
      break;
    case "done":
      facts.push(pr === null ? null : `${pr} merged`);
      break;
    case "cancelled":
      break;
  }
  if (fail !== null) facts.unshift(fail);
  if (card.stackedOn.length > 0 && card.state !== "done") facts.push(`stacked on ${shortList(card.stackedOn)}`);
  const kept = facts.filter((fact): fact is string => fact !== null);
  // A retry that is not a failure still shows: it takes the third place if the row has no room left.
  const retry = fail === null ? retryFact(card) : null;
  return { word, facts: retry === null ? kept.slice(0, 3) : [...kept.slice(0, 2), retry] };
}

/** How long a ticket has been in its state, as the row's right edge says it. */
export const ageOf = (card: Pick<BoardCard, "stateAt">, now: number) => formatDuration(Math.max(0, now - card.stateAt));

/** What the list's first screen has room for, measured from the page: its height and each part's. */
export interface ListFit {
  /** From the list's top to the bottom of the first screen. */
  room: number;
  /** Every group's heading, Done's included: always shown. */
  fixed: number;
  row: number;
  /** The "N more" line under a group that shows some of its rows. */
  fold: number;
}

/**
 * How many rows each group shows on the first screen: one row per group in order first, then one more each in turn, at
 * most `cap`, while they fit under every heading. A group that shows none folds into its heading, so when room runs out
 * the list shows headings only, never more rows. Unmeasured (null, as in tests), each group shows up to `cap`.
 */
export function rowsShown(sizes: readonly number[], fit: ListFit | null, cap = 8): number[] {
  if (fit === null) return sizes.map((size) => Math.min(size, cap));
  const shown = sizes.map(() => 0);
  const cost = () => shown.reduce((sum, n, at) => sum + n * fit.row + (n > 0 && n < sizes[at]! ? fit.fold : 0), fit.fixed);
  let grew = true;
  while (grew) {
    grew = false;
    for (let at = 0; at < sizes.length; at++) {
      if (shown[at]! >= Math.min(sizes[at]!, cap)) continue;
      shown[at]! += 1;
      if (cost() > fit.room) shown[at]! -= 1;
      else grew = true;
    }
  }
  return shown;
}

/**
 * The end of a title that tells it from a near-identical one in the same list: what comes after the longest prefix it
 * shares with another, when that prefix is long enough to be cut off. Null when nothing it shares is that long.
 */
export function distinguishingEnd(title: string, others: readonly string[], minShared = 24): string | null {
  let shared = 0;
  for (const other of others) {
    if (other === title) continue;
    let n = 0;
    while (n < title.length && n < other.length && title[n] === other[n]) n++;
    shared = Math.max(shared, n);
  }
  if (shared < minShared) return null;
  // Back to the word before the one the difference is in, so the end reads as words: "shard 13", and "shard 1" for the
  // title the other one starts with.
  const at = Math.min(shared, title.length - 1);
  const word = title.lastIndexOf(" ", at) + 1;
  const start = word <= 1 ? 0 : title.lastIndexOf(" ", word - 2) + 1;
  const end = title.slice(start);
  return end.length > 28 || start === 0 ? null : end;
}
