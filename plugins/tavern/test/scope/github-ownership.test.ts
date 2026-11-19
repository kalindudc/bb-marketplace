// @vitest-environment node
import { expect, it, vi } from "vitest";
import { prepareCall } from "../../src/scope/prepare";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
const cwd = process.cwd();
const metadata = { isDraft: true, author: { login: "tester" }, headRefName: "feature", headRepositoryOwner: { login: "kalindudc" }, headRepository: { name: "world" } };
function check(patch: Record<string, unknown> = {}, command = "gh pr edit 1 --body x") {
  const readCommand = vi.fn((program: string, args: string[]) => {
    if (program === "git" && args.includes("symbolic-ref")) return "feature";
    if (program === "git" && args.includes("get-url")) return "git@github.com:kalindudc/world.git";
    if (program === "gh" && args[0] === "api") return '{"login":"tester"}';
    if (program === "gh" && args[0] === "pr") return JSON.stringify({ ...metadata, ...patch });
    throw new Error("Unexpected fact lookup");
  });
  const scope = bindPaths({ ...scopeForClass("smith"), assignedBranch: "feature" }, { home: cwd, worktree: cwd, tmp: [cwd + "/scratch"], scopesDir: cwd + "/scopes" });
  const decision = evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } }, { readCommand, scope }));
  return { decision, readCommand };
}
it("allows an authenticated user's draft on this checkout's branch and head repository", () => expect(check().decision.allow).toBe(true));
it.each([{ headRefName: "another-branch" }, { headRepository: { name: "another-repository" } }, { headRepositoryOwner: null }])("rejects missing or mismatched ownership facts: %s", patch => expect(check(patch).decision.allow).toBe(false));
it.each(["gh -R owner/repo pr edit 1 --body x", "gh pr edit 1 --body x --repo owner/repo", "gh pr edit 1 --repo=owner/repo --body x"])("verifies the exact repository the edit will target: %s", command => {
  const result = check({}, command); expect(result.decision.allow).toBe(true);
  expect(result.readCommand).toHaveBeenCalledWith("gh", ["pr", "view", "1", "--repo", "owner/repo", "--json", "isDraft,author,headRefName,headRepository,headRepositoryOwner"], cwd);
});
it("allows an authored PR after draft state changes", () => expect(check({ isDraft: false }).decision.allow).toBe(true));
it("retains the author check", () => expect(check({ author: { login: "another-user" } }).decision.allow).toBe(false));
it("denies the edit when GitHub facts are unavailable", () => {
  const scope = bindPaths({ ...scopeForClass("smith"), assignedBranch: "feature" }, { home: cwd, worktree: cwd, tmp: [cwd + "/scratch"], scopesDir: cwd + "/scopes" });
  expect(evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command: "gh pr edit 1 --body x" } }, { readCommand: () => { throw new Error("offline"); } })).allow).toBe(false);
});
it.each(["gh api -X POST repos/o/r", "gh api repos/o/r -X POST", "gh api -f query='query { viewer { login } }' graphql", "gh api graphql -f query='query { viewer { login } }' -X POST"])("classifies the actual API method and endpoint: %s", command => {
  const scope = bindPaths(scopeForClass("ranger"), { home: cwd, tmp: [cwd + "/scratch"], scopesDir: cwd + "/scopes" });
  const decision = evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } }));
  expect(decision.allow).toBe(command.includes("graphql"));
});
it.each(["find . -exec gh pr merge 1 \\;", "find . -exec kubectl apply -f x \\;", "find . -exec sed -i s/a/b/ x \\;"])("does not treat find executors as unchecked read programs: %s", command => {
  const scope = bindPaths(scopeForClass("ranger"), { home: cwd, tmp: [cwd + "/scratch"], scopesDir: cwd + "/scopes" });
  expect(evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } })).allow).toBe(false);
});
