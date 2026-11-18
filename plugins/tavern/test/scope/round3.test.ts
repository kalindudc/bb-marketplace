// @vitest-environment node
import { expect, it, vi } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { prepareCall } from "../../src/scope/prepare";
const cwd = process.cwd();
const paths = { home: cwd + "/scratch/home", worktree: cwd, tmp: [cwd + "/scratch/tmp"], threadStorage: cwd + "/storage", scopesDir: cwd + "/scopes" };
function check(command: string, role = "smith") {
  const readCommand = vi.fn((program: string, args: string[]) => {
    if (program === "git" && args.includes("symbolic-ref")) return "feature";
    if (program === "git" && args.includes("get-url")) return "git@github.com:kalindudc/world.git";
    if (program === "git" && args.includes("--show-toplevel")) return cwd;
    if (program === "gh" && args[0] === "api") return '{"login":"tester"}';
    if (program === "gh" && args[0] === "pr") return JSON.stringify({ isDraft: true, author: { login: args[2] === "5" ? "someone-else" : "tester" }, headRefName: "feature", headRepositoryOwner: { login: "kalindudc" }, headRepository: { name: "world" } });
    throw new Error("Unexpected lookup");
  });
  const scope = bindPaths(scopeForClass(role), paths);
  return { decision: evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } }, { readCommand, scope })), readCommand };
}
it.each(["gh pr edit --body x 5", "gh pr edit --title=x --body x 5", "gh pr edit -b x 5", "gh pr edit --body x -- 5"])("verifies the actual positional selector: %s", command => {
  const f = check(command); expect(f.decision.allow).toBe(false);
  expect(f.readCommand.mock.calls.some(([program, args]) => program === "gh" && args[0] === "pr" && args[2] === "5")).toBe(true);
});
it.each(["gh pr edit --body x 1", "gh pr edit --body=x 1", "gh pr edit -bx 1", "git status && gh pr edit --body x"])("allows verified, unambiguous own-draft edits: %s", command => expect(check(command).decision.allow).toBe(true));
it.each(["GH_REPO=other/repo gh pr edit 1 --body x", "env GH_HOST=example.org gh pr edit 1 --body x", "export GH_REPO=other/repo; gh pr edit 1 --body x", "GH_HOST=example.org; gh pr edit --body x", "git switch colleague-fix && gh pr edit --body x", "git switch main; gh pr edit 1 --body x", "gh pr edit 1 --body x; git switch main; gh pr edit 1 --body y"])("does not grant stale or redirected PR facts: %s", command => expect(check(command).decision.allow).toBe(false));
it.each(["git switch main && git push origin HEAD", "git checkout main; git merge feature; git push origin HEAD", "git checkout -b master && git push -u origin HEAD", "git push origin HEAD; git switch main; git push origin HEAD"])("does not grant a stale HEAD target: %s", command => expect(check(command).decision.allow).toBe(false));
it.each(["git push origin HEAD", "git status && git push origin HEAD", "git log -1; git push origin HEAD", "git status || true; git push origin HEAD"])("resolves HEAD after reads only: %s", command => expect(check(command).decision.allow).toBe(true));
it.each(["ranger", "smith", "wanderer"])("expands bound storage/tmp variables for %s", role => {
  for (const command of ['echo x > "$BB_THREAD_STORAGE/notes.md"', 'mkdir -p "${BB_THREAD_STORAGE}/review"', 'cat > "$BB_THREAD_STORAGE/r.md" <<\'EOF\'\nx\nEOF', 'echo x > "$TMPDIR/x"', 'cd "$BB_THREAD_STORAGE" && echo x > n.md']) expect(check(command, role).decision.allow, command).toBe(true);
});
it.each(["ranger", "smith"])("does not trust assigned, unset or unknown path variables for %s", role => {
  for (const command of ['TMPDIR=/outside; echo x > "$TMPDIR/x"', 'export BB_THREAD_STORAGE=/outside; mkdir "$BB_THREAD_STORAGE/x"', 'unset TMPDIR; echo x > "$TMPDIR/x"', 'echo x > "$UNKNOWN/x"']) expect(check(command, role).decision.allow, command).toBe(false);
});
it("protects known open-preset roots while permitting unknown paths", () => {
  expect(check('cp a "$HOME/.ssh/config"', "wanderer").decision.allow).toBe(false);
  expect(check('cp a "$HOME/.ssh/$UNKNOWN"', "wanderer").decision.allow).toBe(false);
  expect(check('cp a "$HOME/x"', "wanderer").decision.allow).toBe(true);
  expect(check('echo x > "$UNKNOWN/x"', "wanderer").decision.allow).toBe(true);
  expect(check('echo x > "$PWD/src/x"').decision.allow).toBe(true);
});
it.each(["cat <<EOF | bash\ngit push origin main\nEOF", "bash <<< 'git push origin main'", "bash < <(echo git push origin main)", `cd /etc || cd ${cwd}; touch x`, `cd /etc && cd ${cwd}/__scope_missing_directory__; touch x`, "gs dss", "git-spice stack submit", "git-spice dss", "bun publish", "cargo publish", "gem push package.gem", "twine upload dist/*"])("blocks the new Low probes: %s", command => expect(check(command).decision.allow).toBe(false));
it.each(["git tag -l", "git tag --list 'v*'", "git branch --contains HEAD", "git remote show origin", "awk '/foo|bar/' f", "sed -n '/x/{p;q}' f", "gh api graphql -F owner=o -F name=r -f query='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){name}}'", "gh api -X GET search/issues -f q=bug", "kubectl config get-contexts", "curl -fsS -o /dev/null -w '%{http_code}' https://example.org", "tree", "fd foo", "column -t f", "shasum f", "md5 f", "hostname", "mktemp", "node --version", "npm ls", "npm view pkg", "bb flare list"])("allows fresh everyday Ranger reads: %s", command => expect(check(command, "ranger").decision.allow).toBe(true));
it.each(['cd "$(git rev-parse --show-toplevel)/packages/a" && npm test', 'for ((i=0;i<3;i++)); do echo "$i"; done'])("allows fresh everyday Smith work: %s", command => expect(check(command).decision.allow).toBe(true));
it.each(["tree -o /outside/file", "fd --exec sh -c bad", "fd -x sh -c bad", "hostname changed", "node --version -e bad", "npm version patch", "mktemp /outside/file.XXXX", "awk 'BEGIN{x=1 / system(\"bad\") / 2}'", "sed -n '/x/{p;e bad}'", "gh api graphql -f query='mutation{bad}' -F owner=o", "git branch --contains HEAD -D feature", "git tag --list -d v1", "gh api -X POST search/issues -f q=bug"])("does not turn read additions into unchecked writers: %s", command => expect(check(command, "ranger").decision.allow).toBe(false));
it.each(["mkdir '$TMPDIR'", "export PWD=/outside; touch \"$PWD/x\"", "env --unset TMPDIR mkdir \"$TMPDIR/x\"", "env --unset=TMPDIR bash -c 'echo x > \"$TMPDIR/x\"'", "env -i bash -c 'echo x > \"$TMPDIR/x\"'", "for TMPDIR in /outside; do echo x > \"$TMPDIR/x\"; done"])("does not expand quoted or reassigned bindings: %s", command => expect(check(command, "ranger").decision.allow).toBe(false));
it.each(["tavern_note", "tavern_gate"])("makes Keeper memory tools available to Rangers too: %s", toolName => {
  for (const role of ["keeper", "ranger"]) expect(evaluate(bindPaths(scopeForClass(role), paths), { kind: "tool", toolName, cwd, input: {} }).allow).toBe(true);
});
