// @vitest-environment node
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { evaluate, type ScopeCall } from "../../src/scope/engine";
import { bindPaths, realPath } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { shouldScope } from "../../src/scope";
import { prepareCall } from "../../src/scope/prepare";
import { linkedWorktree } from "./git-fixture";
let repo: string, cwd: string;
beforeAll(() => { repo = mkdtempSync(join(tmpdir(), "tavern-round2-git-")); cwd = linkedWorktree(repo).worktree; });
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "tavern-round2-")); dirs.push(path); return path; };
const bound = (role: string, path = cwd) => bindPaths(scopeForClass(role), { home: path, worktree: path, tmp: [join(path, "scratch")], scopesDir: join(path, "scopes") }, realPath);
const shell = (role: string, command: string) => evaluate(bound(role), prepareCall({ kind: "bash", toolName: "bash", input: { command }, cwd }));
it.each(["echo $((1+1)); bash <<EOF\ngit push origin main\nEOF", "((n=1)); bash <<EOF\ngit push origin main\nEOF", "(( n = 1 )); bash <<EOF\ngit push --force origin feature\nEOF", "echo $((1+1)); bash <<'EOF'\ngit push origin main\nEOF", "bash -c '((n=1)); bash <<EOF\ngit push origin main\nEOF'"])("inspects heredocs at the correct arithmetic-relative offsets: %s", command => expect(shell("smith", command).allow).toBe(false));
const rangerReads = ["git reflog -5", "git ls-remote origin", "git show-ref --heads", "git check-ignore -v x", "git worktree list", "git --version", "git whatchanged", "git count-objects", "awk 'NR>1 {print $2}' f", "awk -F, '$3 > 100' f", 'awk \'{print "a > b"}\' f', "awk '$1 < 5 || $2 > 2 { print $1 }' f", "sed -n 's/a/b/p' f", "sed 's/^/  /' f", "env | grep BB_", "printenv PATH", "whoami", "id", "ps aux | grep node", 'while read -r l; do echo "$l"; done < f', "bash -c 'git status' | head", "bash -euo pipefail -c 'git status | head'", "gh api graphql -f query='query { viewer { login } }'", "find . -name '*.ts' -exec grep -l foo {} +"];
it.each(rangerReads)("allows everyday Ranger inspection: %s", command => expect(shell("ranger", command).allow).toBe(true));
it.each(["git apply patch.diff", "git apply --check patch.diff", "git am patch.mbox", "git submodule update --init", "git lfs pull", "git format-patch -1 HEAD", "git bisect start", 'cd "$(git rev-parse --show-toplevel)" && npm test', "pushd packages/a && npm test && popd && npm run lint", "ln -sf ../x y && npm test", "gh run watch 123"])("allows everyday Smith work: %s", command => expect(shell("smith", command).allow).toBe(true));
it.each(["git reflog expire --all", "git reflog delete HEAD@{0}", "awk '{print > \"/outside/file\"}' f", "awk '{print | \"sh\"}' f", "awk 'BEGIN {system(\"bad\")}'", "sed 's/a/b/w /outside/file' f", "sed 's/a/b/e' f", "find . -exec sh -c 'git push origin main' \\;", "gh api graphql -f query='mutation { dangerous }'", "env bash script.sh"])("retains Ranger write/execution blocks: %s", command => expect(shell("ranger", command).allow).toBe(false));
it.each(["git -C src status; touch ../outside", "env -C src true; touch ../outside"])("does not change parent shell cwd for a child process: %s", command => expect(shell("smith", command).allow).toBe(false));
it.each(["gs ss", "gs bs", "gs rs", "gs us", "gs uss", "gs bss", "gs stack submit", "gs branch submit", "gs repo sync", "gs upstack submit", "gs branch submit --draft", "npm publish", "yarn publish", "pnpm publish"])("blocks Smith publication: %s", command => expect(shell("smith", command).allow).toBe(false));
it("leaves direct Wanderers/untyped threads unscoped, but scopes hired Wanderers", () => {
  expect(shouldScope("wanderer", "direct")).toBe(false); expect(shouldScope(undefined, "direct")).toBe(false); expect(shouldScope("untyped", "direct")).toBe(false);
  expect(shouldScope("wanderer", "hire")).toBe(true); expect(shouldScope("smith", "direct")).toBe(true);
});
it("protects both the spelling and real target of symlinked extension entries", () => {
  const home = root(), real = root(), extensions = join(home, ".pi/agent/extensions"); mkdirSync(extensions, { recursive: true }); symlinkSync(real, join(extensions, "bash-guard"));
  const scope = bound("wanderer", home);
  for (const path of [join(extensions, "bash-guard/index.ts"), join(real, "index.ts")]) expect(evaluate(scope, prepareCall({ kind: "write", toolName: "write", input: { path }, cwd: home })).allow).toBe(false);
  expect(scope.sandbox).toBe(false);
  expect(evaluate(scope, prepareCall({ kind: "write", toolName: "write", input: { path: join(home, ".claude/skills/x/SKILL.md") }, cwd: home })).allow).toBe(true);
  expect(evaluate(scope, prepareCall({ kind: "write", toolName: "write", input: { path: join(home, ".claude/settings.json") }, cwd: home })).allow).toBe(false);
});
