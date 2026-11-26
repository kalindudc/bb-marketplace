// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { ScopeStore } from "../../src/scope/store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-legacy-preset-")); roots.push(root);
  const store = new ScopeStore(root);
  const scope = { ...scopeForClass("keeper", undefined, "keeper"), threadId: "t1", issuedAt: 1 };
  scope.tools = { allow: ["read"], deny: ["write", "check_ui"], hide: true };
  scope.writes.allow.push("/approved/grant");
  scope.shell.allow.push({ id: "git-push", argv: ["git", "push"], why: "Approved", remote: "github.com/example/repo" });
  scope.network = "none";
  writeFileSync(store.file("t1"), JSON.stringify({ ...scope, bindingTemplate: scope }));
  return { root, scope, store: new ScopeStore(root) };
}
it("loads a restrictive legacy preset as data without hiding ordinary tools", () => {
  const f = fixture(), before = readFileSync(f.store.file("t1"), "utf8");
  const saved = f.store.records.get("t1")!;
  expect(saved.scope).toEqual(f.scope);
  expect(saved.template).toEqual(f.scope);
  expect(saved.presetProvenance).toBeUndefined();
  for (const toolName of ["read", "write", "check_ui", "ui_examples"])
    expect(evaluate(saved.scope!, { kind: "tool", toolName, input: {}, cwd: f.root })).toMatchObject({ allow: true });
  expect(readFileSync(f.store.file("t1"), "utf8")).toBe(before);
});
it("gives new Keepers the open preset without changing member presets", () => {
  expect(scopeForClass("keeper")).toMatchObject({ preset: "open", tools: { allow: ["*"], hide: false }, writes: { mode: "any" } });
  expect(["ranger", "warden", "smith", "wanderer"].map(role => scopeForClass(role).preset)).toEqual(["readonly", "checker", "worktree", "open"]);
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
