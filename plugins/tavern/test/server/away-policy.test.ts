// @vitest-environment node
import { makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { LEGACY_AWAY_STOP_LIST, awayWindowSchema } from "../../src/shared/away";
import { awayExecutionPolicy, awayReturnFromDispatch, awayShouldNotify } from "../../src/server/away/policy";

const window = awayWindowSchema.parse({ id: "away-1", version: 1, closedAt: 1_000_000, until: 2_000_000,
  note: null, quests: [{ questId: "draft", endState: "drafts-ready" }, { questId: "pause", endState: "pause" }],
  allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false }, stopList: [...LEGACY_AWAY_STOP_LIST],
  eventFloor: 1, eventCeiling: null, returnedAt: null, returnCause: null });
const returned = awayWindowSchema.parse({ ...window, version: 2, eventCeiling: 2, returnedAt: 1_100_000,
  returnCause: { kind: "explicit-return", threadId: null, refId: null } });
const text = [{ type: "text" as const, text: "How did the checks go?", mentions: [] }];
const ctx = () => makeMessageDispatchHookContext({ thread: { id: "lead" }, input: { text: "How did the checks go?", blocks: text }, initiator: "user", originPluginId: null, senderThreadId: null });

describe("Closing time real-return evidence", () => {
  it("recognizes an inline user message in a Tavern thread", () => {
    expect(awayReturnFromDispatch(window, ctx(), true)).toEqual({ kind: "user-message", threadId: "lead", refId: null });
    expect(awayReturnFromDispatch(window, ctx(), false)).toBeNull();
    expect(awayReturnFromDispatch(null, ctx(), true)).toBeNull();
    expect(awayReturnFromDispatch(returned, ctx(), true)).toBeNull();
  });

  it.each([
    { initiator: "agent" as const, senderThreadId: "member" },
    { initiator: "system" as const },
    { initiator: "user" as const, originPluginId: "tavern" },
    { initiator: "user" as const, senderThreadId: "member" },
  ])("never treats ticks, retries or agent/plugin messages as a return: %j", patch => {
    expect(awayReturnFromDispatch(window, { ...ctx(), ...patch }, true)).toBeNull();
  });

  it("does not treat agent-only context or an empty input as a return", () => {
    expect(awayReturnFromDispatch(window, { ...ctx(), input: { text: "Status", blocks: [{ type: "text", text: "Status", visibility: "agent-only", mentions: [] }] } }, true)).toBeNull();
    expect(awayReturnFromDispatch(window, { ...ctx(), input: { text: "", blocks: [] } }, true)).toBeNull();
  });

  it("uses each queued author in a mixed group rather than only the first row", () => {
    const agent = makeQueueEntry({ id: "agent", threadId: "lead", initiator: "system", originPluginId: "tavern", senderThreadId: null, createdAt: window.closedAt + 1, content: text });
    const user = makeQueueEntry({ id: "user", threadId: "lead", initiator: "user", originPluginId: null, senderThreadId: null, createdAt: window.closedAt + 2, content: text });
    expect(awayReturnFromDispatch(window, { ...ctx(), initiator: "mixed", originPluginId: "tavern", queuedMessages: [agent, user] }, true)).toEqual({ kind: "user-message", threadId: "lead", refId: "user" });
  });

  it("does not reopen for an old queued user message, including an ambiguous closing-millisecond row", () => {
    for (const createdAt of [window.closedAt - 1, window.closedAt]) {
      const row = makeQueueEntry({ id: "old-user", threadId: "lead", initiator: "user", originPluginId: null, senderThreadId: null, createdAt, content: text });
      expect(awayReturnFromDispatch(window, { ...ctx(), queuedMessages: [row] }, true)).toBeNull();
    }
  });

  it("ignores fresh agent-only queue rows and accepts a later real user row", () => {
    const row = makeQueueEntry({ id: "context", threadId: "lead", initiator: "user", originPluginId: null, senderThreadId: null, createdAt: window.closedAt + 1,
      content: [{ type: "text", text: "Context", visibility: "agent-only", mentions: [] }] });
    expect(awayReturnFromDispatch(window, { ...ctx(), queuedMessages: [row] }, true)).toBeNull();
    const user = makeQueueEntry({ ...row, id: "user", createdAt: window.closedAt + 2, content: text });
    expect(awayReturnFromDispatch(window, { ...ctx(), queuedMessages: [row, user] }, true)).toHaveProperty("refId", "user");
  });
});

describe("Closing time work policy", () => {
  it("is inert outside an active window", () => {
    expect(awayExecutionPolicy(null, "draft", false)).toEqual({ mode: "open", reason: null });
    expect(awayExecutionPolicy(returned, "draft", false)).toEqual({ mode: "open", reason: null });
  });
  it("keeps guarded private drafts moving but holds paused or unpinned quests", () => {
    expect(awayExecutionPolicy(window, "draft", true)).toEqual({ mode: "guarded", reason: null });
    expect(awayExecutionPolicy(window, "pause", true)).toEqual({ mode: "held", reason: "paused" });
    expect(awayExecutionPolicy(window, "new-quest", true)).toEqual({ mode: "held", reason: "not-pinned" });
  });
  it("holds watched-only work unless the user explicitly opted in for this window", () => {
    expect(awayExecutionPolicy(window, "draft", false)).toEqual({ mode: "held", reason: "not-prevented" });
    expect(awayExecutionPolicy({ ...window, allowWatched: true }, "draft", false)).toEqual({ mode: "watched", reason: null });
    expect(awayExecutionPolicy({ ...window, allowWatched: true }, "pause", false)).toEqual({ mode: "held", reason: "paused" });
  });
  it("keeps the holds after the expected return time", () => {
    expect(awayExecutionPolicy({ ...window, until: window.closedAt + 1 }, "pause", true)).toEqual({ mode: "held", reason: "paused" });
  });
});

describe("Closing time wake policy", () => {
  it("adds no notification restrictions outside an active window", () => {
    expect(awayShouldNotify(null, "decision", 0, 1)).toBe(true);
    expect(awayShouldNotify(returned, "decision", 0, 1)).toBe(true);
  });
  it("only allows matching blockers by default", () => {
    expect(awayShouldNotify(window, "blocker", 0, 1)).toBe(true);
    for (const kind of ["production", "decision", "greenlight", "credentials", "scope-widening"])
      expect(awayShouldNotify(window, kind, 0, 10_000_000)).toBe(false);
    expect(awayShouldNotify({ ...window, wakeRules: { ...window.wakeRules, blockers: false } }, "blocker", 0, 1)).toBe(false);
  });
  it.each(["production", "cluster-write"])("only wakes for a %s ask after two hours when selected", kind => {
    const selected = { ...window, wakeRules: { ...window.wakeRules, productionAsksAfterTwoHours: true } };
    expect(awayShouldNotify(selected, kind, 1000, 7_200_999)).toBe(false);
    expect(awayShouldNotify(selected, kind, 1000, 7_201_000)).toBe(true);
    expect(awayShouldNotify(selected, kind, 5000, 1000)).toBe(false);
    expect(awayShouldNotify(selected, "decision", 1000, 7_201_000)).toBe(false);
  });
});
