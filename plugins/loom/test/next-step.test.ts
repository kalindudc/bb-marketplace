import { describe, expect, it } from "vitest";
import type { BoardCard, ProjectSummary } from "../src/contract";
import { STAGES, nextStepOf, type NextStepInput } from "../src/next-step";
import { clockTime } from "../src/format";
import { PAUSE_NOW_REASON } from "../src/states";
import { card, overview } from "./fixtures";

const input = (over: Partial<ProjectSummary>, board: BoardCard[], rest: Partial<NextStepInput> = {}): NextStepInput => ({
  overview: overview(over),
  board,
  version: 1,
  maxWorkers: 2,
  triage: true,
  startFailed: [],
  reviewRefused: [],
  ...rest,
});
const queued = (key: string, ready: boolean) => card({ key, ready, ...(ready ? {} : { waitingOn: ["CSV-1"] }) });
const blocked = (key: string, reason: string | null) => card({ key, state: "blocked", ready: false, blockedReason: reason });
const refused = "bb refused to start a worker: HTTP 400: Provider pi only supports full permission mode.";
const reviewerRefused = "bb refused to start a reviewer: HTTP 400: Unsupported provider claude";

describe("nextStepOf", () => {
  it("has six stages", () => {
    expect(STAGES).toEqual(["Plan", "Review draft", "Approve", "Start", "Work", "Land"]);
  });

  it("shows nothing for an archived project", () => {
    expect(nextStepOf(input({ state: "archived" }, []))).toBeNull();
  });

  it("asks to review a draft, and approving it creates its tickets", () => {
    const step = nextStepOf(input({ state: "draft", approvedVersion: null }, [queued("CSV-1", true), queued("CSV-2", false)]))!;
    expect(step).toMatchObject({ stage: 1, tone: "normal", title: "Next: review draft v1." });
    expect(step.text).toBe("Read its tickets and checks, and ask the planner in its chat for any change, or approve it as it is. Approving creates 2 tickets on the board; nothing runs until you start.");
    expect(step.action).toEqual({ control: "approve", version: 1, label: "Approve v1 · create 2 tickets", confirm: "Click again to approve v1" });
  });

  it("waits in the Plan stage with no button while a draft's spec review runs, has findings or did not finish, and names the override", () => {
    const draft = (specReview: NextStepInput["specReview"]) => nextStepOf(input({ state: "draft", approvedVersion: null }, [queued("CSV-1", true)], { specReview }))!;
    expect(draft({ kind: "reviewing", version: 1, round: 1 })).toEqual({
      stage: 0,
      tone: "normal",
      title: "Loom is reviewing draft v1.",
      text: "A separate reviewer checks it against your request and for work the goal does not need. The planner revises it for each finding, and this bar asks you to approve once a review passes. To approve it now anyway, run `bb loom approve csv --skip-review`.",
      action: null,
    });
    expect(draft({ kind: "changes", version: 1, round: 2, findings: [{ title: "a", detail: "b" }, { title: "c", detail: "d" }] })).toMatchObject({
      stage: 0,
      title: "The spec review found 2 problems in v1.",
      text: "The planner is revising it (round 2 of 3 done). To approve it now anyway, run `bb loom approve csv --skip-review`.",
      action: null,
    });
    expect(draft({ kind: "failed", version: 1, round: 1, reason: "the reviewer's thread was archived or deleted" })).toMatchObject({
      stage: 0,
      tone: "warning",
      title: "The spec review of v1 did not finish.",
      text: "The reviewer's thread was archived or deleted. Ask the planner to propose again to restart it, or approve without a passed review with `bb loom approve csv --skip-review`.",
      action: null,
    });
  });

  it("asks to review a draft whose spec review passed or stopped, and says which", () => {
    const draft = (specReview: NextStepInput["specReview"]) => nextStepOf(input({ state: "draft", approvedVersion: null }, [queued("CSV-1", true)], { specReview }))!;
    const passed = draft({ kind: "approved", version: 1, round: 1, summary: "Fits." });
    expect(passed).toMatchObject({ stage: 1, title: "Next: review draft v1.", action: { control: "approve", version: 1 } });
    expect(passed.text.startsWith("Loom's spec review passed it. Read its tickets and checks")).toBe(true);
    expect(draft({ kind: "limit", version: 4, findings: [] }).text.startsWith("Loom stopped reviewing it after 3 rounds; the planner's chat lists the findings it left open. Read")).toBe(true);
    const skipped = draft({ kind: "skipped", version: 2, against: 1, paths: ["merge.forge.feedback"] });
    expect(skipped).toMatchObject({ stage: 1, title: "Next: review draft v1.", action: { control: "approve", version: 1 } });
    expect(skipped.text.startsWith("Loom skipped its spec review, because against v1 it changes only operational settings: merge.forge.feedback. Read")).toBe(true);
  });

  it("asks to approve a pending version, and names the tickets it requeues", () => {
    const board = [blocked("CSV-1", refused), blocked("CSV-2", refused), queued("CSV-3", false)];
    const step = nextStepOf(input({ state: "running", pendingVersion: 2 }, board, { startFailed: ["CSV-1", "CSV-2"] }))!;
    expect(step).toMatchObject({ stage: 4, tone: "normal", title: "Next: approve v2." });
    expect(step.text).toBe("The planner proposed spec v2; it changes the spec, not the tickets on the board. Approving queues CSV-1 and CSV-2 again, because bb never started their workers, and tells the planner.");
    expect(step.action).toEqual({ control: "approve", version: 2, label: "Approve v2 · requeue 2 tickets", confirm: "Click again to approve v2" });

    const both = nextStepOf(input({ state: "running", pendingVersion: 2 }, [blocked("CSV-1", refused), blocked("CSV-2", reviewerRefused)], { startFailed: ["CSV-1"], reviewRefused: ["CSV-2"] }))!;
    expect(both.text).toBe(
      "The planner proposed spec v2; it changes the spec, not the tickets on the board. Approving queues CSV-1 again, because bb never started its worker, sends CSV-2 back to review, because bb refused to start its reviewer, and tells the planner.",
    );
    expect(both.action).toMatchObject({ label: "Approve v2 · requeue 2 tickets" });
    const review = nextStepOf(input({ state: "running", pendingVersion: 2 }, [blocked("CSV-2", reviewerRefused)], { reviewRefused: ["CSV-2"] }))!;
    expect(review.text).toContain(" Approving sends CSV-2 back to review, because bb refused to start its reviewer, and tells the planner.");
    expect(review.action).toMatchObject({ label: "Approve v2 · requeue 1 ticket" });

    const plain = nextStepOf(input({ state: "ready", pendingVersion: 2 }, [queued("CSV-1", true)]))!;
    expect(plain).toMatchObject({ stage: 3, text: "The planner proposed spec v2; it changes the spec, not the tickets on the board. Approving tells the planner." });
    expect(plain.action).toMatchObject({ label: "Approve v2" });
    expect(nextStepOf(input({ state: "paused", pendingVersion: 2 }, []))!.stage).toBe(4);
    expect(nextStepOf(input({ state: "done", pendingVersion: 2 }, []))!.stage).toBe(STAGES.length);
  });

  it("waits for a pending version's spec review with no button, in the project's stage, and notes a passed review", () => {
    const pending = (specReview: NextStepInput["specReview"]) => nextStepOf(input({ state: "running", pendingVersion: 2 }, [], { specReview }))!;
    const reviewing = pending({ kind: "reviewing", version: 2, round: 1 });
    expect(reviewing).toMatchObject({ stage: 4, title: "Loom is reviewing v2.", action: null });
    expect(reviewing.text).toContain("bb loom approve csv --version 2 --skip-review");
    expect(pending({ kind: "changes", version: 2, round: 1, findings: [{ title: "Too wide", detail: "d" }] })).toMatchObject({ stage: 4, title: "The spec review found 1 problem in v2.", action: null });
    const passed = pending({ kind: "approved", version: 2, round: 1, summary: "Holds." });
    expect(passed.text).toContain("Loom's spec review passed it.");
    expect(passed.action).toMatchObject({ control: "approve", version: 2 });
    const skipped = pending({ kind: "skipped", version: 2, against: 1, paths: ["merge.forge.feedback", "budget.max_tokens"] });
    expect(skipped.text).toContain("Loom skipped its spec review, because against v1 it changes only operational settings: merge.forge.feedback, budget.max_tokens. Approving tells the planner.");
    expect(skipped.action).toMatchObject({ control: "approve", version: 2 });
  });

  it("says who paused the project and offers Resume", () => {
    const human = nextStepOf(input({ state: "paused" }, [queued("CSV-1", true)]))!;
    expect(human).toMatchObject({ stage: 4, tone: "normal", title: "Paused.", text: "You paused the project: running workers finish their turn and no new one starts." });
    expect(human.action).toEqual({ control: "resume", label: "Resume", confirm: "Click again to resume" });

    const now = nextStepOf(input({ state: "paused", reason: PAUSE_NOW_REASON }, []))!;
    expect(now).toMatchObject({ tone: "normal", text: "You paused the project and stopped its workers; Resume continues them." });

    const loom = nextStepOf(input({ state: "paused", reason: "The deadline 2026-01-01 has passed." }, []))!;
    expect(loom).toMatchObject({ tone: "warning", text: "Loom paused it: The deadline 2026-01-01 has passed." });

    const stuck = nextStepOf(input({ state: "paused" }, [blocked("CSV-1", "Needs creds")]))!;
    expect(stuck.tone).toBe("warning");
    expect(stuck.text).toBe("You paused the project: running workers finish their turn and no new one starts. CSV-1: Needs creds. Loom tells the planner in a triage round; it can requeue, change or split the ticket.");
  });

  it("names the largest group of blocked tickets, its reason and what Loom does", () => {
    const board = [blocked("CSV-1", refused), blocked("CSV-2", `${refused}`), blocked("CSV-3", null), card({ key: "CSV-4", state: "working", ready: false })];
    const step = nextStepOf(input({ state: "running" }, board, { startFailed: ["CSV-1", "CSV-2"] }))!;
    expect(step).toMatchObject({ stage: 4, tone: "warning", title: "3 tickets are blocked.", action: null });
    expect(step.text).toBe(
      `CSV-1 and CSV-2: ${refused} 1 more for other reasons. Loom tells the planner in a triage round; it can requeue, change or split them. If the planner proposes a fixed spec, approving it queues CSV-1 and CSV-2 again.`,
    );

    const review = nextStepOf(input({ state: "running" }, [blocked("CSV-1", reviewerRefused)], { reviewRefused: ["CSV-1"] }))!;
    expect(review.text).toBe(
      `CSV-1: ${reviewerRefused}. Loom tells the planner in a triage round; it can requeue, change or split the ticket. If the planner proposes a fixed spec, approving it sends CSV-1 back to review.`,
    );

    const one = nextStepOf(input({ state: "running" }, [blocked("CSV-3", null)], { triage: false }))!;
    expect(one).toMatchObject({ title: "1 ticket is blocked.", text: "CSV-3: no reason recorded. Triage is off, so open a ticket to requeue or cancel it." });
  });

  it("offers Start with the workers it starts and the tickets they take", () => {
    const step = nextStepOf(input({ state: "ready" }, [queued("CSV-1", true), queued("CSV-2", true), queued("CSV-3", true), queued("CSV-4", false)]))!;
    expect(step).toMatchObject({ stage: 3, tone: "normal", title: "Next: start the project." });
    expect(step.text).toBe("Loom starts 2 workers right away, on CSV-1 and CSV-2. The other 2 tickets wait for the tickets they depend on or share files with.");
    expect(step.action).toEqual({ control: "start", label: "Start project · 2 workers", confirm: "Click again to start 2 workers" });

    const single = nextStepOf(input({ state: "ready" }, [queued("CSV-1", true), queued("CSV-2", false)]))!;
    expect(single.text).toBe("Loom starts 1 worker right away, on CSV-1. The other ticket waits for the tickets it depends on or shares files with.");
    expect(single.action).toEqual({ control: "start", label: "Start project · 1 worker", confirm: "Click again to start 1 worker" });

    const none = nextStepOf(input({ state: "ready" }, [queued("CSV-2", false)]))!;
    expect(none.action).toEqual({ control: "start", label: "Start project", confirm: "Click again to start" });
  });

  it("offers Land once every ticket of an integration project is finished", () => {
    const step = nextStepOf(input({ state: "running", ticketCounts: { done: 2, cancelled: 1 } }, [card({ state: "done", ready: false })]))!;
    expect(step).toMatchObject({ stage: 5, tone: "normal", title: "Next: land the project." });
    expect(step.text).toBe("Every ticket is finished. Read what lands on the Changes tab; landing pushes the integration branch and opens its pull request, or updates the one already open.");
    expect(step.action).toEqual({ control: "land", label: "Land · open the pull request", confirm: "Click again to land" });
  });

  it("names the repos of a multi-repo project whose merged work is not landed yet in the land step", () => {
    const repo = (name: string, toLand: boolean) => ({ name, bbProjectId: `proj_${name}`, bbProjectName: null, base: "main", branch: "loom/csv", prUrl: null, landedAt: null, toLand });
    const finished = (repos: ReturnType<typeof repo>[]) => input({ state: "running", ticketCounts: { done: 2, cancelled: 1 }, repos }, [card({ state: "done", ready: false })]);

    const two = nextStepOf(finished([repo("web", true), repo("docs", false), repo("api", true)]))!;
    expect(two).toMatchObject({ stage: 5, tone: "normal", title: "Next: land the project." });
    expect(two.text).toBe(
      'Every ticket is finished, and the repos "web" and "api" have merged work that is not landed yet. Read what lands on the Changes tab; landing pushes each one\'s integration branch and opens its pull request, or updates the one already open.',
    );
    expect(two.action).toEqual({ control: "land", label: "Land · 2 repos", confirm: "Click again to land" });

    const one = nextStepOf(finished([repo("web", false), repo("api", true)]))!;
    expect(one.text).toBe('Every ticket is finished, and the repo "api" has merged work that is not landed yet. Read what lands on the Changes tab; landing pushes its integration branch and opens its pull request, or updates the one already open.');
    expect(one.action).toMatchObject({ label: "Land · 1 repo" });

    const none = nextStepOf(finished([repo("web", false), repo("api", false)]))!;
    expect(none).toMatchObject({ stage: 5, text: "Every ticket is finished, and every repo with merged work is landed. Read what lands on the Changes tab; landing again finishes the project." });
    expect(none.action).toEqual({ control: "land", label: "Land · finish the project", confirm: "Click again to land" });

    const working = nextStepOf(input({ state: "running", ticketCounts: { done: 1, working: 1 }, repos: [repo("web", true), repo("api", false)] }, [card({ key: "CSV-2", state: "working", ready: false })]))!;
    expect(working.title).toBe("Running.");
  });

  it("says what runs while nothing needs the human", () => {
    const board = [card({ key: "CSV-2", state: "working", ready: false }), card({ key: "CSV-3", state: "working", ready: false }), queued("CSV-4", false)];
    const step = nextStepOf(input({ state: "running" }, board))!;
    expect(step).toMatchObject({ stage: 4, tone: "normal", title: "Running.", action: null });
    expect(step.text).toBe("2 workers are on CSV-2 and CSV-3. Nothing needs you now; this bar turns yellow when something does.");

    const waiting = [card({ key: "CSV-2", state: "working", ready: false }), card({ key: "CSV-3", state: "working", ready: false, waitsForSlot: true }), card({ key: "CSV-4", state: "working", ready: false, waitsForSlot: true })];
    expect(nextStepOf(input({ state: "running" }, waiting))!.text).toBe("1 worker is on CSV-2. CSV-3 and CSV-4 wait for a worker slot. Nothing needs you now; this bar turns yellow when something does.");
    const allWaiting = [card({ key: "CSV-3", state: "working", ready: false, waitsForSlot: true })];
    expect(nextStepOf(input({ state: "running" }, allWaiting))!.text).toBe("No worker is running now; tickets in checks, review or the merge queue move by themselves. CSV-3 waits for a worker slot. Nothing needs you now; this bar turns yellow when something does.");

    const idle = nextStepOf(input({ state: "running" }, [card({ state: "review", ready: false })]))!;
    expect(idle.text).toBe("No worker is running now; tickets in checks, review or the merge queue move by themselves. Nothing needs you now; this bar turns yellow when something does.");
  });

  it("says when a merge waits after a temporary failure and when Loom tries it again, without asking anything of the human", () => {
    const until = Date.UTC(2026, 9, 27, 14, 5);
    const board = [card({ key: "CSV-2", state: "merging", ready: false, mergeWait: { failures: 1, since: until - 60_000, until, message: "host plugin call 1f46 exceeded its deadline" } })];
    const step = nextStepOf(input({ state: "running" }, board))!;
    expect(step).toMatchObject({ tone: "normal", title: "Running.", action: null });
    expect(step.text).toBe(
      `No worker is running now; tickets in checks, review or the merge queue move by themselves. CSV-2's merge waits: Loom tries the merge again at ${clockTime(until)} after a temporary failure: host plugin call 1f46 exceeded its deadline. Nothing needs you now; this bar turns yellow when something does.`,
    );
  });

  it("is done when every ticket is", () => {
    expect(nextStepOf(input({ state: "done" }, [card({ state: "done", ready: false })]))).toEqual({ stage: STAGES.length, tone: "normal", title: "Done.", text: "Every ticket is done or cancelled.", action: null });
  });
});
