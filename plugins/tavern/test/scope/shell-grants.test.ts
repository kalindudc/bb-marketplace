// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { ScopeStore } from "../../src/scope/store";
import { evaluate, type ScopeCall } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { shellGrantTarget, publishShellGrants, readShellGrants, claimShellGrant, checkShellGrantReceipt, shellGrantCapable } from "../../src/scope/shell-grants";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-shell-grant-")); dirs.push(root);
  const file = join(root, "member.json");
  const scope = bindPaths({ ...scopeForClass("ranger"), threadId: "member", issuedAt: 100 }, { home: root, tmp: [tmpdir()], scopesDir: root });
  const call = (command: string, cwd = root): ScopeCall => ({ kind: "bash", toolName: "bash", cwd, input: { command }, containment: "sandbox" });
  const command = "npm publish";
  const target = shellGrantTarget(call(command))!;
  return { root, scope, file, call, command, target };
}

it("grants exactly one matching call before it needs a new ask", () => {
  const { root, file, call, scope, command, target } = fixture();
  const grant = { id: "once", digest: target.digest, scope: "once" as const };
  publishShellGrants(file, scope, [grant]);
  const decide = (command: string, cwd = root) => evaluate(scope, { ...call(command, cwd), shellGrants: readShellGrants(file, scope) });
  expect(decide("npm publish other").allow).toBe(false);
  expect(decide(command, tmpdir()).allow).toBe(false);
  expect(decide(command)).toMatchObject({ allow: true, shellGrant: "once" });
  expect(claimShellGrant(file, scope, grant.id, "attempt-1", [command])).toBe(true);
  expect(claimShellGrant(file, scope, grant.id, "attempt-2", [command])).toBe(false);
  expect(decide(command).allow).toBe(false);
  expect(checkShellGrantReceipt(file, grant.id, "attempt-1", command)).toBe("once");
  expect(checkShellGrantReceipt(file, grant.id, "attempt-2", command)).toBeNull();
  expect(checkShellGrantReceipt(file, grant.id, "attempt-1", command + " different-target")).toBeNull();
});

it("the guard proves compatibility and claims once before dispatch, including across restart", () => {
  const { root, command, target, scope } = fixture();
  const store = new ScopeStore(root);
  const file = store.file("member");
  store.write("member", scope);
  publishShellGrants(file, scope, [{ id: "once", digest: target.digest, scope: "once" }]);
  store.arm(scope);
  expect(shellGrantCapable(file, scope)).toBe(false);
  vi.stubEnv("TAVERN_SCOPE_FILE", file);
  vi.stubEnv("BB_THREAD_ID", "member");
  const mount = () => {
    const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
    guard({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ["bash"], setActiveTools: () => {} });
    const ctx = { cwd: root };
    handlers.get("session_start")!({}, ctx);
    return (toolCallId: string) => handlers.get("tool_call")!({ toolName: "bash", toolCallId, input: { command } }, ctx);
  };
  try {
    const first = mount();
    expect(shellGrantCapable(file, scope)).toBe(true);
    expect(first("first")).toBeUndefined();
    expect(mount()("second")).toMatchObject({ block: true });
  } finally { vi.unstubAllEnvs(); }
});

it("keeps a quest grant reusable until the controller withdraws it", () => {
  const { file, call, scope, target, command } = fixture();
  publishShellGrants(file, scope, [{ id: "quest", digest: target.digest, scope: "quest" }]);
  for (const attempt of ["attempt-1", "attempt-2"]) {
    expect(evaluate(scope, { ...call(command), shellGrants: readShellGrants(file, scope) })).toMatchObject({ allow: true, shellGrant: "quest" });
    expect(claimShellGrant(file, scope, "quest", attempt, [command])).toBe(true);
    expect(checkShellGrantReceipt(file, "quest", attempt, command)).toBe("quest");
  }
  publishShellGrants(file, scope, []);
  expect(claimShellGrant(file, scope, "quest", "attempt-3", [command])).toBe(false);
  expect(evaluate(scope, { ...call(command), shellGrants: readShellGrants(file, scope) }).allow).toBe(false);
});

it.each([
  "kubectl --context fixture apply -f object.yaml", "terraform apply", "helm upgrade release ./chart", "kapp deploy -a fixture",
  "bb tavern stop fixture", "bb machine create fixture", "echo literal; npm publish", "npm publish > /tmp/file",
  "npm publish \"$TARGET\"", "npm publish $(pwd)", "env PATH=/tmp npm publish", "npm publish &",
  "gh pr merge https://github.example.test/org/repo/pull/42 --merge", "curl --config request.conf https://example.test",
])("cannot issue a general grant for %s", command => {
  const f = fixture();
  expect(shellGrantTarget(f.call(command))).toBeNull();
});

it("does not reuse grants across scopes or override an explicit policy deny", () => {
  const { file, scope, call, command, target } = fixture();
  publishShellGrants(file, scope, [{ id: "quest", digest: target.digest, scope: "quest" }]);
  expect(readShellGrants(file, { ...scope, issuedAt: scope.issuedAt + 1 })).toEqual([]);
  scope.shell.deny.push({ id: "project-policy", argv: ["npm", "publish"], why: "Project does not publish packages" });
  expect(evaluate(scope, { ...call(command), shellGrants: readShellGrants(file, scope) })).toMatchObject({ allow: false, ruleId: "project-policy" });
});
