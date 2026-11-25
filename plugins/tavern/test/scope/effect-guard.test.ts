// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import extension, { type PiGuardApi } from "../../adapters/pi/extension";
import { ScopeStore } from "../../src/scope/store";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths, realPath } from "../../src/scope/paths";
import { sandboxProfile } from "../../src/scope/sandbox";
import { prepareCall } from "../../src/scope/prepare";
import { linkedWorktree } from "./git-fixture";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(mode: "watch" | "enforce" = "enforce") {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-effect-"))); roots.push(root);
  const store = new ScopeStore(root);
  const scope = bindPaths({ ...scopeForClass("ranger"), mode, threadId: "t1", issuedAt: 1 }, { home: root, tmp: [join(root, "tmp")], threadStorage: join(root, "storage"), scopesDir: store.directory });
  store.write("t1", scope);
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
  extension({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => ["bash"], setActiveTools: () => {} });
  return { root, scope, emit: (name: string, event: Parameters<Parameters<PiGuardApi["on"]>[1]>[0]) => handlers.get(name)!(event, { cwd: root }) };
}
it.skipIf(process.platform !== "darwin")("does not add general path warnings to a tool result", () => {
  const f = fixture();
  for (const id of ["denied", "ok"]) expect(f.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command: "python3 -c 'print(1)'" } })).toBeUndefined();
  const result = f.emit("tool_result", { toolName: "bash", toolCallId: "denied", content: [{ type: "text", text: "Operation not permitted" }] });
  expect(result).toBeUndefined();
  expect(f.emit("tool_result", { toolName: "bash", toolCallId: "denied", content: [{ type: "text", text: "Operation not permitted" }] })).toBeUndefined();
  expect(f.emit("tool_result", { toolName: "bash", toolCallId: "ok", content: [{ type: "text", text: "ok" }] })).toBeUndefined();
});
it("keeps only the control-file overlay, not a discretionary hold or hint, in Watch", () => {
  const f = fixture("watch"), input = { command: "git push origin main" };
  expect(f.emit("tool_call", { toolName: "bash", toolCallId: "watch", input })).toBeUndefined();
  expect(input.command.startsWith("/usr/bin/sandbox-exec")).toBe(process.platform === "darwin");
  expect(input.command).not.toContain("(deny file-write*)");
  expect(f.emit("tool_result", { toolName: "bash", toolCallId: "watch", content: [{ type: "text", text: "Operation not permitted" }] })).toBeUndefined();
});
it("allows a Warden fetch metadata root only on the fetch profile, never on a check profile", () => {
  const f = fixture(), { worktree } = linkedWorktree(f.root);
  const scope = { ...f.scope, preset: "checker" as const, checks: { worktree, commands: [] } };
  const call = prepareCall({ kind: "bash", toolName: "bash", input: { command: "git fetch" }, cwd: worktree, containment: "sandbox" }, { scope });
  expect(call.fetchWriteRoots?.length).toBeGreaterThan(0);
  for (const root of call.fetchWriteRoots!) {
    expect(sandboxProfile(scope, false, call.fetchWriteRoots)).not.toContain(`(deny file-write* (subpath ${JSON.stringify(root)}))`);
    expect(sandboxProfile(scope, true, call.fetchWriteRoots)).toContain(`(deny file-write* (subpath ${JSON.stringify(root)}))`);
    expect(sandboxProfile(scope)).toContain(`(deny file-write* (subpath ${JSON.stringify(root)}))`);
  }
});
