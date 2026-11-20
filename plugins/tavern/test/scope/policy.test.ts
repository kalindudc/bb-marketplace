// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScopePolicy, mergeOverride } from "../../src/scope/policy";
import { scopeForClass } from "../../src/scope/presets";
import { evaluate } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "tavern-policy-")); dirs.push(home);
  const projectRoot = join(home, "repo"); mkdirSync(projectRoot);
  const globalFile = join(home, ".agents/tavern/scopes.yml"); mkdirSync(join(home, ".agents/tavern"), { recursive: true });
  const context = { projectRoot, remotes: ["git@github.com:kalindudc/personal.git"] };
  return { home, projectRoot, globalFile, context, policy: new ScopePolicy({ home }) };
}
const push = (scope: ReturnType<ScopePolicy["resolve"]>["scope"], target = "git@github.com:kalindudc/personal.git") => evaluate(bindPaths(scope, { home: "/home/me", worktree: "/repo", tmp: ["/tmp"], scopesDir: "/data/scopes" }), { kind: "bash", toolName: "bash", input: { command: "git push origin main" }, cwd: "/repo", pushTargets: { ["/repo\0origin"]: [target] } });
it("withholds unapproved widening and applies safe narrowing without policy", () => {
  const { policy, context } = setup();
  const denied = policy.resolve("smith", context, { allowRules: ["git-push-main"] });
  expect(denied.widenings).toEqual(["git-push-main"]); expect(push(denied.scope).allow).toBe(false);
  const narrow = policy.resolve("ranger", context, { tools: { deny: ["web_*"] } });
  expect(narrow.widenings).toEqual([]); expect(narrow.scope.tools.deny).toContain("web_*");
});
it("automatically applies personal-repo defaults and permits named Keeper widening", () => {
  const { policy, context, globalFile } = setup();
  writeFileSync(globalFile, `v: 1
rules:
  - remote: github.com/kalindudc/*
    classes:
      smith:
        defaults:
          allowRules: [git-push-main]
        keeperMayAllow: [git-push-target]
`);
  expect(push(policy.resolve("smith", context).scope).allow).toBe(true);
  expect(policy.resolve("smith", context, { allowRules: ["git-push-target"] }).widenings).toEqual([]);
  expect(policy.resolve("smith", { ...context, remotes: ["https://github.com/company/repo.git"] }, { allowRules: ["git-push-main"] }).widenings).toEqual(["git-push-main"]);
  expect(policy.resolve("smith", context, { allowRules: ["git-push-force"] }).widenings).toEqual(["git-push-force"]);
});
it("merges shipped, global and project layers deterministically; project can revoke widening", () => {
  const { policy, context, globalFile, projectRoot } = setup();
  writeFileSync(globalFile, "v: 1\nrules:\n  - classes:\n      smith:\n        defaults: { allowRules: [git-push-main] }\n        keeperMayAllow: [gh-merge]\n");
  mkdirSync(join(projectRoot, ".agents/tavern"), { recursive: true });
  writeFileSync(join(projectRoot, ".agents/tavern/scopes.yml"), "v: 1\nrules:\n  - classes:\n      smith:\n        defaults:\n          denyRules: [{id: git-push-main, argv: [git, push], why: Project denies pushes}]\n        keeperMayAllow: []\n");
  const result = policy.resolve("smith", context, { allowRules: ["gh-merge"] });
  expect(push(result.scope).allow).toBe(false); expect(result.widenings).toEqual([]);
  expect(policy.policy(context).sources).toHaveLength(3);
});
it("remembers an approved rule atomically in the global policy and leaves project comments intact", () => {
  const { policy, context, projectRoot } = setup();
  mkdirSync(join(projectRoot, ".agents/tavern"), { recursive: true });
  const file = join(projectRoot, ".agents/tavern/scopes.yml");
  writeFileSync(file, "# My repository policy\nv: 1\nrules: []\n");
  policy.rememberWidening(context, "smith", ["git-push-main"]);
  expect(readFileSync(file, "utf8")).toContain("# My repository policy");
  expect(push(policy.resolve("smith", context).scope).allow).toBe(true);
});
it("keeps a global remembered grant matched to the repository, not every remote", () => {
  const { policy, context } = setup();
  policy.rememberWidening(context, "smith", ["git-push-main"], "global");
  expect(push(policy.resolve("smith", context).scope).allow).toBe(true);
  expect(push(policy.resolve("smith", { remotes: ["https://github.com/company/other"] }).scope, "https://github.com/company/other").allow).toBe(false);
});
it("cannot weaken a deny by submitting another deny with its id", () => {
  const original = scopeForClass("ranger");
  const narrowed = mergeOverride(original, { denyRules: [{ id: "git-push", argv: ["git", "push", "only-this"], why: "narrow" }] });
  expect(narrowed.shell.deny.filter(rule => rule.id === "git-push")).toHaveLength(2);
});
const clusterRule = { id: "cluster-write", argv: ["kubectl", "apply"], why: "Cluster write" };
const clusterReason = /Cluster writes can.t be granted as scope; ask the user/;
it("refuses both requested and explicitly approved cluster scope grants", () => {
  const { policy, context } = setup();
  const scope = mergeOverride(scopeForClass("smith"), { denyRules: [clusterRule] });
  const override = { allowRules: ["cluster-write"] };
  expect(() => mergeOverride(scope, override)).toThrow(clusterReason);
  expect(() => policy.apply(scope, context, override)).toThrow(clusterReason);
  expect(() => policy.apply(scope, context, override, ["cluster-write"])).toThrow(clusterReason);
  expect(() => policy.rememberWidening(context, "smith", ["cluster-write"])).toThrow(clusterReason);
});
it.each(["defaults: { allowRules: [cluster-write] }", "keeperMayAllow: [cluster-write]"])("ignores a standing cluster grant from scopes.yml: %s", entry => {
  const { policy, context, globalFile } = setup();
  writeFileSync(globalFile, `v: 1\nrules:\n  - classes:\n      smith:\n        ${entry}\n`);
  const result = policy.resolve("smith", context);
  expect(result.problems.join("\n")).toMatch(clusterReason);
  expect(result.scope.shell.allow).not.toContainEqual(expect.objectContaining({ id: "cluster-write" }));
  expect(policy.policy(context).classes.smith?.keeperMayAllow).not.toContain("cluster-write");
});
it("does not honour a cluster exception already stored on a scope", () => {
  const scope = bindPaths(scopeForClass("smith"), { home: "/home/me", worktree: "/repo", tmp: ["/tmp"], scopesDir: "/data/scopes" });
  scope.shell.allow.push(clusterRule);
  expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command: "kubectl apply -f demo.yaml" }, cwd: "/repo" })).toMatchObject({ allow: false, ruleId: "cluster-write" });
});
it("fails visibly on malformed policy and rejects unknown rule ids", () => {
  const { policy, context, globalFile } = setup();
  expect(() => policy.resolve("smith", context, { allowRules: ["no-such-rule"] })).toThrow("Unknown");
  writeFileSync(globalFile, "v: 99");
  expect(() => policy.policy(context)).toThrow();
});
