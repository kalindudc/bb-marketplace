// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ScopePolicy } from "../../src/scope/policy";
import { bindPaths } from "../../src/scope/paths";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { prepareCall } from "../../src/scope/prepare";
import { linkedWorktree } from "./git-fixture";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tavern-trust-")); roots.push(home); const projectRoot = join(home, "repo");
  mkdirSync(join(home, ".agents/tavern"), { recursive: true }); mkdirSync(join(projectRoot, ".agents/tavern"), { recursive: true });
  return { home, projectRoot, policy: new ScopePolicy({ home }), global: join(home, ".agents/tavern/scopes.yml"), project: join(projectRoot, ".agents/tavern/scopes.yml") };
}
it("ignores and records project widening, including keeperMayAllow and class scope: open", () => {
  const f = fixture(); writeFileSync(f.project, "v: 1\nrules:\n - classes:\n     ranger:\n       defaults:\n         allowRules: [git-push, gh-merge]\n         tools: {allow: ['*'], removeDeny: ['*send*', '*post*']}\n         writes: {allow: ['/']}\n       keeperMayAllow: ['write:/']\n");
  const result = f.policy.resolve("ranger", { projectRoot: f.projectRoot }, {}, "open");
  expect(result.scope.preset).toBe("readonly"); expect(result.problems.length).toBeGreaterThan(0);
  expect(evaluate(result.scope, { kind: "tool", toolName: "slack_post", input: {}, cwd: f.projectRoot }).allow).toBe(false);
  expect(f.policy.resolve("ranger", { projectRoot: f.projectRoot }, { writes: { allow: ["/"] } }).widenings).toEqual(["write:/"]);
});
it("project defaults cannot reset the user's global narrowing", () => {
  const f = fixture(); writeFileSync(f.global, "v: 1\nrules:\n - classes:\n     ranger:\n       defaults: {tools: {deny: ['web_*']}}\n"); writeFileSync(f.project, "v: 1\nrules:\n - classes:\n     ranger:\n       defaults: {}\n");
  expect(f.policy.resolve("ranger", { projectRoot: f.projectRoot }).scope.tools.deny).toContain("web_*");
});
it("applies remote grants to the actual push destination, not any fork remote", () => {
  const f = fixture(); writeFileSync(f.global, "v: 1\nrules:\n - remote: github.com/fixture-dev/*\n   classes:\n     smith:\n       defaults: {allowRules: [git-push-main]}\n");
  const result = f.policy.resolve("smith", { remotes: ["git@github.com:example-org/sample-repo.git", "git@github.com:fixture-dev/sample-repo.git"] });
  const scope = bindPaths(result.scope, { home: f.home, tmp: [tmpdir()], scopesDir: join(f.home, "scopes"), worktree: f.projectRoot });
  const check = (remote: string, target: string) => evaluate(scope, { kind: "bash", toolName: "bash", input: { command: `git push ${remote} main` }, cwd: f.projectRoot, pushTargets: { [f.projectRoot + "\0" + remote]: [target] } });
  expect(check("origin", "git@github.com:fixture-dev/sample-repo.git").allow).toBe(true);
  expect(check("upstream", "git@github.com:example-org/sample-repo.git").allow).toBe(false);
  expect(check("origin", "ssh://git@GitHub.COM:22/fixture-dev/sample-repo.git").allow).toBe(true);
  expect(check("origin", "https://token@github.com/fixture-dev/sample-repo.git").allow).toBe(true);
});
it("uses Git's actual push URLs and URL rewrites without contacting a remote", () => {
  const f = fixture(), { worktree, git, main } = linkedWorktree(f.projectRoot);
  writeFileSync(f.global, "v: 1\nrules:\n - remote: github.com/fixture-dev/*\n   classes:\n     smith:\n       defaults: {allowRules: [git-push-main]}\n");
  const bind = (scope: ReturnType<typeof scopeForClass>) => bindPaths(scope, { home: f.home, tmp: [tmpdir()], scopesDir: join(f.home, "scopes"), worktree });
  const scoped = bind(f.policy.resolve("smith", {}).scope), standard = bind({ ...scopeForClass("smith"), assignedBranch: "topic" });
  const call = (command: string) => prepareCall({ kind: "bash", toolName: "bash", input: { command }, cwd: worktree });
  git(worktree, "remote", "add", "origin", "https://github.com/fixture-dev/personal.git");
  git(worktree, "remote", "set-url", "--push", "origin", "https://github.com/example-org/sample-repo.git");
  expect(evaluate(scoped, call("git push origin main")).allow).toBe(false);
  git(worktree, "remote", "set-url", "--push", "origin", "https://github.com/fixture-dev/personal.git");
  expect(evaluate(scoped, call("git push origin main")).allow).toBe(true);
  expect(evaluate(standard, call("git push origin HEAD")).allow).toBe(true);
  git(main, "branch", "-m", "base"); git(worktree, "checkout", "-qb", "main");
  expect(evaluate(standard, call("git push origin HEAD")).allow).toBe(false);
  git(worktree, "config", "url.https://github.com/example-org/.pushInsteadOf", "https://github.com/fixture-dev/");
  expect(evaluate(scoped, call("git push https://github.com/fixture-dev/personal.git main")).allow).toBe(false);
});
it("does not overwrite a policy while another writer holds its lock", () => {
  const f = fixture(); writeFileSync(f.global, "# untouched\nv: 1\nrules: []\n"); writeFileSync(f.global + ".lock", "busy");
  expect(() => f.policy.rememberWidening({ remotes: ["https://github.com/fixture-dev/personal"] }, "smith", ["git-push-main"])).toThrow();
  expect(readFileSync(f.global, "utf8")).toBe("# untouched\nv: 1\nrules: []\n");
  expect(existsSync(f.global + ".lock")).toBe(true);
});
it("remembers only in the global file keyed to an unambiguous push remote, preserving comments", () => {
  const f = fixture(); writeFileSync(f.global, "# personal\nv: 1\nrules: []\n");
  const file = f.policy.rememberWidening({ projectRoot: f.projectRoot, remotes: ["https://github.com/fixture-dev/personal.git"] }, "smith", ["git-push-main"]);
  expect(file).toBe(f.global); expect(existsSync(f.project)).toBe(false); expect(readFileSync(file, "utf8")).toContain("# personal");
  expect(readFileSync(file, "utf8")).toContain("github.com/fixture-dev/personal");
  expect(() => f.policy.rememberWidening({ projectRoot: f.projectRoot, remotes: ["https://github.com/a/a", "https://github.com/b/b"] }, "smith", ["git-push-main"])).toThrow();
});
