// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, waypointEntry } from "./support";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import type { PullRequest } from "../../src/shared/pull-request";
import * as patch from "../../src/server/pr-rebase";
import * as worktree from "../../src/server/member-worktree";

const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };

async function fixture() {
  const f = setup({ projects: { get: async () => ({ sources: [], gitRemoteUrl: "https://github.com/example/repo.git" }) } });
  const q = await seedQuest(f.k, "lead", "Check the change", "Check");
  f.k.resetRoutes("lead");
  const owner = { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Build",
    brief: { outcome: "Build", doneWhen: "Checks pass", outOfScope: "Release", mode: "make-it-work" as const, context: [], questions: [], timeboxMinutes: null } };
  const smith = f.k.bind("maker", "smith", "juno", "project", owner);
  const warden = f.k.bind("warden", "warden", "vex", "project", owner);
  f.k.store.put("members", warden.threadId, { ...warden, checkerMakerThreadId: smith.threadId, checkerWaypointId: "w1" });
  const pr = f.k.store.recordPullRequest({ keeperThreadId: "lead", boardQuestId: q.id, projectId: "project", owner: "maker", url: "https://github.com/example/repo/pull/1", forge: "gh", state: "draft", head: "private-branch", base: "main", memberHead: a, pushedHead: null, verifiedCommit: null }, f.k.now());
  let live = { state: "draft" as PullRequest["state"], headCommit: a };
  const forge = f.runtime.placements().forge;
  const inspect = vi.spyOn(forge, "inspect").mockImplementation(async () => live);
  const close = vi.spyOn(forge, "close").mockImplementation(async () => (live = { ...live, state: "closed" }));
  const review = vi.fn(async (_pr: PullRequest, action: "ready" | "draft", _reviewers: string[]) => (live = { ...live, state: action }));
  Object.assign(forge, { setReviewState: review });
  registerTools(f.bb, f.runtime); registerRpc(f.bb, f.runtime);
  const change = (input: object, caller = "lead") => f.harness.behavior.invokeAgentTool("tavern_pull_request", input, { threadId: caller });
  const current = () => f.k.store.get("pullRequests", pr.id)!;
  const remote = (headCommit: string) => { live = { ...live, headCommit }; };
  const verify = (commit: string, actor = "warden") => {
    const entry = waypointEntry("maker", q.id);
    f.port.linkedEntries = () => [{ ...entry, status: "verified", review: { actor: { kind: "agent", threadId: actor }, at: f.k.now(), evidence: [{ kind: "note", ref: commit, detail: "Verified head", exitCode: null }], reason: null, previousNote: null, memberEvidenceAt: null } }];
  };
  return { ...f, q, pr, change, current, verify, review, remote, close, inspect };
}

it("allows only the Keeper to make the exact verified draft ready, and Undo returns it to draft", async () => {
  const f = await fixture();
  const input = { action: "ready", pullRequestId: f.pr.id, reviewers: ["reviewer-one"], reason: "Review the checked change" };
  await expect(f.change(input, "maker")).rejects.toThrow(/keeper/i);
  await expect(f.change(input)).rejects.toThrow(/Warden.*exact head/i);
  f.verify(a, "maker");
  await expect(f.change(input)).rejects.toThrow(/Warden.*exact head/i);
  expect(f.review).not.toHaveBeenCalled();
  f.verify(a);
  await f.change(input);
  expect(f.current()).toMatchObject({ state: "ready", verifiedCommit: a, verdict: { commit: a, wardenThreadId: "warden", entryId: "a1" } });
  expect(f.review).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.pr.id }), "ready", ["reviewer-one"]);
  const decision = f.k.store.all("decisions").find(row => row.pullRequestReady === f.pr.id)!;
  expect(decision.reversible).toBe(true);
  await f.harness.invokeRpc("undoDecision", { decisionId: decision.id }, client);
  expect(f.review).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.pr.id }), "draft", []);
  expect(f.current().state).toBe("draft");
  expect(f.k.store.get("decisions", decision.id)?.undone).toBe(true);
});

it("keeps Undo when readiness succeeds but requesting reviewers fails", async () => {
  const f = await fixture();
  f.verify(a);
  f.review.mockImplementationOnce(async (_pr, _action, reviewers) => {
    if (reviewers.length) throw new Error("Reviewer unavailable");
    return { state: "ready", headCommit: a };
  }).mockRejectedValueOnce(new Error("Reviewer unavailable"));
  await expect(f.change({ action: "ready", pullRequestId: f.pr.id, reviewers: ["reviewer-one"], reason: "Send for review" })).rejects.toThrow(/Reviewer unavailable/);
  const decisionId = f.current().readyDecisionId;
  expect(f.current().state).toBe("ready");
  expect(f.k.store.all("decisions")).toContainEqual(expect.objectContaining({ id: decisionId, pullRequestReady: f.pr.id, reversible: true }));
});

it("clears verification on a changed head and preserves it only when the existing clean-rebase proof succeeds", async () => {
  const f = await fixture();
  f.verify(a);
  vi.spyOn(worktree, "memberWorktree").mockResolvedValue({ environmentId: "work", hostId: "host", root: "/fixture/work" });
  const proof = vi.spyOn(patch, "homePullRequestRebaseMatches").mockImplementation(async (_maker, _home, old, head) => old === a && head === b);
  const read = () => f.harness.invokeRpc("boardQuest", { id: f.q.id, refreshPullRequests: true }, client);
  await read();
  expect(f.current().verifiedCommit).toBe(a);
  f.remote(b); await read();
  expect(proof).not.toHaveBeenCalled();
  expect(f.current()).toMatchObject({ pushedHead: b, verifiedCommit: null });
  await f.change({ action: "ready", pullRequestId: f.pr.id, reason: "Review the clean rebase" });
  expect(proof).toHaveBeenCalledWith("/fixture/work", expect.objectContaining({ base: "main" }), a, b);
  expect(f.current()).toMatchObject({ pushedHead: b, verifiedCommit: b, verdict: { commit: a } });
  f.remote(c); await read();
  expect(proof).toHaveBeenCalledTimes(1);
  expect(f.current()).toMatchObject({ pushedHead: c, verifiedCommit: null });
  await expect(f.change({ action: "ready", pullRequestId: f.pr.id, reason: "Review" })).rejects.toThrow(/Warden.*exact head/i);
});

it("binds a Keeper comment to its recorded pull request and never posts to another owner", async () => {
  const f = await fixture();
  const post = vi.spyOn(f.runtime.placements().forge, "comment").mockResolvedValue({ state: "draft", headCommit: a });
  const input = { action: "comment", pullRequestId: f.pr.id, body: "Thanks for checking" };
  await expect(f.change(input, "maker")).rejects.toThrow(/keeper/i);
  await f.change(input);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: f.pr.id }), "Thanks for checking");
  expect(f.k.store.latestQuestEvent(f.q.id, "pull-request.changed")?.data).toMatchObject({ action: "comment", receipt: expect.any(String) });
  f.k.store.changePullRequest({ ...f.current(), owner: "user" }, f.k.now());
  await expect(f.change(input)).rejects.toThrow(/quest-owned/i);
  expect(post).toHaveBeenCalledTimes(1);
});

it("explains why a forge without a head cannot be marked ready here", async () => {
  const f = await fixture();
  f.inspect.mockResolvedValue({ state: "draft" });
  await expect(f.change({ action: "ready", pullRequestId: f.pr.id, reason: "Send for review" })).rejects.toThrow(/cannot confirm the pull request head/);
});

it("records the Keeper's close outside conclude but refuses a pull request taken by the user", async () => {
  const f = await fixture();
  const input = { action: "close", pullRequestId: f.pr.id, reason: "Superseded" };
  f.k.store.changePullRequest({ ...f.current(), owner: "user" }, f.k.now());
  await expect(f.change(input)).rejects.toThrow(/quest-owned/i);
  expect(f.close).not.toHaveBeenCalled();
  f.k.store.changePullRequest({ ...f.current(), owner: "maker" }, f.k.now());
  await f.change(input);
  expect(f.current().state).toBe("closed");
  expect(f.k.store.latestQuestEvent(f.q.id, "pull-request.changed")).toMatchObject({ actor: { kind: "agent", threadId: "lead" }, data: { action: "close", reason: "Superseded", receipt: expect.any(String) } });
});

it("only refreshes on explicit quest reads and dedupes concurrent ones", async () => {
  const f = await fixture();
  const read = (refreshPullRequests?: boolean) => f.harness.invokeRpc("boardQuest", { id: f.q.id, refreshPullRequests }, client);
  await read();
  expect(f.inspect).not.toHaveBeenCalled();
  await Promise.all([read(true), read(true), read()]);
  expect(f.inspect).toHaveBeenCalledTimes(1);
});

it.each(["setting", "delegation", "default", "unsure"] as const)("uses the sends-as-you decision lane for %s", async lane => {
  const f = await fixture();
  f.runtime.enableScopes({ installGuard: false, dataDir: process.env.TAVERN_TEST_FIXTURES });
  const grant = vi.spyOn(f.runtime.scopes!, "refreshPullRequestPolicy").mockReturnValue(true);
  if (lane === "setting") {
    const settings = f.k.settings.bind(f.k);
    vi.spyOn(f.k, "settings").mockImplementation(id => { const current = settings(id); return { ...current, keepers: { ...current.keepers, alwaysAsk: current.keepers.alwaysAsk.filter(k => k !== "sends-as-you") } }; });
  }
  if (lane === "delegation" || lane === "unsure") await f.harness.invokeRpc("delegateQuest", { boardQuestId: f.q.id, kind: "sends-as-you", via: "page" }, client);
  const url = "https://github.com/example/other/pull/2";
  const command = `gh pr comment ${url} --body hi`;
  await f.change({ action: "draft", boardQuestId: f.q.id, operation: "comment", url, body: "hi", command, ...(lane === "unsure" ? { unsure: true } : {}) });
  const ask = f.k.store.query("asks", "boardQuestId", f.q.id).find(a => a.kind === "sends-as-you")!;
  if (lane === "default" || lane === "unsure") {
    expect(ask).toMatchObject({ state: "open", lane: "user" });
    expect(ask.options.some(o => o.id === "delegate")).toBe(true);
    expect(f.k.store.all("decisions").filter(d => d.askId === ask.id)).toEqual([]);
  } else {
    expect(ask.answer?.by).toBe("keeper");
    expect(f.k.store.all("decisions")).toContainEqual(expect.objectContaining({ askId: ask.id, reversible: true, pullRequestGrant: expect.objectContaining({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
    expect(grant).toHaveBeenCalledWith("lead");
  }
});

it.each(["comment", "review", "approve"] as const)("drafts an external PR %s in the user's sends-as-you lane", async operation => {
  const f = await fixture();
  const url = "https://github.com/example/other/pull/2";
  await f.change({ action: "draft", operation, url, body: "Please reconsider the second step." });
  const ask = f.k.store.openAsks("lead").find(a => a.kind === "sends-as-you")!;
  expect(ask).toMatchObject({ lane: "user", effect: { type: "pull-request-draft", operation }, draft: { to: url, body: "Please reconsider the second step." }, proceedAt: null });
  expect(ask.options.map(o => o.id)).toEqual(["approve", "deny"]);
  await f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "approve", note: null, via: "page" }, client);
  expect(f.review).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
});
