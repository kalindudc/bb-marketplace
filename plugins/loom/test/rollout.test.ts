import { describe, expect, it } from "vitest";
import type { LiveBy, RolloutMarkRow, TicketRow } from "../src/db/store";
import type { PrMeta } from "../src/pr-meta";
import { rolloutOf, rolloutSection, type RolloutView, type TicketRollout } from "../src/rollout";
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
