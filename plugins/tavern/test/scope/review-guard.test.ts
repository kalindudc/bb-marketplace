// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import extension from "../../adapters/pi/extension";
import { ScopeStore } from "../../src/scope/store";
import { bindPaths, realPath, normalizeToolPath } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { linkedWorktree } from "./git-fixture";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-guard-review-")); dirs.push(root);
  const store = new ScopeStore(root), handlers = new Map<string, Function>();
  let tools = ["read", "write", "bash", "quest", "tavern_report"];
  const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), getActiveTools: () => [...tools], setActiveTools: (names: string[]) => { tools = [...names]; } };
  const scope = bindPaths({ ...scopeForClass("ranger"), threadId: "t1", issuedAt: 1 }, { home: root, tmp: [join(root, "scratch")], scopesDir: store.directory }, realPath);
  store.write("t1", scope); vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  return { root, store, scope, pi, emit: (name: string, input: unknown = {}) => handlers.get(name)!(input, { cwd: root }) };
}
it("switches modes live, restoring tools and disabling both preflight blocking and sandbox wrapping", () => {
  const f = fixture(); extension(f.pi); f.emit("session_start");
  expect(f.pi.getActiveTools()).toContain("write");
  for (const mode of ["watch", "off"] as const) {
    f.scope.mode = mode; f.store.write("t1", f.scope); f.emit("before_agent_start");
    expect(f.pi.getActiveTools()).toContain("write");
    expect(f.emit("tool_call", { toolName: "write", input: { path: "/outside" } })).toBeUndefined();
    const event = { toolName: "bash", input: { command: "git push origin main" } }; expect(f.emit("tool_call", event)).toBeUndefined(); expect(event.input.command).toBe("git push origin main");
  }
  f.scope.mode = "enforce"; f.store.write("t1", f.scope);
  expect(f.emit("tool_call", { toolName: "write", input: { path: "/outside" } })).toMatchObject({ block: true });
});
it("arms a session started off and reports its first newly enforced call in the result", () => {
  const f = fixture(); f.scope.mode = "off"; f.store.write("t1", f.scope); extension(f.pi); f.emit("session_start");
  expect(f.store.isArmed("t1")).toBe(true);
  f.scope.mode = "enforce"; f.store.write("t1", f.scope);
  expect(f.emit("tool_call", { toolName: "read", toolCallId: "c1", input: {} })).toBeUndefined();
  expect(f.emit("tool_result", { toolName: "read", toolCallId: "c1", content: [{ type: "text", text: "ok" }] })).toMatchObject({ content: [{ type: "text", text: "ok" }, { type: "text", text: expect.stringContaining("Enforcement enabled") }] });
});
it("rejects a shared checkout even with an unresolved worktree template, and rejects a known wrong root", () => {
  const f = fixture(), { main, worktree } = linkedWorktree(f.root);
  const template = bindPaths({ ...scopeForClass("smith"), threadId: "t1", issuedAt: 1 }, { home: f.root, tmp: [join(f.root, "scratch")], scopesDir: f.store.directory }, realPath);
  f.store.write("t1", template); const cwd = vi.spyOn(process, "cwd").mockReturnValue(main);
  extension(f.pi); f.emit("session_start"); expect(f.store.isArmed("t1")).toBe(false);
  expect(f.emit("tool_call", { toolName: "read", input: {} })).toMatchObject({ block: true, reason: expect.stringContaining("linked Git worktree") });
  f.store.write("t1", { ...template, expectedWorktree: main }); cwd.mockReturnValue(worktree); f.emit("session_start");
  expect(f.store.isArmed("t1")).toBe(false);
  expect(f.emit("tool_call", { toolName: "read", input: {} })).toMatchObject({ block: true, reason: expect.stringContaining("expected root") });
});
it("honours observation/off modes even when the scope is corrupt, while retaining its error", () => {
  const f = fixture(); writeFileSync(f.store.file("t1"), "broken json");
  const recovered = new ScopeStore(f.root);
  extension(f.pi);
  for (const mode of ["watch", "off"] as const) {
    recovered.setMode("t1", mode); f.emit("before_agent_start");
    expect(f.emit("tool_call", { toolName: "bash", input: { command: "git push" } })).toBeUndefined();
    expect(recovered.records.get("t1")?.error).toBeTruthy();
    expect(JSON.parse(readFileSync(f.store.file("t1"), "utf8")).invalidScope).toBe("broken json");
  }
  recovered.setMode("t1", "enforce");
  expect(f.emit("tool_call", { toolName: "read", input: {} })).toMatchObject({ block: true });
});
it("normalizes pi's Unicode spaces and path forms", () => {
  expect(normalizeToolPath("@~/a\u00a0b", "/work", "/home/me")).toBe("/home/me/a b");
  expect(normalizeToolPath("file:///outside/a%20b", "/work")).toBe("/outside/a b");
});
