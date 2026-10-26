// The order a pull request project's pull requests merge in, as pure functions over ticket rows. A pull request is at
// step 1 when nothing it waits on is still open, and one step after the latest of those otherwise. It waits on the
// tickets it depends on and the ones its merge_after names; it is stacked when it targets another ticket's pull request
// branch, so merging it first would put it into that branch instead of the base. Nothing here asks the forge: it reads
// what the poll last stored, so the page never adds a call to GitHub.
import type { TicketRow } from "./db/store";
import { metaOf, type ReviewDecision } from "./pr-meta";
import { statusOf } from "./pull-requests";
import { repoSettings } from "./repos";
import type { Spec } from "./spec";
import type { TicketState } from "./states";

export type MergeVerdict =
  /** Nothing before it, it targets the base, its checks pass, and the forge says it is approved and not a draft. */
  | "ready"
  /** Nothing before it, but the pull request itself holds it: a draft, a review, checks, or a fix round Loom is pushing. */
  | "first"
  /** Nothing before it and its checks pass, but the forge did not say it is approved and not a draft, so Loom cannot say it is ready. */
  | "checks_pass"
  | "after"
  /** The pull request it was stacked on merged; Loom moves it to the base and runs its checks again. */
  | "moving"
  | "no_pr"
  | "blocked"
  | "merged"
  /** Merged while it targeted another ticket's pull request branch, which has not merged, so its change is not on the base. */
  | "merged_elsewhere";

export interface MergeWait {
  key: string;
  why: "stacked" | "depends" | "merge_after";
  repo: string | null;
  prNumber: string | null;
}

export interface MergeEntry {
  key: string;
  title: string;
  repo: string | null;
  state: TicketState;
  /** The branch its repo merges into: "main". */
  base: string;
  prUrl: string | null;
  prNumber: string | null;
  /** It has a pull request that is still open: Loom pushed a commit to it and it has neither merged nor closed. */
  prOpen: boolean;
  /** The branch the pull request targets when it is neither the base nor another ticket's pull request branch. */
  elsewhere: string | null;
  /** 1 for nothing before it, one more than the latest open one it waits on otherwise; 0 once it merged. */
  step: number;
  /** The open ticket whose pull request branch this one targets. */
  stackedOn: string | null;
  /** What it still waits on, the ticket it is stacked on first. */
  waitsOn: MergeWait[];
  /** The open tickets that wait on it. */
  unblocks: string[];
  checks: { passed: number; failed: number; pending: number } | null;
  draft: boolean | null;
  review: ReviewDecision | null;
  /** The forge reported its draft flag or review decision. */
  reviewRead: boolean;
  verdict: MergeVerdict;
  /** On a pull request with nothing before it, what still holds it, in words: "draft", "needs review", "1 check pending". */
  holds: string[];
  /** The forge says it is approved while the pull request it is stacked on is still open. */
  trap: boolean;
  /** For merged_elsewhere: the ticket whose branch it merged into, and that ticket's state now. */
  mergedInto: string | null;
  mergedIntoState: TicketState | null;
  blockedReason: string | null;
}

export interface MergeOrderView {
  /** Repos in the spec's [[repo]] order, with null for a single-repo project. */
  repos: Array<string | null>;
  steps: number;
  entries: MergeEntry[];
  /** Open pull requests; those at step 1; those ready to merge; those merged into the branch of a ticket that has not merged. */
  counts: { open: number; first: number; ready: number; wrong: number };
}

const FINISHED: readonly TicketState[] = ["done", "cancelled"];
const numberOf = (url: string | null) => (url === null ? null : (/\/(\d+)\/?$/u.exec(url)?.[1] ?? null));
const keysOf = (json: string) => JSON.parse(json) as string[];

export function mergeOrderOf(spec: Spec, tickets: readonly TicketRow[]): MergeOrderView | null {
  if (spec.merge.strategy !== "pr") return null;
  const shown = tickets.filter((ticket) => ticket.state !== "cancelled");
  const byKey = new Map(shown.map((ticket) => [ticket.key, ticket]));
  const byBranch = new Map(shown.filter((ticket) => ticket.pr_branch !== null).map((ticket) => [ticket.pr_branch!, ticket]));
  const baseOf = (ticket: TicketRow) => repoSettings(spec, ticket.repo).base;
  // What the forge last said the pull request targets wins over what Loom asked for, since a forge can retarget on its own.
  const targetOf = (ticket: TicketRow) => metaOf(ticket)?.base ?? ticket.pr_base;
  const parentOf = (ticket: TicketRow) => {
    const target = targetOf(ticket);
    if (target === null || target === baseOf(ticket)) return null;
    const parent = byBranch.get(target);
    return parent === undefined || parent.id === ticket.id ? null : parent;
  };
  const open = (ticket: TicketRow | undefined): ticket is TicketRow => ticket !== undefined && !FINISHED.includes(ticket.state);
  const waitsOf = (ticket: TicketRow): MergeWait[] => {
    if (FINISHED.includes(ticket.state)) return [];
    const parent = parentOf(ticket);
    const waits = new Map<string, MergeWait>();
    const add = (other: TicketRow, why: MergeWait["why"]) => {
      if (!waits.has(other.key)) waits.set(other.key, { key: other.key, why, repo: other.repo, prNumber: numberOf(other.pr_url) });
    };
    if (open(parent ?? undefined)) add(parent!, "stacked");
    for (const key of keysOf(ticket.deps_json)) if (open(byKey.get(key))) add(byKey.get(key)!, "depends");
    for (const key of keysOf(ticket.merge_after_json)) if (open(byKey.get(key))) add(byKey.get(key)!, "merge_after");
    return [...waits.values()];
  };
  const waits = new Map(shown.map((ticket) => [ticket.key, waitsOf(ticket)]));

  const steps = new Map<string, number>();
  const visiting = new Set<string>();
  const stepOf = (ticket: TicketRow): number => {
    if (ticket.state === "done") return 0;
    const known = steps.get(ticket.key);
    if (known !== undefined) return known;
    // The spec and the board tools refuse cycles; one that slipped in counts as nothing before it rather than looping.
    if (visiting.has(ticket.key)) return 0;
    visiting.add(ticket.key);
    const before = waits.get(ticket.key)!.map((wait) => stepOf(byKey.get(wait.key)!));
    visiting.delete(ticket.key);
    const step = before.length === 0 ? 1 : 1 + Math.max(...before);
    steps.set(ticket.key, step);
    return step;
  };

  const entries = shown.map((ticket): MergeEntry => {
    const meta = metaOf(ticket);
    const status = statusOf(ticket);
    const parent = parentOf(ticket);
    const own = waits.get(ticket.key)!;
    const checks = status === null ? null : { passed: status.passed, failed: status.failed, pending: status.pending };
    const draft = meta?.draft ?? null;
    const review = meta?.review ?? null;
    const reviewRead = meta !== null && (meta.draft !== null || meta.review !== null);
    const base = baseOf(ticket);
    const target = targetOf(ticket);
    // pr_url outlives a pull request Loom let go of; until a new one opens, a requeued ticket has none. A blocked or done one keeps it to point at.
    const prUrl = ticket.pushed_sha !== null || ticket.state === "blocked" || ticket.state === "done" ? ticket.pr_url : null;
    const entry: MergeEntry = {
      key: ticket.key,
      title: ticket.title,
      repo: ticket.repo,
      state: ticket.state,
      base,
      prUrl,
      prNumber: numberOf(prUrl),
      // A closed or wrongly merged pull request lets go of its branch (closedPrReset), so a pushed commit means it is open.
      prOpen: prUrl !== null && !FINISHED.includes(ticket.state) && ticket.pushed_sha !== null && meta?.state !== "CLOSED" && meta?.state !== "MERGED",
      elsewhere: target !== null && target !== base && parent === null ? target : null,
      step: stepOf(ticket),
      stackedOn: parent !== null && open(parent) ? parent.key : null,
      waitsOn: own,
      unblocks: shown.filter((other) => waits.get(other.key)!.some((wait) => wait.key === ticket.key)).map((other) => other.key),
      checks,
      draft,
      review,
      reviewRead,
      verdict: "no_pr",
      holds: [],
      trap: false,
      mergedInto: null,
      mergedIntoState: null,
      blockedReason: ticket.state === "blocked" ? ticket.blocked_reason : null,
    };
    const mergedInto = (into: TicketRow | null) => ({ verdict: "merged_elsewhere" as const, mergedInto: into?.key ?? null, mergedIntoState: into?.state ?? null, step: 0, waitsOn: [] });
    if (ticket.state === "done") return parent !== null && parent.state !== "done" ? { ...entry, ...mergedInto(parent) } : { ...entry, verdict: "merged" };
    // Loom blocks a pull request that merged into a branch other than the base, and the read that saw it is kept.
    if (ticket.state === "blocked" && meta?.state === "MERGED" && meta.base !== null && meta.base !== base) return { ...entry, ...mergedInto(byBranch.get(meta.base) ?? null) };
    if (ticket.state === "blocked") return { ...entry, verdict: "blocked" };
    if (prUrl === null) return { ...entry, verdict: own.length > 0 ? "after" : "no_pr" };
    if (own.length > 0) return { ...entry, verdict: "after", trap: entry.stackedOn !== null && review === "APPROVED" };
    if (parent !== null) return { ...entry, verdict: "moving" };
    const holds = [
      ...(entry.elsewhere !== null ? [`targets ${entry.elsewhere}, not ${base}`] : []),
      ...(ticket.state !== "pr_open" ? ["Loom is pushing a fix"] : []),
      ...(draft === true ? ["draft"] : []),
      ...(review === "CHANGES_REQUESTED" ? ["changes requested"] : review === "REVIEW_REQUIRED" ? ["needs review"] : []),
      ...(checks === null ? ["checks not read"] : []),
      ...(checks !== null && checks.failed > 0 ? [`${checks.failed} ${checks.failed === 1 ? "check" : "checks"} failing`] : []),
      ...(checks !== null && checks.pending > 0 ? [`${checks.pending} ${checks.pending === 1 ? "check" : "checks"} pending`] : []),
    ];
    if (holds.length > 0) return { ...entry, verdict: "first", holds };
    // Ready needs every signal said out loud: checks that passed, not a draft, and approved. A forge that leaves one out passes its checks, no more.
    return { ...entry, verdict: draft === false && review === "APPROVED" ? "ready" : "checks_pass" };
  });

  const live = entries.filter((entry) => entry.state !== "done");
  const repos: Array<string | null> = spec.repo !== undefined && spec.repo.length > 0 ? spec.repo.map((repo) => repo.name) : [null];
  return {
    repos,
    steps: Math.max(0, ...live.map((entry) => entry.step)),
    entries,
    counts: {
      open: live.filter((entry) => entry.prOpen).length,
      first: live.filter((entry) => entry.prOpen && entry.step === 1 && entry.verdict !== "blocked").length,
      ready: entries.filter((entry) => entry.verdict === "ready").length,
      // Once the ticket whose branch it went into merges too, the change may be on the base through it: a warning, not an alarm.
      wrong: entries.filter((entry) => entry.verdict === "merged_elsewhere" && entry.mergedIntoState !== "done").length,
    },
  };
}
