import { describe, expect, it } from "vitest";
import type { LiveBy, RolloutMarkRow, TicketRow } from "../src/db/store";
import type { PrMeta } from "../src/pr-meta";
import { rolloutOf, rolloutSection, type RolloutView, type TicketRollout } from "../src/rollout";
import { byUrgency, chainOf, columnsOf, earliestOf, holdsOf, milestoneBlockers, milestoneStatus, pullRequestNote, readyToMerge, repoDeploys, shortCommand, stepStatus } from "../src/ui/rollout-plan";
import type { MergeEntry } from "../src/merge-order";
import { parseSpec, type Spec } from "../src/spec";
import type { TicketState } from "../src/states";
import { HOUR, NOW } from "./fixtures";
import { specToml, type Doc } from "./helpers";

const DAY = 24 * HOUR;

// core deploys with the project's Shipit text, edge applies on merge; three stages, and a milestone that gates the last.
const specOf = (edit?: (doc: Doc) => void): Spec => {
  const result = parseSpec(
    specToml((doc) => {
      doc.merge = { strategy: "pr" };
      doc.repo = [
        { name: "core", project: "proj_core" },
        { name: "edge", project: "proj_edge", deploy: { on_merge: true, how: "The actuator applies on merge" } },
      ];
      doc.rollout = {
        deploy: { how: "Shipit deploys main" },
        stage: [
          { name: "expand", goal: "Servers accept the header", soak: "1d" },
          { name: "migrate", goal: "Callers send it" },
          { name: "contract", goal: "The old path is gone" },
        ],
        milestone: [{ ref: "old-traffic-zero", title: "Old path traffic near zero", check: "./zero.sh", stage: "contract" }],
      };
      doc.ticket[0].repo = "core";
      doc.ticket[1].repo = "core";
      edit?.(doc);
    }),
  );
  expect(result.errors).toEqual([]);
  return result.spec!;
};

let seq = 0;
type Over = Partial<TicketRow> & { rollout?: TicketRollout; meta?: Partial<PrMeta> };
function row(key: string, state: TicketState, over: Over = {}): TicketRow {
  seq += 1;
  const { rollout, meta, ...rest } = over;
  const pr = !["queued", "working", "cancelled"].includes(state);
  return {
    id: seq,
    project_id: 1,
    seq,
    key,
    ref: key.toLowerCase(),
    title: `${key} title`,
    body: "",
    acceptance_json: "[]",
    verify_json: "[]",
    scope_json: "[]",
    deps_json: "[]",
    priority: 2,
    state,
    attempt: 1,
    failures: 0,
    check_failures: 0,
    review_round: 1,
    branch: null,
    environment_id: null,
    worker_thread_id: null,
    head_sha: null,
    merge_before: null,
    pr_url: pr ? `https://github.com/acme/core/pull/${seq}` : null,
    pr_checked_at: null,
    blocked_reason: null,
    repo: "core",
    pr_branch: null,
    pushed_sha: pr ? `sha-${key}` : null,
    pushed_at: null,
    pr_ask_json: null,
    pr_text_json: null,
    pr_seen_json: "[]",
    pr_rounds: 0,
    pr_status_json: null,
    handback_json: null,
    stack_json: null,
    pr_base: null,
    start_wait_json: null,
    environment_json: null,
    pr_poll_json: null,
    merge_after_json: "[]",
    pr_meta_json: meta === undefined ? null : JSON.stringify({ at: 0, draft: false, review: null, base: null, ...meta }),
    head_tree: null,
    merge_wait_json: null,
    merge_step_json: null,
    pr_proposal_json: null,
    pr_applied_json: null,
    rollout_json: rollout === undefined ? null : JSON.stringify(rollout),
    created_by: "human",
    created_at: 0,
    updated_at: 0,
    state_at: 0,
    ...rest,
  };
}

const live = (target: string, by: LiveBy, at: number, evidence: string | null = null): RolloutMarkRow => ({ project_id: 1, target, live_at: at, live_by: by, evidence, undone_at: null, checked_at: null, check_exit: null, check_output: null, run_token: null, run_at: null });
const stepOf = (view: RolloutView, key: string) => view.stages.flatMap((stage) => stage.steps).find((step) => step.key === key)!;

/** LANE-1 merged and LANE-2 open in expand; LANE-3 approved and LANE-4 queued in migrate, released together; LANE-5 in contract; LANE-6 in no stage. */
function board(over: Partial<Record<string, Over & { state?: TicketState }>> = {}): TicketRow[] {
  seq = 0;
  const make = (key: string, state: TicketState, base: Over) => {
    const { state: replaced, ...rest } = over[key] ?? {};
    return row(key, replaced ?? state, { ...base, ...rest });
  };
  return [
    make("LANE-1", "done", { rollout: { stage: "expand", verify: "curl -f https://core.example.com/health", rollback: "Revert the commit" } }),
    make("LANE-2", "pr_open", { repo: "edge", rollout: { stage: "expand" } }),
    make("LANE-3", "pr_open", { rollout: { stage: "migrate", requires_live: ["LANE-1"], how: "Shipit, canary first", release: "wave-1" }, meta: { review: "APPROVED" } }),
    make("LANE-4", "queued", { rollout: { stage: "migrate", requires_live: ["LANE-1", "LANE-2"], release: "wave-1", dark: true } }),
    make("LANE-5", "queued", { rollout: { stage: "contract" } }),
    make("LANE-6", "queued", {}),
    make("LANE-7", "cancelled", { rollout: { stage: "expand" } }),
  ];
}

describe("rolloutOf", () => {
  it("is null on the integration strategy and for a project with no rollout, and not once a ticket has one", () => {
    const plain = parseSpec(specToml((doc) => (doc.merge = { strategy: "pr" }))).spec!;
    expect(rolloutOf(parseSpec(specToml()).spec!, [row("CSV-1", "queued")], [], NOW)).toBeNull();
    expect(rolloutOf(plain, [row("CSV-1", "queued", { repo: null })], [], NOW)).toBeNull();
    const view = rolloutOf(plain, [row("CSV-1", "queued", { repo: null, rollout: { verify: "true" } }), row("CSV-2", "queued", { repo: null })], [], NOW)!;
    expect(view.stages.map((stage) => [stage.name, stage.steps.map((step) => step.key)])).toEqual([[null, ["CSV-1"]]]);
  });

  it("lays the steps out by stage, with how each deploys, what it requires, its release and its pull request", () => {
    const view = rolloutOf(specOf(), board(), [], NOW)!;
    expect(view.stages.map((stage) => [stage.name, stage.goal, stage.soak, stage.steps.map((step) => step.key), stage.milestones.map((milestone) => milestone.ref)])).toEqual([
      ["expand", "Servers accept the header", "1d", ["LANE-1", "LANE-2"], []],
      ["migrate", "Callers send it", null, ["LANE-3", "LANE-4"], []],
      ["contract", "The old path is gone", null, ["LANE-5"], ["old-traffic-zero"]],
      [null, null, null, ["LANE-6"], []],
    ]);
    expect(stepOf(view, "LANE-1")).toMatchObject({ merge: "merged", how: "Shipit deploys main", onMerge: false, verify: "curl -f https://core.example.com/health", rollback: "Revert the commit", waiting: 2, live: null, soaked: false });
    expect(stepOf(view, "LANE-2")).toMatchObject({ merge: "open", how: "The actuator applies on merge", onMerge: true, waiting: 1 });
    expect(stepOf(view, "LANE-3")).toMatchObject({ merge: "approved", how: "Shipit, canary first", release: "wave-1", releaseWith: ["LANE-4"], prNumber: "3" });
    expect(stepOf(view, "LANE-4")).toMatchObject({ merge: "no_pr", prUrl: null, dark: true, releaseWith: ["LANE-3"] });
    expect(stepOf(view, "LANE-4").requires).toEqual([
      { target: "LANE-1", kind: "ticket", title: "LANE-1 title", live: false, cancelled: false, unknown: false, viaStage: false, prUrl: "https://github.com/acme/core/pull/1", prNumber: "1", how: "Shipit deploys main" },
      { target: "LANE-2", kind: "ticket", title: "LANE-2 title", live: false, cancelled: false, unknown: false, viaStage: false, prUrl: "https://github.com/acme/core/pull/2", prNumber: "2", how: "The actuator applies on merge" },
    ]);
    expect(stepOf(view, "LANE-5").requires).toEqual([expect.objectContaining({ target: "old-traffic-zero", kind: "milestone", title: "Old path traffic near zero", live: false, viaStage: true })]);
    expect(view.milestones).toEqual([{ ref: "old-traffic-zero", title: "Old path traffic near zero", stage: "contract", check: "./zero.sh", live: null, lastCheck: null, neededBy: ["LANE-5"] }]);
    expect(view.counts).toEqual({ steps: 6, live: 0, soaked: 0 });
  });

  it("orders the stages tickets name without [[rollout.stage]] tables by the first ticket that names each", () => {
    const loose = parseSpec(specToml((doc) => ((doc.merge = { strategy: "pr" }), (doc.ticket[0].rollout = { stage: "beta" })))).spec!;
    const view = rolloutOf(loose, [row("CSV-1", "queued", { repo: null, rollout: { stage: "beta" } }), row("CSV-2", "queued", { repo: null, rollout: { stage: "alpha" } })], [], NOW)!;
    expect(view.stages.map((stage) => [stage.name, stage.goal])).toEqual([
      ["beta", null],
      ["alpha", null],
    ]);
  });

  it("keeps a check's last run and says when a live step has soaked, and which live steps rely on it", () => {
    const marks = [live("LANE-1", "verify", NOW - 2 * DAY, "200 OK"), live("LANE-3", "human", NOW - HOUR, "Deployed by hand"), { ...live("LANE-2", "merge", NOW - HOUR), live_at: null, live_by: null, checked_at: NOW - 60_000, check_exit: 1, check_output: "503" }];
    const view = rolloutOf(specOf(), board({ "LANE-3": { state: "done" } }), marks, NOW)!;
    expect(stepOf(view, "LANE-1")).toMatchObject({ live: { at: NOW - 2 * DAY, by: "verify", evidence: "200 OK" }, soaked: true, soakedAt: NOW - DAY, liveConsumers: ["LANE-3"] });
    expect(stepOf(view, "LANE-2")).toMatchObject({ live: null, lastCheck: { at: NOW - 60_000, exitCode: 1, output: "503" } });
    expect(stepOf(view, "LANE-3")).toMatchObject({ soaked: true, liveConsumers: [] });
    expect(view.counts).toEqual({ steps: 6, live: 2, soaked: 2 });
  });
});

describe("the next safe step", () => {
  it("deploys the merged step of the earliest stage first, and names the others that can go", () => {
    expect(rolloutOf(specOf(), board(), [], NOW)!.next).toEqual({
      kind: "deploy",
      keys: ["LANE-1", "LANE-2"],
      stage: "expand",
      until: null,
      text: "Deploy LANE-1 (Shipit deploys main). 2 steps wait on it. LANE-2 can go now too.",
    });
  });

  it("says to merge a pull request, and whether its merge deploys it", () => {
    const open = rolloutOf(specOf(), board({ "LANE-1": { state: "pr_open" } }), [], NOW)!.next;
    expect(open.text).toBe("Merge LANE-1 (#1), then deploy it (Shipit deploys main). 2 steps wait on it. LANE-2 can go now too.");
    const edge = rolloutOf(specOf(), board(), [live("LANE-1", "verify", NOW - 2 * DAY)], NOW)!.next;
    expect(edge).toMatchObject({ kind: "merge", keys: ["LANE-2"], text: "Merge LANE-2 (#2): it deploys when it merges (The actuator applies on merge). 1 step waits on it." });
  });

  it("waits for the stage before to soak", () => {
    const marks = [live("LANE-1", "verify", NOW - 2 * HOUR), live("LANE-2", "merge", NOW - HOUR)];
    expect(rolloutOf(specOf(), board({ "LANE-2": { state: "done" } }), marks, NOW)!.next).toEqual({
      kind: "soak",
      keys: ["LANE-3", "LANE-4"],
      stage: "expand",
      until: NOW + 23 * HOUR,
      text: "Wait for the expand stage to soak until Jan 11 11:00 UTC.",
    });
    expect(rolloutOf(specOf(), board({ "LANE-2": { state: "done" }, "LANE-3": { state: "done" } }), marks, NOW + 2 * DAY)!.next.text).toBe("Deploy LANE-3 (Shipit, canary first). LANE-4 can go now too.");
  });

  it("waits for a milestone that gates the stage, then goes on to the steps with no stage, then says everything is live", () => {
    const early = [live("LANE-1", "verify", NOW - 3 * DAY), live("LANE-2", "merge", NOW - 3 * DAY), live("LANE-3", "human", NOW - DAY), live("LANE-4", "human", NOW - DAY)];
    const done = board({ "LANE-2": { state: "done" }, "LANE-3": { state: "done" }, "LANE-4": { state: "done" } });
    expect(rolloutOf(specOf(), done, early, NOW)!.next).toMatchObject({ kind: "milestone", keys: ["old-traffic-zero"], text: "Wait for old-traffic-zero (Old path traffic near zero) to hold; 1 step needs it." });
    const held = [...early, live("old-traffic-zero", "check", NOW - HOUR)];
    expect(rolloutOf(specOf(), done, held, NOW)!.next).toMatchObject({ kind: "pr", keys: ["LANE-5"], text: "LANE-5 is next; its pull request is not open yet." });
    const contract = [...held, live("LANE-5", "human", NOW)];
    expect(rolloutOf(specOf(), done, contract, NOW)!.next).toMatchObject({ kind: "pr", keys: ["LANE-6"], stage: null });
    expect(rolloutOf(specOf(), done, [...contract, live("LANE-6", "human", NOW)], NOW)!.next).toEqual({ kind: "done", keys: [], stage: null, until: null, text: "Everything is live." });
  });
});

describe("rollout warnings", () => {
  const warningsOf = (rows: TicketRow[], marks: RolloutMarkRow[] = [], edit?: (doc: Doc) => void, now = NOW) => rolloutOf(specOf(edit), rows, marks, now)!.warnings;

  it("warns when a deploy-on-merge pull request or a merged step would reach traffic before what it requires", () => {
    const rows = board({ "LANE-2": { rollout: { stage: "expand", requires_live: ["LANE-1"] } }, "LANE-3": { state: "done" } });
    expect(warningsOf(rows)).toEqual([
      { kind: "ships_on_merge", tone: "warning", keys: ["LANE-2"], text: "LANE-2 deploys when it merges, and LANE-1 is not live yet." },
      { kind: "deploy_early", tone: "warning", keys: ["LANE-3"], text: "LANE-3 merged; deploy it only after LANE-1 is live." },
      { kind: "soak", tone: "warning", keys: ["LANE-3"], text: "LANE-3 is in the migrate stage, and the expand stage is not all live yet." },
    ]);
  });

  it("warns about a merged step whose stage before has not soaked, and an open one that needs a milestone that does not hold", () => {
    const marks = [live("LANE-1", "verify", NOW - 2 * HOUR), live("LANE-2", "merge", NOW - HOUR)];
    const rows = board({ "LANE-2": { state: "done" }, "LANE-3": { state: "done" }, "LANE-5": { state: "pr_open" } });
    expect(warningsOf(rows, marks)).toEqual([
      { kind: "soak", tone: "warning", keys: ["LANE-3"], text: "LANE-3 is in the migrate stage, and the expand stage soaks until Jan 11 11:00 UTC." },
      { kind: "milestone", tone: "info", keys: ["LANE-5"], text: "LANE-5 needs old-traffic-zero to hold before it deploys, and it does not yet." },
    ]);
  });

  it("warns about a deploy-on-merge pull request inside a window, or with one starting within 14 days", () => {
    const windows = (doc: Doc) => {
      doc.rollout.window = [
        { title: "Holiday freeze", from: "2026-01-09", to: "2026-01-12" },
        { title: "Launch freeze", from: "2026-01-20", to: "2026-01-25" },
        { title: "Summer freeze", from: "2026-07-01", to: "2026-07-05" },
      ];
    };
    const view = rolloutOf(specOf(windows), board(), [], NOW)!;
    expect(view.windows.map((window) => [window.title, window.active, window.startsIn, window.past])).toEqual([
      ["Holiday freeze", true, null, false],
      ["Launch freeze", false, 10, false],
      ["Summer freeze", false, 172, false],
    ]);
    expect(view.warnings).toEqual([
      { kind: "window", tone: "warning", keys: ["LANE-2"], text: "LANE-2 deploys on merge, and the Holiday freeze is on until Jan 12." },
      { kind: "window", tone: "info", keys: ["LANE-2"], text: "LANE-2 deploys on merge and has 10 days before the Launch freeze (Jan 20 to Jan 25)." },
    ]);
  });

  it("does not count a cancelled requirement against a step", () => {
    const rows = board({ "LANE-3": { state: "done", rollout: { stage: "migrate", requires_live: ["LANE-7"] } } });
    expect(stepOf(rolloutOf(specOf(), rows, [], NOW)!, "LANE-3").requires).toEqual([expect.objectContaining({ target: "LANE-7", cancelled: true })]);
    expect(warningsOf(rows).filter((warning) => warning.kind === "deploy_early")).toEqual([]);
  });
});

describe("the pull request's Rollout section", () => {
  it("says the stage, what must be live first with its pull request and how it deploys, and how this change deploys", () => {
    const rows = board();
    const lane4 = rows.find((ticket) => ticket.key === "LANE-4")!;
    expect(rolloutSection(specOf(), rows, lane4, [live("LANE-1", "verify", NOW - HOUR)], NOW)).toEqual([
      "## Rollout",
      "",
      "Stage: migrate (2 of 3): Callers send it.",
      "Live first:",
      "- LANE-1 LANE-1 title (https://github.com/acme/core/pull/1). It deploys: Shipit deploys main. It is live.",
      "- LANE-2 LANE-2 title (https://github.com/acme/core/pull/2). It deploys: The actuator applies on merge. It is not live yet.",
      "Deploys: Shipit deploys main. Merging does not deploy it.",
      "Release: wave-1, with LANE-3.",
      "Dark: it ships with its gate off.",
      "",
      "Loom tracks this order on the project's Rollout tab. It is advice: Loom holds no merge or deploy for it.",
    ]);
  });

  it("names a milestone that gates the stage, a deploy on merge, verify and rollback", () => {
    const rows = board({ "LANE-2": { rollout: { stage: "expand", verify: "dig +short edge.example.com", rollback: "Revert; the actuator applies the revert" } } });
    const section = (key: string) => rolloutSection(specOf(), rows, rows.find((ticket) => ticket.key === key)!, [], NOW);
    expect(section("LANE-5").slice(3, 5)).toEqual(["Live first:", "- old-traffic-zero: Old path traffic near zero. It gates this stage. It does not hold yet."]);
    expect(section("LANE-2").slice(2, 7)).toEqual([
      "Stage: expand (1 of 3): Servers accept the header.",
      "Live first: nothing.",
      "Deploys on merge: The actuator applies on merge.",
      "Verify: `dig +short edge.example.com`",
      "Rollback: Revert; the actuator applies the revert.",
    ]);
  });

  it("is there for a ticket outside the stages of a staged project, and not for a ticket of a project with neither", () => {
    const staged = parseSpec(specToml((doc) => ((doc.merge = { strategy: "pr" }), (doc.rollout = { stage: [{ name: "expand", goal: "Live" }] })))).spec!;
    const plain = row("CSV-1", "pr_open", { repo: null });
    expect(rolloutSection(staged, [plain], plain, [], NOW).slice(2, 3)).toEqual(["This change is in no rollout stage. Loom follows the project's deploy order on its Rollout tab."]);
    expect(rolloutSection(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr" }))).spec!, [plain], plain, [], NOW)).toEqual([]);
  });
});

describe("the Rollout tab's reading of the order", () => {
  const statuses = (view: RolloutView, now = NOW) => Object.fromEntries(view.stages.flatMap((stage) => stage.steps).map((step) => [step.key, [stepStatus(view, step, now).kind, stepStatus(view, step, now).label, stepStatus(view, step, now).why]]));

  it("gives each step one status: what to do next, what it waits for, or that it is live", () => {
    expect(statuses(rolloutOf(specOf(), board(), [], NOW)!)).toEqual({
      "LANE-1": ["deploy", "Deploy now", null],
      "LANE-2": ["merge", "Merge now", "merging deploys it"],
      "LANE-3": ["waiting", "Waiting", "for LANE-1"],
      "LANE-4": ["no_pr", "No pull request yet", "then waits for LANE-1 and LANE-2"],
      "LANE-5": ["no_pr", "No pull request yet", "then waits for old-traffic-zero"],
      "LANE-6": ["no_pr", "No pull request yet", null],
    });
    const marks = [live("LANE-1", "verify", NOW - 2 * HOUR)];
    expect(statuses(rolloutOf(specOf(), board(), marks, NOW)!)).toMatchObject({ "LANE-1": ["soaking", "Live", "soaking"], "LANE-3": ["ready_after", "Ready after expand", null] });
    expect(statuses(rolloutOf(specOf(), board(), [live("LANE-1", "verify", NOW - 2 * DAY)], NOW)!)["LANE-1"]).toEqual(["live", "Live", null]);
  });

  it("says not to merge a deploy-on-merge step, or deploy a merged one, before what it needs; and names a blocked one", () => {
    const early = rolloutOf(specOf(), board({ "LANE-2": { rollout: { stage: "expand", requires_live: ["LANE-1"] } }, "LANE-3": { state: "done" } }), [], NOW)!;
    expect(statuses(early)).toMatchObject({ "LANE-2": ["merge_early", "Don't merge yet", "merging deploys it; needs LANE-1"], "LANE-3": ["deploy_early", "Don't deploy yet", "needs LANE-1"] });
    const after = rolloutOf(specOf(), board({ "LANE-3": { state: "done" } }), [live("LANE-1", "verify", NOW - HOUR)], NOW)!;
    expect(statuses(after)["LANE-3"]).toEqual(["deploy_after", "Deploy after expand", null]);
    expect(statuses(rolloutOf(specOf(), board({ "LANE-3": { state: "blocked" } }), [], NOW)!)["LANE-3"]).toEqual(["blocked", "Blocked", "its ticket is blocked"]);
  });

  it("lays each stage out in layers, with a milestone in the stage that first needs it and one that gates a stage atop it", () => {
    const edit = (doc: Doc) => doc.rollout.milestone.push({ ref: "cache-warm", title: "The cache is warm" }, { ref: "unused", title: "Nobody needs it" });
    const rows = board({ "LANE-3": { rollout: { stage: "migrate", requires_live: ["LANE-1", "cache-warm"] } }, "LANE-4": { rollout: { stage: "migrate", requires_live: ["LANE-3"] } } });
    const { columns, others } = columnsOf(rolloutOf(specOf(edit), rows, [], NOW)!);
    const keys = (layer: Array<{ step: { key: string } } | { milestone: { ref: string } }>) => layer.map((item) => ("step" in item ? item.step.key : item.milestone.ref));
    expect(columns.map((column) => [column.stage.name, column.gates.map((gate) => gate.ref), column.layers.map(keys)])).toEqual([
      ["expand", [], [["LANE-1", "LANE-2"]]],
      ["migrate", [], [["cache-warm"], ["LANE-3"], ["LANE-4"]]],
      ["contract", ["old-traffic-zero"], [["LANE-5"]]],
      [null, [], [["LANE-6"]]],
    ]);
    expect(others.map((milestone) => milestone.ref)).toEqual(["unused"]);
  });

  it("groups the warnings by step, with what each waits for", () => {
    const view = rolloutOf(specOf(), board({ "LANE-2": { rollout: { stage: "expand", requires_live: ["LANE-1"] } }, "LANE-3": { state: "done" } }), [], NOW)!;
    expect(holdsOf(view).map((hold) => [hold.step.key, hold.kind, hold.tone, hold.needs.map((need) => need.target), hold.stage?.name ?? null])).toEqual([
      ["LANE-2", "dont_merge", "hold", ["LANE-1"], null],
      ["LANE-3", "dont_deploy", "hold", ["LANE-1"], "expand"],
    ]);
    const windows = (doc: Doc) => {
      doc.rollout.window = [
        { title: "Holiday freeze", from: "2026-01-09", to: "2026-01-12" },
        { title: "Launch freeze", from: "2026-01-20", to: "2026-01-25" },
        { title: "Summer freeze", from: "2026-07-01", to: "2026-07-05" },
      ];
    };
    const calendar = holdsOf(rolloutOf(specOf(windows), board(), [], NOW)!);
    expect(calendar.map((hold) => [hold.step.key, hold.kind, hold.windows.map((window) => window.title)])).toEqual([["LANE-2", "calendar", ["Holiday freeze", "Launch freeze"]]]);
  });

  it("finds the earliest each stage could be done, and stops at a milestone that does not hold", () => {
    const view = rolloutOf(specOf(), board(), [live("LANE-1", "verify", NOW - 2 * HOUR)], NOW)!;
    expect(earliestOf(view, NOW).map((each) => [each.stage.name, each.at, each.waitsFor])).toEqual([
      ["expand", NOW + DAY, []],
      ["migrate", NOW + DAY, []],
      ["contract", null, ["old-traffic-zero"]],
    ]);
    const warm = (doc: Doc) => doc.rollout.milestone.push({ ref: "cache-warm", title: "The cache is warm" });
    const waiting = rolloutOf(specOf(warm), board({ "LANE-3": { rollout: { stage: "migrate", requires_live: ["LANE-1", "cache-warm"] } } }), [], NOW)!;
    expect(earliestOf(waiting, NOW).map((each) => [each.stage.name, each.at, each.waitsFor])).toEqual([
      ["expand", NOW + DAY, []],
      ["migrate", null, ["cache-warm"]],
      ["contract", null, ["cache-warm", "old-traffic-zero"]],
    ]);
  });

  it("keeps the time of a stage that is all live, even when a gate it had stopped holding, and goes on to the next", () => {
    const gateExpand = (doc: Doc) => (doc.rollout.milestone[0].stage = "expand");
    const marks = [live("LANE-1", "verify", NOW - 3 * DAY), live("LANE-2", "merge", NOW - 3 * DAY)];
    const view = rolloutOf(specOf(gateExpand), board(), marks, NOW)!;
    expect(view.next).toMatchObject({ kind: "merge", keys: ["LANE-3", "LANE-4"] });
    expect(earliestOf(view, NOW).map((each) => [each.stage.name, each.at, each.waitsFor])).toEqual([
      ["expand", NOW - 2 * DAY, []],
      ["migrate", NOW, []],
      ["contract", NOW, []],
    ]);
  });

  it("finds a milestone a step waits for through a step with no stage", () => {
    const warm = (doc: Doc) => doc.rollout.milestone.push({ ref: "cache-warm", title: "The cache is warm" });
    const rows = board({ "LANE-3": { rollout: { stage: "migrate", requires_live: ["LANE-6"] } }, "LANE-6": { rollout: { requires_live: ["cache-warm"] } } });
    const view = rolloutOf(specOf(warm), rows, [], NOW)!;
    expect(milestoneBlockers(view, view.stages[1]!.steps.find((step) => step.key === "LANE-3")!)).toEqual(["cache-warm"]);
    expect(earliestOf(view, NOW).map((each) => [each.stage.name, each.waitsFor])).toEqual([
      ["expand", []],
      ["migrate", ["cache-warm"]],
      ["contract", ["cache-warm", "old-traffic-zero"]],
    ]);
  });

  it("puts a milestone that gates a stage with no steps beside the earliest step that needs it", () => {
    const empty = (doc: Doc) => {
      doc.rollout.stage.splice(1, 0, { name: "warmup", goal: "Caches fill" });
      doc.rollout.milestone.push({ ref: "warm", title: "Caches are warm", stage: "warmup" });
    };
    const view = rolloutOf(specOf(empty), board({ "LANE-3": { rollout: { stage: "migrate", requires_live: ["LANE-1", "warm"] } } }), [], NOW)!;
    const { columns, others } = columnsOf(view);
    expect(columns.find((column) => column.stage.name === "migrate")!.layers.map((layer) => layer.map((item) => ("milestone" in item ? item.milestone.ref : item.step.key)))).toEqual([["warm", "LANE-4"], ["LANE-3"]]);
    expect(others).toEqual([]);
  });

  it("orders windows by what is on now, then what starts first, and calls only a pull request the merge order calls ready ready", () => {
    const window = (title: string, active: boolean, startsIn: number | null) => ({ title, from: "2026-01-01", to: "2026-01-02", note: null, active, startsIn, past: false });
    expect(byUrgency([window("later", false, 20), window("now", true, null), window("soon", false, 3)]).map((each) => each.title)).toEqual(["now", "soon", "later"]);
    expect(readyToMerge({ verdict: "ready" } as MergeEntry)).toBe(true);
    expect(readyToMerge({ verdict: "first", review: "APPROVED", draft: true } as MergeEntry)).toBe(false);
    expect(readyToMerge(undefined)).toBe(false);
  });

  it("names what a step needs and what waits on it, through any chain", () => {
    const view = rolloutOf(specOf(), board(), [], NOW)!;
    expect(chainOf(view, "LANE-4")).toEqual({ up: new Set(["LANE-1", "LANE-2"]), down: new Set() });
    expect(chainOf(view, "LANE-1")).toEqual({ up: new Set(), down: new Set(["LANE-3", "LANE-4"]) });
  });

  it("reads a milestone's state, a command short, each repo's deploy and a pull request's review in a few words", () => {
    const view = rolloutOf(specOf(), board(), [], NOW)!;
    expect(milestoneStatus(view.milestones[0]!)).toEqual({ kind: "waiting", tone: "wait", label: "Not checked yet", why: "Loom runs its check every 15 minutes" });
    expect(milestoneStatus({ ...view.milestones[0]!, lastCheck: { at: NOW, exitCode: 1, output: "" } })).toMatchObject({ tone: "hold", label: "Does not hold", why: "its check exited 1" });
    expect(shortCommand("/bin/bash /Users/kim/.local/share/forge/check.sh gate staging")).toBe("check.sh gate staging");
    expect(shortCommand("./scripts/zero.sh --prod")).toBe("zero.sh --prod");
    expect(shortCommand("curl -f https://core.example.com/health")).toBe("curl -f https://core.example.com/health");
    expect(repoDeploys(view)).toEqual([
      { repo: "core", how: "Shipit deploys main", onMerge: false },
      { repo: "edge", how: "The actuator applies on merge", onMerge: true },
    ]);
    const entry = { prOpen: true, reviewRead: true, draft: true, review: "REVIEW_REQUIRED", conflicts: false, base: "main", checks: { passed: 20, failed: 1, pending: 0 } } as MergeEntry;
    expect(pullRequestNote(entry)).toEqual({ text: "draft · needs review · ✗ 1 failing · ✓ 20 checks", tone: "hold" });
    expect(pullRequestNote({ ...entry, prOpen: false })).toBeNull();
  });
});
