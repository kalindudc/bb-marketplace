// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerScopes } from "../../src/scope";
import { evaluate } from "../../src/scope/engine";
import { ScopeStore } from "../../src/scope/store";
import { scopeForClass } from "../../src/scope/presets";
import type { RemoteScopeObservation } from "../../src/scope/watch";

it("never uses controller-local arming for remote status and exposes durable observation holds", () => {
  const home = mkdtempSync(join(tmpdir(), "tavern-remote-status-"));
  const store = new ScopeStore(home); store.write("remote", { ...scopeForClass("ranger"), threadId: "remote", issuedAt: 1 });
  const spy = vi.spyOn(ScopeStore.prototype, "isArmed").mockImplementation(() => { throw new Error("Local PID probe"); });
  try {
    const remoteForThread = vi.fn<() => RemoteScopeObservation | undefined>(() => ({ kind: "unavailable", reason: "Host reconnecting" }));
    const bb = { providers: { experimental_contributeEnv: vi.fn() }, events: { on: vi.fn() }, onDispose: vi.fn() } as unknown as BbPluginApi;
    const scopes = registerScopes(bb, { dataDir: home, policyOptions: { home }, guard: { agentDir: join(home, ".pi/agent") }, installGuard: false, pathsForThread: () => ({}), onViolation: vi.fn(), remoteForThread });
    expect(scopes.status().threads[0].armed).toBe(false); expect(spy).not.toHaveBeenCalled();
    remoteForThread.mockImplementation(() => { throw new Error("Lookup unavailable"); }); expect(scopes.status().threads[0].armed).toBe(false); expect(spy).not.toHaveBeenCalled();
    store.saveObservationHold({ threadId: "remote", providerId: "pi", eventId: "event", seq: 1, at: 1, reason: "Inspection unavailable" });
    expect(scopes.observationHolds("remote")).toMatchObject([{ threadId: "remote", seq: 1 }]);
    scopes.clearScope("remote"); expect(scopes.observationHolds("remote")).toEqual([]);
  } finally { spy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});
it("registers all providers, writes before resolving env and gates live widening", async () => {
  const home = mkdtempSync(join(tmpdir(), "tavern-register-"));
  try {
    const worktree = join(home, "work"); mkdirSync(worktree);
    const resolvers = new Map<string, Function>(), handlers = new Map<string, Function>();
    const bb = { providers: { experimental_contributeEnv: (id: string, fn: Function) => resolvers.set(id, fn) }, events: { on: (name: string, fn: Function) => handlers.set(name, fn) }, onDispose: vi.fn() } as unknown as BbPluginApi;
    let provisioned = false;
    const scopes = registerScopes(bb, { dataDir: home, policyOptions: { home }, guard: { agentDir: join(home, ".pi/agent") }, installGuard: false, onViolation: vi.fn(), pathsForThread: () => ({ worktree: provisioned ? worktree : undefined }), projectForThread: () => ({ projectRoot: worktree }) });
    expect([...resolvers.keys()]).toEqual(["pi", "claude-code", "codex"]);
    for (const resolver of resolvers.values()) expect(await resolver({ threadId: "t1" })).toEqual([]);
    const written = await scopes.writeScope("t1", scopes.resolve("smith", { projectRoot: worktree }).scope);
    expect(written.writes.allow).toContain("${worktree}");
    for (const resolver of resolvers.values()) expect((await resolver({ threadId: "t1" }))[0].name).toBe("TAVERN_SCOPE_FILE");
    const requested = await scopes.applyOverride("t1", { allowRules: ["git-push-main"] });
    expect(requested.widenings).toEqual(["git-push-main"]);
    expect(requested.scope.writes.allow).toContain("${worktree}");
    provisioned = true;
    const approved = await scopes.applyOverride("t1", { allowRules: ["git-push-main"] }, { approvedRuleIds: ["git-push-main"] });
    expect(approved.widenings).toEqual([]);
    expect(evaluate(approved.scope, { kind: "bash", toolName: "bash", input: { command: "git push origin main" }, cwd: worktree }).allow).toBe(true);
    expect(scopes.status().threads).toHaveLength(1);
    await handlers.get("thread.archived")!({ thread: { id: "t1" } });
    expect(scopes.status().threads).toHaveLength(1);
    expect(scopes.mode()).toBe("enforce");
    scopes.setMode("watch"); expect(scopes.status().mode).toBe("watch");
    expect(scopes.status().threads[0].scope?.mode).toBe("watch");
    scopes.setMode("off"); expect(scopes.status().threads[0].scope?.mode).toBe("off");
    await handlers.get("thread.deleted")!({ thread: { id: "t1" } });
    expect(scopes.status().threads).toEqual([]);
    expect(scopes.violations()).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
