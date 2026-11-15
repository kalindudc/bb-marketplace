// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerScopes, type Scope } from "../../src/scope";
import extension from "../../adapters/pi/extension";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(narrowBoundScope: (scope: Scope) => Scope) {
  const root = mkdtempSync(join(tmpdir(), "tavern-bound-narrowing-")); roots.push(root);
  const envs = new Map<string, Function>();
  const bb = { providers: { experimental_contributeEnv: (id: string, fn: Function) => envs.set(id, fn) }, events: { on: vi.fn() }, onDispose: vi.fn(), log: { warn: vi.fn() } } as unknown as BbPluginApi;
  const scopes = registerScopes(bb, { dataDir: root, policyOptions: { home: root }, guard: { agentDir: join(root, ".pi/agent") }, installGuard: false, pathsForThread: () => ({}), onViolation: vi.fn(), narrowBoundScope });
  const file = join(root, "scopes/member.json");
  return { root, scopes, envs, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}
it("applies a local final-copy overlay and removes it on rebind without losing the base or grants", async () => {
  let away = false;
  const overlay = vi.fn((scope: Scope) => {
    expect(scope.env.variables.HOME).toBeTruthy(); expect(scope.writes.deny.every(path => !path.includes("${"))).toBe(true);
    if (away) { scope.tools.deny.push("read"); scope.shell.deny.push({ id: "away-check", argv: ["node", "--version"], why: "Wait for the user to return" }); }
    return scope;
  });
  const f = fixture(overlay), base = f.scopes.resolve("ranger", {}).scope;
  base.shell.allow.push({ id: "retained-user-grant", argv: ["example"], why: "Approved rule retained in the original template" });
  await f.scopes.writeScope("member", base); const original = f.read().bindingTemplate, bytes = readFileSync(f.file, "utf8");
  await f.scopes.rebindScope("member"); expect(readFileSync(f.file, "utf8")).toBe(bytes);
  away = true; await f.scopes.rebindScope("member"); expect(f.read().tools.deny).toContain("read"); expect(f.read().bindingTemplate).toEqual(original);
  expect(f.read().shell.allow).toEqual(original.shell.allow);
  vi.stubEnv("TAVERN_SCOPE_FILE", f.file); vi.stubEnv("BB_THREAD_ID", "member"); const handlers = new Map<string, Function>();
  extension({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ["read", "journal"], setActiveTools: vi.fn() });
  expect(handlers.get("tool_call")!({ toolName: "read", input: {} }, { cwd: f.root })).toMatchObject({ block: true });
  expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: "node --version" } }, { cwd: f.root })).toMatchObject({ block: true, reason: expect.stringContaining("Wait for the user to return") });
  away = false; await f.scopes.rebindScope("member"); expect(f.read().bindingTemplate).toEqual(original); expect(f.read().tools.deny).not.toContain("read");
  expect(handlers.get("tool_call")!({ toolName: "read", input: {} }, { cwd: f.root })).toBeUndefined();
  expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: "node --version" } }, { cwd: f.root })).toBeUndefined();
});
it.each(["remove-deny", "add-grant", "mode", "write-root", "identity"])("rejects an accidental %s change without replacing the valid scope", async change => {
  let invalid = false;
  const f = fixture(scope => {
    if (invalid) {
      if (change === "remove-deny") scope.shell.deny = [];
      if (change === "add-grant") scope.shell.allow.push({ id: "new-grant", argv: ["anything"], why: "Not an away narrowing" });
      if (change === "mode") scope.mode = "off";
      if (change === "write-root") scope.writes.allow.push("/");
      if (change === "identity") scope.threadId = "another";
    }
    return scope;
  });
  await f.scopes.writeScope("member", f.scopes.resolve("ranger", {}).scope); const before = readFileSync(f.file, "utf8"); invalid = true;
  await expect(f.scopes.rebindScope("member")).rejects.toThrow(/narrow|den/i); expect(readFileSync(f.file, "utf8")).toBe(before);
});
it("never invokes the local hook for host templates or presents it as native enforcement", async () => {
  const overlay = vi.fn(() => { throw new Error("Local hook must not run for a host template"); }), f = fixture(overlay);
  await f.scopes.writeScope("member", f.scopes.resolve("ranger", {}).scope, { binding: { kind: "host", placementId: "placement", generation: 1 } });
  const snapshot = f.scopes.hostTemplate("member"); await f.scopes.rebindScope("member"); expect(f.scopes.hostTemplate("member")).toEqual(snapshot);
  expect(overlay).not.toHaveBeenCalled(); expect(f.scopes.status().threads[0]).toMatchObject({ hostScope: "unresolved", armed: false });
});
it("fails closed through the local provider env if an overlay cannot be applied", async () => {
  let invalid = false; const f = fixture(scope => { if (invalid) throw new Error("Away narrowing unavailable"); return scope; });
  await f.scopes.writeScope("member", f.scopes.resolve("ranger", {}).scope); invalid = true;
  const env = await f.envs.get("pi")!({ threadId: "member", projectId: null, hostId: "local" });
  expect(env).toContainEqual(expect.objectContaining({ name: "TAVERN_SCOPE_FILE", value: f.file })); expect(f.read().bindingError).toContain("Away narrowing unavailable");
});
