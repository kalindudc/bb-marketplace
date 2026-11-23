// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { prepareCall } from "../../src/scope/prepare";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-round4-")), cwd = join(root, "work"); roots.push(root);
  for (const path of ["work/src", "work/packages/a", "scratch", "storage", "outside"]) mkdirSync(join(root, path), { recursive: true });
  const readCommand = vi.fn((program: string, args: string[]) => {
    if (program === "git" && args.includes("symbolic-ref")) return "feature";
    if (program === "git" && args.includes("--show-toplevel")) return cwd;
    if (program === "git" && args.includes("get-url")) return "git@github.com:fixture-dev/sample-repo.git";
    if (program === "gh" && args[0] === "api") return '{"login":"tester"}';
    if (program === "gh" && args[0] === "pr") return JSON.stringify({ isDraft: true, author: { login: "tester" }, headRefName: "feature", headRepositoryOwner: { login: "fixture-dev" }, headRepository: { name: "sample-repo" } });
    throw new Error("Unexpected lookup");
  });
  const check = (source: string, role = "smith") => {
    const command = source.replaceAll("OUTSIDE", join(root, "outside"));
    const scope = bindPaths({ ...scopeForClass(role, undefined, role === "keeper" ? "keeper" : undefined), assignedBranch: "feature" }, { home: root, worktree: cwd, tmp: [join(root, "scratch")], threadStorage: join(root, "storage"), scopesDir: join(root, "scopes") });
    const call = prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } }, { scope, readCommand });
    return { decision: evaluate(scope, call), call };
  };
  return { root, cwd, check, readCommand };
}
it.each(["ranger", "keeper"])("allows assignments and shell state builtins for %s", role => {
  for (const command of ['X=1; echo "$X"', 'sha=$(git rev-parse HEAD) && git show --stat "$sha"', 'branch=$(git branch --show-current); echo "$branch"', "set -euo pipefail; git status", "set -e\ngit status", "local x=1", "declare x=1", "typeset x=1"]) expect(fixture().check(command, role).decision.allow, command).toBe(true);
});
it.each(["ranger", "warden"])("still checks assignment substitutions for %s", role => expect(fixture().check("x=$(gh pr merge 1)", role).decision.allow).toBe(false));
it("checks Keeper cluster writes in assignment substitutions", () => expect(fixture().check("x=$(terraform apply)", "keeper").decision).toMatchObject({ allow: false, ruleId: "cluster-write" }));
it.each(["ranger", "smith", "keeper"])("rejects mutations before expansion across the whole call for %s", role => {
  for (const command of ['for x in 1 2; do echo x > "$TMPDIR/loop"; TMPDIR=OUTSIDE; done', 'while true; do echo x > "$TMPDIR/loop"; TMPDIR=OUTSIDE; done', 'f() { echo x > "$TMPDIR/function"; }; TMPDIR=OUTSIDE; f', 'printf -v TMPDIR %s OUTSIDE; echo x > "$TMPDIR/printf"', 'declare -n R=TMPDIR; R=OUTSIDE; echo x > "$TMPDIR/alias"', '((TMPDIR=1)); echo x > "$TMPDIR/arith"', 'echo $((TMPDIR=1)); echo x > "$TMPDIR/arith"', 'TMPDIR=OUTSIDE mktemp', 'export TMPDIR=OUTSIDE; mktemp', 'IFS=/; cp /etc/hosts $BB_THREAD_STORAGE']) expect(fixture().check(command, role).decision.allow, command).toBe(false);
});
it("permits quoted expansions after an IFS assignment", () => expect(fixture().check('IFS=/; cp /etc/hosts "$BB_THREAD_STORAGE/hosts"', "ranger").decision.allow).toBe(true));
it.each(["cd packages/a && npm ci; npm test", "cd packages/a && npm ci\nnpm test", "cd src && ls; touch x", "cd src || exit 1; touch x", "cd src || return; touch x", "cd missing || exit; touch x", "cd missing && ls; touch x", "cd src && cd missing && ls; touch x"])("tracks proven or safe candidate cwd states: %s", command => expect(fixture().check(command).decision.allow).toBe(true));
it("uses checked directory facts to prove successful && changes", () => {
  const f = fixture(); expect(f.check(`cd /etc && cd ${f.cwd}; touch x`).decision.allow).toBe(true);
});
it.each(["rmdir src; cd src && ls; touch ../escape", "cd OUTSIDE || cd src; touch x", "cd OUTSIDE/missing && ls; touch x", "cd OUTSIDE/missing && ls; npm test", "cd OUTSIDE && cd src; touch x", "false && cd src; touch ../escape"])("checks every possible write location: %s", command => expect(fixture().check(command).decision.allow).toBe(false));
it.each(["git add -A && git commit -m x && git push origin HEAD", "git commit -am x && git push -u origin HEAD", "git fetch origin && git push origin HEAD", "git stash push && git push origin HEAD", "git tag v2 && git push origin HEAD", "gh pr edit 1 --body x && gh pr edit 1 --title y"])("preserves branch facts through approved non-switching commands: %s", command => expect(fixture().check(command).decision.allow).toBe(true));
it.each(["npm test && git push origin HEAD", "git switch main && git push origin HEAD", "git stash pop && git push origin HEAD", "git reset --hard main && git push origin HEAD"])("does not widen the branch-preserving list: %s", command => expect(fixture().check(command).decision.allow).toBe(false));
it("allows mktemp -d only as a checked scratch writer", () => {
  for (const role of ["ranger", "smith"]) expect(fixture().check("tmp=$(mktemp -d); echo ok", role).decision.allow).toBe(true);
  expect(fixture().check("mktemp -d", "keeper").decision.allow).toBe(true);
});
