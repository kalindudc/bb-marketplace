import { beforeEach, describe, expect, it } from "vitest";
import { SpawnRefusedError, SpawnUnavailableError, type SpawnArgs } from "../src/ports";
import { SPEC_REVIEW_RUBRIC } from "../src/prompts";
import {
  approvalRefusal,
  endSpecReviews,
  ensureSpecReview,
  onSpecReviewerGone,
  onSpecReviewerIdle,
  onSpecReviewerTurnFailed,
  reconcileSpecReviews,
  retrySpecReviews,
  specReviewerOf,
  specReviewStatus,
  specVerdict,
  type SpecFinding,
} from "../src/spec-review";
import { SPEC_REVIEW_ROUNDS } from "../src/states";
import { MAX_RATE_LIMIT_RETRIES, type TurnFailure } from "../src/workers";
import { GIT_WORKTREE_PROVIDER, makeCtx, specToml, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const status = () => specReviewStatus(h.store, project());
const propose = (edit?: (doc: Doc) => void) => h.projects.propose({ toml: specToml(edit), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
const draft = async (edit?: (doc: Doc) => void) => {
  await propose(edit);
  return ensureSpecReview(h.ctx, "csv");
};
const spawns = () => h.bb.callsTo("spawnThread").map(([args]) => args as SpawnArgs);
const rows = () => h.store.specReviews(project().id);
const reviewer = () => rows().at(-1)!.thread_id!;
const findings = (n: number): SpecFinding[] => Array.from({ length: n }, (_, index) => ({ path: "ticket[csv-model]", title: `Problem ${index + 1}`, detail: `Detail ${index + 1}` }));
const toPlanner = () => h.bb.sent("thr_plan");
const goal = (n: number) => (doc: Doc) => (doc.project.goal = `Let people export their orders as a CSV file, revision ${n}.`);

describe("starting a spec review", () => {
  it("starts one reviewer for a fresh draft on the reviewer's model, with the brief, and none for the same spec again", async () => {
    expect(await draft()).toEqual({ kind: "reviewing", version: 1, round: 1 });
    expect(spawns()).toHaveLength(1);
    const args = spawns()[0]!;
    expect(args).toMatchObject({
      bbProjectId: "proj_1",
      hostId: "host_1",
      baseBranch: "origin/main",
      title: "CSV · spec review v1",
      sectionId: project().section_id,
      providerId: "codex",
      model: "gpt",
      metadata: { project: "csv", role: "spec-review", version: "1" },
    });
    expect(args.prompt).toContain("bb thread log thr_plan --format minimal --all");
    expect(args.prompt).toContain("Ask User Question");
    for (const line of SPEC_REVIEW_RUBRIC) expect(args.prompt).toContain(line);
    expect(args.prompt).toMatch(/project\.done_when item to the tickets whose acceptance criteria make it true/);
    expect(args.prompt).toMatch(/documenting why the goal cannot be met/);
    expect(args.prompt).toContain('slug = "csv"');
    expect(args.prompt).toContain("loom_spec_request_changes");
    expect(rows()[0]).toMatchObject({ thread_id: "thr_w1", state: "reviewing", version: 1, round: 1 });

    expect(await draft()).toEqual({ kind: "reviewing", version: 1, round: 1 });
    expect(spawns()).toHaveLength(1);
    expect(approvalRefusal("csv", status())?.message).toBe("Draft v1 of csv is still in its spec review (round 1 of 3).");
    expect(approvalRefusal("csv", status())?.hint).toContain("bb loom approve csv --skip-review");
  });

  it("starts a multi-repo project's reviewer in its first repo, from that repo's remote base", async () => {
    h.bb.addBbProject("proj_api", { host_1: "/src/api" });
    await draft((doc) => {
      doc.repo = [{ name: "api", project: "proj_api", base: "trunk", remote: "upstream" }];
      for (const ticket of doc.ticket) ticket.repo = "api";
    });
    expect(spawns()[0]).toMatchObject({ bbProjectId: "proj_api", baseBranch: "upstream/trunk" });
  });

  it("ends the review as failed when bb refuses the reviewer, without a message: the tool reply tells the planner", async () => {
    h.bb.spawnError = () => new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.");
    expect(await draft()).toEqual({ kind: "failed", version: 1, round: 1, reason: "bb could not start the reviewer: HTTP 400: Provider pi only supports full permission mode." });
    expect(toPlanner()).toEqual([]);
    h.bb.spawnError = null;
    expect(await draft()).toEqual({ kind: "reviewing", version: 1, round: 1 });
  });

  it("waits when the reviewer cannot start, tries again from the tick, and fails only after four failures in a row", async () => {
    h.bb.spawnError = () => new Error("bb is restarting");
    expect(await draft()).toEqual({ kind: "reviewing", version: 1, round: 1, waiting: { reason: "bb is restarting", until: h.clock.t + 60_000 } });
    expect(approvalRefusal("csv", status())?.message).toBe("Draft v1 of csv is still in its spec review (round 1 of 3): its reviewer could not start (bb is restarting), and Loom tries again.");
    await retrySpecReviews(h.ctx);
    expect(spawns()).toHaveLength(1);
    // A restart keeps a review that waits.
    await reconcileSpecReviews(h.ctx);
    expect(rows()[0]).toMatchObject({ state: "reviewing", thread_id: null });

    for (let n = 0; n < 3; n++) {
      h.clock.advance(15 * 60_000);
      await retrySpecReviews(h.ctx);
    }
    expect(spawns()).toHaveLength(4);
    expect(status()).toMatchObject({ kind: "failed", reason: "bb could not start the reviewer: bb is restarting" });
    expect(toPlanner().join("\n")).toContain("bb could not start the reviewer: bb is restarting");
  });

  it("starts the same review once the provider is available again, and fails it if the provider stays unavailable for an hour", async () => {
    h.bb.spawnError = () => new SpawnUnavailableError("No free slot.");
    await draft();
    for (let n = 0; n < 3; n++) {
      h.clock.advance(15 * 60_000);
      await retrySpecReviews(h.ctx);
    }
    expect(status()).toMatchObject({ kind: "reviewing", waiting: { reason: "No free slot." } });
    h.bb.spawnError = null;
    h.clock.advance(15 * 60_000);
    await retrySpecReviews(h.ctx);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ state: "reviewing", thread_id: "thr_w1" });
    await onSpecReviewerIdle(h.ctx, rows()[0]!);
    expect(status()).toEqual({ kind: "reviewing", version: 1, round: 1 });

    h = makeCtx();
    h.bb.spawnError = () => new SpawnUnavailableError("No free slot.");
    await draft();
    for (let n = 0; n < 4; n++) {
      h.clock.advance(15 * 60_000);
      await retrySpecReviews(h.ctx);
    }
    expect(status()).toMatchObject({ kind: "failed", reason: "bb could not start the reviewer: the environment provider was unavailable for 1h: No free slot." });
    expect(toPlanner().join("\n")).toContain("the environment provider was unavailable for 1h");
  });

  it("treats a reviewer whose environment could not be provisioned as one that did not start", async () => {
    await draft();
    h.bb.systemErrors.set("thr_w1", { code: "thread_provisioning_failed", message: "Provisioning thread failed", detail: "No free slot." });
    await onSpecReviewerTurnFailed(h.ctx, rows()[0]!, { threadId: "thr_w1", requestId: "req_1", attemptNumber: 1, errorInfo: null, rateLimits: null });
    expect(rows()[0]).toMatchObject({ state: "reviewing", thread_id: null });
    expect(status()).toMatchObject({ kind: "reviewing", waiting: { reason: "No free slot." } });
    expect(h.bb.sent("thr_w1")).toEqual([]);
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
  });

  it("has nothing to wait for on a draft with no review", async () => {
    await propose();
    expect(status()).toEqual({ kind: "none" });
    expect(approvalRefusal("csv", status())).toBeNull();
  });
});

describe("ending reviews", () => {
  it("ends the reviews up to the version approved, and keeps a newer version's review", async () => {
    await draft();
    const id = project().id;
    const newer = h.store.addSpecReview({ project_id: id, version: 2, round: 1, spawn_token: "newer" });
    await endSpecReviews(h.ctx, id, 1);
    expect(rows().map((row) => [row.version, row.state])).toEqual([
      [1, "superseded"],
      [2, "reviewing"],
    ]);
    await endSpecReviews(h.ctx, id);
    expect(h.store.specReview(newer.id)!.state).toBe("superseded");
  });
});

describe("reviewing a pending version", () => {
  const approveDraft = async () => {
    await draft();
    await specVerdict(h.ctx, reviewer(), findings(1), "Too much.");
    await draft(goal(2));
    await specVerdict(h.ctx, reviewer(), [], "Holds.");
    await h.projects.approve("csv", "human");
  };

  it("reviews a version proposed after approval as a change to the version in force, counting its rounds from 1", async () => {
    await approveDraft();
    await propose(goal(3));
    expect(await ensureSpecReview(h.ctx, "csv")).toEqual({ kind: "reviewing", version: 3, round: 1 });
    expect(status()).toEqual({ kind: "reviewing", version: 3, round: 1 });
    const brief = spawns().at(-1)!.prompt;
    expect(brief).toContain("## A change to an approved project");
    expect(brief).toContain("The human approved v2 and the project is ready");
    expect(brief).toContain("- project.goal: rewritten");
    expect(brief).not.toContain("## Earlier rounds");
    expect(approvalRefusal("csv", status(), true)?.message).toBe("Pending v3 of csv is still in its spec review (round 1 of 3).");
    expect(approvalRefusal("csv", status(), true)?.hint).toContain("bb loom approve csv --version 3 --skip-review");
  });

  it("tells the planner a passed pending version waits for the human, with loom_ask_human for what follows", async () => {
    await approveDraft();
    await propose(goal(3));
    await ensureSpecReview(h.ctx, "csv");
    await specVerdict(h.ctx, reviewer(), [], "The change is the smallest fix.");
    expect(status()).toEqual({ kind: "approved", version: 3, round: 1, summary: "The change is the smallest fix." });
    expect(toPlanner().at(-1)).toContain("tell them what v3 changes and that it waits for their approval");
    expect(toPlanner().at(-1)).toContain("loom_ask_human");
  });

  it("has nothing to wait for on a pending version from before spec reviews, and none once it is approved", async () => {
    await propose();
    await h.projects.approve("csv", "human");
    await propose(goal(2));
    expect(status()).toEqual({ kind: "none" });
    await h.projects.approve("csv", "human");
    expect(status()).toEqual({ kind: "none" });
  });
});

describe("versions that change only operational settings", () => {
  const forge = (doc: Doc) => {
    doc.merge = { strategy: "pr", forge: { kind: "command", open: "open.sh", state: "state.sh", feedback: "feedback-2.sh" } };
  };
  const onPr = (doc: Doc) => (doc.merge = { strategy: "pr", forge: { kind: "command", open: "open.sh", state: "state.sh", feedback: "feedback.sh" } });
  const approveDraft = async () => {
    await draft(onPr);
    await specVerdict(h.ctx, reviewer(), [], "Holds.");
    await h.projects.approve("csv", "human");
  };

  it("skips the review of a pending version that changes only operational settings against the version in force, and approval needs no --skip-review", async () => {
    await approveDraft();
    await propose((doc) => {
      forge(doc);
      doc.agents.max_workers = 4;
    });
    const skipped = await ensureSpecReview(h.ctx, "csv");
    expect(skipped).toEqual({ kind: "skipped", version: 2, against: 1, paths: ["merge.forge.feedback", "agents.max_workers"] });
    expect(status()).toEqual(skipped);
    expect(spawns()).toHaveLength(1);
    expect(rows().at(-1)).toMatchObject({ version: 2, state: "skipped", thread_id: null, summary: "v2 changes only operational settings against v1: merge.forge.feedback, agents.max_workers.", skip_json: JSON.stringify({ against: 1, paths: ["merge.forge.feedback", "agents.max_workers"] }) });
    expect(approvalRefusal("csv", status(), true)).toBeNull();
    const text = toPlanner().at(-1)!;
    expect(text).toContain("[loom] Loom skipped the spec review of v2 of csv: against v1, it changes only operational settings (merge.forge.feedback, agents.max_workers).");
    expect(text).toContain("Hand over to the human now: tell them what v2 changes and that it waits for their approval.");
    const event = h.store.eventsOfKind(project().id, "spec.review.skipped").at(-1)!;
    expect(JSON.parse(event.data_json)).toEqual({ version: 2, round: 1, against: 1, paths: ["merge.forge.feedback", "agents.max_workers"] });

    expect(await ensureSpecReview(h.ctx, "csv")).toEqual(skipped);
    expect(toPlanner().filter((message) => message.includes("skipped the spec review"))).toHaveLength(1);
  });

  it("reviews a pending version that changes anything else, or that only revises a skipped one into content", async () => {
    await approveDraft();
    await propose((doc) => {
      forge(doc);
      goal(3)(doc);
    });
    expect(await ensureSpecReview(h.ctx, "csv")).toEqual({ kind: "reviewing", version: 2, round: 1 });
    await propose(forge);
    expect(await ensureSpecReview(h.ctx, "csv")).toMatchObject({ kind: "skipped", version: 3, against: 1 });
    expect(rows().find((row) => row.version === 2)!.state).toBe("superseded");
  });

  it("skips a draft's review only after the draft before it cleared its own, and never the first version", async () => {
    expect(await draft(onPr)).toEqual({ kind: "reviewing", version: 1, round: 1 });
    expect(await draft(forge)).toEqual({ kind: "reviewing", version: 2, round: 1 });
    await specVerdict(h.ctx, reviewer(), findings(1), "Too much.");
    expect(await draft(onPr)).toEqual({ kind: "reviewing", version: 3, round: 2 });
    await specVerdict(h.ctx, reviewer(), [], "Holds.");
    expect(await draft(forge)).toMatchObject({ kind: "skipped", version: 4, against: 3, paths: ["merge.forge.feedback"] });
    expect(toPlanner().at(-1)).toContain("tell them what you proposed and that the draft is ready to approve");
    expect(await draft((doc) => {
      forge(doc);
      doc.budget = { max_tokens: 5_000_000 };
    })).toMatchObject({ kind: "skipped", version: 5, against: 4, paths: ["budget.max_tokens"] });
    expect(approvalRefusal("csv", status())).toBeNull();
  });
});

describe("verdicts", () => {
  it("records an approval, tells the planner to hand over, and unblocks approval", async () => {
    await draft();
    expect(await specVerdict(h.ctx, reviewer(), [], "Every ticket serves the request.")).toBe("Your verdict on spec v1 is recorded and goes to the planner. End your turn.");
    expect(status()).toEqual({ kind: "approved", version: 1, round: 1, summary: "Every ticket serves the request." });
    expect(approvalRefusal("csv", status())).toBeNull();
    expect(toPlanner().at(-1)).toContain("[loom] Spec review round 1 passed v1 of csv: Every ticket serves the request.");
    expect(toPlanner().at(-1)).toContain("Hand over to the human now");
    await expect(specVerdict(h.ctx, reviewer(), [], "again")).rejects.toThrow("This review is over");
  });

  it("sends findings to the planner, keeps approval blocked, and reviews the revision in the next round with the earlier findings", async () => {
    await draft();
    await specVerdict(h.ctx, reviewer(), findings(2), "More than the goal needs.");
    expect(status()).toMatchObject({ kind: "changes", version: 1, round: 1 });
    expect(approvalRefusal("csv", status())?.message).toBe("Draft v1 of csv has 2 open findings from round 1, and the planner is revising it.");
    const text = toPlanner().at(-1)!;
    expect(text).toContain("[loom] Spec review round 1 of 3 found 2 problems in v1 of csv: More than the goal needs.");
    expect(text).toContain("1. ticket[csv-model]: Problem 1\n   Detail 1");
    expect(text).toContain("Do not hand over yet");
    expect(text).not.toContain("last automatic round");

    expect(await draft()).toMatchObject({ kind: "changes", version: 1 });
    expect(spawns()).toHaveLength(1);
    expect(await draft(goal(2))).toEqual({ kind: "reviewing", version: 2, round: 2 });
    expect(spawns()[1]!.prompt).toContain("## Earlier rounds");
    expect(spawns()[1]!.prompt).toContain("Problem 2");
  });

  it("refuses a thread that is not a spec reviewer, an empty summary, and a verdict on a superseded review", async () => {
    await draft();
    await expect(specVerdict(h.ctx, "thr_plan", [], "ok")).rejects.toThrow("This tool is for Loom's spec reviewer");
    await expect(specVerdict(h.ctx, reviewer(), [], "  ")).rejects.toThrow("The summary is empty");
    const old = reviewer();
    expect(await draft(goal(2))).toEqual({ kind: "reviewing", version: 2, round: 1 });
    expect(rows()[0]!.state).toBe("superseded");
    expect(h.bb.callsTo("stop")).toContainEqual([old]);
    expect(h.bb.callsTo("archive")).toContainEqual([old]);
    await expect(specVerdict(h.ctx, old, [], "late")).rejects.toThrow("This review is over");
  });

  it(`stops reviewing after ${SPEC_REVIEW_ROUNDS} rounds with findings, and approval opens`, async () => {
    await draft();
    for (let round = 1; round <= SPEC_REVIEW_ROUNDS; round++) {
      if (round > 1) expect(await draft(goal(round))).toEqual({ kind: "reviewing", version: round, round });
      await specVerdict(h.ctx, reviewer(), findings(1), `Round ${round}.`);
    }
    expect(toPlanner().at(-1)).toContain("This was the last automatic round");
    expect(status()).toMatchObject({ kind: "limit", version: 3 });
    expect(approvalRefusal("csv", status())).toBeNull();
    expect(await draft(goal(4))).toMatchObject({ kind: "limit", version: 4 });
    expect(spawns()).toHaveLength(SPEC_REVIEW_ROUNDS);
  });
});

describe("the reviewer's thread", () => {
  it("nudges once, then fails the review and tells the planner; the same spec again starts a new reviewer in the same round", async () => {
    await draft();
    const first = () => rows()[0]!;
    await onSpecReviewerIdle(h.ctx, first());
    expect(h.bb.sent("thr_w1")).toEqual(["[loom] Your turn ended without a verdict on spec v1. Call loom_spec_approve({ summary }) or loom_spec_request_changes({ summary, findings }), then end your turn."]);
    await onSpecReviewerIdle(h.ctx, first());
    expect(first()).toMatchObject({ state: "failed", reason: "the reviewer ended its turn twice without a verdict" });
    expect(toPlanner().at(-1)).toContain("[loom] The spec review of v1 of csv did not finish: the reviewer ended its turn twice without a verdict.");
    expect(h.bb.callsTo("archive")).toContainEqual(["thr_w1"]);
    expect(status()).toMatchObject({ kind: "failed", version: 1, round: 1 });
    expect(approvalRefusal("csv", status())?.message).toBe("Draft v1 of csv was not reviewed: the reviewer ended its turn twice without a verdict.");
    expect(await draft()).toEqual({ kind: "reviewing", version: 1, round: 1 });
    expect(spawns()).toHaveLength(2);
  });

  it("archives the thread on its first idle after a verdict, with no nudge", async () => {
    await draft();
    await specVerdict(h.ctx, reviewer(), [], "Fits.");
    await onSpecReviewerIdle(h.ctx, rows()[0]!);
    expect(h.bb.callsTo("archive")).toContainEqual(["thr_w1"]);
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });

  it("fails the review when the human archives the reviewer's thread", async () => {
    await draft();
    await onSpecReviewerGone(h.ctx, rows()[0]!);
    expect(rows()[0]).toMatchObject({ state: "failed", reason: "the reviewer's thread was archived or deleted" });
    expect(toPlanner().at(-1)).toContain("did not finish: the reviewer's thread was archived or deleted.");
  });

  it("retries a rate-limited turn at the window's reset with no nudge, and counts a failure past the retries as an idle", async () => {
    await draft();
    const reset = h.clock.t + 60_000;
    const event = (attemptNumber: number): TurnFailure => ({ threadId: "thr_w1", requestId: "req_1", attemptNumber, errorInfo: { category: "rate-limit" }, rateLimits: { windows: [{ resetsAtMs: reset, status: "blocked" }] } });
    await onSpecReviewerTurnFailed(h.ctx, rows()[0]!, event(1));
    expect(h.bb.callsTo("retryTurn")).toEqual([["thr_w1", "req_1", reset + 15_000]]);
    expect(h.bb.sent("thr_w1")).toEqual([]);
    await onSpecReviewerTurnFailed(h.ctx, rows()[0]!, event(MAX_RATE_LIMIT_RETRIES + 1));
    expect(h.bb.callsTo("retryTurn")).toHaveLength(1);
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
    await onSpecReviewerTurnFailed(h.ctx, rows()[0]!, { ...event(1), errorInfo: { category: "provider" } });
    expect(rows()[0]!.state).toBe("failed");
  });

  it("supersedes a live review and ends its thread when the project is approved or archived", async () => {
    await draft();
    await endSpecReviews(h.ctx, project().id);
    expect(rows()[0]!.state).toBe("superseded");
    expect(h.bb.callsTo("archive")).toContainEqual(["thr_w1"]);
    expect(toPlanner()).toEqual([]);
  });
});

describe("binding and restarts", () => {
  it("finds a reviewer by its thread id, binds a late thread once by its spawn token, and ignores a forged token", async () => {
    await draft();
    expect(specReviewerOf(h.store, "thr_w1", {})?.id).toBe(rows()[0]!.id);
    const late = h.store.addSpecReview({ project_id: project().id, version: 1, round: 1, spawn_token: "tok_late" });
    expect(specReviewerOf(h.store, "thr_late", { spawnToken: "tok_late" })?.id).toBe(late.id);
    expect(h.store.specReview(late.id)!.thread_id).toBe("thr_late");
    expect(specReviewerOf(h.store, "thr_other", { spawnToken: "tok_late" })).toBeNull();
    expect(specReviewerOf(h.store, "thr_forged", { spawnToken: "forged", role: "spec-review" })).toBeNull();
  });

  it("on restart, nudges a reviewer whose thread went idle and fails one that never started", async () => {
    await draft();
    h.bb.threads.get("thr_w1")!.status = "idle";
    await reconcileSpecReviews(h.ctx);
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
    expect(rows()[0]!.idle_count).toBe(1);

    h.bb.threads.get("thr_w1")!.status = "active";
    const lost = h.store.addSpecReview({ project_id: project().id, version: 1, round: 1, spawn_token: "tok_lost" });
    await reconcileSpecReviews(h.ctx);
    expect(h.store.specReview(lost.id)).toMatchObject({ state: "failed", reason: "Loom restarted before the reviewer started" });
    expect(rows()[0]!.state).toBe("reviewing");
  });

  it("on restart, fails a review whose thread is gone", async () => {
    await draft();
    h.bb.threads.delete("thr_w1");
    await reconcileSpecReviews(h.ctx);
    expect(rows()[0]).toMatchObject({ state: "failed", reason: "the reviewer's thread was archived or deleted" });
  });
});

describe("the spec reviewer's environment", () => {
  it("starts in the spec's environment provider, on its own branch from the remote base, and in a managed worktree without one", async () => {
    h.bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, { ...GIT_WORKTREE_PROVIDER, id: "trees", pluginId: "trees", inputs: { type: "object" } }];
    h.bb.pluginList = [...h.bb.pluginList, { id: "trees", enabled: true, builtin: false }];
    await draft((doc) => (doc.environment = { provider: "trees", inputs: { branch: "{branch}", base: "{base}" } }));
    expect(spawns().at(-1)!.environment).toEqual({ providerId: "trees", inputs: { branch: "loom/csv/spec-review-1-1", base: "origin/main" } });
  });

  it("keeps the managed worktree without an environment", async () => {
    await draft();
    expect(spawns().at(-1)!.environment).toBeUndefined();
  });
});
