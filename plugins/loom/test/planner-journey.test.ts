import { describe, expect, it } from "vitest";
import { changeLine, journey, leadOf, stepMatches, workingOn, type JourneyStep, type QuestionRound } from "../src/planner-journey";
import type { PlannerStep } from "../src/planner-view";

const turn = (at: number, version?: number, text: string | null = `Turn at ${at}.`): PlannerStep => ({
  kind: "turn",
  at,
  text,
  actions: version === undefined ? [] : [{ kind: "proposed", version, tickets: 4, change: version === 1 ? null : { added: [], removed: ["gem"], changed: ["alerts"], settings: 0, guardrails: 1 } }],
});
const round = (askedAt: number, answeredAt: number | null, answers = 2): QuestionRound => ({ id: `r${askedAt}`, title: `${answers} questions`, askedAt, status: answeredAt === null ? "open" : "answered", answeredAt, answers: Array.from({ length: answeredAt === null ? 0 : answers }, (_, n) => ({ header: `Q${n}`, question: `Question ${n}?`, answer: `A${n}` })) });
const started: PlannerStep = { kind: "started", at: 0, text: "Export orders as CSV" };
const view = (steps: PlannerStep[], pendingVersion: number | null = null) => ({ steps, pendingVersion, triageRounds: 0 });

describe("the planner's journey", () => {
  it("cuts chapters at each draft version, at the human's input after one, and at approval", () => {
    const steps: PlannerStep[] = [
      started,
      turn(20, 1),
      { kind: "review", at: 30, version: 1, round: 1, state: "changes_requested", summary: "Too much.", findings: [{ title: "Too wide", detail: "d" }], reason: null, startedAt: 21, endedAt: 30 },
      turn(40, 2),
      { kind: "review", at: 50, version: 2, round: 2, state: "approved", summary: "Fits.", findings: [], reason: null, startedAt: 41, endedAt: 50 },
      turn(55, undefined, "v2 passed; it is ready for you."),
      { kind: "notes", at: 60, version: 2, notes: [{ version: 2, paths: ["ticket[alerts]"], body: "Stack it." }] },
      turn(70, 3),
      { kind: "control", at: 80, action: "approve", version: 3, pending: false, skipReview: false },
      { kind: "triage", at: 90, round: 1, blocked: [{ key: "CF-2", title: "Retry deletes", reason: "Check crashes." }], response: turn(95, 4) as never },
    ];
    const chapters = journey(view(steps, 4), [round(10, 15), round(65, 68, 1)]);
    expect(chapters.map((chapter) => [chapter.title, chapter.steps.map((step) => step.kind)])).toEqual([
      ["Draft v1", ["started", "questions", "turn", "review"]],
      ["Draft v2", ["turn", "review", "turn"]],
      ["Draft v3", ["notes", "questions", "turn"]],
      ["Running on v3", ["control", "triage"]],
    ]);
    expect(chapters.map((chapter) => chapter.summary)).toEqual([
      "From 2 answers: 4 tickets. Loom's review found 1 problem in round 1.",
      "4 tickets, −1, 1 changed. Loom's review passed it in round 2.",
      "From 1 comment and 1 answer: 4 tickets, −1, 1 changed.",
      "1 triage round. v4 waits for you.",
    ]);
  });

  it("keeps a review in the chapter of the version it reviewed when a message closed that chapter meanwhile", () => {
    const steps: PlannerStep[] = [
      started,
      turn(10, 1),
      { kind: "message", at: 20, text: "Also export customers." },
      { kind: "review", at: 30, version: 1, round: 1, state: "approved", summary: "Fits.", findings: [], reason: null, startedAt: 11, endedAt: 30 },
      turn(40, 2),
    ];
    const chapters = journey(view(steps), []);
    expect(chapters.map((chapter) => [chapter.title, chapter.steps.map((step) => step.kind)])).toEqual([
      ["Draft v1", ["started", "turn", "review"]],
      ["Draft v2", ["message", "turn"]],
    ]);
    expect(chapters[1]!.summary).toBe("From 1 message: 4 tickets, −1, 1 changed.");
  });

  it("names the running chapter for the version in force now", () => {
    const steps: PlannerStep[] = [started, turn(10, 1), { kind: "control", at: 20, action: "approve", version: 1, pending: false, skipReview: false }, { kind: "control", at: 30, action: "approve", version: 2, pending: true, skipReview: false }];
    expect(journey({ ...view(steps), approvedVersion: 2 }, []).at(-1)!.title).toBe("Running on v2");
    expect(journey(view(steps), []).at(-1)!.title).toBe("Running on v1");
  });

  it("calls the chapter before any version Planning, and one after a version with no newer one Since that version", () => {
    expect(journey(view([started]), [round(5, null)]).map((chapter) => [chapter.title, chapter.summary])).toEqual([["Planning", "The planner is reading the goal and the code."]]);
    const after = journey(view([started, turn(10, 1), { kind: "message", at: 20, text: "One more thing." }]), []);
    expect(after.map((chapter) => [chapter.title, chapter.summary])).toEqual([
      ["Draft v1", "4 tickets."],
      ["Since v1", "1 message so far."],
    ]);
  });

  it("says what a working planner is on: the newest thing that reached it since its last words", () => {
    const notes: JourneyStep = { kind: "notes", at: 30, version: 2, notes: [{ version: 2, paths: ["ticket[a]"], body: "x" }, { version: 2, paths: ["ticket[b]"], body: "y" }] };
    expect(workingOn([started])).toBe("your request");
    expect(workingOn([started, turn(10, 1), notes])).toBe("your comments on v2");
    expect(workingOn([started, turn(10, 1), notes, turn(40, 3)])).toBeNull();
    expect(workingOn([turn(10, 1), { kind: "questions", at: 20, round: round(20, 25) }])).toBe("your answers");
    expect(workingOn([turn(10, 1), { kind: "triage", at: 20, round: 2, blocked: [], response: null }])).toBe("triage round 2");
    expect(workingOn([turn(10, 1), { kind: "control", at: 20, action: "approve", version: 4, pending: true, skipReview: false }])).toBe("your approval of v4");
    expect(workingOn([turn(10, 1), { kind: "review", at: 20, version: 1, round: 1, state: "changes_requested", summary: null, findings: [], reason: null, startedAt: 11, endedAt: 20 }])).toBe("the spec review's findings on v1");
  });

  it("filters the steps by who acted, and words a proposal and a planner's first sentence", () => {
    const proposal = turn(10, 2);
    expect([stepMatches(proposal, "spec"), stepMatches(proposal, "you"), stepMatches(turn(10), "spec")]).toEqual([true, false, false]);
    expect(stepMatches({ kind: "control", at: 1, action: "pause", version: null, pending: false, skipReview: false }, "spec")).toBe(false);
    expect(changeLine(4, null)).toBe("4 tickets");
    expect(changeLine(4, { added: [], removed: [], changed: [], settings: 1, guardrails: 1 })).toBe("4 tickets, tickets unchanged, 2 other changes");
    expect(changeLine(5, { added: ["a"], removed: [], changed: [], settings: 0, guardrails: 0 })).toBe("5 tickets, +1");
    expect(leadOf("**Spec v3** passed Loom's review. The draft is ready.")).toBe("Spec v3 passed Loom's review.");
    expect(leadOf("\n\nNo full stop here")).toBe("No full stop here");
    expect(leadOf("x".repeat(300), 20)).toHaveLength(20);
  });
});
