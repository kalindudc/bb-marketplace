// Ship's fixtures: a LANE-like pull request project whose rollout names a next step the merge order holds (LANE-36,
// stacked on LANE-35, with a failing check), a freeze, a stage still to soak, a held final review and a step to mark
// live; and a CSV-like one whose merges the person confirms in Loom.
import type { BoardCard, MergeEntry, MergeOrderView, ProjectView, RolloutStep, RolloutView } from "../src/contract";
import { card, HOUR, NOW, overview, projectView, repoOverview } from "./fixtures";

export const entry = (over: Partial<MergeEntry> & Pick<MergeEntry, "key">): MergeEntry => ({
  title: `${over.key} title`,
  repo: null,
  state: "pr_open",
  base: "main",
  prUrl: `https://github.com/acme/shop/pull/${over.key.split("-")[1]}`,
  prNumber: over.key.split("-")[1]!,
  prOpen: over.state === undefined || over.state === "pr_open",
  elsewhere: null,
  step: 1,
  stackedOn: null,
  waitsOn: [],
  unblocks: [],
  checks: { passed: 4, failed: 0, pending: 0 },
  draft: false,
  draftHold: null,
  publishWait: null,
  review: "APPROVED",
  reviewRead: true,
  conflicts: false,
  behind: null,
  refreshBehind: null,
  verdict: "ready",
  holds: [],
  prHolds: [],
  trap: false,
  mergedInto: null,
  mergedIntoState: null,
  blockedReason: null,
  finalReview: null,
  ...over,
});

export const step = (over: Partial<RolloutStep> & Pick<RolloutStep, "key">): RolloutStep => ({
  title: `${over.key} title`,
  repo: "world",
  state: "pr_open",
  stage: "expand",
  prUrl: `https://github.com/acme/shop/pull/${over.key.split("-")[1]}`,
  prNumber: over.key.split("-")[1]!,
  merge: "open",
  live: null,
  soaked: false,
  soakedAt: null,
  how: "The pipeline deploys main",
  onMerge: false,
  requires: [],
  release: null,
  releaseWith: [],
  dark: false,
  verify: null,
  rollback: null,
  lastCheck: null,
  liveConsumers: [],
  waiting: 0,
  ...over,
});

const need = (target: string, live: boolean) => ({ target, kind: "ticket" as const, title: `${target} title`, live, cancelled: false, unknown: false, viaStage: false, prUrl: null, prNumber: null, how: null });

export function laneOrder(over: (entries: MergeEntry[]) => MergeEntry[] = (entries) => entries): MergeOrderView {
  const entries = over([
    entry({ key: "LANE-6", title: "ubertool: lane command sends X-Lane-Env", repo: "ubertool", unblocks: ["LANE-17"] }),
    entry({ key: "LANE-7", title: "admin-web: send X-Lane-Env", repo: "world", checks: { passed: 6, failed: 0, pending: 0 } }),
    entry({ key: "LANE-10", title: "admin-mobile sends the header", repo: "world", checks: { passed: 3, failed: 0, pending: 0 } }),
    entry({ key: "LANE-11", title: "finance-mobile sends the header", repo: "world", checks: { passed: 5, failed: 0, pending: 0 } }),
    entry({ key: "LANE-12", title: "Platform suites identify the lane", repo: "world", finalReview: { state: "held", reason: "bb could not start the reviewer: HTTP 409" } }),
    entry({ key: "LANE-26", title: "Payments worker reads the header", repo: "ttc" }),
    entry({ key: "LANE-35", title: "Envoy: shop routes read the header", repo: "world", verdict: "first", review: "REVIEW_REQUIRED", holds: [{ code: "needs_review" }], prHolds: [{ code: "needs_review" }], unblocks: ["LANE-36"] }),
    entry({ key: "LANE-36", title: "Rust SFR QA reads Force-Env", repo: "world", step: 2, stackedOn: "LANE-35", waitsOn: [{ key: "LANE-35", why: "stacked", repo: "world", prNumber: "35" }], verdict: "after", checks: { passed: 1, failed: 1, pending: 0 }, prHolds: [{ code: "failing", count: 1 }] }),
    entry({ key: "LANE-16", title: "Envoy: lane routing config", repo: "infrastructure", state: "blocked", verdict: "blocked", prOpen: false, blockedReason: "Needs a decision" }),
    entry({ key: "LANE-30", title: "Stage the lane flag", repo: "infrastructure", step: 2, waitsOn: [{ key: "LANE-16", why: "stacked", repo: "infrastructure", prNumber: "16" }], verdict: "after" }),
    entry({ key: "LANE-17", title: "Cut over ubertool", repo: "ubertool", state: "queued", prUrl: null, prNumber: null, prOpen: false, step: 2, waitsOn: [{ key: "LANE-6", why: "depends", repo: "ubertool", prNumber: "6" }], verdict: "after", checks: null, review: null }),
    entry({ key: "LANE-4", title: "Envoy: read X-Lane-Env", repo: "world", state: "done", verdict: "merged", step: 0, prOpen: false }),
  ]);
  return { repos: ["world", "ttc", "ubertool", "infrastructure"], steps: 2, entries, counts: { open: 9, first: 7, ready: 5, wrong: 0 } };
}

export function laneRollout(over: Partial<RolloutView> = {}): RolloutView {
  return {
    stages: [
      {
        name: "expand",
        goal: "Servers accept the header",
        soak: "1d",
        steps: [
          step({ key: "LANE-4", state: "done", merge: "merged", waiting: 2 }),
          step({ key: "LANE-6", repo: "ubertool", merge: "approved" }),
          step({ key: "LANE-26", repo: "ttc", merge: "approved", onMerge: true, how: "The actuator applies on merge" }),
          step({ key: "LANE-36", merge: "open", requires: [need("LANE-4", false)] }),
        ],
        milestones: [],
        live: false,
        soakedAt: null,
        soaked: false,
      },
      {
        name: "contract",
        goal: "Clients send it",
        soak: "1d",
        steps: [step({ key: "LANE-31", state: "done", merge: "merged", stage: "contract" }), step({ key: "LANE-32", state: "done", merge: "merged", stage: "contract" })],
        milestones: [],
        live: false,
        soakedAt: null,
        soaked: false,
      },
    ],
    milestones: [],
    windows: [{ title: "Payments freeze", from: "2026-01-09", to: "2026-01-13", note: null, active: true, startsIn: null, past: false }],
    next: { kind: "merge", keys: ["LANE-36"], stage: "expand", until: null, text: "Merge LANE-36, then deploy it." },
    warnings: [],
    counts: { steps: 6, live: 0, soaked: 0 },
    ...over,
  };
}

export function laneBoard(): BoardCard[] {
  const at = NOW - 4 * HOUR;
  return [
    card({ key: "LANE-4", title: "Envoy: read X-Lane-Env", state: "done", repo: "world", stateAt: at }),
    card({ key: "LANE-6", title: "ubertool: lane command sends X-Lane-Env", state: "pr_open", repo: "ubertool", prUrl: "https://github.com/acme/shop/pull/6", stateAt: at }),
    card({ key: "LANE-7", title: "admin-web: send X-Lane-Env", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/7", stateAt: at }),
    card({ key: "LANE-10", title: "admin-mobile sends the header", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/10", stateAt: at }),
    card({ key: "LANE-11", title: "finance-mobile sends the header", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/11", stateAt: at }),
    card({ key: "LANE-12", title: "Platform suites identify the lane", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/12", stateAt: at }),
    card({ key: "LANE-16", title: "Envoy: lane routing config", state: "blocked", repo: "infrastructure", prUrl: "https://github.com/acme/shop/pull/16", blockedReason: "Needs a decision", stateAt: at }),
    card({ key: "LANE-17", title: "Cut over ubertool", state: "queued", repo: "ubertool", deps: ["LANE-6"], stateAt: at }),
    card({ key: "LANE-26", title: "Payments worker reads the header", state: "pr_open", repo: "ttc", prUrl: "https://github.com/acme/shop/pull/26", stateAt: at }),
    card({ key: "LANE-30", title: "Stage the lane flag", state: "pr_open", repo: "infrastructure", prUrl: "https://github.com/acme/shop/pull/30", stateAt: at }),
    card({ key: "LANE-31", title: "Contract: drop the old route", state: "done", repo: "world", stateAt: at }),
    card({ key: "LANE-32", title: "Contract: drop the old header", state: "done", repo: "world", stateAt: at }),
    card({ key: "LANE-33", title: "Lane routing in Envoy", state: "queued", repo: "world", prereqs: [{ key: "LANE-4", kind: "live" }], stateAt: at }),
    card({ key: "LANE-35", title: "Envoy: shop routes read the header", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/35", stateAt: at }),
    card({ key: "LANE-36", title: "Rust SFR QA reads Force-Env", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/36", prereqs: [{ key: "LANE-35", kind: "merge" }, { key: "LANE-4", kind: "live" }], stateAt: at }),
  ];
}

export function laneShip(over: Partial<ProjectView> = {}): ProjectView {
  return projectView({
    overview: overview({ slug: "lane", key: "LANE", name: "One X-Lane-Env contract for lane routing", strategy: "pr", branch: null, state: "paused", repos: ["world", "ttc", "ubertool", "infrastructure"].map((name) => repoOverview({ name })) }),
    board: laneBoard(),
    mergeOrder: laneOrder(),
    rollout: laneRollout(),
    ...over,
  });
}

/** CSV, whose merges the person confirms: CSV-12 is ready, CSV-15 waits on it and has a failing check, CSV-16 waits on it alone. */
export function csvShip(over: Partial<ProjectView> = {}): ProjectView {
  const confirm = { prUrl: "https://github.com/acme/shop/pull/418", sha: "9f3c2e1a7b4d5e6f8091a2b3c4d5e6f708192a3b", ready: true, waiting: null, confirmed: false, requested: null };
  return projectView({
    overview: overview({ strategy: "pr", branch: null }),
    board: [
      card({ key: "CSV-12", title: "Gzip the stream when the client accepts it", state: "pr_open", prUrl: confirm.prUrl, mergeConfirm: confirm }),
      card({ key: "CSV-15", title: "Retry a failed chunk", state: "pr_open", prUrl: "https://github.com/acme/shop/pull/415", prereqs: [{ key: "CSV-12", kind: "merge" }] }),
      card({ key: "CSV-16", title: "Resume a broken export", state: "queued", deps: ["CSV-12"] }),
      card({ key: "CSV-3", title: "Docs for exports", state: "pr_open", prUrl: "https://github.com/acme/shop/pull/403", draft: "held" }),
    ],
    mergeOrder: {
      repos: [null],
      steps: 2,
      entries: [
        entry({ key: "CSV-12", prUrl: confirm.prUrl, prNumber: "418", unblocks: ["CSV-15", "CSV-16"], checks: { passed: 6, failed: 0, pending: 0 } }),
        entry({ key: "CSV-15", prNumber: "415", step: 2, waitsOn: [{ key: "CSV-12", why: "merge_after", repo: null, prNumber: "418" }], verdict: "after", checks: { passed: 2, failed: 1, pending: 0 }, prHolds: [{ code: "failing", count: 1 }] }),
        entry({ key: "CSV-16", prUrl: null, prNumber: null, state: "queued", prOpen: false, step: 2, waitsOn: [{ key: "CSV-12", why: "depends", repo: null, prNumber: "418" }], verdict: "after" }),
        entry({ key: "CSV-3", prNumber: "403", draft: true, draftHold: "held", verdict: "first", holds: [{ code: "draft" }], prHolds: [{ code: "draft" }] }),
      ],
      counts: { open: 3, first: 2, ready: 1, wrong: 0 },
    },
    ...over,
  });
}

/**
 * LANE with a hold of every kind on the steps the rollout names next. LANE-35 needs a review; LANE-36 is stacked on it,
 * deploys on merge and needs LANE-4 live; LANE-38 deploys on merge before LANE-4 is live; LANE-37 is in Contract, which
 * waits for Expand to soak. LANE-6 alone can go. With `freeze`, a freeze is on as well. With `reviewOwed`, LANE-37 deploys
 * nothing on merge and still needs a review, a hold that outlasts Expand's soak.
 */
export function laneHeld({ freeze, reviewOwed = false }: { freeze: boolean; reviewOwed?: boolean }): ProjectView {
  const base = laneRollout();
  const [expand, contract] = base.stages;
  const order = laneOrder((entries) => [
    ...entries.map((one) => (one.key === "LANE-36" ? { ...one, checks: { passed: 3, failed: 0, pending: 0 }, prHolds: [] } : one)),
    entry({ key: "LANE-37", title: "Contract: drop the alias", repo: "world", ...(reviewOwed ? { verdict: "first", review: "REVIEW_REQUIRED", holds: [{ code: "needs_review" }], prHolds: [{ code: "needs_review" }] } : {}) }),
    entry({ key: "LANE-38", title: "Edge rules read the header", repo: "world" }),
  ]);
  const rollout = laneRollout({
    stages: [
      {
        ...expand!,
        steps: [
          ...expand!.steps.filter((one) => one.key !== "LANE-36"),
          step({ key: "LANE-35", merge: "open" }),
          step({ key: "LANE-36", merge: "open", onMerge: true, requires: [need("LANE-4", false)] }),
          step({ key: "LANE-38", merge: "approved", onMerge: true, requires: [need("LANE-4", false)] }),
        ],
      },
      { ...contract!, steps: [...contract!.steps, step({ key: "LANE-37", stage: "contract", merge: reviewOwed ? "open" : "approved", onMerge: !reviewOwed })] },
    ],
    windows: freeze ? base.windows : [],
    next: { kind: "merge", keys: ["LANE-36", "LANE-6", "LANE-35", "LANE-38", "LANE-37"], stage: "expand", until: null, text: "Merge LANE-36, then deploy it." },
  });
  const at = NOW - 4 * HOUR;
  return laneShip({
    mergeOrder: order,
    rollout,
    board: [
      ...laneBoard(),
      card({ key: "LANE-37", title: "Contract: drop the alias", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/37", stateAt: at }),
      card({ key: "LANE-38", title: "Edge rules read the header", state: "pr_open", repo: "world", prUrl: "https://github.com/acme/shop/pull/38", prereqs: [{ key: "LANE-4", kind: "live" }], stateAt: at }),
    ],
  });
}
