// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { planInput } from "./support";
import { journalEntrySchema } from "../../src/shared/schema";
import { readStatus, statusInput } from "../../src/server/status";

const brief = {
  outcome: "Scout",
  mode: "make-it-work" as const,
  outOfScope: "Writes",
  doneWhen: "Report",
  context: [],
  questions: ["1. What failed?"],
  timeboxMinutes: 5,
};
const ask = {
  kind: "decision" as const,
  question: "Fixture?",
  why: "Reversible",
  options: [{ id: "yes", label: "Yes", detail: "", recommended: true }],
  meanwhile: "Scout",
  holds: [],
};
function member(k: ReturnType<typeof setup>["k"], id: string, classId: string) {
  k.bind(id, classId, "otto", "project", {
    keeperThreadId: "lead",
    boardQuestId: null,
    waypointId: null,
    errand: true,
    title: "Scout",
    brief,
  });
}

describe("additional dispatch and policy coverage", () => {
  it("H3 preserves repeated identical user messages and pairs their drains FIFO", async () => {
    const { k, runtime, time } = setup();
    await runtime.dispatch(dispatch049({ text: "same", status: "active" }));
    await runtime.dispatch(dispatch049({ text: "same", status: "active" }));
    const rows = [queued049("same1", "same", time()), queued049("same2", "same", time())];
    await runtime.dispatch(dispatch049({ rows }));
    await runtime.dispatch(dispatch049({ rows }));
    expect(k.store.runtime("lead").pending).toHaveLength(2);
    expect(new Set(k.store.runtime("lead").pending.map((p) => p.id)).size).toBe(2);
  });
  it("H1/L1 ignores a plugin-authored member brief without a sender", async () => {
    const { k, runtime } = setup();
    member(k, "kid", "ranger");
    await runtime.dispatch(
      dispatch049({ threadId: "kid", text: "Your brief", pluginId: "tavern" }),
    );
    expect(k.store.events("lead").some((e) => e.type === "user.told-member")).toBe(false);
  });
  it("M1 refuses an explicitly chosen broken character pool or unknown class without silently starting plain", async () => {
    const { runtime, k } = setup();
    vi.spyOn(runtime.registry, "character").mockImplementation(() => {
      throw new Error("No compatible character");
    });
    const ctx = dispatch049({
      threadId: "new",
      status: "pending",
      submission: { pluginId: "tavern", data: { classId: "keeper" } },
    });
    expect(await runtime.dispatch(ctx)).toMatchObject({ action: "reject", message: expect.stringContaining("No compatible character") });
    expect(k.member("new")).toBeNull();
    ctx.experimental_submission = { pluginId: "tavern", data: { classId: "unknown" } };
    expect((await runtime.dispatch(ctx)).action).toBe("reject");
  });
  it("M2 defaults later asks even if an earlier default is malformed", () => {
    const { k, advance } = setup();
    const bad = k.ask("lead", { ...ask, reversible: true, proceedInMinutes: 1 });
    const good = k.ask("lead", { ...ask, reversible: true, proceedInMinutes: 1 });
    k.store.put("asks", bad.id, { ...bad, options: [] });
    advance(61_000);
    const errors = vi.fn();
    k.defaults("lead", errors);
    expect(errors).toHaveBeenCalledOnce();
    expect(k.store.get("asks", good.id)?.state).toBe("defaulted");
  });
  it("enforces the live member budget, Ranger budget, class policy and errand policy", async () => {
    const { k, runtime } = setup();
    const input = { classId: "ranger", errand: true, title: "Scout", brief };
    await expect(runtime.hire("lead", "project", { ...input, classId: "keeper" })).rejects.toThrow(
      /policy/,
    );
    await expect(runtime.hire("lead", "project", { ...input, classId: "smith" })).rejects.toThrow(
      /Only Ranger/,
    );
    for (let i = 0; i < 3; i++) member(k, `r${i}`, "ranger");
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/Ranger budget/);
    for (let i = 0; i < 2; i++) member(k, `w${i}`, "wanderer");
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/party budget/);
  });
  it("requires a bounded Ranger brief even for an aside", async () => {
    const { runtime } = setup();
    const input = { classId: "ranger", errand: true, title: "Scout", brief };
    await expect(
      runtime.hire("lead", "project", { ...input, brief: { ...brief, questions: [] } }),
    ).rejects.toThrow(/numbered questions/);
    await expect(
      runtime.hire("lead", "project", { ...input, brief: { ...brief, timeboxMinutes: 60 } }),
    ).rejects.toThrow(/time box/);
  });
  it("blocks Smith hires when three real waypoints are waiting for review", async () => {
    const { k, runtime, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    const base = planInput(q.id);
    const waypoints = [1, 2, 3, 4].map((i) => ({ ...base.waypoints[0]!, id: `w${i}` }));
    k.plan("lead", {
      ...base,
      waypoints,
      party: [1, 2, 3, 4].map(() => ({
        classId: "smith",
        characterId: null,
        model: null,
        purpose: "Build",
        waypointIds: [],
      })),
    });
    k.answerAsk(k.asks("lead")[0]!.id, "approve", null, "page", "user");
    const entries = [1, 2, 3].map((i) =>
      journalEntrySchema.parse({
        id: "a1",
        threadId: `s${i}`,
        description: "Build",
        parentId: null,
        status: "done",
        evidence: [{ kind: "command", ref: "npm test", exitCode: 0, detail: "Passed" }],
        link: { boardQuestId: q.id, waypointId: `w${i}` },
        owner: `s${i}`,
        note: null,
        order: 0,
        createdAt: k.now(),
        updatedAt: k.now(),
        createdBy: { kind: "tavern" },
        updatedBy: { kind: "agent", threadId: `s${i}` },
      }),
    );
    const original = port.get;
    port.get = (id) => ({ ...original(id), entries: entries.filter((e) => e.threadId === id) });
    port.linkedEntries = () => entries;
    for (let i = 1; i <= 3; i++) {
      k.bind(`s${i}`, "smith", "juno", "project", {
        keeperThreadId: "lead",
        boardQuestId: q.id,
        waypointId: `w${i}`,
        errand: false,
        title: "Build",
        brief,
      });
      k.report(`s${i}`, {
        status: "done",
        outcome: `Review ${i}`,
        evidence: [],
        artifacts: [],
        confidence: null,
        voice: null,
      });
    }
    expect(runtime.review().waiting).toBe(3);
    await expect(
      runtime.hire("lead", "project", {
        classId: "smith",
        boardQuestId: q.id,
        waypointId: "w4",
        title: "Build",
        brief,
      }),
    ).rejects.toThrow(/review budget/);
  });
  it("H4 exposes full reports and answered asks through bounded status pages", () => {
    const { k, runtime } = setup();
    member(k, "kid", "ranger");
    const report = k.report("kid", {
      status: "blocked",
      outcome: "x".repeat(4000),
      evidence: [],
      artifacts: Array.from({ length: 30 }, () => "y".repeat(1000)),
      confidence: null,
      voice: null,
    });
    const first = readStatus(runtime, "lead", statusInput.parse({ reportId: report.id }));
    const next = readStatus(
      runtime,
      "lead",
      statusInput.parse({ reportId: report.id, offset: 8000 }),
    );
    expect(String(first)).toContain("offset=8000");
    expect(String(first).length).toBeLessThan(9000);
    expect(String(next)).toContain("8000-16000");
    const opened = k.ask("lead", ask);
    k.answerAsk(opened.id, "yes", "Choice", "page", "user");
    expect(readStatus(runtime, "lead", statusInput.parse({ section: "asks" }))).toMatchObject({
      asks: [{ state: "answered", answer: { note: "Choice" } }],
    });
  });
});
