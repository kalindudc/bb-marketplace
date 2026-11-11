// Ship's Do next: the person's moves in order, from the merge order and the rollout read through one readiness
// calculation (ship-readiness.ts), so a step is offered only when both allow it. When the rollout's own next step cannot
// go, its prerequisite is offered instead with the reason, or the step is held with every hold named.
import type { MergeConfirmView, ProjectView, RolloutStep } from "../contract";
import { listText } from "./common";
import { consequenceText } from "./readiness";
import { earlierOpen, stageLabel, stageOfStep, unmet } from "./rollout-plan";
import { deployHoldsOf, holdsLine, readinessMap, shipConsequences, waitText, type Readiness } from "./ship-readiness";

export type DoKind = "merge" | "confirm" | "release" | "live";

export interface DoStep {
  id: string;
  kind: DoKind;
  /** One ticket, or several ready pull requests that merge in any order. */
  keys: string[];
  title: string;
  /** Short facts: the pull request, its checks, what its merge or going live does. */
  facts: string[];
  prs: Array<{ key: string; url: string; number: string | null }>;
  /** For a prerequisite offered in place of the rollout's next step: why it goes first. */
  first: string | null;
  /** For a merge: what it changes for the tickets that wait on it, as the ticket's Confirm merge says it. */
  then: string | null;
  confirm: MergeConfirmView | null;
  /** The live mark a live step sets. */
  target: string | null;
}

export interface HeldGroup {
  keys: string[];
  why: string;
}

export interface DoNext {
  steps: DoStep[];
  held: HeldGroup[];
  /** The rollout's next step in Do next's words, for the Rollout tab's card, when it differs from the rollout's own. */
  lead: string | null;
}

const keyOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const checksFact = (readiness: Readiness) => {
  const checks = readiness.entry.checks;
  return checks === null || checks.failed > 0 || checks.pending > 0 ? null : `checks ${checks.passed}/${checks.passed}`;
};

function prsOf(readiness: readonly Readiness[]): DoStep["prs"] {
  return readiness.flatMap((each) => (each.entry.prUrl === null ? [] : [{ key: each.key, url: each.entry.prUrl, number: each.entry.prNumber }]));
}

/** "LANE-36 is stacked on it and has 1 check failing", for a prerequisite offered first. */
function firstText(waiting: Readiness, prerequisite: string): string {
  const wait = waiting.entry.waitsOn.find((each) => each.key === prerequisite)!;
  const how = wait.why === "stacked" ? "is stacked on it" : wait.why === "merge_after" ? "merges after it" : "waits on it";
  const rest = [...waiting.holds.filter((hold) => hold !== waitText(wait)), ...waiting.rolloutHolds];
  return `${waiting.key} ${how}${rest.length === 0 ? "" : `, and ${listText(rest)} still ${rest.length === 1 ? "holds" : "hold"} it`}`;
}

/** The tickets that wait on `key`'s merge or need it live, in words: "LANE-33, LANE-36 need it". */
function neededBy(view: ProjectView, key: string): string | null {
  const keys = [...new Set([...(view.mergeOrder?.entries.find((entry) => entry.key === key)?.unblocks ?? []), ...view.board.filter((card) => card.state !== "done" && card.state !== "cancelled" && card.prereqs.some((prereq) => prereq.key === key && prereq.kind === "live")).map((card) => card.key)])].sort(keyOrder);
  return keys.length === 0 ? null : `${listText(keys)} ${keys.length === 1 ? "needs" : "need"} it`;
}

function heldWhy(readiness: Readiness): string {
  const final = readiness.entry.finalReview ?? null;
  if (readiness.loomMerges && final !== null) return final.state === "held" ? "final review held" : final.state === "failed" ? "final review failed" : "Loom merges after a final review";
  return holdsLine(readiness) || "not ready";
}

/** A live step can go: its change merged, what it needs is live, the stages before it soaked, and no freeze is on. */
function liveReady(view: ProjectView, step: RolloutStep): boolean {
  if (view.rollout === null || step.live !== null || step.merge !== "merged" || step.state === "blocked" || unmet(step).length > 0) return false;
  if (deployHoldsOf(view.rollout, step.key).length > 0) return false;
  const stage = stageOfStep(view.rollout, step.key);
  return stage === null || earlierOpen(view.rollout, stage) === null;
}

/** Do next for a project with a merge order; null for one without (an integration project lands from Changes). */
export function doNextOf(view: ProjectView): DoNext | null {
  const order = view.mergeOrder;
  if (order === null) return null;
  const rollout = view.rollout;
  const readiness = readinessMap(order, rollout);
  const cards = new Map(view.board.map((card) => [card.key, card]));
  const titleOf = (key: string) => cards.get(key)?.title ?? order.entries.find((entry) => entry.key === key)?.title ?? key;
  const steps: DoStep[] = [];
  const taken = new Set<string>();
  const step = (kind: DoKind, keys: string[], over: Partial<DoStep> = {}): DoStep => ({ id: `${kind}:${keys.join(",")}`, kind, keys, title: keys.length === 1 ? titleOf(keys[0]!) : listText(keys), facts: [], prs: prsOf(keys.flatMap((key) => readiness.get(key) ?? [])), first: null, then: null, confirm: null, target: null, ...over });
  const mergeStep = (one: Readiness, first: string | null = null): DoStep => {
    const card = cards.get(one.key);
    const confirm = card?.mergeConfirm?.ready === true && !card.mergeConfirm.confirmed ? card.mergeConfirm : null;
    // A confirmation names the commit it merges, so the row does too.
    const pr = [...(one.entry.prNumber === null ? [] : [`#${one.entry.prNumber}`]), ...(confirm === null ? [] : [confirm.sha.slice(0, 7)])];
    const checks = checksFact(one);
    const deploys = one.deploys ? ["merging deploys it"] : [];
    const then = consequenceText(one.key, shipConsequences(one.key, order, view.board, rollout));
    return step(confirm === null ? "merge" : "confirm", [one.key], { facts: [...pr, ...(checks === null ? [] : [checks]), one.entry.verdict === "checks_pass" ? "no approval Loom can read" : "approved", ...deploys], first, confirm, then });
  };
  const add = (made: DoStep) => {
    steps.push(made);
    for (const key of made.keys) taken.add(key);
  };

  // The rollout's next merge goes first when it can; otherwise its prerequisite, or it is held with why.
  let lead: string | null = null;
  const next = rollout?.next;
  if (next !== undefined && next.kind === "merge" && next.keys[0] !== undefined) {
    const wanted = readiness.get(next.keys[0]);
    if (wanted !== undefined && wanted.canMerge) add(mergeStep(wanted));
    else if (wanted !== undefined) {
      const prerequisite = wanted.entry.waitsOn.map((wait) => readiness.get(wait.key)).find((one) => one?.canMerge === true);
      if (prerequisite !== undefined) {
        const first = firstText(wanted, prerequisite.key);
        add(mergeStep(prerequisite, first));
        lead = `Merge ${prerequisite.key}${prerequisite.entry.prNumber === null ? "" : ` (#${prerequisite.entry.prNumber})`} first: ${first}`;
      } else lead = `${wanted.key} cannot merge yet: ${heldWhy(wanted)}`;
    }
  }

  // Merges the person confirms in Loom, then held drafts to release, then every other pull request that can merge now.
  for (const card of view.board) {
    const one = readiness.get(card.key);
    if (taken.has(card.key) || one === undefined || card.mergeConfirm?.ready !== true || card.mergeConfirm.confirmed || one.rolloutHolds.length > 0) continue;
    add(mergeStep(one));
  }
  for (const card of view.board) {
    if (taken.has(card.key) || card.draft !== "held" || card.prUrl === null || card.state === "blocked") continue;
    const one = readiness.get(card.key);
    add(step("release", [card.key], { facts: [...(one?.entry.prNumber == null ? [] : [`#${one.entry.prNumber}`]), card.releaseRequested === null ? "held as a draft" : "the planner asks you to release it"], prs: card.prUrl === null ? [] : [{ key: card.key, url: card.prUrl, number: one?.entry.prNumber ?? null }] }));
  }
  // On a repo whose merges the person confirms in Loom, Confirm merge is the only way a merge goes.
  const free = [...readiness.values()].filter((one) => !taken.has(one.key) && one.canMerge && cards.get(one.key)?.mergeConfirm == null).sort((a, b) => a.entry.step - b.entry.step || keyOrder(a.key, b.key));
  // A merge the rollout cares about stands alone; the rest merge in any order, so they share one row.
  const alone = free.filter((one) => one.deploys || one.entry.unblocks.length > 0);
  const together = free.filter((one) => !alone.includes(one));
  for (const one of alone) add(mergeStep(one));
  if (together.length === 1) add(mergeStep(together[0]!));
  if (together.length > 1) add(step("merge", together.map((one) => one.key), { facts: [together.every((one) => one.entry.review === "APPROVED") ? "approved" : "checks pass", "nothing waits on them"] }));

  // Steps whose change merged and can go live now; the rollout's next one first.
  const live = (rollout?.stages.flatMap((stage) => stage.steps) ?? []).filter((one) => liveReady(view, one));
  live.sort((a, b) => Number(b.key === next?.keys[0]) - Number(a.key === next?.keys[0]) || b.waiting - a.waiting || keyOrder(a.key, b.key));
  for (const one of live) {
    const needs = neededBy(view, one.key);
    add(step("live", [one.key], { facts: [one.onMerge ? "deployed when it merged" : (one.how ?? "deploy it"), ...(needs === null ? [] : [needs])], target: one.key, prs: [] }));
  }

  // What holds the rest of the first step, and merged steps that wait to go live, by reason.
  const groups = new Map<string, string[]>();
  const hold = (key: string, why: string) => groups.set(why, [...(groups.get(why) ?? []), key]);
  for (const one of readiness.values()) {
    const card = cards.get(one.key);
    const waitingConfirm = card?.mergeConfirm != null && !card.mergeConfirm.ready && !card.mergeConfirm.confirmed ? card.mergeConfirm.waiting : null;
    if (taken.has(one.key) || (one.canMerge && waitingConfirm === null)) continue;
    // Behind another pull request, or with none yet, it is the merge order's to show, not a hold on the next move.
    if ((one.entry.waitsOn.length > 0 || one.entry.prUrl === null) && one.key !== next?.keys[0]) continue;
    hold(one.key, one.canMerge ? (waitingConfirm ?? "waits") : heldWhy(one));
  }
  for (const one of rollout?.stages.flatMap((stage) => stage.steps) ?? []) {
    if (taken.has(one.key) || one.live !== null || one.merge !== "merged" || one.state === "blocked") continue;
    const needs = unmet(one).map((need) => need.target);
    const stage = stageOfStep(rollout!, one.key);
    const earlier = stage === null ? null : earlierOpen(rollout!, stage);
    const order = needs.length > 0 ? `needs ${listText(needs)} live` : earlier !== null ? `${stageLabel(earlier.name)} ${earlier.live && earlier.soakedAt !== null ? "soaks" : "is not all live"}` : null;
    const why = [...(order === null ? [] : [order]), ...deployHoldsOf(rollout!, one.key)].join(" · ");
    if (why !== "") hold(one.key, why);
  }
  const held = [...groups].map(([why, keys]) => ({ why, keys: keys.sort(keyOrder) })).sort((a, b) => b.keys.length - a.keys.length || keyOrder(a.keys[0]!, b.keys[0]!));
  return { steps, held, lead };
}
