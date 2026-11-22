// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./runtime-fixture";
import { makeMessageDispatchHookContext, makeThreadResponse } from "./host";
import { dispatch049 } from "./dispatch-fixture";
import { scopeForClass } from "../../src/scope/presets";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Other work", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null };
function bindWorker(f: ReturnType<typeof setup>, role: "member" | "solo" = "member") {
  return f.k.bind("worker", "smith", null, "project", role === "member" ? { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief } : undefined);
}

describe("registry dispatch recheck", () => {
  it.each([false, true])("admits a tick (resend=%s) only after registry, scope and Closing time gates, without consuming it on wait or recording it as user input", async resend => {
    const f = setup();
    f.k.store.event(f.time(), "lead", null, "promise.due", "An unread fact");
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("unconfirmed send"));
    await f.runtime.tick("lead");
    const batch = f.k.store.pendingTick("lead")!;
    f.k.store.putTick({ ...batch, attempted: resend, resendCount: 1, admittedResendCount: 0 });
    const unchanged = () => {
      expect.soft(f.k.store.tick(batch.id)?.attempted).toBe(resend);
      expect.soft(f.k.store.tick(batch.id)?.admittedResendCount).toBe(0);
    };
    let scopeBroken = true, scopeDecision = false, closed = true;
    const ensure = vi.fn(async () => { if (scopeBroken) throw new Error("Guard unavailable"); });
    f.runtime.scopes = { ensure, pending: () => scopeDecision ? { initialBrief: "brief" } : null } as never;
    const gate = vi.spyOn(f.runtime.away, "dispatch").mockImplementation(async () => closed ? { action: "wait", reason: "Closing time" } : null);
    const receive = vi.spyOn(f.k, "receiveUser"), mirror = vi.spyOn(f.runtime, "mirror").mockResolvedValue();
    const ctx = dispatch049({ text: batch.text + (resend ? "\nDelivery retry of the same tick id. Ignore it if you have already seen or acted on this id." : ""), pluginId: "tavern" });
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: expect.stringContaining("Registry offline") });
    unchanged();
    expect(ensure).not.toHaveBeenCalled();
    f.bb.sdk.projects.get = async () => ({ sources: [] }) as never;
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: expect.stringContaining("Guard unavailable") });
    unchanged();
    scopeBroken = false; scopeDecision = true;
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: "Awaiting the user's scope decision" });
    unchanged();
    scopeDecision = false;
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: "Closing time" });
    unchanged();
    closed = false;
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.store.tick(batch.id)?.attempted).toBe(true);
    expect(f.k.store.tick(batch.id)?.admittedResendCount).toBe(resend ? 1 : 0);
    expect(ensure).toHaveBeenCalledTimes(4);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(receive).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "reject", message: expect.stringContaining("duplicate tick") });
  });

  it.each(["keeper", "member", "solo"] as const)("waits with a retry for a bound %s when its registry cannot load", async role => {
    const f = setup();
    if (role !== "keeper") bindWorker(f, role);
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const receive = vi.spyOn(f.k, "receiveUser");
    const result = await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: role === "keeper" ? "lead" : "worker", status: "idle" } }));
    expect(result).toMatchObject({ action: "wait", reason: expect.stringContaining("Registry offline"), sendAt: expect.any(Number) });
    if (result.action === "wait") expect(result.sendAt).toBeGreaterThan(f.time());
    expect(receive).not.toHaveBeenCalled();
  });

  it("keeps a pending hire blocked until registry, scopes and Closing time all admit it, then records its input once", async () => {
    const f = setup(), order: string[] = [];
    f.k.store.put("hires", "token", { classId: "smith", characterId: null, projectId: "project", createdAt: f.time(), initialInput: "First brief", scopeResolution: { scope: scopeForClass("smith"), widenings: [], problems: [] }, owner: { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief } });
    const ensure = vi.fn(async () => { order.push("scope"); });
    const hired = vi.fn(async () => { order.push("scope-hired"); });
    f.runtime.scopes = { ensure, hired, pending: () => null } as never;
    let closed = true;
    vi.spyOn(f.runtime.away, "dispatch").mockImplementation(async () => { order.push("closing"); return closed ? { action: "wait", reason: "Closing time paused this member" } : null; });
    const receive = vi.spyOn(f.k, "receiveUser");
    const ctx = makeMessageDispatchHookContext({ thread: { id: "new-worker", parentThreadId: "lead", status: "pending" } });
    ctx.experimental_submission = { pluginId: "tavern", data: { hireToken: "token" } };
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: expect.stringContaining("Registry offline") });
    expect(f.k.member("new-worker")).toBeNull();
    expect(order).toEqual([]);
    expect(receive).not.toHaveBeenCalled();
    f.bb.sdk.projects.get = async () => ({ sources: [] }) as never;
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: "Closing time paused this member" });
    expect(order).toEqual(["scope-hired", "scope", "closing"]);
    expect(receive).not.toHaveBeenCalled();
    closed = false;
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(order).toEqual(["scope-hired", "scope", "closing", "scope", "closing"]);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it.each(["bound", "new"] as const)("admits a %s Keeper through its real built-in scope and remaining gates after thirty seconds", async start => {
    const f = setup(), root = mkdtempSync(join(tmpdir(), "tavern-keeper-fallback-")); roots.push(root);
    f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: null });
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const id = start === "new" ? "fresh-keeper" : "lead";
    const ctx = makeMessageDispatchHookContext({ thread: { id, status: start === "new" ? "pending" : "idle", environmentId: null } });
    if (start === "new") ctx.experimental_submission = { pluginId: "tavern", data: { classId: "keeper" } };
    const receive = vi.spyOn(f.k, "receiveUser");
    const gate = vi.spyOn(f.runtime.away, "dispatch").mockImplementation(async () => {
      expect(f.runtime.scopes!.api.status().threads.find(thread => thread.threadId === id)?.scope?.preset).toBe("open");
      return null;
    });
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect(receive).not.toHaveBeenCalled();
    f.advance(30_001);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.member(id)?.role).toBe("keeper");
    expect(f.k.store.runtime(id).classNotice?.message).toContain("built-in Keeper");
    expect(f.runtime.scopes!.api.status().threads.find(thread => thread.threadId === id)?.scope?.preset).toBe("open");
    expect(gate).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledTimes(1);
    mkdirSync(join(root, ".agents/tavern/classes"), { recursive: true });
    writeFileSync(join(root, ".agents/tavern/classes/keeper.md"), readFileSync(new URL("../../classes/keeper.md", import.meta.url), "utf8").replace("scope: open", "scope: { preset: open, tools: { deny: [web_search] } }"));
    f.bb.sdk.projects.get = async () => ({ sources: [{ path: root, hostId: "host", isDefault: true }] }) as never;
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    const restored = f.runtime.scopes!.api.status().threads.find(thread => thread.threadId === id)?.scope;
    expect(restored?.tools.deny).toContain("web_search");
    expect(f.k.store.runtime(id).builtinKeeperFallback).toBe(false);
    expect(f.k.store.runtime(id).scopeKeeperFallback).toBe(false);
    expect(f.k.store.runtime(id).classNotice).toBeNull();
  });

  it("still checks a fallback Keeper start against the built-in guard guarantee", async () => {
    const f = setup(), ensure = vi.fn();
    f.runtime.scopes = { ensure, pending: () => null } as never;
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = makeMessageDispatchHookContext({ thread: { id: "new-keeper", status: "pending" } });
    ctx.requestedExecution.providerId = "codex";
    ctx.experimental_submission = { pluginId: "tavern", data: { classId: "keeper" } };
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    f.advance(30_001);
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "reject", message: expect.stringContaining("Pi") });
    expect(f.k.member("new-keeper")).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not let a second hung Keeper lookup extend admission beyond the thirty-second deadline", async () => {
    const f = setup();
    vi.useFakeTimers();
    f.bb.sdk.projects.get = () => new Promise(() => {});
    const ensure = vi.fn(async () => {});
    f.runtime.scopes = { ensure, pending: () => null } as never;
    vi.spyOn(f.runtime.away, "dispatch").mockResolvedValue(null);
    const ctx = makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle" } });
    const first = f.runtime.dispatch(ctx);
    await vi.waitFor(() => expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(1));
    f.advance(20_001);
    await vi.advanceTimersByTimeAsync(20_001);
    expect.soft(await first).toMatchObject({ action: "wait" });
    f.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    let result: Awaited<ReturnType<typeof f.runtime.dispatch>> | undefined;
    const second = f.runtime.dispatch(ctx).then(value => { result = value; });
    await vi.waitFor(() => expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(2));
    f.advance(5_001);
    await vi.advanceTimersByTimeAsync(5_001);
    expect.soft(result).toEqual({ action: "proceed" });
    expect.soft(ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await second;
  });

  it.each(["member", "hire"] as const)("keeps a %s waiting after several minutes and records one notice for its Keeper", async start => {
    const f = setup();
    if (start === "member") bindWorker(f);
    else f.k.store.put("hires", "token", { classId: "smith", characterId: null, projectId: "project", createdAt: f.time(), owner: { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief } });
    f.bb.sdk.projects.get = async () => { throw new Error("Registry offline"); };
    const ctx = makeMessageDispatchHookContext({ thread: { id: "worker", status: start === "hire" ? "pending" : "idle", parentThreadId: start === "hire" ? "lead" : null } });
    if (start === "hire") ctx.experimental_submission = { pluginId: "tavern", data: { hireToken: "token" } };
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect(f.k.asks("lead")).toHaveLength(0);
    f.advance(300_001);
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect.soft(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect(f.k.asks("lead")).toMatchObject([{ kind: "blocker", state: "answered", answer: { by: "tavern" }, why: expect.stringContaining("Registry offline") }]);
    expect(f.k.store.events("lead").filter(event => event.type === "blocker.moved")).toHaveLength(1);
    f.bb.sdk.projects.get = async () => ({ sources: [] }) as never;
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.asks("lead").filter(ask => ask.state === "open")).toHaveLength(0);
  });

  it("does not turn a later admission exception into permission to run a Keeper", async () => {
    const f = setup();
    const receive = vi.spyOn(f.k, "receiveUser");
    vi.spyOn(f.runtime.away, "dispatch").mockRejectedValue(new Error("Closing gate unavailable"));
    expect(await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle" } }))).toMatchObject({ action: "wait", sendAt: expect.any(Number) });
    expect(receive).not.toHaveBeenCalled();
  });

  it.each(["idle", "pending"] as const)("does not make any registry host calls for a plain %s thread", async status => {
    const f = setup();
    expect(await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "plain", status } }))).toEqual({ action: "proceed" });
    expect(f.harness.inspection.sdk.callsTo("system.config")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.updatePluginMetadata")).toHaveLength(0);
  });

  it("does not load class metadata for an explicit plain start even when a Keeper is the default", async () => {
    const f = setup(), config = f.runtime.config();
    vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, defaultClass: "keeper" } });
    const ctx = makeMessageDispatchHookContext({ thread: { id: "plain", status: "pending" } });
    ctx.experimental_submission = { pluginId: "tavern", data: { classId: "none" } };
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.harness.inspection.sdk.callsTo("system.config")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(0);
  });

  it("caches canonical source metadata for a minute while still admitting each member message", async () => {
    const f = setup();
    bindWorker(f);
    const ctx = makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" } });
    const gate = vi.spyOn(f.runtime.away, "dispatch").mockResolvedValue(null);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    f.advance(30_000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect.soft(f.harness.inspection.sdk.callsTo("system.config")).toHaveLength(1);
    expect.soft(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(1);
    f.advance(30_001);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect.soft(f.harness.inspection.sdk.callsTo("system.config")).toHaveLength(2);
    expect.soft(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(2);
    expect(gate).toHaveBeenCalledTimes(3);
  });

  it("refreshes edited class files without refetching cached canonical source metadata", async () => {
    const f = setup(), root = mkdtempSync(join(tmpdir(), "tavern-cached-source-")); roots.push(root);
    f.bb.sdk.projects.get = async () => ({ sources: [{ path: root, hostId: "host", isDefault: true }] }) as never;
    await f.runtime.prepareRegistry("project");
    mkdirSync(join(root, ".agents/tavern/classes"), { recursive: true });
    writeFileSync(join(root, ".agents/tavern/classes/ranger.md"), readFileSync(new URL("../../classes/ranger.md", import.meta.url), "utf8").replace("label: Ranger", "label: Updated scout"));
    f.runtime.registry.invalidate();
    const refreshed = await f.runtime.prepareRegistry("project");
    expect(refreshed.classes.find(role => role.id === "ranger")?.label).toBe("Updated scout");
    expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(1);
  });

  it("shares one in-flight source lookup between concurrent callers", async () => {
    const f = setup();
    let finish!: (project: never) => void;
    const project = new Promise<never>(resolve => { finish = resolve; });
    f.bb.sdk.projects.get = vi.fn(() => project);
    const first = f.runtime.prepareRegistry("project"), second = f.runtime.prepareRegistry("project");
    finish({ sources: [] } as never);
    await Promise.all([first, second]);
    expect(f.harness.inspection.sdk.callsTo("system.config")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("projects.get")).toHaveLength(1);
  });
});
