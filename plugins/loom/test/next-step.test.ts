import { describe, expect, it } from "vitest";
import type { BoardCard, ProjectSummary } from "../src/contract";
import { STAGES, nextStepOf, type NextStepInput } from "../src/next-step";
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

  it("says what runs while nothing needs the human", () => {
    const board = [card({ key: "CSV-2", state: "working", ready: false }), card({ key: "CSV-3", state: "working", ready: false }), queued("CSV-4", false)];
    const step = nextStepOf(input({ state: "running" }, board))!;
    expect(step).toMatchObject({ stage: 4, tone: "normal", title: "Running.", action: null });
    expect(step.text).toBe("2 workers are on CSV-2 and CSV-3. Nothing needs you now; this bar turns yellow when something does.");

    const idle = nextStepOf(input({ state: "running" }, [card({ state: "review", ready: false })]))!;
    expect(idle.text).toBe("No worker is running now; tickets in checks, review or the merge queue move by themselves. Nothing needs you now; this bar turns yellow when something does.");
  });

  it("is done when every ticket is", () => {
    expect(nextStepOf(input({ state: "done" }, [card({ state: "done", ready: false })]))).toEqual({ stage: STAGES.length, tone: "normal", title: "Done.", text: "Every ticket is done or cancelled.", action: null });
  });
});
