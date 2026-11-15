// @vitest-environment node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import extension from "../../adapters/pi/extension";
import { bindChecks } from "../../src/scope/checker";
import { evaluate } from "../../src/scope/engine";
import { guardLoaderSource } from "../../src/scope/install";
import { bindPaths, realPath } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { scopeSchema } from "../../src/scope/schema";
import { ScopeStore } from "../../src/scope/store";
import { registerWatcher } from "../../src/scope/watch";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realPath(fs.mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "dedicated-"))); roots.push(root);
  const workspace = join(root, "workspace"), scratch = join(root, "scratch"); fs.mkdirSync(workspace); fs.mkdirSync(scratch);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "member"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(join(workspace, "source"), "source\n"); git("add", "source"); git("commit", "-qm", "initial");
  const store = new ScopeStore(join(root, "data"));
  const makeScope = (role = "smith") => bindPaths({ ...scopeForClass(role), threadId: "member", issuedAt: 1, sandbox: false }, { home: root, tmp: [scratch], scopesDir: store.directory, worktree: workspace }, realPath);
  return { root, workspace, scratch, store, makeScope };
}
function guard() {
  const handlers = new Map<string, Function>(); let tools = ["read", "write", "bash", "tavern_report", "journal", "tavern_ready"];
  const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), getActiveTools: () => tools, setActiveTools: (value: string[]) => { tools = value; } };
  return { pi, emit: (name: string, input: unknown, cwd: string) => handlers.get(name)?.(input, { cwd }) };
}
it("retains authenticated readiness when an absent scope fails closed", () => {
  const f = fixture(); vi.stubEnv("TAVERN_SCOPE_FILE", join(f.root, "missing.json")); vi.stubEnv("BB_THREAD_ID", "member");
  const runtime = guard(); extension(runtime.pi); runtime.emit("session_start", {}, f.workspace);
  expect(runtime.pi.getActiveTools()).toContain("tavern_ready");
  expect(runtime.emit("tool_call", { toolName: "tavern_ready", input: {} }, f.workspace)).toBeUndefined();
  expect(runtime.emit("tool_call", { toolName: "bash", input: { command: "pwd" } }, f.workspace)).toMatchObject({ block: true });
});
it("retains readiness in the missing guard-artifact loader without opening other tools", async () => {
  const f = fixture(); vi.stubEnv("TAVERN_SCOPE_FILE", join(f.root, "missing.json"));
  const load = Function("fs", guardLoaderSource(join(f.root, "absent.mjs")).replaceAll('await import("node:fs")', "fs").replace("export default", "return"))(fs);
  const runtime = guard(); await load(runtime.pi); runtime.emit("session_start", {}, f.workspace);
  expect(runtime.pi.getActiveTools()).toContain("tavern_ready");
  expect(runtime.emit("tool_call", { toolName: "tavern_ready", input: {} }, f.workspace)).toBeUndefined();
  expect(runtime.emit("tool_call", { toolName: "write", input: { path: "file" } }, f.workspace)).toMatchObject({ block: true });
});
it("permits readiness with a pending worktree binding for every default class", () => {
  for (const role of ["ranger", "warden", "smith", "keeper", "wanderer"]) {
    const scope = { ...scopeForClass(role), threadId: "member", issuedAt: 1 };
    expect(evaluate(scope, { kind: "tool", toolName: "tavern_ready", input: {}, cwd: "/pending" }), role).toEqual({ allow: true });
  }
});
it("accepts a trusted dedicated primary checkout while leaving legacy linked-only behavior unchanged", () => {
  const f = fixture(); vi.spyOn(process, "cwd").mockReturnValue(f.workspace); vi.stubEnv("TAVERN_SCOPE_FILE", f.store.file("member")); vi.stubEnv("BB_THREAD_ID", "member");
  const dedicated = scopeSchema.parse({ ...f.makeScope(), workspaceKind: "dedicated-machine", expectedWorktree: f.workspace }); f.store.write("member", dedicated);
  const runtime = guard(); extension(runtime.pi); runtime.emit("session_start", {}, f.workspace);
  expect(f.store.isArmed("member")).toBe(true);
  expect(runtime.emit("tool_call", { toolName: "write", input: { path: "owned-file" } }, f.workspace)).toBeUndefined();
  expect(runtime.emit("tool_call", { toolName: "write", input: { path: join(f.root, "outside") } }, f.workspace)).toMatchObject({ block: true });
  f.store.write("member", f.makeScope());
  expect(runtime.emit("tool_call", { toolName: "write", input: { path: "owned-file" } }, f.workspace)).toMatchObject({ block: true });
});
it("requires the dedicated checkout to match its trusted expected root", () => {
  const f = fixture(); vi.spyOn(process, "cwd").mockReturnValue(f.workspace); vi.stubEnv("TAVERN_SCOPE_FILE", f.store.file("member")); vi.stubEnv("BB_THREAD_ID", "member");
  for (const expectedWorktree of [undefined, join(f.root, "wrong")]) {
    f.store.write("member", scopeSchema.parse({ ...f.makeScope(), workspaceKind: "dedicated-machine", ...(expectedWorktree ? { expectedWorktree } : {}) }));
    const runtime = guard(); extension(runtime.pi);
    expect(runtime.emit("tool_call", { toolName: "write", input: { path: "file" } }, f.workspace)).toMatchObject({ block: true });
    expect(runtime.emit("tool_call", { toolName: "tavern_ready", input: {} }, f.workspace)).toBeUndefined();
  }
});
it("binds dedicated checker commands to the checker-local carried root", () => {
  const f = fixture();
  const scoped = scopeSchema.parse({ ...f.makeScope("warden"), workspaceKind: "dedicated-machine", expectedWorktree: f.workspace, checks: { worktree: f.workspace, commands: ["node --test"] } });
  const bound = bindChecks(scoped);
  expect(bound.checks?.worktree).toBe(f.workspace);
  expect(evaluate(bound, { kind: "bash", toolName: "bash", input: { command: "node --test" }, cwd: f.workspace })).toEqual({ allow: true, check: true });
  expect(() => bindChecks({ ...scoped, checks: { worktree: f.root, commands: [] } })).toThrow();
  expect(evaluate(bound, { kind: "bash", toolName: "bash", input: { command: "git add ." }, cwd: f.workspace })).toMatchObject({ allow: false });
});
it("does not stop a bootstrap readiness call for an unarmed pending Pi scope", async () => {
  const f = fixture(); f.store.write("member", f.makeScope());
  const events = new Map<string, Function>(), stop = vi.fn();
  const bb = { events: { on: (name: string, fn: Function) => events.set(name, fn) }, onDispose: vi.fn(), log: { warn: vi.fn() }, sdk: { threads: { stop, events: { list: async () => [{ id: "row", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { type: "toolCall", tool: "tavern_ready", arguments: {} } } }] } } } } as unknown as BbPluginApi;
  registerWatcher(bb, f.store, { onViolation: vi.fn() });
  await events.get("experimental_thread.events")!({ thread: { id: "member", providerId: "pi" }, sequence: 1 });
  expect(stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]);
});
