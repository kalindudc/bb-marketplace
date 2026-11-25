// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { bindPaths } from "../../src/scope/paths";
import { ScopeStore, armScope } from "../../src/scope/store";
import { envForScope } from "../../src/scope/env";
import { scopeForClass } from "../../src/scope/presets";
import { armShellGrantCapability, scopeRestartReason } from "../../src/scope/shell-grants";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-scope-refresh-")); roots.push(root);
  const store = new ScopeStore(root);
  const scope = { ...scopeForClass("ranger"), threadId: "member", issuedAt: 42 };
  scope.env.poisonGh = true;
  scope.env.blockGitPush = true;
  scope.github = "none";
  store.write("member", scope);
  return { root, store, scope, file: store.file("member") };
}
it("does not lend environment speed bumps to a new provider even for legacy scopes", () => {
  const { store } = fixture();
  const names = envForScope(store.records, "member").map(entry => entry.name);
  expect(names).toEqual(["TAVERN_SCOPE_FILE", "TAVERN_SCOPE_MODE"]);
});
it("a running guard uses rewritten act authority on its next call", () => {
  const { root, store, scope, file } = fixture();
  const current = bindPaths(scope, { home: root, tmp: [tmpdir()], threadStorage: root, scopesDir: store.directory });
  store.write("member", current);
  vi.stubEnv("TAVERN_SCOPE_FILE", file);
  vi.stubEnv("BB_THREAD_ID", "member");
  const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
  try {
    guard({ on: (key, handler) => handlers.set(key, handler), getActiveTools: () => ["bash"], setActiveTools: () => {} });
    const call = () => handlers.get("tool_call")!({ toolName: "bash", toolCallId: "fixture", input: { command: "npm publish" } }, { cwd: root });
    expect(call()).toMatchObject({ block: true });
    store.write("member", { ...current, shell: { ...current.shell, allow: [...current.shell.allow, { id: "publish", argv: ["npm", "publish"], why: "Fixture policy changed" }] } });
    expect(call()).toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
});

it("reports which old guard or inherited variables require a provider restart", () => {
  const { file, scope } = fixture();
  expect(scopeRestartReason(file, scope)).toBeNull();
  armScope(file, scope, undefined, 100);
  expect(scopeRestartReason(file, scope)).toContain("older scope guard");
  armShellGrantCapability(file, scope, 100, ["GH_TOKEN", "Git push block"]);
  expect(scopeRestartReason(file, scope)).toContain("GH_TOKEN and Git push block");
  armScope(file, scope, undefined, 101);
  armShellGrantCapability(file, scope, 101, []);
  expect(scopeRestartReason(file, scope)).toBeNull();
});
