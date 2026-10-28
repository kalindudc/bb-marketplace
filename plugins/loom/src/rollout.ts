// The deploy order of a pull request project, as pure functions over the spec, the ticket rows and the rollout marks:
// which stage each ticket's change belongs to, what must be live before it reaches traffic, how it deploys, whether it
// is live, the next safe step and warnings. It is advice for the human: nothing here reaches the scheduler, the review
// or the merge, and Loom holds nothing back because of it.
import type { LiveBy, RolloutMarkRow, TicketRow } from "./db/store";
import { plural } from "./format";
import { metaOf } from "./pr-meta";
// Only types from spec.ts: prompts.ts reads this file, and the page's bundle reads prompts.ts, which keeps zod out of it.
import type { Spec, TicketRolloutSpec } from "./spec";
import type { TicketState } from "./states";

export const SOAK_PATTERN = /^([1-9]\d{0,2})([mhd])$/;
const SOAK_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** A stage's soak in milliseconds: "30m", "2h", "1d". */
export function soakMs(soak: string): number {
  const match = SOAK_PATTERN.exec(soak);
  if (match === null) throw new Error(`"${soak}" is not a soak.`);
  return Number(match[1]) * SOAK_UNIT_MS[match[2] as keyof typeof SOAK_UNIT_MS];
}

/** Whether a ticket in `repo` deploys when its pull request merges: the repo's deploy.on_merge, else the [rollout] table's. */
export function deploysOnMerge(spec: Spec, repo: string | null): boolean {
  const own = repo === null ? undefined : spec.repo?.find((entry) => entry.name === repo)?.deploy;
  return (own?.on_merge ?? spec.rollout?.deploy?.on_merge) === true;
}

/** Whether the spec has any deploy order: a [rollout] table, a repo's deploy or a ticket's rollout. */
export function hasRollout(spec: Spec): boolean {
  return spec.rollout !== undefined || (spec.repo ?? []).some((repo) => repo.deploy !== undefined) || spec.ticket.some((ticket) => ticket.rollout !== undefined);
}

/** A ticket row's rollout: the spec's, with the tickets in requires_live as keys and milestones as refs. */
export type TicketRollout = TicketRolloutSpec;

export const rolloutOfTicket = (ticket: Pick<TicketRow, "rollout_json">): TicketRollout | null => (ticket.rollout_json === null ? null : (JSON.parse(ticket.rollout_json) as TicketRollout));

/** The rollout_json a ticket row keeps for a spec or patch rollout, its ticket refs turned into keys by `keyOf`; null for none or an empty one. */
export function rolloutJson(rollout: TicketRolloutSpec | undefined, keyOf: (ref: string) => string): string | null {
  if (rollout === undefined || Object.keys(rollout).length === 0) return null;
  return JSON.stringify(rollout.requires_live === undefined ? rollout : { ...rollout, requires_live: rollout.requires_live.map(keyOf) });
}

/** How a ticket's change reaches traffic: the ticket's own words, else its repo's, else the project's; and whether its merge does it. */
export function deployOf(spec: Spec, ticket: Pick<TicketRow, "repo" | "rollout_json">): { how: string | null; onMerge: boolean } {
  const repo = ticket.repo === null ? undefined : spec.repo?.find((entry) => entry.name === ticket.repo)?.deploy;
  return { how: rolloutOfTicket(ticket)?.how ?? repo?.how ?? spec.rollout?.deploy?.how ?? null, onMerge: deploysOnMerge(spec, ticket.repo) };
}

/** A ticket is a step of the rollout when it has a rollout of its own, or its repo or the project says how changes deploy. */
export function isRolloutStep(spec: Spec, ticket: Pick<TicketRow, "repo" | "rollout_json" | "state">): boolean {
  if (ticket.state === "cancelled") return false;
  const repo = ticket.repo === null ? undefined : spec.repo?.find((entry) => entry.name === ticket.repo);
  return ticket.rollout_json !== null || repo?.deploy !== undefined || spec.rollout?.deploy !== undefined;
}

/** Whether the project has deploy order at all: only on the pr strategy, from its spec or a ticket the planner gave a rollout since. */
export const followsRollout = (spec: Spec, tickets: readonly Pick<TicketRow, "rollout_json">[]): boolean => spec.merge.strategy === "pr" && (hasRollout(spec) || tickets.some((ticket) => ticket.rollout_json !== null));

export type RolloutMerge = "no_pr" | "open" | "approved" | "merged";

export interface RolloutLive {
  at: number;
  by: LiveBy;
  /** The tail of the command's output, or the human's note. */
  evidence: string | null;
}

export interface RolloutCheckResult {
  at: number;
  /** Null when it did not exit: it timed out, or Loom could not run it. */
  exitCode: number | null;
  output: string;
}

export interface RolloutRequirement {
  /** A ticket key or a milestone ref. */
  target: string;
  kind: "ticket" | "milestone";
  title: string | null;
  /** Live, for a ticket; holds, for a milestone. */
  live: boolean;
  /** A cancelled ticket never goes live, so it holds nothing back. */
  cancelled: boolean;
  /** Neither a ticket on the board nor a milestone of the spec in force, so it holds nothing back either. */
  unknown: boolean;
  /** The milestone gates the step's stage; the step does not name it itself. */
  viaStage: boolean;
  prUrl: string | null;
  prNumber: string | null;
  /** How a ticket requirement deploys. */
  how: string | null;
}

export interface RolloutStep {
  key: string;
  title: string;
  repo: string | null;
  state: TicketState;
  stage: string | null;
  prUrl: string | null;
  prNumber: string | null;
  merge: RolloutMerge;
  live: RolloutLive | null;
  /** Live for its stage's whole soak; a stage without a soak counts a live step soaked. */
  soaked: boolean;
  /** When it has soaked, once it is live. */
  soakedAt: number | null;
  how: string | null;
  onMerge: boolean;
  requires: RolloutRequirement[];
  release: string | null;
  /** The other steps of its release. */
  releaseWith: string[];
  dark: boolean;
  verify: string | null;
  rollback: string | null;
  lastCheck: RolloutCheckResult | null;
  /** The live steps that require it: rolling it back now would break them. */
  liveConsumers: string[];
  /** Steps that are not live and need it live first, directly or through another step. */
  waiting: number;
}

export interface RolloutMilestone {
  ref: string;
  title: string;
  stage: string | null;
  check: string | null;
  /** When it held, and by what; null while it does not hold. */
  live: RolloutLive | null;
  lastCheck: RolloutCheckResult | null;
  /** The steps that need it, by naming it or through the stage it gates. */
  neededBy: string[];
}

export interface RolloutStage {
  /** Null for the steps that name no stage. */
  name: string | null;
  goal: string | null;
  soak: string | null;
  steps: RolloutStep[];
  /** The milestones that gate it; the stage-less group holds those that gate none. */
  milestones: RolloutMilestone[];
  /** It has steps and every one is live. */
  live: boolean;
  /** When its last step will have soaked, once every step is live. */
  soakedAt: number | null;
  soaked: boolean;
}

export interface RolloutWindow {
  title: string;
  /** The first and last day, inclusive, in UTC. */
  from: string;
  to: string;
  note: string | null;
  active: boolean;
  /** Whole days until it starts; null once it has started. */
  startsIn: number | null;
  past: boolean;
}

export type RolloutWarningKind = "ships_on_merge" | "deploy_early" | "milestone" | "soak" | "window";

export interface RolloutWarning {
  kind: RolloutWarningKind;
  tone: "warning" | "info";
  keys: string[];
  text: string;
}

export type RolloutNextKind = "deploy" | "merge" | "pr" | "blocked" | "soak" | "milestone" | "wait" | "done";

export interface RolloutNext {
  kind: RolloutNextKind;
  /** The steps that can go now, the one the sentence names first; or the milestone or step everything waits for. */
  keys: string[];
  stage: string | null;
  /** When the stage it waits on has soaked. */
  until: number | null;
  text: string;
}

export interface RolloutView {
  stages: RolloutStage[];
  milestones: RolloutMilestone[];
  windows: RolloutWindow[];
  next: RolloutNext;
  warnings: RolloutWarning[];
  counts: { steps: number; live: number; soaked: number };
}

const DAY_MS = 86_400_000;
export const WINDOW_NOTICE_DAYS = 14;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const numberOf = (url: string | null) => (url === null ? null : (/\/(\d+)\/?$/u.exec(url)?.[1] ?? null));
const pad = (n: number) => String(n).padStart(2, "0");
/** "Oct 29 14:00 UTC": the view's sentences are the same on the page and in the CLI. */
export const whenText = (at: number) => {
  const date = new Date(at);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
};
const dayText = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const dayStart = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const listText = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const keyOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

const liveOf = (mark: RolloutMarkRow | undefined): RolloutLive | null => (mark?.live_at == null ? null : { at: mark.live_at, by: mark.live_by ?? "human", evidence: mark.evidence });
const checkOf = (mark: RolloutMarkRow | undefined): RolloutCheckResult | null => (mark?.checked_at == null ? null : { at: mark.checked_at, exitCode: mark.check_exit, output: mark.check_output ?? "" });

function mergeOf(ticket: TicketRow): RolloutMerge {
  if (ticket.state === "done") return "merged";
  // A pushed commit on a ticket that has not finished is an open pull request, as the Merge order tab reads it.
  if (ticket.pushed_sha === null || ticket.state === "cancelled") return "no_pr";
  return metaOf(ticket)?.review === "APPROVED" ? "approved" : "open";
}

const prUrlOf = (ticket: TicketRow) => (ticket.pushed_sha !== null || ticket.state === "blocked" || ticket.state === "done" ? ticket.pr_url : null);
const unmet = (step: RolloutStep) => step.requires.filter((need) => !need.live && !need.cancelled && !need.unknown);

/** "CSV-4 is not live and old-traffic-zero does not hold", for what a step still needs. */
function needsText(needs: readonly RolloutRequirement[], positive: boolean): string {
  const tickets = needs.filter((need) => need.kind === "ticket").map((need) => need.target);
  const milestones = needs.filter((need) => need.kind === "milestone").map((need) => need.target);
  const parts = [
    ...(tickets.length === 0 ? [] : [`${listText(tickets)} ${tickets.length === 1 ? "is" : "are"}${positive ? "" : " not"} live`]),
    ...(milestones.length === 0 ? [] : [`${listText(milestones)} ${positive ? (milestones.length === 1 ? "holds" : "hold") : milestones.length === 1 ? "does not hold" : "do not hold"}`]),
  ];
  return parts.join(" and ");
}

/**
 * The project's deploy order now, or null when it has none. `marks` are the project's rollout marks; only what they
 * say is live counts, so the engine's live tracking is the one place a ticket goes live.
 */
export function rolloutOf(spec: Spec, tickets: readonly TicketRow[], marks: readonly RolloutMarkRow[], now: number): RolloutView | null {
  if (!followsRollout(spec, tickets)) return null;
  const markOf = new Map(marks.map((mark) => [mark.target, mark]));
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const rows = tickets.filter((ticket) => isRolloutStep(spec, ticket));
  const declared = spec.rollout?.stage ?? [];
  const specMilestones = spec.rollout?.milestone ?? [];
  const milestoneByRef = new Map(specMilestones.map((milestone) => [milestone.ref, milestone]));

  // Stages a ticket names that the spec does not declare follow the declared ones, in the order tickets first name them.
  const stageNames = [...declared.map((stage) => stage.name)];
  for (const ticket of rows) {
    const stage = rolloutOfTicket(ticket)?.stage;
    if (stage !== undefined && !stageNames.includes(stage)) stageNames.push(stage);
  }
  const soakOf = (stage: string | null) => {
    const soak = stage === null ? undefined : declared.find((entry) => entry.name === stage)?.soak;
    return soak === undefined ? null : soak;
  };
  const gating = (stage: string | null) => specMilestones.filter((milestone) => (milestone.stage ?? null) === stage && (stage === null || stageNames.includes(stage)));
  const milestoneLive = (ref: string) => liveOf(markOf.get(ref));

  const requirementsOf = (ticket: TicketRow): RolloutRequirement[] => {
    const rollout = rolloutOfTicket(ticket);
    const stage = rollout?.stage ?? null;
    const own = (rollout?.requires_live ?? []).map((target): RolloutRequirement => {
      const other = byKey.get(target);
      if (other !== undefined) {
        return { target, kind: "ticket", title: other.title, live: liveOf(markOf.get(target)) !== null, cancelled: other.state === "cancelled", unknown: false, viaStage: false, prUrl: prUrlOf(other), prNumber: numberOf(prUrlOf(other)), how: deployOf(spec, other).how };
      }
      const milestone = milestoneByRef.get(target);
      return { target, kind: "milestone", title: milestone?.title ?? null, live: milestoneLive(target) !== null, cancelled: false, unknown: milestone === undefined, viaStage: false, prUrl: null, prNumber: null, how: null };
    });
    const named = new Set(own.map((need) => need.target));
    const gates = stage === null ? [] : gating(stage).filter((milestone) => !named.has(milestone.ref));
    return [...own, ...gates.map((milestone): RolloutRequirement => ({ target: milestone.ref, kind: "milestone", title: milestone.title, live: milestoneLive(milestone.ref) !== null, cancelled: false, unknown: false, viaStage: true, prUrl: null, prNumber: null, how: null }))];
  };

  const steps: RolloutStep[] = rows.map((ticket) => {
    const rollout = rolloutOfTicket(ticket);
    const stage = rollout?.stage ?? null;
    const live = liveOf(markOf.get(ticket.key));
    const soak = soakOf(stage);
    const soakedAt = live === null ? null : live.at + (soak === null ? 0 : soakMs(soak));
    const deploy = deployOf(spec, ticket);
    const prUrl = prUrlOf(ticket);
    return {
      key: ticket.key,
      title: ticket.title,
      repo: ticket.repo,
      state: ticket.state,
      stage,
      prUrl,
      prNumber: numberOf(prUrl),
      merge: mergeOf(ticket),
      live,
      soaked: soakedAt !== null && now >= soakedAt,
      soakedAt,
      how: deploy.how,
      onMerge: deploy.onMerge,
      requires: requirementsOf(ticket),
      release: rollout?.release ?? null,
      releaseWith: [],
      dark: rollout?.dark === true,
      verify: rollout?.verify ?? null,
      rollback: rollout?.rollback ?? null,
      lastCheck: checkOf(markOf.get(ticket.key)),
      liveConsumers: [],
      waiting: 0,
    };
  });
  const stepByKey = new Map(steps.map((step) => [step.key, step]));
  for (const step of steps) {
    if (step.release !== null) step.releaseWith = steps.filter((other) => other.release === step.release && other.key !== step.key).map((other) => other.key);
    step.liveConsumers = steps.filter((other) => other.live !== null && other.requires.some((need) => need.kind === "ticket" && need.target === step.key)).map((other) => other.key);
  }
  // Each step counts the steps that are not live and need it, through any chain of requirements.
  const dependents = new Map<string, string[]>();
  for (const step of steps) for (const need of step.requires) if (need.kind === "ticket") dependents.set(need.target, [...(dependents.get(need.target) ?? []), step.key]);
  for (const step of steps) {
    const seen = new Set<string>();
    const walk = (key: string) => {
      for (const next of dependents.get(key) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        walk(next);
      }
    };
    walk(step.key);
    step.waiting = [...seen].filter((key) => stepByKey.get(key)?.live === null).length;
  }

  const milestones: RolloutMilestone[] = specMilestones.map((milestone) => ({
    ref: milestone.ref,
    title: milestone.title,
    stage: milestone.stage ?? null,
    check: milestone.check ?? null,
    live: milestoneLive(milestone.ref),
    lastCheck: checkOf(markOf.get(milestone.ref)),
    neededBy: steps.filter((step) => step.requires.some((need) => need.target === milestone.ref)).map((step) => step.key),
  }));
  const milestoneOf = new Map(milestones.map((milestone) => [milestone.ref, milestone]));

  const stageOf = (name: string | null, staged: RolloutStep[]): RolloutStage => {
    const live = staged.length > 0 && staged.every((step) => step.live !== null);
    const soakedAt = live ? Math.max(...staged.map((step) => step.soakedAt!)) : null;
    return {
      name,
      goal: name === null ? null : (declared.find((entry) => entry.name === name)?.goal ?? null),
      soak: soakOf(name),
      steps: staged.sort((a, b) => keyOrder(a.key, b.key)),
      milestones: (name === null ? specMilestones.filter((milestone) => milestone.stage === undefined || !stageNames.includes(milestone.stage)) : gating(name)).map((milestone) => milestoneOf.get(milestone.ref)!),
      live,
      soakedAt,
      soaked: soakedAt !== null && now >= soakedAt,
    };
  };
  const stages = [...stageNames.map((name) => stageOf(name, steps.filter((step) => step.stage === name))), stageOf(null, steps.filter((step) => step.stage === null))].filter((stage) => stage.steps.length > 0 || stage.milestones.length > 0);

  const windows: RolloutWindow[] = (spec.rollout?.window ?? []).map((window) => {
    const from = dayStart(window.from);
    const end = dayStart(window.to) + DAY_MS;
    return { title: window.title, from: window.from, to: window.to, note: window.note ?? null, active: now >= from && now < end, startsIn: now < from ? Math.ceil((from - now) / DAY_MS) : null, past: now >= end };
  });

  return {
    stages,
    milestones,
    windows,
    next: nextOf(stages, now),
    warnings: warningsOf(stages, windows),
    counts: { steps: steps.length, live: steps.filter((step) => step.live !== null).length, soaked: steps.filter((step) => step.soaked).length },
  };
}

const prRef = (step: RolloutStep) => (step.prNumber === null ? "" : ` (#${step.prNumber})`);
const howText = (step: RolloutStep) => (step.how === null ? "" : ` (${step.how})`);
const MERGE_RANK: Record<RolloutMerge, number> = { merged: 0, approved: 1, open: 2, no_pr: 3 };

/** The earliest stage with steps that are not live; within it, the steps whose requirements are all live. */
function nextOf(stages: readonly RolloutStage[], now: number): RolloutNext {
  let soaking: RolloutStage | null = null;
  for (const stage of stages) {
    const pending = stage.steps.filter((step) => step.live === null);
    if (pending.length === 0) {
      if (stage.name !== null && !stage.soaked && stage.soakedAt !== null && (soaking === null || stage.soakedAt > soaking.soakedAt!)) soaking = stage;
      continue;
    }
    if (stage.name !== null && soaking !== null) {
      return { kind: "soak", keys: pending.map((step) => step.key), stage: soaking.name, until: soaking.soakedAt, text: `Wait for the ${soaking.name} stage to soak until ${whenText(soaking.soakedAt!)}.` };
    }
    return pickNext(stage, pending);
  }
  const soakNote = soaking === null ? "" : ` The ${soaking.name} stage soaks until ${whenText(soaking.soakedAt!)}.`;
  return { kind: "done", keys: [], stage: null, until: soaking?.soakedAt ?? null, text: `Everything is live.${soakNote}` };
}

function pickNext(stage: RolloutStage, pending: RolloutStep[]): RolloutNext {
  const ready = pending
    .filter((step) => unmet(step).length === 0)
    .sort((a, b) => Number(a.state === "blocked") - Number(b.state === "blocked") || MERGE_RANK[a.merge] - MERGE_RANK[b.merge] || b.waiting - a.waiting || keyOrder(a.key, b.key));
  const first = ready[0];
  if (first === undefined) {
    const needs = pending.flatMap(unmet);
    const milestone = needs.find((need) => need.kind === "milestone");
    const need = milestone ?? needs[0]!;
    const count = pending.filter((step) => unmet(step).some((each) => each.target === need.target)).length;
    const who = `${plural(count, "step")} ${count === 1 ? "needs" : "need"} it`;
    if (milestone !== undefined) return { kind: "milestone", keys: [need.target], stage: stage.name, until: null, text: `Wait for ${need.target}${need.title === null ? "" : ` (${need.title})`} to hold; ${who}.` };
    return { kind: "wait", keys: [need.target], stage: stage.name, until: null, text: `Wait for ${need.target} to go live; ${who}.` };
  }
  const waits = first.waiting === 0 ? "" : ` ${plural(first.waiting, "step")} ${first.waiting === 1 ? "waits" : "wait"} on it.`;
  const also = ready.length > 1 ? ` ${listText(ready.slice(1).map((step) => step.key))} can go now too.` : "";
  const keys = ready.map((step) => step.key);
  if (first.state === "blocked") return { kind: "blocked", keys, stage: stage.name, until: null, text: `${first.key} is next, and it is blocked.${waits}${also}` };
  switch (first.merge) {
    case "merged":
      return { kind: "deploy", keys, stage: stage.name, until: null, text: `Deploy ${first.key}${howText(first)}.${waits}${also}` };
    case "open":
    case "approved":
      return {
        kind: "merge",
        keys,
        stage: stage.name,
        until: null,
        text: first.onMerge ? `Merge ${first.key}${prRef(first)}: it deploys when it merges${howText(first)}.${waits}${also}` : `Merge ${first.key}${prRef(first)}, then deploy it${howText(first)}.${waits}${also}`,
      };
    case "no_pr":
      return { kind: "pr", keys, stage: stage.name, until: null, text: `${first.key} is next; its pull request is not open yet.${waits}${also}` };
  }
}

function warningsOf(stages: readonly RolloutStage[], windows: readonly RolloutWindow[]): RolloutWarning[] {
  const warnings: RolloutWarning[] = [];
  const staged = stages.filter((stage) => stage.name !== null);
  for (const stage of stages) {
    const earlier = stage.name === null ? undefined : staged.slice(0, staged.indexOf(stage)).find((before) => before.steps.length > 0 && !before.soaked);
    for (const step of stage.steps) {
      if (step.live !== null) continue;
      const needs = unmet(step);
      const pending = step.merge === "open" || step.merge === "approved";
      const moving = (step.onMerge && pending) || step.merge === "merged";
      if (step.onMerge && pending && needs.length > 0) warnings.push({ kind: "ships_on_merge", tone: "warning", keys: [step.key], text: `${step.key} deploys when it merges, and ${needsText(needs, false)} yet.` });
      else if (step.merge === "merged" && needs.length > 0) warnings.push({ kind: "deploy_early", tone: "warning", keys: [step.key], text: `${step.key} merged; deploy it only after ${needsText(needs, true)}.` });
      else if (!step.onMerge && pending && needs.some((need) => need.kind === "milestone")) {
        const waiting = needs.filter((need) => need.kind === "milestone");
        warnings.push({ kind: "milestone", tone: "info", keys: [step.key], text: `${step.key} needs ${listText(waiting.map((need) => need.target))} to hold before it deploys, and ${waiting.length === 1 ? "it does" : "they do"} not yet.` });
      }
      if (moving && earlier !== undefined) {
        const why = earlier.live ? `soaks until ${whenText(earlier.soakedAt!)}` : "is not all live yet";
        warnings.push({ kind: "soak", tone: "warning", keys: [step.key], text: `${step.key} is in the ${stage.name} stage, and the ${earlier.name} stage ${why}.` });
      }
      if (step.onMerge && pending) {
        for (const window of windows) {
          if (window.active) warnings.push({ kind: "window", tone: "warning", keys: [step.key], text: `${step.key} deploys on merge, and the ${window.title} is on until ${dayText(window.to)}.` });
          else if (window.startsIn !== null && window.startsIn <= WINDOW_NOTICE_DAYS) {
            warnings.push({ kind: "window", tone: "info", keys: [step.key], text: `${step.key} deploys on merge and has ${plural(window.startsIn, "day")} before the ${window.title} (${dayText(window.from)} to ${dayText(window.to)}).` });
          }
        }
      }
    }
  }
  return warnings;
}

const LIVE_BY: Record<LiveBy, string> = { merge: "its pull request merged", verify: "its verify passed", check: "its check passed", human: "marked by the human" };
const sentence = (text: string) => (/[.!?]$/u.test(text) ? text : `${text}.`);

/** A verify or check run in words: "passed", "exited 1", or why it did not finish. */
export function checkText(check: RolloutCheckResult): string {
  if (check.exitCode === 0) return `passed at ${whenText(check.at)}`;
  if (check.exitCode !== null) return `exited ${check.exitCode} at ${whenText(check.at)}`;
  return `did not finish at ${whenText(check.at)}: ${check.output.split("\n")[0] ?? ""}`;
}

function needText(need: RolloutRequirement): string {
  if (need.cancelled) return `${need.target} (cancelled)`;
  if (need.unknown) return `${need.target} (no longer in the spec)`;
  if (need.kind === "milestone") return `${need.target} (${need.live ? "holds" : "does not hold"}${need.viaStage ? ", gates the stage" : ""})`;
  return `${need.target} (${need.live ? "live" : "not live"})`;
}

function stepText(step: RolloutStep): string {
  const pr = step.prNumber === null ? "" : ` #${step.prNumber}`;
  const merge = step.merge === "merged" ? "merged" : step.merge === "no_pr" ? "no pull request yet" : `pull request${pr} ${step.merge}`;
  const soaking = step.live !== null && !step.soaked && step.soakedAt !== null ? `, soaking until ${whenText(step.soakedAt)}` : "";
  const live = step.live === null ? "not live" : `live since ${whenText(step.live.at)}, ${LIVE_BY[step.live.by]}${soaking}`;
  const parts = [
    `${step.key} ${step.title}: ${merge}, ${live}${step.state === "blocked" ? ", blocked" : ""}.`,
    step.onMerge ? sentence(`Deploys on merge${step.how === null ? "" : `: ${step.how}`}`) : step.how === null ? "" : sentence(`Deploys: ${step.how}`),
    step.requires.length === 0 ? "" : `Needs ${listText(step.requires.map(needText))}.`,
    step.release === null ? "" : `Release ${step.release}${step.releaseWith.length === 0 ? "" : ` with ${listText(step.releaseWith)}`}.`,
    step.dark ? "Ships dark, with its gate off." : "",
    step.verify === null ? "" : `Verify: \`${step.verify}\`${step.lastCheck === null ? "" : `, ${checkText(step.lastCheck)}`}.`,
    step.rollback === null ? "" : sentence(`Rollback: ${step.rollback}`),
    step.liveConsumers.length === 0 ? "" : `Rolling it back now breaks ${listText(step.liveConsumers)}, which ${step.liveConsumers.length === 1 ? "is" : "are"} live.`,
  ];
  return parts.filter((part) => part !== "").join(" ");
}

function milestoneText(milestone: RolloutMilestone): string {
  const state = milestone.live === null ? "does not hold" : `holds since ${whenText(milestone.live.at)}, ${LIVE_BY[milestone.live.by]}`;
  const check = milestone.check === null ? "" : ` Check: \`${milestone.check}\`${milestone.lastCheck === null ? "" : `, ${checkText(milestone.lastCheck)}`}.`;
  const needed = milestone.neededBy.length === 0 ? "" : ` ${listText(milestone.neededBy)} ${milestone.neededBy.length === 1 ? "needs" : "need"} it.`;
  return `${milestone.ref} ${milestone.title}: ${state}.${check}${needed}`;
}

/** The view as sentences, for `bb loom rollout`. */
export function rolloutLines(view: RolloutView): string[] {
  const lines = [`Next: ${view.next.text}`];
  if (view.warnings.length > 0) lines.push("", "Warnings:", ...view.warnings.map((warning) => `- ${warning.text}`));
  for (const stage of view.stages) {
    const live = `${stage.steps.filter((step) => step.live !== null).length} of ${plural(stage.steps.length, "step")} live`;
    const head = stage.name === null ? `No stage: ${live}.` : `${stage.name}: ${stage.goal === null ? "" : sentence(stage.goal)} ${stage.soak === null ? "" : `Soak ${stage.soak}. `}${sentence(live)}`.replace(/ {2,}/gu, " ");
    lines.push("", head, ...stage.steps.map((step) => `- ${stepText(step)}`));
  }
  if (view.milestones.length > 0) lines.push("", "Milestones:", ...view.milestones.map((milestone) => `- ${milestoneText(milestone)}`));
  if (view.windows.length > 0) {
    const state = (window: RolloutWindow) => (window.active ? "on now" : window.past ? "over" : `starts in ${plural(window.startsIn!, "day")}`);
    lines.push("", "Windows:", ...view.windows.map((window) => `- ${window.title}: ${dayText(window.from)} to ${dayText(window.to)}, ${state(window)}.${window.note === null ? "" : ` ${sentence(window.note)}`}`));
  }
  return lines;
}

/**
 * What the spec says about a ticket's place in the deploy order, as lines for its pull request and its briefs: its stage,
 * what must be live first with each pull request and how it deploys, how it deploys itself, its release, dark, verify and
 * rollback. With `marks` it also says what is live now. No lines when the ticket has no rollout and the project no stages.
 */
export function rolloutFacts(spec: Spec, tickets: readonly TicketRow[], ticket: TicketRow, marks: readonly RolloutMarkRow[] | null, now: number): string[] {
  const stages = spec.rollout?.stage ?? [];
  if (spec.merge.strategy !== "pr" || (ticket.rollout_json === null && stages.length === 0)) return [];
  const step = rolloutOf(spec, tickets, marks ?? [], now)?.stages.flatMap((stage) => stage.steps).find((each) => each.key === ticket.key);
  if (step === undefined) return ["This change is in no rollout stage. Loom follows the project's deploy order on its Rollout tab."];
  const at = step.stage === null ? -1 : stages.findIndex((stage) => stage.name === step.stage);
  const stageLine =
    step.stage === null ? "Stage: none." : at < 0 ? `Stage: ${step.stage}.` : `Stage: ${step.stage} (${at + 1} of ${stages.length}): ${sentence(stages[at]!.goal)}`;
  const status = (need: RolloutRequirement) => {
    if (marks === null || need.cancelled || need.unknown) return "";
    if (need.kind === "milestone") return need.live ? " It holds." : " It does not hold yet.";
    return need.live ? " It is live." : " It is not live yet.";
  };
  const needLine = (need: RolloutRequirement) => {
    if (need.kind === "milestone") return `- ${need.target}${need.title === null ? "" : `: ${sentence(need.title)}`}${need.viaStage ? " It gates this stage." : ""}${status(need)}`;
    const name = need.title === null ? need.target : `${need.target} ${need.title}`;
    const how = need.how === null ? "" : ` It deploys: ${sentence(need.how)}`;
    return `- ${name} (${need.prUrl ?? "no pull request yet"}).${need.cancelled ? " It is cancelled." : how}${status(need)}`;
  };
  const deploy = step.onMerge
    ? sentence(`Deploys on merge${step.how === null ? "" : `: ${step.how}`}`)
    : step.how === null
      ? "Merging does not deploy it; it deploys the way its repo does."
      : `Deploys: ${sentence(step.how)} Merging does not deploy it.`;
  return [
    stageLine,
    ...(step.requires.length === 0 ? ["Live first: nothing."] : ["Live first:", ...step.requires.map(needLine)]),
    deploy,
    ...(step.release === null ? [] : [`Release: ${step.release}${step.releaseWith.length === 0 ? "" : `, with ${listText(step.releaseWith)}`}.`]),
    ...(step.dark ? ["Dark: it ships with its gate off."] : []),
    ...(step.verify === null ? [] : [`Verify: \`${step.verify}\``]),
    ...(step.rollback === null ? [] : [sentence(`Rollback: ${step.rollback}`)]),
  ];
}

/** The `## Rollout` section Loom adds to a ticket's pull request description, or no lines when it has nothing to say. */
export function rolloutSection(spec: Spec, tickets: readonly TicketRow[], ticket: TicketRow, marks: readonly RolloutMarkRow[], now: number): string[] {
  const facts = rolloutFacts(spec, tickets, ticket, marks, now);
  if (facts.length === 0) return [];
  return ["## Rollout", "", ...facts, "", "Loom tracks this order on the project's Rollout tab. It is advice: Loom holds no merge or deploy for it."];
}
