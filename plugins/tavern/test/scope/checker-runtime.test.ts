// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import extension from "../../adapters/pi/extension";
import { registerScopes } from "../../src/scope";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths, realPath } from "../../src/scope/paths";
import { ScopeStore } from "../../src/scope/store";
import { registerWatcher } from "../../src/scope/watch";
import { linkedWorktree } from "./git-fixture";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-checker-runtime-"))); roots.push(root);
  const { worktree, git } = linkedWorktree(root), ownCwd = join(root, "warden"), scratch = join(root, "scratch"); mkdirSync(ownCwd); mkdirSync(scratch);
  writeFileSync(join(worktree, ".gitignore"), "coverage/\n"); git(worktree, "add", ".gitignore");
  const store = new ScopeStore(root), scope = { ...bindPaths({ ...scopeForClass("warden"), threadId: "t1", issuedAt: 1 }, { home: root, tmp: [scratch], scopesDir: store.directory }, realPath), checks: { worktree, commands: ["node --test"] } };
  store.write("t1", scope);
  return { root, worktree, ownCwd, scratch, store, scope };
}
it("arms in the Warden environment but checks and sandboxes against the different maker root", () => {
  const f = fixture(); vi.stubEnv("TAVERN_SCOPE_FILE", f.store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const handlers = new Map<string, Function>(); extension({ on: (name, fn) => { handlers.set(name, fn); }, getActiveTools: () => ["bash", "read", "journal", "tavern_report"], setActiveTools: vi.fn() });
  handlers.get("session_start")!({}, { cwd: f.ownCwd }); expect(f.store.isArmed("t1")).toBe(true);
  expect(handlers.get("tool_call")!({ toolName: "read", input: { path: "x" } }, { cwd: f.ownCwd })).toBeUndefined();
  const wrong = { toolName: "bash", input: { command: "npm test" } }; expect(handlers.get("tool_call")!(wrong, { cwd: f.ownCwd })).toMatchObject({ block: true });
  const event = { toolName: "bash", input: { command: "cd '" + f.worktree + "' && node --test" } };
  expect(handlers.get("tool_call")!(event, { cwd: f.ownCwd })).toBeUndefined();
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) { expect(event.input.command).toContain("/usr/bin/sandbox-exec"); expect(event.input.command).toContain("(deny network*)"); expect(event.input.command).toContain(f.worktree); }
});
it("allows byte inspection and runs unclassified programs locally, sandboxed on macOS", () => {
  const f = fixture(); vi.stubEnv("TAVERN_SCOPE_FILE", f.store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const handlers = new Map<string, Function>(); extension({ on: (name, fn) => { handlers.set(name, fn); }, getActiveTools: () => ["bash", "read", "journal", "tavern_report"], setActiveTools: vi.fn() });
  handlers.get("session_start")!({}, { cwd: f.ownCwd });
  const event = { toolName: "bash", input: { command: "W='" + f.worktree + "'; cd $W && tail -c 20 input | od -c | tail -3; xxd -g 1 input; hexdump -C input; file input; stat input" } };
  expect(handlers.get("tool_call")!(event, { cwd: f.ownCwd })).toBeUndefined();
  for (const command of ["xxd input output", "file -C -m magic"]) {
    const call = { toolName: "bash", input: { command } };
    expect(handlers.get("tool_call")!(call, { cwd: f.ownCwd })).toBeUndefined();
    if (process.platform === "darwin") {
      expect(call.input.command).toMatch(/^\/usr\/bin\/sandbox-exec /);
      expect(call.input.command).toContain("(deny file-write*)");
    } else {
      expect(call.input.command).toBe(command);
    }
  }
});
it("does not create a watcher violation for routine checks, but still contains Git writes", async () => {
  const f = fixture(), callbacks = new Map<string, Function>(), stop = vi.fn(), onViolation = vi.fn();
  let rows = [{ id: "r1", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { type: "commandExecution", command: "cd '" + f.worktree + "' && npm test", cwd: f.ownCwd } } }];
  const bb = { events: { on: (name: string, fn: Function) => callbacks.set(name, fn) }, onDispose: vi.fn(), log: { warn: vi.fn() }, sdk: { threads: { stop, events: { list: async () => rows } } } } as unknown as BbPluginApi;
  registerWatcher(bb, f.store, { onViolation }); const emit = (sequence: number) => callbacks.get("experimental_thread.events")!({ thread: { id: "t1", providerId: "codex" }, sequence });
  await emit(1); expect(stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]);
  rows = [{ id: "r2", seq: 2, type: "item/started", createdAt: Date.now(), data: { item: { type: "commandExecution", command: "git add .", cwd: f.worktree } } }];
  await emit(2); expect(stop).toHaveBeenCalledOnce(); expect(f.store.violations()[0]).toMatchObject({ ruleId: "checker-write", stopped: true });
});
it("persists the maker binding and done-when grants across overrides, mode changes and reload", async () => {
  const f = fixture(), bb = { providers: { experimental_contributeEnv: vi.fn() }, events: { on: vi.fn() }, onDispose: vi.fn() } as unknown as BbPluginApi;
  const start = () => registerScopes(bb, { dataDir: join(f.root, "registered"), policyOptions: { home: f.root }, installGuard: false, pathsForThread: () => ({ worktree: f.ownCwd, threadStorage: join(f.root, "storage") }), onViolation: vi.fn() });
  const scopes = start(); await scopes.writeScope("t1", f.scope); await scopes.applyOverride("t1", { tools: { deny: ["web_*"] } });
  scopes.setMode("watch"); const reloaded = start(), rebound = await reloaded.rebindScope("t1");
  expect(rebound.checks).toEqual(f.scope.checks); expect(rebound.tools.deny).toContain("web_*"); expect(rebound.expectedWorktree).toBeUndefined();
});
