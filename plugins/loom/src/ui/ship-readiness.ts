// Ship's one readiness calculation: whether a pull request can merge now and, when it cannot, every hold in words. It reads
// the merge order (what the pull request waits on and what it holds itself on, prHolds) and the rollout (a merge that
// deploys it during a freeze, before what it needs is live, or ahead of its stage). Do next, the merge order's lead and
// verdicts, the rollout's next step, its columns and a ticket's Confirm merge all read it, so none of them offers a merge
// another holds. Every sentence about what happens after something (a merge, a soak, a step going live) asks it again with
// only that one thing assumed, so the holds the event does not remove stay named. The rollout holds are advice: Loom's
// engine never holds a merge back for a rollout, so they never take Confirm merge away; they say why to wait.
import type { BoardCard, MergeEntry, MergeOrderView, RolloutStep, RolloutView } from "../contract";
import { holdText } from "../verdict";
import { listText } from "./common";
import { mergeConsequences, type MergeConsequence } from "./readiness";
import { earlierOpen, stageLabel, stageOfStep, stepStatus, unmet, type Status } from "./rollout-plan";

export interface Readiness {
  key: string;
  entry: MergeEntry;
  /** Nothing it waits on is open, its checks pass, it is not held as a draft, Loom does not merge it itself, and no rollout hold applies. */
  canMerge: boolean;
  /** What the merge order holds it on: open tickets it waits on first, then its pull request's own holds. */
  holds: string[];
  /** Why merging now would ship it too early: a freeze, a requirement that is not live, a stage ahead of it. */
  rolloutHolds: string[];
  /** Its merge deploys it. */
  deploys: boolean;
  /** Loom merges it itself after a final review, so the human has no merge to make. */
  loomMerges: boolean;
}

/** What a sentence about the future takes as done: a ticket merged, targets live, the stages before soaked. */
export interface Assume {
  merged?: string;
  live?: readonly string[];
  soaked?: boolean;
}

const MERGEABLE = new Set<MergeEntry["verdict"]>(["ready", "checks_pass"]);
const FINISHED = new Set<MergeEntry["verdict"]>(["merged", "merged_elsewhere"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

/** "stacked on LANE-35", "waits on CSV-6", "merges after CSV-2". */
export const waitText = (wait: MergeEntry["waitsOn"][number]) => (wait.why === "stacked" ? `stacked on ${wait.key}` : wait.why === "merge_after" ? `merges after ${wait.key}` : `waits on ${wait.key}`);

export const rolloutStepOf = (rollout: RolloutView | null, key: string): RolloutStep | null => rollout?.stages.flatMap((stage) => stage.steps).find((step) => step.key === key) ?? null;

/** "Payments freeze is on until Jan 13", for each window that is on now. */
const freezeHolds = (rollout: RolloutView) => rollout.windows.filter((each) => each.active).map((window) => `${window.title.split(":")[0]!.trim()} is on until ${dayText(window.to)}`);

/**
 * What holds a merged step's deploy beyond the rollout's own order: a window that is on now, which the spec defines as a
 * freeze or a deploy restriction. A step that deploys on merge has no deploy left to hold. The server's warnings and a pull
 * request's Rollout section apply a window only to a merge that deploys; Ship's advice holds the later deploy too.
 */
export function deployHoldsOf(rollout: RolloutView | null, key: string): string[] {
  const step = rolloutStepOf(rollout, key);
  if (rollout === null || step === null || step.merge !== "merged" || step.onMerge || step.live !== null) return [];
  return freezeHolds(rollout);
}

/** Why merging the step now would ship it too early, when its merge deploys it. */
export function rolloutHoldsOf(rollout: RolloutView | null, key: string, assume: Assume = {}): string[] {
  const step = rolloutStepOf(rollout, key);
  if (rollout === null || step === null || !step.onMerge || step.live !== null) return [];
  const out: string[] = freezeHolds(rollout);
  const needs = unmet(step)
    .map((need) => need.target)
    .filter((target) => !(assume.live ?? []).includes(target));
  if (needs.length > 0) out.push(`it needs ${listText(needs)} live first`);
  const stage = stageOfStep(rollout, key);
  const earlier = stage === null || assume.soaked === true ? null : earlierOpen(rollout, stage);
  if (earlier !== null) out.push(`${stageLabel(earlier.name)} has not soaked`);
  return out;
}

/** The readiness of one ticket's pull request, or null when the merge order does not list it or it has merged. */
export function readinessOf(key: string, order: MergeOrderView | null, rollout: RolloutView | null, assume: Assume = {}): Readiness | null {
  const entry = order?.entries.find((each) => each.key === key);
  if (entry === undefined || FINISHED.has(entry.verdict) || entry.state === "done" || entry.state === "cancelled") return null;
  const waits = entry.waitsOn.filter((wait) => wait.key !== assume.merged);
  const holds: string[] = [];
  if (entry.verdict === "blocked") holds.push("blocked");
  holds.push(...waits.map(waitText));
  if (entry.prUrl === null && entry.verdict !== "blocked") holds.push("no pull request yet");
  if (entry.verdict === "moving") holds.push(`Loom moves it to ${entry.base}`);
  for (const hold of entry.prHolds) holds.push(hold.code === "draft" && entry.draftHold === "held" ? "held as a draft" : holdText(hold));
  if (entry.draftHold === "held" && !entry.prHolds.some((hold) => hold.code === "draft")) holds.push("held as a draft");
  // With the wait it had gone, a pull request whose own holds are clear reads as the server would read it: mergeable.
  const unwaited = entry.verdict === "after" && waits.length === 0 && entry.prUrl !== null && entry.prHolds.length === 0;
  const mergeable = MERGEABLE.has(entry.verdict) || unwaited;
  const final = entry.finalReview ?? null;
  const loomMerges = final !== null && mergeable;
  const rolloutHolds = rolloutHoldsOf(rollout, key, assume);
  const step = rolloutStepOf(rollout, key);
  return {
    key,
    entry,
    canMerge: holds.length === 0 && mergeable && !loomMerges && rolloutHolds.length === 0,
    holds,
    rolloutHolds,
    deploys: step?.onMerge === true,
    loomMerges,
  };
}

/** Every listed pull request's readiness by ticket, for the surfaces that show many at once. */
export function readinessMap(order: MergeOrderView | null, rollout: RolloutView | null): Map<string, Readiness> {
  return new Map(
    (order?.entries ?? []).flatMap((entry) => {
      const one = readinessOf(entry.key, order, rollout);
      return one === null ? [] : [[entry.key, one] as const];
    }),
  );
}

/** Every hold in one line, the merge order's first: "stacked on LANE-35 · 1 check failing". */
export const holdsLine = (readiness: Readiness) => [...readiness.holds, ...readiness.rolloutHolds].join(" · ");

/**
 * Whether a rollout step could go once `assume` holds: what it needs is live, its stage's turn came, and, unmerged, it
 * could merge. A step the merge order does not list goes by the rollout alone.
 */
export function stepCanGo(key: string, order: MergeOrderView | null, rollout: RolloutView, assume: Assume = {}): boolean {
  const step = rolloutStepOf(rollout, key);
  if (step === null || step.live !== null || step.state === "blocked") return false;
  const needs = unmet(step).filter((need) => !(assume.live ?? []).includes(need.target));
  const stage = stageOfStep(rollout, key);
  const turn = assume.soaked === true || stage === null || earlierOpen(rollout, stage) === null;
  if (needs.length > 0 || !turn) return false;
  if (step.merge === "merged") return deployHoldsOf(rollout, key).length === 0;
  const one = readinessOf(key, order, rollout, assume);
  return one === null ? step.merge !== "no_pr" : one.canMerge;
}

/** The rollout states a status waits for: what the step needs going live, or the earlier stage soaking. */
const CONDITION: Partial<Record<Status["kind"], (step: RolloutStep) => Assume>> = {
  waiting: (step) => ({ live: unmet(step).map((need) => need.target) }),
  merge_early: (step) => ({ live: unmet(step).map((need) => need.target) }),
  merge_after: () => ({ soaked: true }),
  ready_after: () => ({ soaked: true }),
};

/**
 * The rollout's status of a step, held back to what Ship says. A step the rollout would merge now reads as waiting while
 * the merge order, a held draft, Loom's own merge or a freeze holds it. A status that waits for the rollout ("Merge after
 * expand", "Waiting for LANE-4") is read again with only that wait over, so it promises nothing a review, a freeze or a
 * draft would still hold, and names what would. A merged step's deploy reads a window that is on now as a hold, the
 * same way.
 */
export function shipStepStatus(view: RolloutView, step: RolloutStep, now: number, readiness: ReadonlyMap<string, Readiness>, order: MergeOrderView | null): Status {
  const status = stepStatus(view, step, now);
  const deploy = deployHoldsOf(view, step.key).join(" · ");
  if (deploy !== "") {
    if (status.kind === "deploy") return { kind: "waiting", tone: "hold", label: "Not yet", why: deploy };
    if (status.kind === "deploy_after") return { ...status, why: `then still held: ${deploy}` };
    if (status.kind === "deploy_early") return { ...status, why: `${status.why}, then still held: ${deploy}` };
  }
  const one = readiness.get(step.key);
  if (one === undefined) return status;
  if (status.kind === "merge") {
    if (one.canMerge) return status;
    if (one.loomMerges && holdsLine(one) === "") return { kind: "waiting", tone: "wait", label: "Loom merges it", why: "after a final review" };
    return { kind: "waiting", tone: "hold", label: "Not yet", why: holdsLine(one) };
  }
  const condition = CONDITION[status.kind];
  const after = condition === undefined ? null : readinessOf(step.key, order, view, condition(step));
  if (after === null || after.canMerge) return status;
  const still = holdsLine(after);
  const loom = after.loomMerges && still === "";
  if (status.kind === "merge_after" || status.kind === "ready_after") {
    const stage = stageOfStep(view, step.key);
    const earlier = stage === null ? null : earlierOpen(view, stage);
    const when = `after ${stageLabel(earlier?.name ?? null).toLowerCase()}`;
    if (loom) return { kind: status.kind, tone: "wait", label: "Loom merges it", why: `${when} and a final review` };
    return { kind: status.kind, tone: "hold", label: "Not yet", why: `${when}, still held: ${still || "not ready"}` };
  }
  return { ...status, why: `${status.why}, then ${loom ? "Loom merges it after a final review" : `still held: ${still || "not ready"}`}` };
}

/**
 * What merging `key` changes for each ticket that waits on it: the wait it removes, and every hold that stays, from the
 * same calculation with only that merge assumed, so a freeze, a held draft or Loom's own merge stays named.
 */
export function shipConsequences(key: string, order: MergeOrderView | null, board: readonly BoardCard[], rollout: RolloutView | null): MergeConsequence[] {
  return mergeConsequences(key, order, board).map((one) => {
    if (one.removes === null) return one;
    const after = readinessOf(one.key, order, rollout, { merged: key });
    if (after === null) return one;
    const holds = [...after.holds.filter((hold) => hold !== "no pull request yet"), ...after.rolloutHolds];
    const noPr = after.entry.prUrl === null;
    if (holds.length > 0) return { ...one, free: false, holds };
    if (noPr) return { ...one, free: true, then: "is next to merge", holds: [] };
    if (after.loomMerges) return { ...one, free: true, then: "Loom merges it after a final review", holds: [] };
    return { ...one, free: after.canMerge, then: "can merge", holds: after.canMerge ? [] : ["not ready"] };
  });
}

/**
 * What a ticket's Confirm merge warns before the person arms it: the rollout holds of a merge that deploys, in one
 * sentence, as Do next holds it; null when there are none. The merge order's own holds take Confirm merge away on the
 * server, so they never show beside it.
 */
export function confirmHold(key: string, rollout: RolloutView | null): string | null {
  const holds = rolloutHoldsOf(rollout, key);
  return holds.length === 0 ? null : `Hold off: merging deploys it, and ${listText(holds)}.`;
}
