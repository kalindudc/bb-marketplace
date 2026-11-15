// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import extension from "../../adapters/pi/extension";
import { ensureGuardInstalled, guardStatus, uninstallGuard } from "../../src/scope/install";
import { ScopeStore } from "../../src/scope/store";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths, realPath } from "../../src/scope/paths";
import { linkedWorktree } from "./git-fixture";
import { bindWorktree, gitWorktreeRoot } from "../../src/scope/worktree";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "tavern-guard-")); dirs.push(dir); return realPath(dir); };
function host() {
  const handlers = new Map<string, Function>();
  let active = ["read", "write", "bash", "journal", "quest", "tavern_report", "slack_post"];
  const pi = { on: vi.fn((name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name); }), getActiveTools: () => [...active], setActiveTools: vi.fn((names: string[]) => { active = [...names]; }) };
  return { pi, emit: (name: string, input: unknown = {}, cwd = process.cwd()) => handlers.get(name)?.(input, { cwd }) };
}
it("does absolutely nothing unless TAVERN_SCOPE_FILE is set", () => {
  vi.stubEnv("TAVERN_SCOPE_FILE", undefined); const { pi } = host(); extension(pi); expect(pi.on).not.toHaveBeenCalled();
});
it("fails closed when scoped file is missing or invalid, while keeping report, journal and its quest alias", () => {
  const file = join(temp(), "missing.json"); vi.stubEnv("TAVERN_SCOPE_FILE", file);
  const { pi, emit } = host(); extension(pi); emit("session_start");
  expect(emit("tool_call", { toolName: "read", input: {} })).toMatchObject({ block: true, reason: expect.stringContaining("scope file") });
  for (const toolName of ["journal", "quest", "tavern_report"]) expect(emit("tool_call", { toolName, input: {} })).toBeUndefined();
  writeFileSync(file, "{}"); expect(emit("tool_call", { toolName: "bash", input: { command: "ls" } })).toMatchObject({ block: true });
  expect(pi.setActiveTools).toHaveBeenCalledWith(["journal", "quest", "tavern_report"]);
});
it("arms, hides denied tools, checks symlink escapes and reloads policy on every call", () => {
  const root = temp(), { worktree } = linkedWorktree(root), outside = temp();
  vi.spyOn(process, "cwd").mockReturnValue(worktree);
  symlinkSync(outside, join(worktree, "escape"));
  const store = new ScopeStore(root);
  const scope = bindPaths({ ...scopeForClass("smith"), threadId: "t1", issuedAt: Date.now() - 1, sandbox: false }, { home: root, tmp: [join(root, "scratch")], worktree, scopesDir: store.directory }, realPath);
  store.write("t1", scope); vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const { pi, emit } = host(); extension(pi); emit("session_start", {}, worktree);
  expect(store.isArmed("t1")).toBe(true); expect(pi.setActiveTools.mock.lastCall?.[0]).not.toContain("slack_post");
  expect(emit("tool_call", { toolName: "write", input: { path: "escape/new/file" } }, worktree)).toMatchObject({ block: true });
  expect(emit("tool_call", { toolName: "bash", input: { command: "echo x > escape/new/file" } }, worktree)).toMatchObject({ block: true });
  expect(emit("tool_call", { toolName: "write", input: { path: "ok" } }, worktree)).toBeUndefined();
  scope.tools.deny.push("write"); store.write("t1", scope);
  expect(emit("tool_call", { toolName: "write", input: { path: "ok" } }, worktree)).toMatchObject({ block: true });
});
it("late-binds a saved Smith scope from process.cwd git toplevel, not ctx.cwd, and retains the template", () => {
  const { worktree } = linkedWorktree(temp()), storage = temp(), outside = temp();
  const nested = join(worktree, "nested"); mkdirSync(nested);
  vi.spyOn(process, "cwd").mockReturnValue(nested);
  const store = new ScopeStore(storage);
  const scope = bindPaths({ ...scopeForClass("smith"), threadId: "t1", issuedAt: Date.now() - 1, sandbox: false }, { home: storage, tmp: [join(store.dataDir, "scratch")], scopesDir: store.directory }, realPath);
  store.write("t1", scope);
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const { pi, emit } = host(); extension(pi); emit("session_start", {}, outside);
  expect(store.isArmed("t1")).toBe(true);
  expect(emit("tool_call", { toolName: "write", input: { path: join(worktree, "file") } }, outside)).toBeUndefined();
  expect(emit("tool_call", { toolName: "write", input: { path: join(outside, "file") } }, outside)).toMatchObject({ block: true });
  scope.tools.deny.push("write"); store.write("t1", scope);
  expect(emit("tool_call", { toolName: "write", input: { path: join(worktree, "file") } }, nested)).toMatchObject({ block: true });
  expect(JSON.parse(readFileSync(store.file("t1"), "utf8")).writes.allow).toContain("${worktree}");
});
it("fails closed and does not arm when cwd is not a git repository", () => {
  const root = temp(), store = new ScopeStore(root);
  store.write("t1", bindPaths({ ...scopeForClass("smith"), threadId: "t1", issuedAt: 1 }, { home: root, tmp: [join(store.dataDir, "scratch")], scopesDir: store.directory }));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const { pi, emit } = host(); extension(pi); emit("session_start");
  expect(store.isArmed("t1")).toBe(false);
  expect(emit("tool_call", { toolName: "read", input: {} })).toMatchObject({ block: true });
  expect(emit("tool_call", { toolName: "tavern_report", input: {} })).toBeUndefined();
});
it("refuses root, HOME and roots that are missing or escape through a worktree-relative allowance", () => {
  const scope = scopeForClass("smith");
  for (const root of ["/", homedir(), join(temp(), "missing")]) expect(() => bindWorktree(scope, root)).toThrow();
  expect(() => gitWorktreeRoot(temp())).toThrow();
  expect(() => bindWorktree({ ...scope, writes: { ...scope.writes, allow: ["${worktree}/../outside"] } }, temp())).toThrow();
});
it("wraps bash in sandbox-exec only when enabled on macOS", () => {
  const root = temp(), store = new ScopeStore(root);
  store.write("t1", bindPaths({ ...scopeForClass("ranger"), threadId: "t1", issuedAt: 1 }, { home: root, tmp: ["/private/tmp"], scopesDir: store.directory }, realPath));
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const { pi, emit } = host(); extension(pi);
  const event = { toolName: "bash", input: { command: "ls" } };
  expect(emit("tool_call", event)).toBeUndefined();
  expect(event.input.command.startsWith("/usr/bin/sandbox-exec")).toBe(process.platform === "darwin");
});
it("writes and re-points only marked shims; status and uninstall are safe", () => {
  const agentDir = temp(), entryPath = join(temp(), "extension.ts"); writeFileSync(entryPath, "export default () => {};\n");
  expect(ensureGuardInstalled({ agentDir, entryPath })).toBe("installed");
  expect(ensureGuardInstalled({ agentDir, entryPath })).toBe("current");
  expect(guardStatus({ agentDir, entryPath }).installed).toBe(true);
  expect(ensureGuardInstalled({ agentDir, entryPath: entryPath + ".new" })).toBe("updated");
  expect(guardStatus({ agentDir, entryPath }).stale).toBe(true);
  uninstallGuard({ agentDir }); expect(guardStatus({ agentDir, entryPath }).installed).toBe(false);
  const shim = join(agentDir, "extensions/tavern-guard/index.ts"); mkdirSync(join(agentDir, "extensions/tavern-guard"), { recursive: true }); writeFileSync(shim, "// mine\n");
  expect(ensureGuardInstalled({ agentDir, entryPath })).toBe("unmarked");
  uninstallGuard({ agentDir }); expect(readFileSync(shim, "utf8")).toBe("// mine\n");
});
