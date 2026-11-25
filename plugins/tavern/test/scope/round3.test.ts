// @vitest-environment node
import { expect, it, vi } from "vitest";
import { evaluate, readonlyProgram } from "../../src/scope/engine";
import { shellCommands } from "../../src/scope/shell";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
import { prepareCall } from "../../src/scope/prepare";
const cwd = process.cwd();
const paths = { home: cwd + "/scratch/home", worktree: cwd, tmp: [cwd + "/scratch/tmp"], threadStorage: cwd + "/storage", scopesDir: cwd + "/scopes" };
function check(command: string, role = "smith") {
  const readCommand = vi.fn((program: string, args: string[]) => {
    if (program === "git" && args.includes("symbolic-ref")) return "feature";
    if (program === "git" && args.includes("get-url")) return "git@github.com:fixture-dev/sample-repo.git";
    if (program === "git" && args.includes("--show-toplevel")) return cwd;
    if (program === "gh" && args[0] === "api") return '{"login":"tester"}';
    if (program === "gh" && args[0] === "pr") return JSON.stringify({ isDraft: true, author: { login: args[2] === "5" ? "someone-else" : "tester" }, headRefName: args[2] === "5" ? "someone-else" : "feature", headRepositoryOwner: { login: "fixture-dev" }, headRepository: { name: "sample-repo" } });
    throw new Error("Unexpected lookup");
  });
  const scope = bindPaths({ ...scopeForClass(role), assignedBranch: "feature" }, paths);
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
it.each(["ranger", "smith"])("does not refuse ordinary work with assigned, unset or unknown path variables for %s", role => {
  for (const command of ['TMPDIR=/outside; echo x > "$TMPDIR/x"', 'export BB_THREAD_STORAGE=/outside; mkdir "$BB_THREAD_STORAGE/x"', 'unset TMPDIR; echo x > "$TMPDIR/x"', 'echo x > "$UNKNOWN/x"']) expect(check(command, role).decision.allow, command).toBe(true);
});
it("protects known Tavern controls while permitting other paths", () => {
  expect(check('cp a "$HOME/.agents/tavern/settings.toml"', "wanderer").decision.allow).toBe(false);
  expect(check('cp a "$HOME/.ssh/$UNKNOWN"', "wanderer").decision.allow).toBe(true);
  expect(check('cp a "$HOME/x"', "wanderer").decision.allow).toBe(true);
  expect(check('echo x > "$UNKNOWN/x"', "wanderer").decision.allow).toBe(true);
  expect(check('echo x > "$PWD/src/x"').decision.allow).toBe(true);
});
it.each(["cat <<EOF | bash\ngit push origin main\nEOF", "bash <<< 'git push origin main'", "gs dss", "git-spice stack submit", "git-spice dss", "bun publish", "cargo publish", "gem push package.gem", "twine upload dist/*"])("holds recognized acts in shell and package variants: %s", command => expect(check(command).decision.allow).toBe(false));
it("cannot inspect script input from a process substitution", () =>
  expect(check("bash < <(echo git push origin main)").decision).toMatchObject({ allow: true, inspectionUnavailable: true }));
it.each(["git tag -l", "git tag --list 'v*'", "git branch --contains HEAD", "git remote show origin", "awk '/foo|bar/' f", "sed -n '/x/{p;q}' f", "gh api graphql -F owner=o -F name=r -f query='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){name}}'", "gh api -X GET search/issues -f q=bug", "kubectl config get-contexts", "curl -fsS -o /dev/null -w '%{http_code}' https://example.org", "tree", "fd foo", "column -t f", "shasum f", "md5 f", "hostname", "mktemp", "node --version", "npm ls", "npm view pkg", "bb flare list"])("allows fresh everyday Ranger reads: %s", command => expect(check(command, "ranger").decision.allow).toBe(true));
it.each(['cd "$(git rev-parse --show-toplevel)/packages/a" && npm test', 'for ((i=0;i<3;i++)); do echo "$i"; done'])("allows fresh everyday Smith work: %s", command => expect(check(command).decision.allow).toBe(true));
it.each(["tree -o /outside/file", "fd --exec sh -c bad", "fd -x sh -c bad", "hostname changed", "node --version -e bad", "npm version patch", "awk 'BEGIN{x=1 / system(\"bad\") / 2}'", "sed -n '/x/{p;e bad}'"])("does not classify mutating variants of read additions as reads: %s", command => expect(shellCommands(command, cwd).every(readonlyProgram)).toBe(false));
it.each(["gh api graphql -f query='mutation{bad}' -F owner=o", "gh api -X POST search/issues -f q=bug"])("retains Ranger GitHub write blocks: %s", command => expect(check(command, "ranger").decision.allow).toBe(false));
it.each(["mkdir '$TMPDIR'", "export PWD=/outside; touch \"$PWD/x\"", "env --unset TMPDIR mkdir \"$TMPDIR/x\"", "env --unset=TMPDIR bash -c 'echo x > \"$TMPDIR/x\"'", "env -i bash -c 'echo x > \"$TMPDIR/x\"'", "for TMPDIR in /outside; do echo x > \"$TMPDIR/x\"; done"])("passes ordinary calls with quoted or reassigned bindings: %s", command => expect(check(command, "ranger").decision.allow).toBe(true));
it.each(["tavern_note", "tavern_gate"])("makes Keeper memory tools available to Rangers too: %s", toolName => {
  for (const role of ["keeper", "ranger"]) expect(evaluate(bindPaths({ ...scopeForClass(role), assignedBranch: "feature" }, paths), { kind: "tool", toolName, cwd, input: {} }).allow).toBe(true);
});
