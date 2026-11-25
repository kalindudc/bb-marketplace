// @vitest-environment node
import { runtimeFixture } from "./member-fixture";
import { seedQuest } from "./support";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { TavernRuntime } from "../../src/server/runtime";
import { scopeFileSchema } from "../../src/scope";
import { linkedWorktree } from "../scope/git-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { inputText } from "../../src/server/dispatch";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(parentProvider: "git-worktree" | "project-checkout" = "git-worktree") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tavern-pending-scope-")));
  roots.push(root);
  const { main, worktree } = linkedWorktree(root);
  const storage = join(root, "storage");
  mkdirSync(storage);
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>([
    ["lead", makeThreadResponse({ id: "lead", environmentId: parentProvider === "project-checkout" ? "parent-env" : "env" })],
  ]);
  const unavailable = () => Object.assign(
    new Error("HTTP 409: Thread environment is unavailable"),
    { name: "BbHttpError", status: 409 },
  );
  const environment = vi.fn(async ({ environmentId }: { environmentId: string }) => {
    if (!environmentId || ![...threads.values()].some(t => t.environmentId === environmentId))
      throw unavailable();
    if (environmentId === "parent-env")
      return { id: environmentId, hostId: "host", path: main, isGitRepo: true, isWorktree: false, environmentProviderId: "project-checkout", branchName: "main" };
    return { id: environmentId, hostId: "host", path: worktree, isGitRepo: true, isWorktree: true, environmentProviderId: "git-worktree", branchName: "main" };
  });
  const f = setup({
    environments: { get: environment },
    projects: { get: async () => ({ sources: [{ hostId: "host", path: parentProvider === "project-checkout" ? main : worktree, isDefault: true }] }) },
  });
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => threads.get(threadId) ?? makeThreadResponse({ id: threadId }));
  f.bb.sdk.threads.storageLocation = vi.fn(async ({ threadId }) => {
    if (!threads.get(threadId)?.environmentId) throw unavailable();
    return { hostId: "host", storageRootPath: storage };
  });
  f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
  function pending(threadId: string) {
    const thread = makeThreadResponse({ id: threadId, status: "pending", environmentId: null });
    threads.set(threadId, thread);
    return thread;
  }
  async function firstTurn(runtime: TavernRuntime, threadId: string, bindingReady = true) {
    threads.set(threadId, makeThreadResponse({ id: threadId, status: "starting", environmentId: "env" }));
    const ctx = makePluginAgentConfigurationContext({ thread: { id: threadId } });
    ctx.environment.path = worktree;
    runtime.configure(ctx);
    const contributor = vi.mocked(f.bb.providers.experimental_contributeEnv).mock.calls
      .filter(([providerId]) => providerId === "pi").at(-1)![1];
    const env = await contributor({ threadId, projectId: "project", hostId: "host" });
    const file = env.find(entry => entry.name === "TAVERN_SCOPE_FILE")?.value;
    expect(typeof file).toBe("string");
    const scope = scopeFileSchema.parse(JSON.parse(readFileSync(file as string, "utf8")));
    if (bindingReady) {
      expect(scope.env.variables.BB_THREAD_STORAGE).toBe(storage);
      expect(env).toContainEqual(expect.objectContaining({ name: "BB_THREAD_STORAGE", value: storage }));
      expect(scope.bindingError).toBeUndefined();
    } else {
      expect(scope.bindingError).toContain("storage unavailable");
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let active = ["read", "write", "bash", "journal", "tavern_report"];
    const pi: PiGuardApi = {
      on: (name, handler) => handlers.set(name, handler as (...args: unknown[]) => unknown),
      getActiveTools: () => [...active],
      setActiveTools: names => { active = [...names]; },
    };
    vi.stubEnv("TAVERN_SCOPE_FILE", file as string);
    vi.stubEnv("BB_THREAD_ID", threadId);
    vi.spyOn(process, "cwd").mockReturnValue(worktree);
    guard(pi);
    handlers.get("session_start")!({}, { cwd: worktree });
    handlers.get("before_agent_start")!({}, { cwd: worktree });
    const call = (toolName: string, input: Record<string, unknown>) =>
      handlers.get("tool_call")!({ toolName, input }, { cwd: worktree });
    const read = call("read", { path: join(worktree, "README.md") });
    expect(read).toBeUndefined();
    if (!bindingReady) expect(call("bash", { command: "git push origin main" })).toMatchObject({ block: true });
    expect(call("write", { path: file, content: "tamper" })).toMatchObject({ block: true });
    threads.set(threadId, makeThreadResponse({ id: threadId, status: "active", environmentId: "env" }));
    await runtime.threadStarted(threads.get(threadId)!);
    return { scope, env, call };
  }
  return { ...f, root, worktree, storage, threads, pending, firstTurn, environment };
}

describe("scope admission across provisioning", () => {
  it.each([
    ["wanderer", "git-worktree"],
    ["ranger", "git-worktree"],
    ["smith", "git-worktree"],
    ["smith", "project-checkout"],
  ] as const)("spawns a %s from %s and scopes its first turn before spawn returns", async (classId, parentProvider) => {
    const f = fixture(parentProvider);
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    const brief = { outcome: "Investigate the crossword helper", mode: "make-it-work" as const, outOfScope: "Production", doneWhen: "Answer the question", context: [], questions: classId === "ranger" ? ["What must we build?"] : [], timeboxMinutes: classId === "ranger" ? 8 : null };
    let boardQuestId: string | null = null;
    if (classId === "smith") {
      const quest = await seedQuest(f.k,"lead", "Build", "Build");
      f.k.plan("lead", { ...planInput(quest.id), party: [{ classId, characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
      f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
      boardQuestId = quest.id;
    }
    f.bb.sdk.threads.spawn = vi.fn(async args => {
      if (!args.input?.length) throw Object.assign(new Error("HTTP 400: input must contain at least one entry"), { status: 400 });
      expect(args.input[0]).toMatchObject({ type: "text", text: expect.stringContaining(brief.outcome) });
      expect(args.pluginSubmission).toMatchObject({ pluginId: "tavern", data: { hireToken: expect.any(String) } });
      const child = f.pending("child");
      child.parentThreadId = "lead";
      const ctx = dispatch049({ threadId: child.id, status: "pending", pluginId: "tavern", submission: args.pluginSubmission });
      ctx.thread = child;
      ctx.input = { text: inputText(args.input), blocks: args.input };
      expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
      expect(f.k.store.runtime(child.id).briefVersion).toBe(1);
      expect(f.bb.sdk.threads.storageLocation).not.toHaveBeenCalled();
      if (classId === "smith") expect(args.environment).toMatchObject({ type: "provider", environmentProviderId: "git-worktree" });
      const { call } = await f.firstTurn(f.runtime, child.id);
      if (classId === "smith") expect(call("write", { path: join(f.worktree, "first-write"), content: "allowed" })).toBeUndefined();
      return f.threads.get(child.id)!;
    });
    const member = await f.runtime.hire("lead", "project", {
      classId, boardQuestId, waypointId: classId === "smith" ? "w1" : null,
      errand: classId !== "smith", title: "Investigate", brief,
    });
    expect(send).not.toHaveBeenCalled();
    expect(member.briefPending).toBe(false);
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toBeNull();
    expect(f.k.store.runtime(member.threadId).briefVersion).toBe(1);
  });

  it.each(["keeper", "ranger", "smith"])("starts a direct %s despite environment-bound 409s, with a guard before its first tool", async classId => {
    const f = fixture();
    const thread = f.pending("direct");
    await expect(f.bb.sdk.threads.storageLocation({ threadId: thread.id })).rejects.toThrow("HTTP 409");
    vi.mocked(f.bb.sdk.threads.storageLocation).mockClear();
    expect(await f.runtime.dispatch(dispatch049({
      threadId: thread.id, status: "pending", submission: { pluginId: "tavern", data: { classId } },
    }))).toEqual({ action: "proceed" });
    expect(f.bb.sdk.threads.storageLocation).not.toHaveBeenCalled();
    expect(f.environment).not.toHaveBeenCalled();
    const partial = scopeFileSchema.parse(JSON.parse(readFileSync(join(f.root, "scopes/direct.json"), "utf8")));
    expect(partial.env.variables.BB_THREAD_STORAGE).toBeUndefined();
    expect(partial.writes.allow).not.toContain(f.worktree);
    if (classId === "smith") expect(partial.writes.allow).toContain("${worktree}");
    const { scope, call } = await f.firstTurn(f.runtime, thread.id);
    if (classId === "keeper") {
      expect(scope.preset).toBe("open");
      expect(scope.writes.mode).toBe("any");
      expect(scope.env.variables.BB_THREAD_STORAGE).toBe(f.storage);
      expect(call("write", { path: join(f.storage, "note"), content: "ok" })).toBeUndefined();
    } else expect(scope.writes.allow).toContain(f.storage);
    if (classId === "smith") expect(call("write", { path: join(f.worktree, "new-file"), content: "ok" })).toBeUndefined();
  });

  it("keeps a pending hire scoped without resending spawn input and preserves its narrowing when the first session binds paths", async () => {
    const f = fixture();
    const q = await seedQuest(f.k,"lead", "Build", "Tests pass");
    f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
    f.bb.sdk.threads.spawn = vi.fn(async () => f.pending("child"));
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", {
      classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build",
      scope: { writes: { deny: ["${worktree}/restricted"] } },
      brief: { outcome: "Build", mode: "make-it-work", outOfScope: "Production", doneWhen: "Pass", context: [], questions: [], timeboxMinutes: null },
    });
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    const partial = scopeFileSchema.parse(JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8")));
    expect(partial.writes.allow).toContain("${worktree}");
    expect(partial.writes.deny).toContain("${worktree}/restricted");
    expect(f.bb.sdk.threads.storageLocation).not.toHaveBeenCalled();
    expect(await f.runtime.dispatch(dispatch049({ threadId: "child", status: "pending", pluginId: "tavern" }))).toEqual({ action: "proceed" });
    // The template must survive a plugin reload before the first provider session.
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    restarted.enableScopes({ dataDir: f.root, installGuard: false, policyOptions: { home: f.root } });
    const { scope, call } = await f.firstTurn(restarted, "child");
    expect(scope.writes.allow).toContain(f.storage);
    expect(scope.writes.deny).toContain(join(f.worktree, "restricted"));
    expect(call("write", { path: join(f.worktree, "restricted/file"), content: "no" })).toBeUndefined();
  });

  it("keeps the original spawn brief queued behind an exact scope ask and never sends it twice", async () => {
    const f = fixture();
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    let queued: ReturnType<typeof queued049> | null = null;
    let started = false;
    f.bb.sdk.threads.spawn = vi.fn(async args => {
      if (!args.input?.length) throw new Error("HTTP 400: input must contain at least one entry");
      const child = f.pending("child");
      child.parentThreadId = "lead";
      const ctx = dispatch049({ threadId: child.id, status: "pending", pluginId: "tavern", submission: args.pluginSubmission });
      ctx.thread = child;
      ctx.input = { text: inputText(args.input), blocks: args.input };
      expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: "Awaiting the user's scope decision" });
      queued = { ...queued049("spawn-input", ctx.input.text, f.time(), { pluginId: "tavern" }), threadId: child.id, content: args.input };
      expect(f.environment).toHaveBeenCalledTimes(2);
      expect(f.environment.mock.calls).toEqual([[{ environmentId: "env" }], [{ environmentId: "env" }]]);
      return child;
    });
    const member = await f.runtime.hire("lead", "project", {
      classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build",
      scope: { allowRules: ["git-push-main"] },
      brief: { outcome: "Build it", mode: "make-it-work", outOfScope: "Production", doneWhen: "Pass", context: [], questions: [], timeboxMinutes: null },
    });
    expect(member.pendingScopeAsk).toBeTruthy();
    expect(member.briefPending).toBe(true);
    expect(started).toBe(false);
    const recheck = vi.mocked(f.bb.experimental_hooks.recheck).mockImplementation(async () => {
      if (!queued) return;
      const row = queued;
      queued = null;
      const ctx = dispatch049({ threadId: "child", status: "pending", rows: [row] });
      ctx.thread = f.threads.get("child")!;
      expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
      await f.firstTurn(f.runtime, "child");
      started = true;
    });
    await f.runtime.answerAsk(member.pendingScopeAsk!, "approve", null, "page");
    await Promise.all(recheck.mock.results.map(result => result.value));
    expect(started).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(f.bb.sdk.threads.spawn).toHaveBeenCalledOnce();
    expect(f.k.store.runtime("child").briefVersion).toBe(1);
    expect(f.runtime.scopes!.api.status().threads.find(row => row.threadId === "child")!.scope!.shell.allow)
      .toContainEqual(expect.objectContaining({ id: "git-push-main" }));
  });

  it("retains the effective hire scope across a failed first scope write and queued retry without submission data", async () => {
    const f = fixture();
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
    let queued: ReturnType<typeof queued049>;
    f.bb.sdk.threads.spawn = vi.fn(async args => {
      if (!args.input?.length) throw new Error("HTTP 400: input must contain at least one entry");
      const child = f.pending("child");
      child.parentThreadId = "lead";
      const ctx = dispatch049({ threadId: child.id, status: "pending", pluginId: "tavern", submission: args.pluginSubmission });
      ctx.thread = child;
      ctx.input = { text: inputText(args.input), blocks: args.input };
      expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
      queued = { ...queued049("held-spawn", ctx.input.text, f.time(), { pluginId: "tavern" }), threadId: child.id, content: args.input };
      return child;
    });
    const write = vi.spyOn(f.runtime.scopes!.api, "writeScope").mockRejectedValue(new Error("scope disk unavailable"));
    await expect(f.runtime.hire("lead", "project", {
      classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build",
      scope: { writes: { deny: ["${worktree}/restricted"] } },
      brief: { outcome: "Build it", mode: "make-it-work", outOfScope: "Production", doneWhen: "Pass", context: [], questions: [], timeboxMinutes: null },
    })).rejects.toThrow("scope disk unavailable");
    write.mockRestore();
    let resumed = false;
    const recheck = vi.mocked(f.bb.experimental_hooks.recheck).mockImplementation(async () => {
      const ctx = dispatch049({ threadId: "child", status: "pending", rows: [queued] });
      ctx.thread = f.threads.get("child")!;
      expect(ctx.experimental_submission).toBeNull();
      expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
      const { scope } = await f.firstTurn(f.runtime, "child");
      expect(scope.writes.deny).toContain(join(f.worktree, "restricted"));
      resumed = true;
    });
    await f.runtime.reconcile();
    await Promise.all(recheck.mock.results.map(result => result.value));
    expect(resumed).toBe(true);
    expect(f.bb.sdk.threads.spawn).toHaveBeenCalledOnce();
  });

  it("retains the guard environment and holds a protected act when final storage binding fails", async () => {
    const f = fixture();
    f.pending("unbound");
    expect(await f.runtime.dispatch(dispatch049({
      threadId: "unbound", status: "pending", submission: { pluginId: "tavern", data: { classId: "keeper" } },
    }))).toEqual({ action: "proceed" });
    const storageLocation = f.bb.sdk.threads.storageLocation;
    f.bb.sdk.threads.storageLocation = vi.fn(async () => { throw new Error("storage unavailable"); });
    const { call } = await f.firstTurn(f.runtime, "unbound", false);
    expect(call("journal", {})).toBeUndefined();
    f.bb.sdk.threads.storageLocation = storageLocation;
    await f.firstTurn(f.runtime, "unbound");
  });

  it("rechecks old plugin-held pending starts during startup, preserving the original queued message", async () => {
    const f = fixture();
    f.pending("stuck");
    f.k.bind("stuck", "keeper", "moss", "project");
    const row = { ...queued049("original-row", "Keep the launch moving", f.time()), threadId: "stuck" };
    const recheck = vi.mocked(f.bb.experimental_hooks.recheck).mockImplementation(async () => {
      expect(await f.runtime.dispatch(dispatch049({ threadId: "stuck", status: "pending", rows: [row] })))
        .toEqual({ action: "proceed" });
    });
    await f.runtime.reconcile();
    expect(recheck).toHaveBeenCalledOnce();
    expect(f.k.store.runtime("stuck").pending).toContainEqual(expect.objectContaining({ text: "Keep the launch moving" }));
    await f.firstTurn(f.runtime, "stuck");
  });
});
