// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerScopes } from "../../src/scope";
import { ScopeStore, armScope } from "../../src/scope/store";
import { linkedWorktree } from "./git-fixture";
import extension from "../../adapters/pi/extension";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-rebind-")); roots.push(root);
  const envs = new Map<string, Function>();
  let paths: () => { worktree?: string; threadStorage?: string } | Promise<{ worktree?: string; threadStorage?: string }> = () => ({});
  const bb = { providers: { experimental_contributeEnv: (id: string, fn: Function) => envs.set(id, fn) }, events: { on: vi.fn() }, onDispose: vi.fn(), log: { warn: vi.fn() } } as unknown as BbPluginApi;
  const start = () => registerScopes(bb, { dataDir: root, policyOptions: { home: root }, installGuard: false, onViolation: vi.fn(), pathsForThread: () => paths() });
  return { root, start, envs, setPaths: (fn: typeof paths) => { paths = fn; } };
}
it("writes pending scopes without storage lookup, then binds before returning any provider env", async () => {
  const f = fixture(), scopes = f.start(), storage = join(f.root, "storage");
  const initial = scopes.resolve("ranger", {}, { tools: { deny: ["web_*"] }, writes: { deny: ["${threadStorage}/private"] } }).scope;
  await scopes.writeScope("t1", initial);
  expect(scopes.status().threads[0].scope?.env.variables.BB_THREAD_STORAGE).toBeUndefined();
  f.setPaths(async () => ({ threadStorage: storage }));
  for (const resolver of f.envs.values()) {
    const env = Object.fromEntries((await resolver({ threadId: "t1" })).map((entry: any) => [entry.name, entry.value]));
    expect(env.BB_THREAD_STORAGE).toBe(storage); expect(env.TAVERN_SCOPE_FILE).toBe(join(f.root, "scopes/t1.json"));
  }
  const rebound = scopes.status().threads[0].scope!;
  expect(rebound.writes.allow).toContain(storage); expect(rebound.writes.deny).toContain(join(storage, "private")); expect(rebound.tools.deny).toContain("web_*");
});
it("persists the exact approved template across reload and live overrides without resolving policy again", async () => {
  const f = fixture(), first = f.start(), { worktree } = linkedWorktree(f.root);
  await first.writeScope("t1", first.resolve("smith", {}, { tools: { deny: ["web_*"] } }).scope);
  await first.applyOverride("t1", { allowRules: ["git-push-main"], writes: { deny: ["${threadStorage}/private"] } }, { approvedRuleIds: ["git-push-main"] });
  const scopes = f.start(); f.setPaths(() => ({ worktree, threadStorage: join(f.root, "storage") }));
  const bound = await scopes.rebindScope("t1");
  expect(bound.expectedWorktree).toBe(worktree); expect(bound.writes.allow).toContain(join(f.root, "storage")); expect(bound.tools.deny).toContain("web_*");
  expect(bound.writes.deny).toContain(join(f.root, "storage/private")); expect(bound.shell.allow.some(rule => rule.id === "git-push-main")).toBe(true);
  await scopes.applyOverride("t1", { tools: { deny: ["cortex_*"] } });
  const policyDir = join(f.root, ".agents/tavern"); mkdirSync(policyDir, { recursive: true }); writeFileSync(join(policyDir, "scopes.yml"), "not a valid scope policy");
  const reloaded = f.start(); const again = await reloaded.rebindScope("t1");
  expect(again.tools.deny).toEqual(expect.arrayContaining(["web_*", "cortex_*"])); expect(again.shell.allow.some(rule => rule.id === "git-push-main")).toBe(true);
});
it("keeps the scope file readable by pi and does not change its identity on a no-op rebind", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}).scope);
  const file = join(f.root, "scopes/t1.json"), before = readFileSync(file, "utf8"); armScope(file, scopes.status().threads[0].scope!);
  await scopes.rebindScope("t1"); expect(readFileSync(file, "utf8")).toBe(before); expect(new ScopeStore(f.root).isArmed("t1")).toBe(true);
  vi.stubEnv("TAVERN_SCOPE_FILE", file); vi.stubEnv("BB_THREAD_ID", "t1");
  const handlers = new Map<string, Function>(); extension({ on: (name, fn) => { handlers.set(name, fn); }, getActiveTools: () => ["read", "bash", "journal", "tavern_report"], setActiveTools: vi.fn() });
  handlers.get("session_start")!({}, { cwd: f.root }); expect(handlers.get("tool_call")!({ toolName: "read", input: {} }, { cwd: f.root })).toBeUndefined();
});
it("retains scope identity on failure and refuses sensitive acts until repaired", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}).scope);
  f.setPaths(() => { throw new Error("storage unavailable"); });
  const env = await f.envs.get("pi")!({ threadId: "t1" }); expect(env.some((entry: any) => entry.name === "TAVERN_SCOPE_FILE")).toBe(true);
  expect(scopes.status().threads[0].error).toContain("storage unavailable");
  const restored = f.start(); expect(restored.status().threads[0].error).toContain("storage unavailable");
  vi.stubEnv("TAVERN_SCOPE_FILE", join(f.root, "scopes/t1.json")); vi.stubEnv("BB_THREAD_ID", "t1");
  const handlers = new Map<string, Function>(); extension({ on: (name, fn) => { handlers.set(name, fn); }, getActiveTools: () => ["read", "journal", "tavern_report"], setActiveTools: vi.fn() });
  expect(handlers.get("tool_call")!({ toolName: "read", input: {} }, { cwd: f.root })).toBeUndefined();
  expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, { cwd: f.root })).toMatchObject({ block: true });
  f.setPaths(() => ({ threadStorage: join(f.root, "storage") })); await f.envs.get("pi")!({ threadId: "t1" }); expect(restored.status().threads[0].error).toBeUndefined();
});
it("does not resurrect a released scope when an awaited path lookup finishes", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}).scope);
  let finish!: (paths: { threadStorage: string }) => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.setPaths(() => { began(); return new Promise(resolve => { finish = resolve; }); });
  const pending = scopes.rebindScope("t1"); await started; scopes.clearScope("t1"); finish({ threadStorage: join(f.root, "storage") });
  await expect(pending).rejects.toThrow(/released/); expect(scopes.status().threads).toEqual([]);
});
it("keeps launch-time mode changes and enforcement boundaries during an awaited rebind", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}).scope); scopes.setMode("off");
  let finish!: (paths: {}) => void, began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  f.setPaths(() => { began(); return new Promise(resolve => { finish = resolve; }); }); const pending = scopes.rebindScope("t1"); await started;
  scopes.setMode("enforce"); const boundary = scopes.status().threads[0].scope!.enforceFrom; finish({});
  const rebound = await pending; expect(rebound.mode).toBe("enforce"); expect(rebound.enforceFrom).toBe(boundary);
});
it("bounds a hanging env rebind to two seconds, retains FILE, and discards late results", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}).scope); vi.useFakeTimers();
  let finish!: (paths: { threadStorage: string }) => void;
  f.setPaths(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.envs.get("pi")!({ threadId: "t1" }); await vi.advanceTimersByTimeAsync(2000);
  const env = await pending; expect(env.some((entry: any) => entry.name === "TAVERN_SCOPE_FILE")).toBe(true); expect(scopes.status().threads[0].error).toContain("timed out");
  const file = join(f.root, "scopes/t1.json"), failed = readFileSync(file, "utf8");
  finish({ threadStorage: join(f.root, "late") }); await vi.runAllTimersAsync(); expect(readFileSync(file, "utf8")).toBe(failed);
  f.setPaths(() => ({ threadStorage: join(f.root, "storage") })); await f.envs.get("pi")!({ threadId: "t1" }); expect(scopes.status().threads[0].error).toBeUndefined();
});
it("can retry even when a timed-out path lookup never returns", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}).scope); vi.useFakeTimers();
  f.setPaths(() => new Promise(() => {})); const first = f.envs.get("pi")!({ threadId: "t1" }); await vi.advanceTimersByTimeAsync(2000); await first;
  f.setPaths(() => ({ threadStorage: join(f.root, "storage") })); const retry = f.envs.get("pi")!({ threadId: "t1" }); await vi.advanceTimersByTimeAsync(2000); await retry;
  expect(scopes.status().threads[0].error).toBeUndefined(); expect(scopes.status().threads[0].scope?.env.variables.BB_THREAD_STORAGE).toBe(join(f.root, "storage"));
});
it("includes queue wait in the env deadline and never commits a timed-out override", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("t1", scopes.resolve("ranger", {}, { tools: { deny: ["web_*"] } }).scope); vi.useFakeTimers();
  let finish!: (paths: { threadStorage: string }) => void, began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const paths = vi.fn(() => { began(); return new Promise<{ threadStorage: string }>(resolve => { finish = resolve; }); }); f.setPaths(paths);
  const narrowing = expect(scopes.applyOverride("t1", { tools: { deny: ["cortex_*"] } })).rejects.toThrow("timed out"); await started;
  const env = f.envs.get("pi")!({ threadId: "t1" }); await vi.advanceTimersByTimeAsync(2000); expect((await env)[0].name).toBe("TAVERN_SCOPE_FILE");
  finish({ threadStorage: join(f.root, "storage") }); await narrowing; await vi.runAllTimersAsync();
  expect(paths).toHaveBeenCalledOnce(); expect(scopes.status().threads[0].scope?.tools.deny).toContain("web_*");
});
it("does not invent missing legacy allowances or access paths for unscoped threads", async () => {
  const f = fixture(), initial = f.start();
  const legacy = { ...initial.resolve("ranger", {}).scope, threadId: "legacy", issuedAt: Date.now(), writes: { mode: "none" as const, allow: [], deny: [] } };
  new ScopeStore(f.root).write("legacy", legacy); const scopes = f.start(), paths = vi.fn(() => ({ threadStorage: join(f.root, "storage") })); f.setPaths(paths);
  expect((await scopes.rebindScope("legacy")).writes.allow).toEqual([]); expect(scopes.status().threads[0].hasTemplate).toBe(false);
  expect(await f.envs.get("pi")!({ threadId: "unscoped" })).toEqual([]); expect(await f.envs.get("pi")!({ threadId: null })).toEqual([]); expect(paths).not.toHaveBeenCalled();
});
it("retains binding failures across mode changes and rejects a different provisioned root", async () => {
  const f = fixture(), scopes = f.start(), { worktree } = linkedWorktree(f.root);
  f.setPaths(() => ({ worktree })); await scopes.writeScope("t1", scopes.resolve("smith", {}).scope);
  const other = join(f.root, "other"); mkdirSync(other); f.setPaths(() => ({ worktree: other }));
  await f.envs.get("pi")!({ threadId: "t1" }); expect(scopes.status().threads[0].error).toBeTruthy(); scopes.setMode("watch"); expect(f.start().status().threads[0].error).toBeTruthy();
});
