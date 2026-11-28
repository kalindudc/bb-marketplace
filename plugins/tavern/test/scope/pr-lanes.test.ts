// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { prepareCall } from "../../src/scope/prepare";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { ScopeStore } from "../../src/scope/store";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { createHash } from "node:crypto";
import { observedPullRequestReceipt, pullRequestGrantAvailable } from "../../src/scope/pr-grants";

const own = "https://github.com/example/repo/pull/12", other = "https://github.com/example/repo/pull/13";
const call = (command: string) => ({ kind: "bash" as const, toolName: "bash", cwd: process.cwd(), input: { command } });
const policy = (role: string, alwaysAsk: boolean) => bindPaths({ ...scopeForClass(role), pullRequestPolicy: { alwaysAsk, owned: [own], grants: [] } },
  { home: tmpdir(), tmp: [tmpdir()], worktree: process.cwd(), threadStorage: tmpdir(), scopesDir: join(tmpdir(), "scopes") });

it.each(["keeper", "wanderer"])("records own PR writes and follows Always ask for unknown targets in %s", role => {
  for (const command of [`gh pr comment ${own} -b hi`, `gh pr edit ${own} --body hi`, "gh api -X POST repos/example/repo/pulls/12/comments/5/replies -f body=hi"]) {
    expect(evaluate(policy(role, true), call(command))).toMatchObject({ allow: true, acts: [{ kind: "publish" }] });
  }
  const read = vi.fn(() => JSON.stringify({ url: own }));
  expect(evaluate(policy(role, true), prepareCall(call("gh pr edit 12 --body hi"), { scope: policy(role, true), readCommand: read })).allow).toBe(true);
  for (const command of [`gh pr review ${other} --approve`, "gh api -X POST repos/example/repo/pulls/13/reviews -f body=hi"]) {
    for (const alwaysAsk of [true, false]) expect(evaluate(policy(role, alwaysAsk), call(command))).toMatchObject({ allow: false, ruleId: "send-guard" });
  }
  const edit = call(`dt pr edit ${other} --title hi`);
  expect(evaluate(policy(role, true), edit)).toMatchObject({ allow: false, ruleId: "pr-sends-as-you" });
  expect(evaluate(policy(role, false), edit)).toMatchObject({ allow: true });
});

it.each([
  ["gh pr close %s", "delete"],
  ["gh pr edit %s --title 'Title text'", "publish"],
  ["gh pr review %s --comment --body 'Review text'", "publish"],
  ["gh api repos/example/repo/pulls/%s/comments/5/replies -XPOST -f body=hello", "publish"],
  ["gh api repos/example/repo/pulls/%s/reviews -f event=COMMENT -f body=review", "publish"],
  ["gh api repos/example/repo/pulls/%s -XPATCH -f title=updated", "publish"],
  ["gh api repos/example/repo/pulls/%s -X PATCH -f state=closed", "delete"],
])("records only the Keeper’s owned work: %s", (template, kind) => {
  const keeper = policy("keeper", true);
  const command = template.replace("%s", template.startsWith("gh api") ? "12" : own);
  const external = template.replace("%s", template.startsWith("gh api") ? "13" : other);
  expect(evaluate(keeper, call(command))).toMatchObject({ allow: true, acts: [{ kind, ruleId: "pr-owned-write" }] });
  expect(evaluate(keeper, call(external))).toMatchObject({ allow: false });
  expect(evaluate({ ...keeper, pullRequestPolicy: { alwaysAsk: true, owned: [other], grants: [] } }, call(command))).toMatchObject({ allow: false });
});

it.each(["resolveReviewThread", "unresolveReviewThread", "convertPullRequestToDraft"])("checks the forge URL before allowing %s", mutation => {
  const key = mutation === "convertPullRequestToDraft" ? "pullRequestId" : "threadId";
  const command = "gh api graphql -f query='mutation($id:ID!){ " + mutation + "(input:{" + key + ":$id}) { clientMutationId } }' -f id=fixture_1";
  const keeper = policy("keeper", true);
  const inspect = (url: string) => vi.fn((_cmd, _args) => JSON.stringify({ data: { node: key === "threadId" ? { pullRequest: { url } } : { url } } }));
  const read = inspect(own);
  expect(evaluate(keeper, prepareCall(call(command), { scope: keeper, readCommand: read }))).toMatchObject({ allow: true, acts: [{ kind: "publish", ruleId: "pr-owned-write" }] });
  expect(read).toHaveBeenCalledWith("gh", expect.arrayContaining(["api", "graphql", "id=fixture_1"]), expect.any(String));
  expect(evaluate(keeper, call(command))).toMatchObject({ allow: false });
  for (const url of [other, own.replace("github.com", "github.com.example.invalid")]) {
    expect(evaluate(keeper, prepareCall(call(command), { scope: keeper, readCommand: inspect(url) }))).toMatchObject({ allow: false });
  }
});

it.each([
  `gh pr ready ${own}`,
  `gh pr edit ${own} --add-reviewer reviewer-one`,
  "gh api repos/example/repo/pulls/12/requested_reviewers -X POST -f 'reviewers[]=reviewer-one'",
  "gh api graphql -f query='mutation { markPullRequestReadyForReview(input:{pullRequestId:\"fixture\"}){clientMutationId} }'",
])("requires the typed Warden-checked ready action for %s", command => {
  const keeper = policy("keeper", true);
  const readCommand = vi.fn(() => JSON.stringify({ data: { node: { url: own } } }));
  expect(evaluate(keeper, prepareCall(call(command), { scope: keeper, readCommand })))
    .toMatchObject({ allow: false, ruleId: "pr-keeper-ready", reason: expect.stringContaining("tavern_pull_request") });
});

it.each([
  `gh pr comment ${own} --body-file -`,
  `gh pr comment ${own} --body-file=reply.md`,
  `gh pr comment ${own} -F reply.md`,
  `gh pr edit ${own} -Freply.md`,
  "gh api repos/example/repo/pulls/12/comments/5/replies -F body=@reply.md",
  "gh api repos/example/repo/pulls/12/comments/5/replies --field=body=@-",
])("does not give the owned exception to a body read from a file: %s", command => {
  expect(evaluate(policy("keeper", true), call(command))).toMatchObject({ allow: false });
});

it("keeps only the previous allowance on an unverified or custom forge record", () => {
  const keeper = policy("keeper", true);
  const url = "https://forge.example/example/repo/pull/12";
  const scope = { ...keeper, pullRequestPolicy: { alwaysAsk: true, owned: [], legacyOwned: [url], grants: [] } };
  expect(evaluate(scope, call(`gh pr comment ${url} -b hi`))).toMatchObject({ allow: true, acts: [{ ruleId: "pr-owned-write" }] });
  expect(evaluate(scope, call(`gh pr edit ${url} --title hi`))).toMatchObject({ allow: true });
  expect(evaluate(scope, call(`gh pr close ${url}`))).toMatchObject({ allow: false, ruleId: "pr-keeper-close" });
  expect(evaluate(scope, call(`gh pr review ${url} --comment -b hi`))).toMatchObject({ allow: false });
});

it("does not infer ownership from the text of an unparsed API command", () => {
  const command = "gh api repos/example/repo/pulls/12/comments/5/replies -f body='incomplete";
  expect(evaluate(policy("keeper", true), call(command))).toMatchObject({ allow: false, ruleId: "pr-sends-as-you" });
});

it("uses only an exact single GraphQL mutation for the ownership proof", () => {
  const keeper = policy("keeper", true);
  const command = "gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){clientMutationId}unresolveReviewThread(input:{threadId:\"foreign\"}){clientMutationId}}' -f id=fixture";
  const readCommand = vi.fn(() => JSON.stringify({ data: { node: { pullRequest: { url: own } } } }));
  expect(evaluate(keeper, prepareCall(call(command), { scope: keeper, readCommand }))).toMatchObject({ allow: false });
  expect(readCommand).not.toHaveBeenCalled();
});

it("tags an explicit push to the owned PR branch without changing push authority", () => {
  const keeper = policy("keeper", true);
  const scope = { ...keeper, pullRequestPolicy: { ...keeper.pullRequestPolicy!, heads: { [own]: "feature" } } };
  const push = "git push origin HEAD:refs/heads/feature";
  const invocation = { ...call(push), pushTargets: { [process.cwd() + "\0origin"]: ["git@github.com:example/repo.git"] } };
  expect(evaluate(scope, invocation)).toMatchObject({ allow: true, acts: [{ ownedPullRequest: { url: own, command: push } }] });
  expect(evaluate(scope, { ...invocation, pushTargets: {} })).toMatchObject({ allow: true, acts: [{ ruleId: "git-push" }] });
});

it("keeps merge and approving reviews out of the owned PR exception", () => {
  const keeper = policy("keeper", true);
  for (const command of [`gh pr merge ${own}`, "gh api repos/example/repo/pulls/12/merge -X PUT", "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"fixture\"}) { clientMutationId } }'"]) {
    expect(evaluate(keeper, call(command))).toMatchObject({ allow: false, ruleId: "merge-approval" });
  }
  expect(evaluate(keeper, call(`gh pr review ${own} --approve`))).toMatchObject({ allow: false });
  expect(evaluate(keeper, call(`gh pr ready ${own.replace("github.com", "github.com.example.invalid")}`))).toMatchObject({ allow: false });
});

it("claims an exact non-message PR exception once across guard reloads", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-grant-"));
  const store = new ScopeStore(root), threadId = "keeper-one";
  const command = `gh pr edit ${other} --title hi`;
  const grant = { id: "decision-fixture", digest: createHash("sha256").update(command).digest("hex") };
  const scope = policy("keeper", true);
  store.write(threadId, { ...scope, pullRequestPolicy: { alwaysAsk: true, owned: [], grants: [grant] } });
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file(threadId)); vi.stubEnv("BB_THREAD_ID", threadId);
  const load = () => {
    const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
    guard({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => ["bash"], setActiveTools: () => {} });
    return {
      call: (source: string, toolCallId: string) => handlers.get("tool_call")!({ toolName: "bash", toolCallId, input: { command: source } }, { cwd: process.cwd() }),
      result: (toolCallId: string) => handlers.get("tool_result")!({ toolName: "bash", toolCallId, content: [{ type: "text", text: "ok" }] }, { cwd: process.cwd() }),
    };
  };
  try {
    const first = load();
    expect(first.call(command.replace("--title", "--body"), "different")).toMatchObject({ block: true });
    expect(first.call(command, "use-one")).toBeUndefined();
    const receipt = observedPullRequestReceipt({ result: first.result("use-one") });
    expect(receipt).toMatch(/^[a-f0-9-]{36}$/);
    expect(pullRequestGrantAvailable(store.file(threadId), grant.id, receipt)).toBe(true);
    expect(pullRequestGrantAvailable(store.file(threadId), grant.id, "bb-event-with-a-different-id")).toBe(false);
    expect(load().call(command, "use-two")).toMatchObject({ block: true });
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
