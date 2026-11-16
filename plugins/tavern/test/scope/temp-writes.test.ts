// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths, realPath } from "../../src/scope/paths";
import { evaluate } from "../../src/scope/engine";
import { ScopePolicy } from "../../src/scope/policy";
import { sandboxProfile } from "../../src/scope/sandbox";

const bound = (role: string) => bindPaths(scopeForClass(role, undefined, role === "keeper" ? "keeper" : undefined), { home: "/home/test", tmp: ["/tmp", "/private/tmp", "/native-tmp"], worktree: "/repo", threadStorage: "/storage/own", scopesDir: "/scopes" });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it.each(["keeper", "ranger", "warden", "smith", "wanderer"])("%s writes temp and own storage without permission changes", role => {
  const scope = bound(role);
  for (const path of ["/tmp/x/y", "/private/tmp/x", "/native-tmp/x", "/storage/own/report"]) {
    for (const toolName of ["write", "edit", "Write", "Edit"])
      expect(evaluate(scope, { kind: "write", toolName, input: { path }, cwd: "/repo" }).allow, `${role} ${toolName} ${path}`).toBe(true);
    expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command: `printf x > ${path}` }, cwd: "/repo" }).allow).toBe(true);
  }
});
it.each(["ranger", "wanderer"])("keeps exactly the requested temporary subtree when narrowing %s", role => {
  const narrowed = scopeForClass(role, { writes: { allow: ["/tmp/notes/**"] } });
  expect(narrowed.writes.allow).toEqual(["/tmp/notes/**"]);
  const scope = bindPaths(narrowed, { home: "/home/test", tmp: ["/tmp"], threadStorage: "/storage/own", scopesDir: "/scopes" });
  expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: "/tmp/notes/a" }, cwd: "/repo" }).allow).toBe(true);
  expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: "/tmp/other/a" }, cwd: "/repo" }).allow).toBe(false);
  expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: "/storage/own/a" }, cwd: "/repo" }).allow).toBe(false);
});
it("does not classify already-granted temporary paths as widenings", () => {
  const policy = new ScopePolicy({ home: "/missing-home" });
  const scope = bound("keeper");
  expect(policy.apply(scope, {}, { writes: { allow: ["/tmp/**", "/private/tmp/x/**", "/storage/own/**"] } }).widenings).toEqual([]);
  expect(policy.apply(scope, {}, { writes: { allow: ["/storage/other/**", "/repo/**"] } }).widenings).toEqual(["write:/storage/other/**", "write:/repo/**"]);
});
it("treats both thread-storage spellings as already writable on an unbound template or a bound scope", () => {
  const policy = new ScopePolicy({ home: "/missing-home" });
  const scope = bound("smith");
  expect(policy.apply(scope, {}, { writes: { allow: ["$BB_THREAD_STORAGE/**", "${threadStorage}", "${threadStorage}/notes/**"] } }).widenings).toEqual([]);
  expect(policy.apply(scope, {}, { writes: { allow: ["${threadStorage}/../escape/**", "$BB_THREAD_STORAGE*/**"] } }).widenings).toEqual([
    "write:${threadStorage}/../escape/**",
    "write:$BB_THREAD_STORAGE*/**",
  ]);
});
it("refuses threads storage spellings without a bound thread storage root", () => {
  const policy = new ScopePolicy({ home: "/missing-home" });
  const scope = scopeForClass("ranger");
  expect(policy.apply(scope, {}, { writes: { allow: ["$BB_THREAD_STORAGE/**", "${threadStorage}/**"] } }).widenings).toEqual([
    "write:$BB_THREAD_STORAGE/**",
    "write:${threadStorage}/**",
  ]);
});
it("keeps Keeper writes out of the repository and includes temp roots in its sandbox", () => {
  const scope = bound("keeper");
  expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: "/repo/record" }, cwd: "/repo" }).allow).toBe(false);
  expect(sandboxProfile(scope)).toContain('(allow file-write* (subpath "/storage/own"))');
});
it("refuses a canonicalized temporary symlink escaping to protected files or the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "tavern-temp-test-")); dirs.push(root);
  const home = join(root, "home"), repo = join(root, "repo"), temp = join(root, "tmp");
  mkdirSync(join(home, ".ssh"), { recursive: true }); mkdirSync(repo); mkdirSync(temp);
  const scope = bindPaths(scopeForClass("keeper", undefined, "keeper"), { home, tmp: [temp], threadStorage: join(root, "storage"), scopesDir: join(root, "scopes") }, realPath);
  for (const [name, target] of [["secret", join(home, ".ssh")], ["repo", repo]]) {
    symlinkSync(target, join(temp, name));
    const path = join(temp, name, "record");
    expect(evaluate(scope, { kind: "write", toolName: "write", input: { path }, cwd: repo, resolvedPaths: { [path]: realPath(path) } }).allow).toBe(false);
  }
});
it.each(["any", "paths"] as const)("allows Pip's own-storage path with write mode %s", mode => {
  const scope = bound("wanderer"); scope.writes.mode = mode; scope.writes.allow = ["/storage/own/**"];
  expect(evaluate(scope, { kind: "write", toolName: "write", input: { path: "/storage/own/final-replay.md" }, cwd: "/repo" }).allow).toBe(true);
});
