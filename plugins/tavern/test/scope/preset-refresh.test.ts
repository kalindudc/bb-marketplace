// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerScopes } from "../../src/scope";
import { ScopeStore } from "../../src/scope/store";
import { scopeForClass } from "../../src/scope/presets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(role = "keeper", older = false) {
  const root = mkdtempSync(join(tmpdir(), "tavern-preset-refresh-")); roots.push(root);
  const store = new ScopeStore(root);
  const scope = { ...scopeForClass(role, undefined, role === "keeper" ? "keeper" : undefined), threadId: "t1", issuedAt: 1 };
  scope.tools.allow = scope.tools.allow.filter(name => !["check_ui", "ui_examples", ...(older ? ["write", "Write", "edit", "Edit"] : [])].includes(name));
  if (older) scope.tools.deny.push("write", "Write", "edit", "Edit");
  scope.writes.allow.push("/approved/grant");
  scope.shell.allow.push({ id: "git-push", argv: ["git", "push"], why: "Approved", remote: "github.com/example/repo" });
  scope.network = "none";
  writeFileSync(store.file("t1"), JSON.stringify({ ...scope, bindingTemplate: scope }));
  return { root, scope, store: new ScopeStore(root) };
}
function api(root: string) {
  const bb = { providers: { experimental_contributeEnv: vi.fn() }, events: { on: vi.fn() }, onDispose: vi.fn(), log: { warn: vi.fn() } } as unknown as BbPluginApi;
  return registerScopes(bb, { dataDir: root, installGuard: false, policyOptions: { home: root }, pathsForThread: () => ({ threadStorage: join(root, "storage") }), onViolation: vi.fn() });
}
it("leaves a newly written deliberate keeper preset alone, including across a queued write", async () => {
  const f = fixture(), scopes = api(f.root);
  const writing = scopes.writeScope("t1", f.scope);
  const migration = scopes.openKeeperScope("t1");
  await writing;
  expect(await migration).toBe(false);
  expect(scopes.status().threads[0]!.scope!.preset).toBe("keeper");
  expect(await api(f.root).openKeeperScope("t1")).toBe(false);
});
it("keeps legacy provenance absent through mode updates and path rebinding until migration", async () => {
  const f = fixture(), scopes = api(f.root);
  scopes.setMode("watch");
  await scopes.rebindScope("t1");
  expect(JSON.parse(readFileSync(f.store.file("t1"), "utf8")).presetProvenance).toBeUndefined();
  expect(await scopes.openKeeperScope("t1")).toBe(true);
});
it.each(["smith", "wanderer"])("treats wildcard tools as current for %s", role => {
  const f = fixture(role);
  expect(f.store.refreshPresetTools("t1")).toBe("current");
});
it("repairs an already-open snapshot with provenance without changing its grants or other restrictions", async () => {
  const f = fixture(), scopes = api(f.root);
  const open = scopeForClass("keeper");
  open.writes.deny = open.writes.deny.filter(path => path !== "~/.agents/tavern/scopes.yml");
  open.writes.allow.push("/approved/grant");
  open.tools.deny.push("custom_denied_tool");
  await scopes.writeScope("t1", open);
  const before = JSON.parse(readFileSync(f.store.file("t1"), "utf8")).bindingTemplate;
  expect(JSON.parse(readFileSync(f.store.file("t1"), "utf8")).presetProvenance).toBeTruthy();
  expect(await scopes.protectOpenPolicy("t1")).toBe(true);
  const after = JSON.parse(readFileSync(f.store.file("t1"), "utf8")).bindingTemplate;
  expect(after).toEqual({ ...before, writes: { ...before.writes, deny: [...before.writes.deny, "~/.agents/tavern/scopes.yml"] } });
  expect(await scopes.protectOpenPolicy("t1")).toBe(false);
});
it("gives new Keepers the open preset without changing member presets", () => {
  expect(scopeForClass("keeper")).toMatchObject({ preset: "open", tools: { allow: ["*"], hide: false }, writes: { mode: "any" } });
  expect(["ranger", "warden", "smith", "wanderer"].map(role => scopeForClass(role).preset)).toEqual(["readonly", "checker", "worktree", "open"]);
});
it.each(["keeper", "ranger", "warden"])("keeps current %s wildcard availability, restrictions and grants", role => {
  const f = fixture(role), before = structuredClone(f.scope);
  expect(f.store.refreshPresetTools("t1")).toBe("current");
  const refreshed = new ScopeStore(f.root).records.get("t1")!;
  expect(refreshed.scope).toEqual(before);
  expect(refreshed.template).toEqual(refreshed.scope);
  expect(f.store.refreshPresetTools("t1")).toBe("current");
});
it("does not erase explicit native-tool denies from a current wildcard list", () => {
  const f = fixture("keeper", true);
  expect(f.store.refreshPresetTools("t1")).toBe("current");
  const scope = f.store.records.get("t1")!.scope!;
  expect(scope.tools.allow).toContain("*");
  expect(scope.tools.allow).not.toContain("write");
  expect(scope.tools.deny).toEqual(f.scope.tools.deny);
});
it.each(["narrowed", "custom grant"])("leaves a %s tool list untouched", kind => {
  const f = fixture();
  const scope = structuredClone(f.scope);
  if (kind === "narrowed") scope.tools.allow = ["read"];
  else scope.tools.allow.push("approved_custom_tool");
  f.store.write("t1", scope, scope);
  const before = readFileSync(f.store.file("t1"), "utf8");
  expect(f.store.refreshPresetTools("t1")).toBe(kind === "narrowed" ? "skipped" : "current");
  expect(readFileSync(f.store.file("t1"), "utf8")).toBe(before);
});
it("records deterministic preset provenance on writes and reloads it outside the effective policy", () => {
  const f = fixture();
  f.store.write("t1", f.scope, f.scope);
  const saved = JSON.parse(readFileSync(f.store.file("t1"), "utf8"));
  expect(saved.presetProvenance).toEqual({ id: "keeper", version: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const record = new ScopeStore(f.root).records.get("t1")!;
  expect(record.presetProvenance).toEqual(saved.presetProvenance);
  expect(record.scope).toEqual(f.scope);
});
