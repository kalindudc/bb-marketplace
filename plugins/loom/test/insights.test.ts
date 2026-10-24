import { describe, expect, it } from "vitest";
import { clipText, phraseText, projectInsights, rangeOf, type ProjectInsights, type StoryItem } from "../src/insights";
import { MIN, Rows, at, story } from "./insights-rows";

type Chapter = Extract<StoryItem, { type: "chapter" }>;

const insightsOf = (r: Rows, now = at(60), over: Partial<Parameters<typeof projectInsights>[1]> = {}): ProjectInsights => projectInsights(r.rows(), { now, strategy: "integration", maxWorkers: 2, maxTokens: null, ...over });
const chapters = (view: ProjectInsights) => view.groups.flatMap((group) => group.items.filter((item): item is Chapter => item.type === "chapter"));

describe("insights: the story", () => {
  it("groups the events by stretch of the project's state, and names each run when there are several", () => {
    const view = insightsOf(story());
    expect(view.groups.map((group) => group.title)).toEqual(["Planning", "Run 1", "Paused", "Running now 2"]);
    expect(view.groups[2]!.why).toEqual(["you paused it"]);
    expect(view.groups.at(-1)!.current).toBe(true);
  });

  it("writes one chapter per ticket per stretch, with what happened in plain words", () => {
    const [first, second, shipped, blocked] = chapters(insightsOf(story()));
    expect([first, second, shipped, blocked].map((chapter) => [chapter!.key, chapter!.head])).toEqual([
      ["CSV-1", "Still being built when this run ended"],
      ["CSV-2", "Still being built when this run ended"],
      ["CSV-1", "Shipped after fixes"],
      ["CSV-2", "Blocked"],
    ]);
    expect(phraseText(first!.says[0]!)).toBe("A reviewer asked for changes in round 1: “Sort is not stable”.");
    expect(phraseText(second!.says[0]!)).toBe("Checks failed once (npm test).");
    expect(first!.chips).toEqual([{ text: "1 review round", tone: "warn" }]);
    expect(shipped!.says.map((say) => say.filter((part) => typeof part === "string").join(""))).toEqual(["It was sent back once before this stretch.", "Approved in round 2, merged at ."]);
    expect(shipped!.tone).toBe("fixed");
    expect(shipped!.says[1]).toContainEqual({ at: at(51) });
    expect(phraseText(blocked!.says[0]!)).toBe("“The fixture file is missing”");
  });

  it("reads an action that wrote several events as one line", () => {
    const view = insightsOf(story());
    const lines = view.groups.flatMap((group) => group.lines);
    const csv1 = lines.filter((line) => line.key === "CSV-1").map((line) => phraseText(line.text));
    expect(csv1).toContain("A reviewer asked for changes in round 1 (1 finding, 1 blocking): “Sort is not stable”");
    expect(csv1).not.toContain("A reviewer asked for changes, so it went back to the worker.");
    expect(csv1.filter((text) => text.startsWith("Review"))).toEqual([]);
    expect(csv1).toContain("Merged into loom/csv at abcdef1.");
    expect(csv1).not.toContain("Merged: done.");
    expect(lines.filter((line) => line.key === null).map((line) => phraseText(line.text))).not.toContain("The project moved from running to paused.");
  });

  it("marks the problems and your own actions for the filters", () => {
    const lines = insightsOf(story()).groups.flatMap((group) => group.lines);
    expect(lines.filter((line) => line.problem).map((line) => `${line.key} ${phraseText(line.text)}`)).toEqual([
      "CSV-1 A reviewer asked for changes in round 1 (1 finding, 1 blocking): “Sort is not stable”",
      "CSV-2 Checks failed: npm test exited 1.",
      "CSV-2 Blocked: “The fixture file is missing”",
    ]);
    expect(lines.filter((line) => line.you).map((line) => phraseText(line.text))).toEqual(["You approved the spec.", "You started the project.", "You paused the project.", "You resumed the project."]);
  });

  it("lists what needs you or waits right now, only while the project runs or is paused", () => {
    const view = insightsOf(story());
    expect(view.current.map((item) => [item.kind, item.key, item.reason])).toEqual([["blocked", "CSV-2", "The fixture file is missing"]]);
    const paused = story().project(58, "paused").you(58, "pause");
    paused.move(2, 57, "blocked", "queued").move(2, 57, "queued", "working");
    paused.tickets[1]!.blocked_reason = null;
    expect(insightsOf(paused).current.map((item) => [item.kind, item.key])).toEqual([["held", "CSV-2"]]);
    const done = story().move(2, 58, "blocked", "cancelled").project(59, "done", "loom");
    expect(insightsOf(done).current).toEqual([]);
  });
});

describe("insights: the summary and the numbers", () => {
  it("leads with the answer and links the problems and your actions", () => {
    const view = insightsOf(story());
    expect(view.headline).toBe("Running: 1 ticket is blocked and needs you.");
    expect(view.lines.map(phraseText)).toEqual([
      "The one reviewed ticket went back for a fix after review.",
      "Checks failed once in 3 runs, in npm test.",
      "A typical ticket took 44m from its first worker to shipping.",
      "You stepped in twice: a pause and a resume.",
    ]);
    expect(view.lines[0]![0]).toEqual({ link: "problems", text: "The one reviewed ticket" });
    expect(view.lines[3]![0]).toEqual({ link: "you", text: "You stepped in twice" });
  });

  it("counts the numbers the cards show", () => {
    const n = insightsOf(story()).numbers;
    expect(n).toMatchObject({ goal: "shipped", reached: 1, cycle: [{ key: "CSV-1", ms: 44 * MIN }], cycleP50: 44 * MIN, leadP50: 46 * MIN, firstTry: [{ key: "CSV-1", clean: false, rounds: 2 }], findings: { total: 1, blocking: 1 }, interventions: 2, runs: 2 });
    expect(n.checks).toEqual({ runs: 3, failed: 1, outside: 0, commands: [{ command: "npm test", runs: 3, failed: 1, p50Ms: 30_000 }] });
    expect(n.wrong).toMatchObject({ sentBack: 2, byReview: 1, byChecks: 1, blocked: 1, failedAttempts: 0 });
    expect(n.time).toMatchObject({ queued: 2 * MIN, working: 13 * MIN + 20 * MIN, checking: 2 * MIN, review: 8 * MIN });
    expect(n.runningMs).toBe(24 * MIN + 20 * MIN);
  });

  it("on the pull request strategy measures a ticket to its pull request, and the wait on people after it", () => {
    const r = new Rows();
    r.event(0, "project.created", null).event(1, "spec.approved", null, { version: 1 }, "human").ticket(1, 1).project(1, "ready").project(2, "running").you(2, "start");
    r.move(1, 3, "queued", "working").move(1, 13, "working", "checking").check(1, 14, true).move(1, 14, "checking", "review", { round: 1 }).verdict(1, 18, 1, "approved").move(1, 18, "review", "approved").move(1, 18, "approved", "merging");
    r.move(1, 20, "merging", "pr_open").post(1, 20, "merge", "Opened pull request https://github.com/acme/app/pull/7 as 1 commit.", { outcome: "pr_opened" });
    r.tickets[0]!.pr_url = "https://github.com/acme/app/pull/7";
    r.move(1, 140, "pr_open", "done");
    const view = insightsOf(r, at(150), { strategy: "pr" });
    expect(view.numbers).toMatchObject({ goal: "pr", reached: 1, cycleP50: 17 * MIN, prWait: { p50: 120 * MIN, max: 120 * MIN, n: 1 } });
    expect(view.numbers.time.pr_open).toBeUndefined();
    expect(view.lines.map(phraseText)).toContain("Then its pull request waited on people for a typical 2h.");
    expect(view.activity.marks.map((mark) => mark.kind)).toEqual(expect.arrayContaining(["pr", "done"]));
    expect(view.figures[1]).toMatchObject({ value: "17m", note: "of work to its pull request, typically; most within 17m" });
  });

  it("keeps to a window: the numbers and the story cover only that stretch", () => {
    const view = insightsOf(story(), at(60), { window: { from: at(40), to: at(60) } });
    expect(view.range).toEqual({ from: at(40), to: at(60) });
    expect(view.groups.map((group) => group.title)).toEqual(["Running now 2"]);
    expect(view.headline).toBe("1 ticket shipped in this stretch.");
    expect(view.numbers.checks.runs).toBe(1);
    expect(view.numbers.wrong.failedAttempts).toBeNull();
    expect(view.numbers.runningMs).toBe(20 * MIN);
    expect(insightsOf(story(), at(60), { window: "run" }).range).toEqual({ from: at(40), to: at(60) });
  });

  it("offers Latest run only with more than one run, and Last 24 hours only for a project older than two days", () => {
    expect(insightsOf(story()).presets).toEqual({ run: true, day: false });
    const short = new Rows().event(0, "project.created", null).project(1, "ready").project(2, "running");
    expect(insightsOf(short, at(3 * 24 * 60)).presets).toEqual({ run: false, day: true });
  });
});

describe("insights: review fixes", () => {
  it("keeps events written in the same millisecond as a start in the stretch before it", () => {
    const r = new Rows();
    r.event(0, "project.created", null).event(5, "spec.approved", null, { version: 1 }, "human").ticket(1, 5).project(5, "ready").project(5, "running").you(5, "start");
    r.move(1, 6, "queued", "working");
    const view = insightsOf(r, at(10));
    expect(view.groups.map((group) => group.title)).toEqual(["Planning", "Running now"]);
    expect(view.groups[0]!.items.map((item) => item.type)).toContain("created");
    expect(view.groups[1]!.items.map((item) => item.type)).not.toContain("created");
  });

  it("judges the first try on every verdict up to the stretch's end, not only those in it", () => {
    const view = insightsOf(story(), at(60), { window: { from: at(40), to: at(60) } });
    expect(view.numbers.firstTry).toEqual([{ key: "CSV-1", clean: false, rounds: 2 }]);
  });

  it("counts a pull request's wait inside the stretch even when it opened before it, and feedback that queues a fix as sent back", () => {
    const r = new Rows();
    r.event(0, "project.created", null).event(1, "spec.approved", null, { version: 1 }, "human").ticket(1, 1).project(1, "ready").project(2, "running");
    r.move(1, 3, "queued", "working").move(1, 10, "working", "checking").move(1, 11, "checking", "review", { round: 1 }).verdict(1, 12, 1, "approved").move(1, 12, "review", "approved").move(1, 12, "approved", "merging").move(1, 20, "merging", "pr_open");
    r.move(1, 200, "pr_open", "queued");
    const ranged = insightsOf(r, at(210), { strategy: "pr", window: { from: at(100), to: at(160) } });
    expect(ranged.numbers.prWait).toEqual({ p50: 60 * MIN, max: 60 * MIN, n: 1 });
    const whole = insightsOf(r, at(210), { strategy: "pr" });
    expect(whole.numbers.wrong).toMatchObject({ sentBack: 1, byPr: 1 });
    expect(whole.groups.flatMap((group) => group.lines).filter((line) => line.problem).map((line) => phraseText(line.text))).toEqual(["Feedback on the pull request queued a fix round for a new worker."]);
  });

  it("shows an empty stretch for a window outside the project's life", () => {
    const view = insightsOf(story(), at(60), { window: { from: at(500), to: at(600) } });
    expect(view.range).toEqual({ from: at(500), to: at(600) });
    expect(view.groups).toEqual([]);
    expect(view.numbers.reached).toBe(0);
    expect(view.headline).toBe("Nothing shipped in this stretch.");
  });
});

describe("insights: the activity", () => {
  it("steps the tickets in flight at every move and marks what the chart shows", () => {
    const { activity } = insightsOf(story());
    expect(activity.flight).toEqual([
      [at(0), 0],
      [at(7), 2],
      [at(51), 1],
      [at(55), 0],
    ]);
    expect(activity.marks.map((mark) => [mark.kind, mark.key])).toEqual([
      ["milestone", null],
      ["you", null],
      ["you", null],
      ["back", "CSV-1"],
      ["back", "CSV-2"],
      ["you", null],
      ["you", null],
      ["done", "CSV-1"],
      ["bad", "CSV-2"],
    ]);
    expect(activity.spans.map((span) => span.state)).toEqual(["draft", "running", "paused", "running"]);
  });

  it("reads the rows and never changes them", () => {
    const r = story();
    const before = JSON.stringify(r.rows());
    insightsOf(r, at(60), { window: "run" });
    expect(JSON.stringify(r.rows())).toBe(before);
  });
});

describe("rangeOf and clipText", () => {
  const spans = [
    { from: at(0), to: at(5), state: "draft" as const },
    { from: at(5), to: at(30), state: "running" as const },
    { from: at(30), to: at(40), state: "paused" as const },
    { from: at(40), to: at(60), state: "running" as const },
  ];
  it("cuts a window to the project's life and puts its ends in order", () => {
    expect(rangeOf("all", spans, at(0), at(60))).toBeNull();
    expect(rangeOf({ from: at(70), to: at(-5) }, spans, at(0), at(60))).toEqual({ from: at(0), to: at(60) });
    expect(rangeOf({ from: at(70), to: at(80) }, spans, at(0), at(60))).toEqual({ from: at(70), to: at(80) });
    expect(rangeOf("day", spans, at(0), at(60))).toEqual({ from: at(0), to: at(60) });
    expect(rangeOf("run", spans, at(0), at(90))).toEqual({ from: at(40), to: at(90) });
  });

  it("folds whitespace and cuts long text at a word", () => {
    expect(clipText("  one\n two  ")).toBe("one two");
    expect(clipText("alpha beta gamma delta", 15)).toBe("alpha beta…");
  });
});
