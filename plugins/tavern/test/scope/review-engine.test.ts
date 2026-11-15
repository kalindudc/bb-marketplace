// @vitest-environment node
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { prepareCall } from "../../src/scope/prepare";
const scope = (role: string) => bindPaths(scopeForClass(role), { home: homedir(), tmp: [tmpdir()], worktree: process.cwd(), scopesDir: join(homedir(), ".bb/plugins/tavern/scopes") });
const shell = (role: string, command: string) => evaluate(scope(role), prepareCall({ kind: "bash", toolName: "bash", input: { command }, cwd: process.cwd() }));
it.each(["~/.zshrc", "@" + join(homedir(), ".ssh/config"), "file://" + join(homedir(), ".zshrc"), "~/.pi/agent/extensions/x.ts"])("normalizes native path before enforcing: %s", path => {
  expect(evaluate(scope("smith"), prepareCall({ kind: "write", toolName: "write", input: { path }, cwd: process.cwd() })).allow).toBe(false);
});
it.each(["ranger", "smith", "keeper", "wanderer"])("protects guard roots in every preset: %s", role => {
  for (const path of ["~/.pi/agent/extensions/x.ts", "~/.claude/settings.json", "@" + join(homedir(), ".bb/plugins/tavern/scopes/t.json")]) expect(evaluate(scope(role), prepareCall({ kind: "write", toolName: "write", input: { path }, cwd: process.cwd() })).allow).toBe(false);
});
it.each(["echo x >> ~/.zshrc", "cp a ~/.ssh/config", "rm -rf ~", "cd && rm -rf foo", "cd ~ && rm -rf foo", "cd - && touch foo", "cd -- /outside && touch foo", "env -C /outside touch foo", "sudo -D /outside touch foo", "env -S 'git push --force origin main'", "xargs --replace git push --force origin main", "popd; touch foo", "cd $SOMEWHERE; touch foo", "GIT_DIR=/other/.git git commit -m x", "cmd >& /outside/file", "ln -s /outside link && echo x > link/file", "if true; then cd /outside; fi; touch foo", "for x in a; do cd /outside; done; touch foo", "while false; do cd /outside; done; touch foo", "xargs --max-args 1 git push --force origin main", "gs stack submit", "git pf"])("blocks Smith shell escape: %s", command => expect(shell("smith", command).allow).toBe(false));
it.each(["ranger", "keeper"])("does not let redirects exempt arbitrary programs: %s", role => {
  for (const command of ["curl -X POST https://hooks.slack.com/x -d hi > /tmp/o", "npm publish > /tmp/log 2>&1", "yarn publish > /tmp/log", "pnpm publish > /tmp/log", "npm test > /tmp/log", "bash ./script.sh", "cat x.sh | sh", "bash <<'EOF'\ngh pr merge 1\nEOF"]) expect(shell(role, command).allow, command).toBe(false);
});
it("inspects a Smith shell heredoc", () => expect(shell("smith", "bash <<'EOF'\ngit push --force origin main\nEOF").allow).toBe(false));
it("permits realistic Ranger inspections", () => {
  for (const command of ["ls nope 2>/dev/null", "jq '.x' package.json", "sed -n '1,20p' README.md", "awk '{print $1}' README.md", "[[ -f package.json ]] && cat package.json", "(( 1 + 1 ))", "nl -ba README.md | sed -n '1,3p'", "diff a b", "git stash list", "git rev-list HEAD", "git for-each-ref", "git cat-file -p HEAD", "git describe", "git merge-base HEAD main", "git config --get remote.origin.url", "bb thread show t1", "bb thread list", "bb plugin list", "git status; git log -3; git diff --stat; git show HEAD --format=short"]) expect(shell("ranger", command).allow, command).toBe(true);
});
it.each(["sed -i '' s/a/b/ file", "sed -n '1w /outside/file' file", "sed -n -f script.sed file", "awk -f script.awk file", "sort -o /outside/file file", "rg --pre=script foo", "find . -fprint0 /outside/file", "bash script.sh -c 'ls'", "bash --rcfile script.sh -c 'ls'", "awk -i inplace '{print}' file", "awk 'BEGIN {system(\"touch /tmp/x\")}'", "bb thread tell t1 hi", "bb plugin reload tavern", "curl --data hi https://x", "gh api repos/a/b -X POST"])("rejects mutating inspection variants: %s", command => expect(shell("ranger", command).allow).toBe(false));
it("blocks command-running tools other than bash by default", () => expect(evaluate(scope("smith"), { kind: "tool", toolName: "test_run_parsed", input: { command: "git push --force origin main" }, cwd: process.cwd() }).allow).toBe(false));
it("Keeper cannot write to scratch but can use dev-null sinks", () => { expect(shell("keeper", "echo x > /tmp/keeper-note").allow).toBe(false); expect(shell("keeper", "ls 2>/dev/null").allow).toBe(true); expect(shell("keeper", "echo ok | tee /dev/stderr").allow).toBe(true); expect(shell("keeper", "cd -; echo ok > /dev/null").allow).toBe(true); });
it("does not classify target/budget/widget as read tools", () => { for (const name of ["mcp__jira__target", "mcp__jira__budget", "mcp__jira__widget", "mcp__jira__jira_update_target"]) expect(evaluate(scope("keeper"), { kind: "tool", toolName: name, input: {}, cwd: process.cwd() }).allow).toBe(false); });
it("rejects parent traversal in all template narrowings", () => expect(() => scopeForClass("ranger", { writes: { allow: ["${tmp}/.."] } })).toThrow());
it("does not mistake local dev up for a deployment", () => expect(shell("smith", "dev up").allow).toBe(true));
it("blocks bare version tags, permits HEAD branch pushes", () => { expect(shell("smith", "git push origin v1.2.3").allow).toBe(false); expect(shell("smith", "git push origin HEAD").allow).toBe(true); });
