// @vitest-environment node
import { seedQuest } from "./support";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput } from "./support";
import { dispatch049 } from "./dispatch-fixture";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { registerCli } from "../../src/server/cli";
import { provider } from "./provider-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Pass",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
async function fixture(installGuard = false) {
  const root = mkdtempSync(join(tmpdir(), "tavern-backend-scopes-"));
  roots.push(root);
  const work = join(root, "work"),
    storage = join(root, "thread-storage");
  mkdirSync(work);
  mkdirSync(storage);
  const f = setup({
    environments: {
      get: async () => ({
        hostId: "host",
        path: work,
        isGitRepo: true,
        isWorktree: true,
        environmentProviderId: "git-worktree",
      }),
    },
    projects: {
      get: async () => ({
        sources: [{ hostId: "host", path: work, isDefault: true }],
        gitRemoteUrl: "git@github.com:kalindudc/demo.git",
      }),
    },
  });
  f.bb.sdk.threads.get = async ({ threadId }) =>
    makeThreadResponse({ id: threadId, environmentId: "env" });
  f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: storage });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  f.bb.sdk.threads.spawn = vi.fn(async () =>
    makeThreadResponse({ id: "child", environmentId: "env", parentThreadId: "lead" }),
  );
  if (installGuard) mkdirSync(join(root, ".pi/agent"), { recursive: true });
  f.runtime.enableScopes({
    dataDir: root,
    installGuard,
    policyOptions: { home: root },
    guard: { agentDir: join(root, ".pi/agent") },
  });
  const q = await seedQuest(f.k,"lead", "A", "A");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: [
      { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] },
    ],
  });
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page");
  return {
    ...f,
    root,
    work,
    storage,
    q,
    input: { classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build", brief },
  };
}

describe("backend scope integration", () => {
  it("returns already in effect for scratch and own storage requests without opening an ask", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await expect(f.runtime.scopes!.override("lead", "child", { writes: { allow: ["/tmp/**", `${f.storage}/**`] } }, "Keep records")).resolves.toContain("already in effect");
    expect(f.runtime.scopes!.pending("child")).toBeNull();
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
  });
  it.each(["npm test", "node --test"])("rejects %s as a shell command, not a tool grant, without opening an ask", async command => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const before = f.runtime.scopes!.view("child")!.scope;
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { allow: [command] } }, "Run checks")).rejects.toThrow(`${command} is a shell command; the Smith preset already allows it`);
    expect(f.runtime.scopes!.pending("child")).toBeNull();
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "scope")).toHaveLength(0);
    expect(f.runtime.scopes!.view("child")!.scope).toEqual(before);
  });

  it("names the existing shell rule when a mistaken tool grant requests a blocked command", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { denyRules: [{ id: "no-tests", argv: ["npm", "test"], why: "Tests are outside this task" }] }, "Narrow tests");
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { allow: ["npm test"] } }, "Run checks")).rejects.toThrow(/shell command.*no-tests.*Tests are outside this task/);
    expect(f.runtime.scopes!.pending("child")).toBeNull();
  });

  it("refuses an unverified tool name and retains a valid existing tool pattern", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { allow: ["unknown_checking_tool"] } }, "Checks")).rejects.toThrow(/cannot verify.*unknown_checking_tool/i);
    await expect(f.runtime.scopes!.override("lead", "child", { tools: { deny: ["web_*"] } }, "No web")).resolves.toContain("Scope updated");
    expect(f.runtime.scopes!.pending("child")).toBeNull();
  });

  it("states that a denied widening preserves existing permissions in the answer and tick", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Optional push");
    const askId = f.k.store.runtime("child").scopePending!;
    const before = f.runtime.scopes!.view("child")!.scope;
    await f.runtime.answerAsk(askId, "deny", null, "page");
    expect(f.k.store.events("lead").find(event => event.type === "ask.answered" && event.data.askId === askId)?.text).toContain("does not forbid commands already allowed");
    expect(f.runtime.scopes!.view("child")!.scope).toEqual(before);
    const ask = f.k.store.get("asks", askId)!;
    expect(ask.options.find(option => option.id === "deny")?.detail).toContain("does not forbid commands already allowed");
    f.advance(120_000);
    await f.runtime.tick("lead");
    expect(JSON.stringify(f.harness.inspection.sdk.callsTo("threads.send"))).toContain("does not forbid commands already allowed");
  });

  it("refuses a rebrief held by a later scope ask without creating a zero-attempt pending delivery", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Requested push");
    expect(f.runtime.scopes!.pending("child")?.initialBrief).toBeNull();
    await expect(f.runtime.tell("lead", "child", "Review the new work")).rejects.toThrow("scope decision");
    expect(f.k.store.runtime("child").pendingBrief).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("counts scope-preflight failures against a pending rebrief's retry budget and opens its blocker", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("offline"));
    await f.runtime.tell("lead", "child", "Review the new work");
    vi.spyOn(f.runtime.scopes!, "ensure").mockRejectedValue(new Error("scope read unavailable"));
    for (let attempt = 1; attempt < 5; attempt++) {
      f.advance(3_600_000);
      await f.runtime.retryInitialBriefs("lead");
    }
    expect(f.k.store.runtime("child").pendingBrief).toMatchObject({ attempts: 5 });
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "blocker")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("spawns with the brief, records delivery once and never sends a duplicate initial brief", async () => {
    const f = await fixture();
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", f.input);
    const scope = JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8"));
    expect(scope).toMatchObject({ threadId: "child", preset: "worktree" });
    expect(scope.writes.allow).toContain(realpathSync(f.work));
    expect(f.k.member("child")?.keeperThreadId).toBe("lead");
    expect(f.bb.sdk.threads.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ input: [expect.objectContaining({ type: "text", text: expect.stringContaining(brief.outcome) })], permissionMode: "full" }),
    );
    expect(f.bb.sdk.threads.spawn).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.any(String) }),
    );
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    expect(f.k.store.runtime("child").briefVersion).toBe(1);
    expect(f.runtime.scopes!.api.status().installation).toBe("disabled");
  });
  it("keeps scope-managed native permissions within the provider's supported modes", async () => {
    const f = await fixture();
    f.bb.sdk.providers.list = async () => [provider("pi", ["auto"])];
    await f.runtime.hire("lead", "project", f.input);
    expect(f.bb.sdk.threads.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
  });
  it("persists a late-bound worktree for a child whose spawn brief is queued before provisioning", async () => {
    const f = await fixture();
    f.bb.sdk.threads.get = async ({ threadId }) =>
      makeThreadResponse({ id: threadId, environmentId: threadId === "child" ? null : "env" });
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", f.input);
    const scope = JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8"));
    expect(scope.writes.allow).toContain("${worktree}");
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    expect(f.harness.inspection.sdk.callsTo("threads.restoreEnvironment")).toHaveLength(0);
  });
  it("holds a widening hire, requires an actual ask answer and remembers only with explicit repo consent", async () => {
    const f = await fixture();
    registerTools(f.bb, f.runtime);
    registerRpc(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool(
      "tavern_hire",
      { ...f.input, scope: { allowRules: ["git-push-main"] } },
      { threadId: "lead" },
    );
    expect(text).toContain("Awaiting scope approval");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    const ask = f.k.store.openAsks("lead").find((a) => a.kind === "scope")!;
    expect(ask.proceedAt).toBeNull();
    expect(f.runtime.scopes!.api.status().threads[0]!.scope!.shell.allow).toHaveLength(0);
    await f.harness.invokeRpc("answerAsk", {
      askId: ask.id,
      optionId: "remember-repo",
      note: null,
      via: "page",
    });
    expect(
      f.runtime
        .scopes!.api.status()
        .threads[0]!.scope!.shell.allow.some((rule) => rule.id === "git-push-main"),
    ).toBe(true);
    const remembered = readFileSync(join(f.root, ".agents/tavern/scopes.yml"), "utf8");
    expect(remembered).toContain("git-push-main");
    expect(remembered).toContain("github.com/kalindudc/demo");
    expect(existsSync(join(f.work, ".agents/tavern/scopes.yml"))).toBe(false);
    const childSends = () =>
      f.harness.inspection.sdk
        .callsTo("threads.send")
        .filter((call) => (call.args[0] as { threadId: string }).threadId === "child");
    expect(childSends()).toHaveLength(0);
    expect(f.k.store.get("scopeRequests", ask.id)?.state).toBe("applied");
    await f.harness.invokeRpc("answerAsk", {
      askId: ask.id,
      optionId: "remember-repo",
      note: null,
      via: "page",
    });
    expect(childSends()).toHaveLength(0);
  });
  it("applies safe narrowing immediately, refuses foreign members and withholds an unapproved widening", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerTools(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool(
      "tavern_scope",
      {
        memberThreadId: "child",
        reason: "Push a private repository",
        override: { allowRules: ["git-push-main"], tools: { deny: ["web_*"] } },
      },
      { threadId: "lead" },
    );
    expect(text).toContain("scope");
    let scope = f.runtime.scopes!.api.status().threads[0]!.scope!;
    expect(scope.tools.deny).toContain("web_*");
    expect(scope.shell.allow).toHaveLength(0);
    expect(
      await f.runtime.dispatch(dispatch049({ threadId: "child", pluginId: "tavern" })),
    ).toEqual({ action: "proceed" });
    const ask = f.k.store.openAsks("lead").find((a) => a.kind === "scope")!;
    await f.runtime.answerAsk(ask.id, "deny", null, "page");
    scope = f.runtime.scopes!.api.status().threads[0]!.scope!;
    expect(scope.shell.allow).toHaveLength(0);
    expect(scope.tools.deny).toContain("web_*");
    f.k.bind("other", "keeper", "moss", "project");
    await expect(f.runtime.scopes!.override("other", "child", {}, "No")).rejects.toThrow(
      "own party",
    );
  });
  it("writes typed thread scopes before admission and waits instead of launching on a path failure", async () => {
    const f = await fixture();
    const ctx = dispatch049({
      threadId: "typed",
      status: "pending",
      submission: { pluginId: "tavern", data: { classId: "ranger" } },
    });
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(
      f.runtime.scopes!.api.status().threads.find((row) => row.threadId === "typed")?.scope?.preset,
    ).toBe("readonly");
    f.bb.sdk.threads.storageLocation = async () => {
      throw new Error("storage unavailable");
    };
    const fail = dispatch049({
      threadId: "cold",
      status: "pending",
      submission: { pluginId: "tavern", data: { classId: "ranger" } },
    });
    expect(await f.runtime.dispatch(fail)).toMatchObject({
      action: "wait",
      reason: expect.stringContaining("scope"),
    });
  });
  it.each(["wanderer", null])(
    "leaves a directly started %s unscoped without reading scope paths",
    async (classId) => {
      const f = await fixture();
      const shouldScope = vi.spyOn(f.runtime.scopes!.api, "shouldScope");
      const writeScope = vi.spyOn(f.runtime.scopes!.api, "writeScope");
      f.bb.sdk.threads.storageLocation = vi.fn(async () => {
        throw new Error("No scope paths for a direct general-purpose thread");
      });
      const ctx = dispatch049({
        threadId: "direct",
        status: "pending",
        submission: classId ? { pluginId: "tavern", data: { classId } } : null,
      });
      expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
      await f.runtime.threadStarted(
        makeThreadResponse({ id: "direct", environmentId: "env", status: "active" }),
      );
      if (classId) expect(shouldScope).toHaveBeenCalledWith(classId, "direct");
      expect(writeScope).not.toHaveBeenCalled();
      expect(f.bb.sdk.threads.storageLocation).not.toHaveBeenCalled();
      expect(existsSync(join(f.root, "scopes/direct.json"))).toBe(false);
      expect(f.k.member("direct")?.role ?? null).toBe(classId ? "solo" : null);
    },
  );
  it("scopes a hired Wanderer before its brief and retains hire origin on later dispatch", async () => {
    const f = await fixture();
    const shouldScope = vi.spyOn(f.runtime.scopes!.api, "shouldScope");
    f.bb.sdk.threads.send = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
    await f.runtime.hire("lead", "project", {
      classId: "wanderer",
      boardQuestId: null,
      waypointId: null,
      errand: true,
      title: "Answer a side question",
      brief,
    });
    expect(shouldScope).toHaveBeenCalledWith("wanderer", "hire");
    const scope = JSON.parse(readFileSync(join(f.root, "scopes/child.json"), "utf8"));
    expect(scope).toMatchObject({ preset: "open", sandbox: false, writes: { mode: "any" } });
    expect(scope.writes.deny.length).toBeGreaterThan(0);
    expect(f.bb.sdk.threads.send).not.toHaveBeenCalled();
    f.runtime.scopes!.api.clearScope("child");
    shouldScope.mockClear();
    expect(
      await f.runtime.dispatch(dispatch049({ threadId: "child", pluginId: "tavern" })),
    ).toEqual({ action: "proceed" });
    expect(shouldScope).toHaveBeenCalledWith("wanderer", "hire");
    expect(f.runtime.scopes!.view("child")?.scope?.preset).toBe("open");
  });
  it("never treats a remote path or a shared Smith checkout as a local worktree", async () => {
    const f = await fixture();
    f.bb.sdk.environments.get = async () =>
      ({ hostId: "remote", path: f.work, isGitRepo: true, isWorktree: true, environmentProviderId: "git-worktree", branchName: "main" }) as never;
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("server-local");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("records a violation as an external tick fact, opens only one blocker and exposes scope state in RPCs", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    const violation = {
      threadId: "child",
      providerId: "pi",
      at: f.time(),
      eventId: "blocked",
      seq: 3,
      ruleId: "git-push-main",
      reason: "Blocked push",
      stopped: false,
      stopError: "interrupt failed",
      latencyMs: 12,
    };
    await f.runtime.scopes!.violation(violation);
    await f.runtime.scopes!.violation(violation);
    expect(f.k.store.openAsks("lead").filter((a) => a.kind === "blocker")).toHaveLength(1);
    expect(f.k.store.events("lead").filter((e) => e.type === "scope.violation")).toHaveLength(1);
    expect(f.k.member("child")?.state).toBe("waiting");
    const decor = (await f.harness.invokeRpc("decor", { threadId: "child" })) as {
      scope: unknown;
      violations: unknown[];
    };
    expect(decor.scope).toMatchObject({ scope: { preset: "worktree" } });
    expect(decor.violations).toHaveLength(1);
    for (const method of ["ledger", "boardQuest"]) {
      const result = (await f.harness.invokeRpc(
        method,
        method === "ledger" ? { threadId: "lead" } : { id: f.q.id },
      )) as { scopes: unknown[]; violations: unknown[] };
      expect(result.scopes.length).toBeGreaterThan(0);
      expect(result.violations).toHaveLength(1);
    }
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc").length).toBeGreaterThan(0);
    f.k.store.patch("lead", { userAt: null });
    await f.runtime.tick("lead");
    const ticks = f.harness.inspection.sdk
      .callsTo("threads.send")
      .filter((call) => (call.args[0] as { threadId: string }).threadId === "lead");
    expect(JSON.stringify(ticks)).toContain("STOP FAILED");
  });
  it("allows policy-covered grants from trusted remotes without opening an ask", async () => {
    const f = await fixture();
    mkdirSync(join(f.root, ".agents/tavern"), { recursive: true });
    writeFileSync(
      join(f.root, ".agents/tavern/scopes.yml"),
      "v: 1\nrules:\n  - remote: github.com/kalindudc/*\n    classes:\n      smith:\n        keeperMayAllow: [git-push-main]\n",
    );
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    expect(f.k.store.openAsks("lead").filter((ask) => ask.kind === "scope")).toHaveLength(0);
    expect(f.runtime.scopes!.api.status().threads[0]!.scope!.shell.allow[0]?.id).toBe(
      "git-push-main",
    );
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("does not remember an allow-once answer and never exposes approval ids to tools", async () => {
    const f = await fixture();
    registerTools(f.bb, f.runtime);
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    expect(ask.scopeChange).toMatchObject({
      memberThreadId: "child",
      override: { allowRules: ["git-push-main"] },
      widenings: ["git-push-main"],
      projectRoot: f.work,
    });
    expect(
      await f.runtime.dispatch(dispatch049({ threadId: "child", pluginId: "tavern" })),
    ).toMatchObject({ action: "wait" });
    await f.runtime.answerAsk(ask.id, "approve", null, "page");
    expect(existsSync(join(f.work, ".agents/tavern/scopes.yml"))).toBe(false);
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_scope",
        {
          memberThreadId: "child",
          reason: "Forge",
          override: { approvedRuleIds: ["git-push-force"] },
        },
        { threadId: "lead" },
      ),
    ).rejects.toThrow();
  });
  it("declines a held hire without sending its brief or retaining its allocation", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    await f.runtime.answerAsk(ask.id, "deny", null, "page");
    expect(f.k.member("child")?.state).toBe("stopped");
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(0);
  });
  it("installs the marked shim at startup and exposes bounded scope, violation and guard CLI commands", async () => {
    const f = await fixture(true);
    registerCli(f.bb, f.runtime);
    expect(f.runtime.scopes!.api.status().installation).toBe("installed");
    const shim = join(f.root, ".pi/agent/extensions/tavern-guard/index.ts");
    expect(readFileSync(shim, "utf8")).toContain("adapters/pi/extension.ts");
    await f.runtime.hire("lead", "project", f.input);
    const cli = f.harness.inspection.registrations.cli[0]!;
    expect((await cli.run(["scope", "child"], {})).stdout).toContain("worktree");
    expect((await cli.run(["violations", "child"], {})).stdout).toContain("[]");
    expect((await cli.run(["guard", "status"], {})).stdout).toContain("installed");
    const refused = await cli.run(["guard", "uninstall"], { threadId: "lead" });
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(shim)).toBe(true);
    expect((await cli.run(["guard", "uninstall"], {})).exitCode).toBe(0);
    expect(existsSync(shim)).toBe(false);
    expect((await cli.run(["guard", "install"], {})).exitCode).toBe(0);
    expect(existsSync(shim)).toBe(true);
  });
  it("restores an approved pending scope after a retryable application failure", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    const apply = f.runtime.scopes!.api.applyOverride;
    f.runtime.scopes!.api.applyOverride = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockImplementation(apply);
    await expect(f.runtime.answerAsk(ask.id, "approve", null, "page")).rejects.toThrow(
      "disk unavailable",
    );
    expect(f.k.store.get("scopeRequests", ask.id)?.state).toBe("pending");
    await f.runtime.scopes!.resume("lead");
    expect(f.k.store.get("scopeRequests", ask.id)?.state).toBe("applied");
  });
  it("retains archived scopes and cursors, keeps unarchive scoped, and clears only on deletion", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.violation({
      threadId: "child",
      providerId: "pi",
      at: f.time(),
      eventId: "history",
      seq: 1,
      ruleId: "no-main",
      reason: "Main is protected",
      stopped: true,
      latencyMs: 2,
    });
    const file = join(f.root, "scopes/child.json");
    writeFileSync(file + ".cursor", JSON.stringify({ cursor: 17, pendingStop: false }));
    const before = readFileSync(file, "utf8");
    await f.runtime.threadLifecycle("thread.archived", {
      thread: makeThreadResponse({ id: "child", archivedAt: f.time(), environmentId: "env" }),
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(file + ".cursor", "utf8")).cursor).toBe(17);
    await f.runtime.threadLifecycle("thread.unarchived", {
      thread: makeThreadResponse({ id: "child", environmentId: "env" }),
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    f.runtime.updateThread(
      makeThreadResponse({ id: "child", archivedAt: f.time(), deletedAt: f.time() }),
    );
    expect(existsSync(file)).toBe(false);
    expect(f.runtime.scopes!.violations(["child"])).toHaveLength(1);
  });
  it("retains the scope when wrapping archives the party", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    f.k.store.patch("child", { archivePending: true });
    f.bb.sdk.threads.archive = vi.fn(async () => ({
      ok: true as const,
      archivedThreadIds: ["child"],
    }));
    await f.runtime.sweep();
    expect(f.bb.sdk.threads.archive).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.runtime.scopes!.view("child")).toMatchObject({ scope: { preset: "worktree" } });
  });
  it("returns only JSON values for a member hired before guard postures existed", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    const { guardPosture: _absent, ...member } = f.k.member("child")!;
    f.k.store.put("members", "child", member);
    const undefinedPaths = (value: unknown, path = "$"): string[] =>
      value === undefined
        ? [path]
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`))
          : [];
    expect(undefinedPaths(f.runtime.scopes!.view("child"))).toEqual([]);
  });
  it("pins an expected root after a deferred worktree becomes provisioned", async () => {
    const f = await fixture();
    let provisioned = false;
    f.bb.sdk.threads.get = async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        environmentId: threadId === "child" && !provisioned ? null : "env",
      });
    await f.runtime.hire("lead", "project", f.input);
    expect(f.runtime.scopes!.view("child")?.scope?.expectedWorktree).toBeUndefined();
    provisioned = true;
    await f.runtime.threadStarted(
      makeThreadResponse({ id: "child", environmentId: "env", status: "active" }),
    );
    expect(f.runtime.scopes!.view("child")?.scope?.expectedWorktree).toBe(realpathSync(f.work));
  });
  it("surfaces ignored class and project policy widening in member RPCs and hire notes", async () => {
    const f = await fixture();
    mkdirSync(join(f.work, ".agents/tavern"), { recursive: true });
    writeFileSync(
      join(f.work, ".agents/tavern/scopes.yml"),
      "v: 1\nrules:\n  - classes:\n      smith:\n        keeperMayAllow: [git-push-main]\n",
    );
    const snapshot = structuredClone(f.runtime.snapshot());
    snapshot.classes.find((role) => role.id === "smith")!.scope = "open";
    vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
    const hired = await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    expect(hired.executionNotes.join(" ")).toContain("Ignored class scope");
    const decor = (await f.harness.invokeRpc("decor", { threadId: "child" })) as {
      scope: { problems: string[]; mode: string };
    };
    expect(decor.scope.mode).toBe("enforce");
    expect(decor.scope).toHaveProperty("guard.sandbox");
    expect(
      decor.scope.problems.some((problem) => problem.includes("project policies may only narrow")),
    ).toBe(true);
    expect(decor.scope.problems.some((problem) => problem.includes("Ignored class scope"))).toBe(
      true,
    );
  });
  it("lets a human choose the trusted push destination when remembering a grant with several remotes", async () => {
    const f = await fixture();
    const context = {
      projectRoot: f.work,
      remotes: ["https://github.com/kalindudc/demo.git", "https://github.com/company/demo.git"],
    };
    vi.spyOn(f.runtime, "scopeProjectContext").mockReturnValue(context);
    await f.runtime.hire("lead", "project", {
      ...f.input,
      scope: { allowRules: ["git-push-main"] },
    });
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    const choice = ask.options.find((option) => option.label.includes("company/demo"))!;
    expect(choice).toBeDefined();
    await f.runtime.answerAsk(ask.id, choice.id, null, "page");
    const remembered = readFileSync(join(f.root, ".agents/tavern/scopes.yml"), "utf8");
    expect(remembered).toContain("github.com/company/demo");
    expect(remembered).not.toContain("kalindudc/demo");
  });
  it("returns watch-only observations in RPCs without opening blockers or marking the member waiting", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    registerRpc(f.bb, f.runtime);
    f.runtime.scopes!.api.setMode("watch");
    const observation = {
      threadId: "child",
      providerId: "pi",
      at: f.time(),
      eventId: "observed",
      seq: 9,
      ruleId: "no-main",
      reason: "Observed",
      mode: "watch",
      stopped: false,
      latencyMs: 1,
    };
    writeFileSync(join(f.root, "scope-violations.jsonl"), JSON.stringify(observation) + "\n");
    const decor = (await f.harness.invokeRpc("decor", { threadId: "child" })) as {
      violations: (typeof observation)[];
    };
    expect(decor.violations).toHaveLength(1);
    expect(decor.violations[0]!.mode).toBe("watch");
    expect(f.k.store.openAsks("lead").filter((ask) => ask.kind === "blocker")).toHaveLength(0);
    expect(f.k.member("child")?.state).toBe("idle");
  });
  it("clears a pending scope request only after quest Stop is confirmed", async () => {
    const f = await fixture();
    registerRpc(f.bb, f.runtime);
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override("lead", "child", { allowRules: ["git-push-main"] }, "Requested push");
    const askId = f.k.store.runtime("child").scopePending!;
    expect(f.k.store.get("scopeRequests", askId)?.state).toBe("pending");
    expect(f.k.store.get("asks", askId)?.state).toBe("open");
    const get = f.bb.sdk.threads.get;
    let status: "active" | "idle" = "active";
    f.bb.sdk.threads.get = async args => ({
      ...(await get(args)),
      status: args.threadId === "child" ? status : "idle",
    });
    expect(await f.harness.invokeRpc("stopBoardQuest", { id: f.q.id })).toEqual({ phase: "stopping", unconfirmed: 1 });
    expect(f.k.store.runtime("child").scopePending).toBe(askId);
    expect(f.k.store.get("scopeRequests", askId)?.state).toBe("pending");
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(1);
    status = "idle";
    f.advance(5000);
    await f.runtime.retryStops("lead");
    expect(f.k.quest(f.q.id).phase).toBe("stopped");
    expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(0);
    expect(f.k.store.get("scopeRequests", askId)?.state).toBe("declined");
    expect(f.k.store.runtime("child").scopePending).toBeNull();
    expect(f.runtime.scopes!.pending("child")).toBeNull();
    expect(f.k.store.get("asks", askId)?.state).toBe("withdrawn");
  });
  it("clears a released member's scope only after stop confirmation and withdraws pending scope asks", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    await f.runtime.scopes!.override(
      "lead",
      "child",
      { allowRules: ["git-push-main"] },
      "Requested push",
    );
    const ask = f.k.store.openAsks("lead").find((ask) => ask.kind === "scope")!;
    const get = f.bb.sdk.threads.get;
    let status = "active" as "active" | "idle";
    f.bb.sdk.threads.get = async (args) => ({
      ...(await get(args)),
      status: args.threadId === "child" ? status : "idle",
    });
    expect(await f.runtime.release("lead", "child", "Replace it")).toBe(false);
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(1);
    status = "idle";
    await f.runtime.sweep();
    expect(f.runtime.scopes!.api.status().threads).toHaveLength(0);
    expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
    expect(f.k.store.runtime("child").scopePending).toBeNull();
  });
});
