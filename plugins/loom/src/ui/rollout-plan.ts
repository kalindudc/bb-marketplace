// What the Rollout tab reads from the project's deploy order, as pure functions over the RolloutView: one status per
// step in the words a human acts on, where each milestone sits, the order of the steps inside a stage, the warnings
// grouped by step, and the earliest each stage could be done. The view itself stays the one source of the order.
import type { MergeEntry, RolloutMilestone, RolloutRequirement, RolloutStage, RolloutStep, RolloutView, RolloutWindow } from "../contract";
import { soakMs, WINDOW_NOTICE_DAYS } from "../rollout";

export type Tone = "live" | "go" | "hold" | "warn" | "wait";

export type StatusKind = "soaking" | "live" | "blocked" | "deploy_early" | "deploy_after" | "deploy" | "no_pr" | "merge_early" | "waiting" | "merge_after" | "ready_after" | "merge";

export interface Status {
  kind: StatusKind;
  tone: Tone;
  label: string;
  why: string | null;
}

const listText = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const keyOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** "staging" reads "Staging", "production-dark" reads "Production dark". */
export const stageLabel = (name: string | null) => (name === null ? "No stage" : name.replace(/[-_]+/gu, " ").replace(/^./u, (first) => first.toUpperCase()));

/** "1d" reads "1 day". */
export function soakWords(soak: string): string {
  const count = Number(soak.slice(0, -1));
  const unit = { m: "minute", h: "hour", d: "day" }[soak.slice(-1) as "m" | "h" | "d"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** What a step still needs: requirements that are not live, leaving out cancelled ones and ones the spec no longer has. */
export const unmet = (step: RolloutStep): RolloutRequirement[] => step.requires.filter((need) => !need.live && !need.cancelled && !need.unknown);

/** The first stage before `stage` with steps that has not soaked, as the warnings read it; none for the stage-less steps. */
export function earlierOpen(view: RolloutView, stage: RolloutStage): RolloutStage | null {
  if (stage.name === null) return null;
  const at = view.stages.indexOf(stage);
  return view.stages.slice(0, at).find((before) => before.name !== null && before.steps.length > 0 && !before.soaked) ?? null;
}

export function stageOfStep(view: RolloutView, key: string): RolloutStage | null {
  return view.stages.find((stage) => stage.steps.some((step) => step.key === key)) ?? null;
}

/** One status per step: what it is, or the one thing to do or wait for next. */
export function stepStatus(view: RolloutView, step: RolloutStep, now: number): Status {
  if (step.live !== null) {
    if (!step.soaked && step.soakedAt !== null && step.soakedAt > now) return { kind: "soaking", tone: "live", label: "Live", why: "soaking" };
    return { kind: "live", tone: "live", label: "Live", why: null };
  }
  if (step.state === "blocked") return { kind: "blocked", tone: "hold", label: "Blocked", why: "its ticket is blocked" };
  const needs = unmet(step).map((need) => need.target);
  const stage = stageOfStep(view, step.key);
  const earlier = stage === null ? null : earlierOpen(view, stage);
  const after = earlier === null ? "" : stageLabel(earlier.name).toLowerCase();
  if (step.merge === "merged") {
    if (needs.length > 0) return { kind: "deploy_early", tone: "hold", label: "Don't deploy yet", why: `needs ${listText(needs)}` };
    if (earlier !== null) return { kind: "deploy_after", tone: "warn", label: `Deploy after ${after}`, why: null };
    return { kind: "deploy", tone: "go", label: "Deploy now", why: null };
  }
  if (step.merge === "no_pr") return { kind: "no_pr", tone: "wait", label: "No pull request yet", why: needs.length > 0 ? `then waits for ${listText(needs)}` : null };
  if (needs.length > 0) {
    return step.onMerge ? { kind: "merge_early", tone: "hold", label: "Don't merge yet", why: `merging deploys it; needs ${listText(needs)}` } : { kind: "waiting", tone: "wait", label: "Waiting", why: `for ${listText(needs)}` };
  }
  if (earlier !== null) return step.onMerge ? { kind: "merge_after", tone: "warn", label: `Merge after ${after}`, why: "merging deploys it" } : { kind: "ready_after", tone: "wait", label: `Ready after ${after}`, why: null };
  return { kind: "merge", tone: "go", label: step.onMerge ? "Merge now" : "Merge, then deploy", why: step.onMerge ? "merging deploys it" : null };
}

export function milestoneStatus(milestone: RolloutMilestone): Status {
  if (milestone.live !== null) return { kind: "live", tone: "live", label: "Holds", why: milestone.live.by === "human" ? "marked by you" : "its check passed" };
  if (milestone.check === null) return { kind: "waiting", tone: "wait", label: "Not marked yet", why: "mark it live once it holds" };
  if (milestone.lastCheck === null) return { kind: "waiting", tone: "wait", label: "Not checked yet", why: "Loom runs its check every 15 minutes" };
  const run = milestone.lastCheck.exitCode === null ? "its check did not finish" : `its check exited ${milestone.lastCheck.exitCode}`;
  return { kind: "waiting", tone: "hold", label: "Does not hold", why: run };
}

export interface Column {
  stage: RolloutStage;
  /** Milestones that gate the stage: every step in it needs them. */
  gates: RolloutMilestone[];
  /** The stage's steps and the milestones its steps need, in layers: a layer's items need only items in earlier layers. */
  layers: Array<Array<{ step: RolloutStep } | { milestone: RolloutMilestone }>>;
}

/**
 * The deploy order as columns, one per stage with steps. A milestone that gates a stage sits atop it; one a step needs
 * sits in the earliest stage that needs it; any other milestone is in `others`.
 */
export function columnsOf(view: RolloutView): { columns: Column[]; others: RolloutMilestone[] } {
  const stages = view.stages.filter((stage) => stage.steps.length > 0);
  const at = new Map(stages.flatMap((stage, index) => stage.steps.map((step) => [step.key, index] as const)));
  const gates = new Map<number, RolloutMilestone[]>();
  const placed = new Map<number, RolloutMilestone[]>();
  const others: RolloutMilestone[] = [];
  const put = (map: Map<number, RolloutMilestone[]>, index: number, milestone: RolloutMilestone) => map.set(index, [...(map.get(index) ?? []), milestone]);
  for (const milestone of view.milestones) {
    const gated = milestone.stage === null ? -1 : stages.findIndex((stage) => stage.name === milestone.stage);
    if (gated >= 0) {
      put(gates, gated, milestone);
      continue;
    }
    // A milestone that gates a stage with no steps, or gates none, sits with the earliest step that needs it.
    const needing = milestone.neededBy.map((key) => at.get(key)).filter((index): index is number => index !== undefined);
    if (needing.length > 0) put(placed, Math.min(...needing), milestone);
    else others.push(milestone);
  }
  const columns = stages.map((stage, index): Column => {
    const here = new Set(stage.steps.map((step) => step.key));
    const milestonesHere = placed.get(index) ?? [];
    const refs = new Set(milestonesHere.map((milestone) => milestone.ref));
    const depth = new Map<string, number>();
    const depthOf = (key: string): number => {
      if (refs.has(key)) return 0;
      const known = depth.get(key);
      if (known !== undefined) return known;
      depth.set(key, 0);
      const step = stage.steps.find((each) => each.key === key)!;
      const inside = step.requires.filter((need) => here.has(need.target) || refs.has(need.target));
      const value = inside.length === 0 ? 0 : 1 + Math.max(...inside.map((need) => depthOf(need.target)));
      depth.set(key, value);
      return value;
    };
    // Within a layer: what is live first, then what goes next, then the rest, each by key.
    const rank = (item: { step: RolloutStep } | { milestone: RolloutMilestone }) => ("step" in item ? (item.step.live !== null ? 0 : item.step.key === view.next.keys[0] ? 2 : 3) : item.milestone.live !== null ? 1 : 2);
    const items = [...milestonesHere.map((milestone) => ({ item: { milestone }, key: milestone.ref, depth: 0 })), ...stage.steps.map((step) => ({ item: { step }, key: step.key, depth: depthOf(step.key) }))];
    items.sort((a, b) => a.depth - b.depth || rank(a.item) - rank(b.item) || keyOrder(a.key, b.key));
    const layers: Column["layers"] = [];
    for (const entry of items) (layers[entry.depth] ??= []).push(entry.item);
    return { stage, gates: gates.get(index) ?? [], layers: layers.filter((layer) => layer !== undefined) };
  });
  return { columns, others };
}

/** Windows that are on now first, then the soonest to start; the spec may list them in any order. */
export const byUrgency = (windows: readonly RolloutWindow[]): RolloutWindow[] => [...windows].sort((a, b) => Number(b.active) - Number(a.active) || (a.startsIn ?? 0) - (b.startsIn ?? 0) || a.from.localeCompare(b.from));

export type HoldKind = "dont_merge" | "dont_deploy" | "waits" | "ahead" | "calendar";

export interface Hold {
  step: RolloutStep;
  kind: HoldKind;
  tone: Tone;
  needs: RolloutRequirement[];
  /** The stage before that has not soaked, for a step that would reach traffic ahead of it. */
  stage: RolloutStage | null;
  windows: RolloutWindow[];
}

/** The warnings grouped by step, in the order they first name it, with what each step waits for as data. */
export function holdsOf(view: RolloutView): Hold[] {
  const kinds = new Map<string, Set<string>>();
  for (const warning of view.warnings) for (const key of warning.keys) kinds.set(key, (kinds.get(key) ?? new Set()).add(warning.kind));
  const steps = new Map(view.stages.flatMap((stage) => stage.steps.map((step) => [step.key, step] as const)));
  const near = byUrgency(view.windows.filter((window) => window.active || (window.startsIn !== null && window.startsIn <= WINDOW_NOTICE_DAYS)));
  return [...kinds].flatMap(([key, found]) => {
    const step = steps.get(key);
    if (step === undefined) return [];
    const stage = stageOfStep(view, key);
    const kind: HoldKind = found.has("ships_on_merge") ? "dont_merge" : found.has("deploy_early") ? "dont_deploy" : found.has("milestone") ? "waits" : found.has("soak") ? "ahead" : "calendar";
    const tone: Tone = kind === "dont_merge" || kind === "dont_deploy" ? "hold" : kind === "waits" ? "wait" : "warn";
    return [{ step, kind, tone, needs: unmet(step), stage: found.has("soak") && stage !== null ? earlierOpen(view, stage) : null, windows: found.has("window") ? near : [] }];
  });
}

export interface Earliest {
  stage: RolloutStage;
  /** When the stage could have soaked at the earliest, if each of its steps went live as soon as it could; null when it waits on a milestone. */
  at: number | null;
  /** The milestones that do not hold yet and that it, or a stage before it, waits on. */
  waitsFor: string[];
}

/** The milestones that do not hold that a step waits for, itself or through the steps it needs, the stage-less ones included. */
export function milestoneBlockers(view: RolloutView, step: RolloutStep): string[] {
  const steps = new Map(view.stages.flatMap((stage) => stage.steps.map((each) => [each.key, each] as const)));
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (at: RolloutStep) => {
    if (seen.has(at.key)) return;
    seen.add(at.key);
    for (const need of unmet(at)) {
      if (need.kind === "milestone") found.add(need.target);
      else {
        const other = steps.get(need.target);
        if (other !== undefined && other.live === null) visit(other);
      }
    }
  };
  visit(step);
  return [...found];
}

/**
 * The earliest each named stage with steps could be done, in order, if every step went live the moment it could. A
 * stage that is all live has its own time; one with steps still to go has none while any milestone they wait for does
 * not hold, nor does any pending stage after it.
 */
export function earliestOf(view: RolloutView, now: number): Earliest[] {
  const out: Earliest[] = [];
  let start = now;
  let waiting: string[] = [];
  for (const stage of view.stages) {
    if (stage.name === null || stage.steps.length === 0) continue;
    const pending = stage.steps.filter((step) => step.live === null);
    const soakedAt = Math.max(...stage.steps.filter((step) => step.live !== null).map((step) => step.soakedAt ?? step.live!.at), 0);
    if (pending.length === 0) {
      out.push({ stage, at: soakedAt, waitsFor: [] });
      if (waiting.length === 0) start = Math.max(start, soakedAt);
      continue;
    }
    const gates = stage.milestones.filter((milestone) => milestone.stage === stage.name && milestone.live === null).map((milestone) => milestone.ref);
    const refs = [...gates, ...pending.flatMap((step) => milestoneBlockers(view, step))];
    if (waiting.length > 0 || refs.length > 0) {
      waiting = [...new Set([...waiting, ...refs])];
      out.push({ stage, at: null, waitsFor: waiting });
      continue;
    }
    const at = Math.max(start + (stage.soak === null ? 0 : soakMs(stage.soak)), soakedAt);
    out.push({ stage, at, waitsFor: [] });
    start = at;
  }
  return out;
}

/** "/bin/bash /Users/kim/.local/bin/check.sh gate staging" reads "check.sh gate staging"; the page keeps the full command on hover and Copy. */
export const shortCommand = (command: string) => command.trim().replace(/^(?:\/(?:usr\/)?bin\/(?:ba|z)?sh\s+)?(?:\S*\/)?(\S+)/u, "$1");

/** How each repo's steps deploy, the words most of its steps use; steps with words of their own show them on the step. */
export function repoDeploys(view: RolloutView): Array<{ repo: string | null; how: string; onMerge: boolean }> {
  const byRepo = new Map<string | null, { counts: Map<string, number>; onMerge: boolean }>();
  for (const step of view.stages.flatMap((stage) => stage.steps)) {
    if (step.how === null) continue;
    const entry = byRepo.get(step.repo) ?? { counts: new Map(), onMerge: step.onMerge };
    entry.counts.set(step.how, (entry.counts.get(step.how) ?? 0) + 1);
    byRepo.set(step.repo, entry);
  }
  return [...byRepo].map(([repo, entry]) => ({ repo, onMerge: entry.onMerge, how: [...entry.counts].sort((a, b) => b[1] - a[1])[0]![0] }));
}

/** Whether the merge order calls the step's pull request ready to merge: checks passed, not a draft, approved, nothing before it. */
export const readyToMerge = (entry: MergeEntry | undefined) => entry !== undefined && entry.verdict === "ready";

/** What the merge order last read about the step's pull request, in a few words: "needs review · ✓ 20 checks". */
export function pullRequestNote(entry: MergeEntry | undefined): { text: string; tone: Tone } | null {
  if (entry === undefined || !entry.prOpen) return null;
  const parts: string[] = [];
  let tone: Tone = "wait";
  if (entry.reviewRead) {
    if (entry.draft === true) parts.push("draft");
    if (entry.review === "APPROVED") parts.push("approved");
    else if (entry.review === "CHANGES_REQUESTED") parts.push("changes requested");
    else if (entry.review === "REVIEW_REQUIRED") parts.push("needs review");
    else parts.push("no review yet");
  }
  if (entry.conflicts) parts.push(`conflicts with ${entry.base}`);
  if (entry.checks !== null) {
    const { passed, failed, pending } = entry.checks;
    if (failed > 0) parts.push(`✗ ${failed} failing`);
    if (pending > 0) parts.push(`${pending} pending`);
    if (passed > 0) parts.push(`✓ ${passed} ${passed === 1 ? "check" : "checks"}`);
  }
  if (entry.conflicts || (entry.checks?.failed ?? 0) > 0 || entry.review === "CHANGES_REQUESTED") tone = "hold";
  return parts.length === 0 ? null : { text: parts.join(" · "), tone };
}

/** The steps that need `key` directly. */
export const dependentsOf = (view: RolloutView, key: string) =>
  view.stages
    .flatMap((stage) => stage.steps)
    .filter((step) => step.requires.some((need) => need.target === key))
    .map((step) => step.key);

/** Everything `key` needs, through any chain, and everything that needs it. */
export function chainOf(view: RolloutView, key: string): { up: Set<string>; down: Set<string> } {
  const edges = view.stages.flatMap((stage) => stage.steps).flatMap((step) => step.requires.map((need) => ({ from: need.target, to: step.key })));
  const walk = (start: string, next: (edge: { from: string; to: string }) => [string, string]) => {
    const seen = new Set<string>();
    const visit = (at: string) => {
      for (const edge of edges) {
        const [here, there] = next(edge);
        if (here !== at || seen.has(there)) continue;
        seen.add(there);
        visit(there);
      }
    };
    visit(start);
    return seen;
  };
  return { up: walk(key, (edge) => [edge.to, edge.from]), down: walk(key, (edge) => [edge.from, edge.to]) };
}
