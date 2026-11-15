// @vitest-environment node
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scopeForClass } from "../../src/scope/presets";
import { shouldScope } from "../../src/scope";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { setup } from "./runtime-fixture";

const classes = ["ranger", "smith", "warden", "wanderer"] as const;
const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Other work", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null };
function solo(classId: typeof classes[number], existingScope = true) {
  const f = setup();
  f.k.bind("solo", classId, null, "project");
  const scope = scopeForClass(classId);
  const ensure = vi.fn(async () => {});
  f.runtime.scopes = { api: { mode: () => "enforce", shouldScope, status: () => ({ threads: existingScope ? [{ threadId: "solo", scope }] : [] }) }, ensure, pending: () => null } as never;
  return { ...f, scope, ensure };
}
async function elapse(f: ReturnType<typeof setup>, ms: number) {
  f.advance(ms);
  await vi.advanceTimersByTimeAsync(ms);
}
afterEach(() => vi.useRealTimers());

describe("classes second recheck dispatch", () => {
  it.each(classes)("bounds a human %s solo registry failure and preserves its existing scope", async classId => {
    const f = solo(classId);
    vi.useFakeTimers();
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = dispatch049({ threadId: "solo", text: "Please answer" });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect(f.k.store.runtime("solo").classNotice?.message).toContain("Registry offline");
    await elapse(f, 29_999);
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", sendAt: f.time() + 1 });
    await elapse(f, 1);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.store.runtime("solo").classNotice?.message).toContain("Registry offline");
    expect(f.k.store.events("solo").filter(event => event.type === "user.message").map(event => event.text)).toEqual(["Please answer"]);
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.scope.preset).toBe(scopeForClass(classId).preset);
  });

  it.each(classes)("bounds generic failures on a human %s solo", async classId => {
    const f = solo(classId);
    vi.useFakeTimers();
    f.port.dispatchCheck = () => { throw new Error("broken solo port"); };
    const ctx = dispatch049({ threadId: "solo" });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.store.runtime("solo").classNotice?.message).toContain("broken solo port");
  });

  it.each(["ranger", "smith", "warden"] as const)("refuses an unscoped %s solo after the bound", async classId => {
    const f = solo(classId, false);
    vi.useFakeTimers();
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = dispatch049({ threadId: "solo" });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "reject", message: expect.stringContaining("Registry offline") });
  });

  it("does not require a scope for an intentionally unscoped Wanderer", async () => {
    const f = solo("wanderer", false);
    vi.useFakeTimers();
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = dispatch049({ threadId: "solo" });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
  });

  it.each(classes)("refuses a new %s start rather than waiting forever when its registry cannot load", async classId => {
    const f = setup();
    vi.useFakeTimers();
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = dispatch049({ threadId: "fresh", status: "pending", submission: { pluginId: "tavern", data: { classId } } });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "reject", message: expect.stringContaining("Registry offline") });
    expect(f.k.member("fresh")).toBeNull();
  });

  it.each(["plugin", "retry"] as const)("does not give a solo's %s message the human fallback", async kind => {
    const f = solo("smith");
    vi.useFakeTimers();
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = dispatch049({ threadId: "solo", ...(kind === "plugin" ? { pluginId: "flare" } : { retry: true }) });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
  });

  it.each(["wait", "reject"] as const)("clears the generic failure clock when a recovered check returns %s", async action => {
    const f = setup();
    vi.useFakeTimers();
    const broken = () => { throw new Error("broken port"); };
    f.port.dispatchCheck = broken;
    expect(await f.runtime.dispatch(dispatch049())).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    f.port.dispatchCheck = () => action === "reject" ? "A deliberate rejection" : null;
    if (action === "wait") vi.spyOn(f.runtime.away, "dispatch").mockResolvedValue({ action: "wait", reason: "A deliberate hold" });
    expect(await f.runtime.dispatch(dispatch049())).toMatchObject({ action });
    expect(f.k.store.runtime("lead").dispatchFailureSince).toBeNull();
    f.port.dispatchCheck = broken;
    expect(await f.runtime.dispatch(dispatch049())).toMatchObject({ action: "wait", sendAt: f.time() + 5_000 });
  });

  it("records a bounded fallback's queued human input once and detects Closing time return", async () => {
    const f = setup();
    const quest = await seedQuest(f.k,"lead", "Quest", "Goal");
    await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: quest.id, endState: "pause" }], allowWatched: false });
    vi.useFakeTimers();
    await elapse(f, 1);
    const ctx = dispatch049({ rows: [queued049("plugin", "Nudge", f.time(), { pluginId: "flare" }), queued049("human", "Please answer", f.time())] });
    const detect = vi.spyOn(f.runtime.away, "detectReturn");
    f.port.dispatchCheck = () => { throw new Error("broken port"); };
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(detect).toHaveBeenCalled();
    expect(f.runtime.away.snapshot().status.closed).toBe(false);
    expect(f.k.store.runtime("lead").pending.map(row => row.text)).toEqual(["Please answer"]);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.store.runtime("lead").pending.map(row => row.text)).toEqual(["Please answer"]);
  });

  it.each(["return", "record", "both"] as const)("tries both fallback bookkeeping steps and proceeds with a notice when %s fails", async failure => {
    const f = setup();
    const quest = await seedQuest(f.k,"lead", "Quest", "Goal");
    f.k.bind("worker", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Build", brief });
    await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: quest.id, endState: "pause" }], allowWatched: false });
    vi.useFakeTimers();
    const detect = vi.spyOn(f.runtime.away, "detectReturn"), record = vi.spyOn(f.k, "receiveUser");
    if (failure !== "record") detect.mockRejectedValue(new Error("return down"));
    if (failure !== "return") record.mockImplementation(() => { throw new Error("record down"); });
    f.port.dispatchCheck = () => { throw new Error("broken port"); };
    const ctx = dispatch049();
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(detect).toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
    const message = f.k.store.runtime("lead").classNotice?.message;
    if (failure !== "record") {
      expect(message).toContain("return down");
      expect(f.runtime.away.snapshot().status.closed).toBe(true);
      expect(f.runtime.away.blocked("worker")).toBe(true);
    }
    if (failure !== "return") expect(message).toContain("Tavern couldn't record this message: record down");
    if (failure === "record") expect(f.runtime.away.snapshot().status.closed).toBe(false);
  });

  it("tries every queued human record even if an earlier one fails", async () => {
    const f = setup();
    vi.useFakeTimers();
    const ctx = dispatch049({ rows: [queued049("first", "First", f.time()), queued049("second", "Second", f.time())] });
    const record = vi.spyOn(f.k, "receiveUser").mockImplementationOnce(() => { throw new Error("first record down"); });
    f.port.dispatchCheck = () => { throw new Error("broken port"); };
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    await elapse(f, 30_000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(record).toHaveBeenCalledTimes(2);
    expect(f.k.store.runtime("lead").pending.map(row => row.text)).toEqual(["Second"]);
    expect(f.k.store.runtime("lead").classNotice?.message).toContain("first record down");
  });

  it.each(["stored-archive", "stored-delete", "thread-archive", "thread-delete"] as const)("drops a tick for a %s Keeper before registry and scope work", async state => {
    const f = setup();
    const ctx = dispatch049({ pluginId: "tavern", text: "[Tavern tick] id=tick_1234" });
    if (state === "stored-archive") f.k.store.patch("lead", { archivedAt: f.time() });
    if (state === "stored-delete") f.k.store.patch("lead", { deletedAt: f.time() });
    if (state === "thread-archive") ctx.thread.archivedAt = f.time();
    if (state === "thread-delete") ctx.thread.deletedAt = f.time();
    const ensure = vi.fn();
    f.runtime.scopes = { ensure } as never;
    const project = vi.spyOn(f.bb.sdk.projects, "get").mockRejectedValue(new Error("Registry offline"));
    const config = vi.spyOn(f.bb.sdk.system, "config"), events = vi.spyOn(f.bb.sdk.threads.events, "list");
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "reject", message: expect.stringContaining("archived or deleted Keeper") });
    expect(project).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("drops an archived Keeper tick even when the journal port is broken", async () => {
    const f = setup();
    f.k.store.patch("lead", { archivedAt: f.time() });
    f.port.dispatchCheck = () => { throw new Error("broken port"); };
    expect(await f.runtime.dispatch(dispatch049({ pluginId: "tavern", text: "[Tavern tick] id=tick_1234" }))).toMatchObject({ action: "reject", message: expect.stringContaining("archived or deleted Keeper") });
  });
});
