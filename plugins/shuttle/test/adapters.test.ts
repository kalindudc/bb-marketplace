// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters/adapter";
import { CommandAdapter, MERGE_DEFAULTS } from "../src/adapters/command";
import { runProcess, shellQuote, type RunOptions, type RunResult } from "../src/adapters/exec";
import { GithubAdapter, isPlacementError, listFields, searchQuery, toActivity, toMergeOptions, toSummary } from "../src/adapters/github";
import { DEFAULT_CONFIG, parseConfig, type ServerConfig } from "../src/config";

interface Call {
  bin: string;
  args: string[];
  env: Record<string, string>;
  stdin: string | undefined;
}

/** Records every process the adapter starts and answers each from `respond`. */
function recorder(respond: (call: Call) => Partial<RunResult> | unknown = () => ({})) {
  const calls: Call[] = [];
  const run = async (bin: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
    const call = { bin, args: [...args], env: options.env ?? {}, stdin: options.stdin };
    calls.push(call);
    const answer = respond(call) as Partial<RunResult> & { json?: unknown };
    const stdout = answer.json === undefined ? (answer.stdout ?? "") : JSON.stringify(answer.json);
    return { code: answer.code ?? 0, stdout, stderr: answer.stderr ?? "", timedOut: false };
  };
  return { calls, run };
}

const github = (hostname?: string): ServerConfig => ({ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {}, ...(hostname ? { hostname } : {}) });

type Node = Parameters<typeof toSummary>[0];
const node = (extra: Partial<Node> = {}): Node => ({
  number: 7, title: "T", url: "https://github.com/acme/api/pull/7", isDraft: false, state: "OPEN", reviewDecision: "REVIEW_REQUIRED",
  headRefOid: "h2", headRefName: "sam/x", baseRefName: "main", createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-23T10:00:00Z",
  closedAt: null, mergedAt: null, additions: 1, deletions: 2, changedFiles: 3, author: { login: "sam", __typename: "User" },
  repository: { nameWithOwner: "acme/api" }, autoMergeRequest: null, commits: { nodes: [] }, labels: { nodes: [] },
  latestReviews: { nodes: [] }, reviewRequests: { nodes: [] },
  ...extra,
});
const at = (iso: string) => Date.parse(iso);

describe("GitHub summaries", () => {
  it("counts the head's checks by outcome from the rollup's counts", () => {
    const summary = toSummary(node({
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: {
        totalCount: 12,
        checkRunCountsByState: [
          { state: "SUCCESS", count: 2 }, { state: "NEUTRAL", count: 1 }, { state: "SKIPPED", count: 1 },
          { state: "FAILURE", count: 1 }, { state: "TIMED_OUT", count: 1 }, { state: "STARTUP_FAILURE", count: 1 },
          { state: "IN_PROGRESS", count: 1 }, { state: "QUEUED", count: 1 }, { state: "STALE", count: 0 },
        ],
        statusContextCountsByState: [{ state: "SUCCESS", count: 1 }, { state: "ERROR", count: 1 }, { state: "EXPECTED", count: 1 }, { state: "PENDING", count: 0 }],
      } } } }] },
    }));
    expect(summary.checks).toBe("failed");
    expect(summary.checkCounts).toEqual({ passed: 5, failed: 4, pending: 3, total: 12 });
    expect(toSummary(node()).checkCounts).toEqual({ passed: 0, failed: 0, pending: 0, total: 0 });
  });

  it("reads when it opened and closed, auto-merge and a bot author", () => {
    const merged = toSummary(node({ state: "MERGED", closedAt: "2026-10-23T11:00:00Z", mergedAt: "2026-10-23T10:59:00Z", autoMergeRequest: { enabledAt: "2026-10-23T09:00:00Z" }, author: { login: "renovate[bot]" } }));
    expect(merged).toMatchObject({ state: "merged", createdAt: at("2026-10-20T10:00:00Z"), closedAt: at("2026-10-23T10:59:00Z"), autoMerge: true, authorBot: true });
    expect(toSummary(node({ state: "CLOSED", closedAt: "2026-10-23T11:00:00Z" })).closedAt).toBe(at("2026-10-23T11:00:00Z"));
    expect(toSummary(node({ closedAt: "2026-10-01T00:00:00Z" }))).toMatchObject({ closedAt: null, autoMerge: false, authorBot: false });
    expect(toSummary(node({ author: { login: "dependabot", __typename: "Bot" } })).authorBot).toBe(true);
  });

  it("gives reviewers the time and commit of their latest review, and keeps mine when I am asked again", () => {
    const summary = toSummary(node({
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "me" } }, { requestedReviewer: { __typename: "Team", combinedSlug: "acme/edge" } }] },
      latestReviews: { nodes: [
        { state: "CHANGES_REQUESTED", submittedAt: "2026-10-21T10:00:00Z", viewerDidAuthor: true, commit: { oid: "h1" }, author: { login: "me" } },
        { state: "APPROVED", submittedAt: "2026-10-22T10:00:00Z", viewerDidAuthor: false, commit: { oid: "h2" }, author: { login: "bo" } },
      ] },
    }));
    expect(summary.reviewers).toEqual([
      { login: "me", team: false, state: "requested", at: at("2026-10-21T10:00:00Z"), head: "h1" },
      { login: "acme/edge", team: true, state: "requested", at: null, head: null },
      { login: "bo", team: false, state: "approved", at: at("2026-10-22T10:00:00Z"), head: "h2" },
    ]);
    expect(summary.myReview).toEqual({ verdict: "changes", at: at("2026-10-21T10:00:00Z"), head: "h1" });
    expect(toSummary(node({ latestReviews: { nodes: [{ state: "PENDING", viewerDidAuthor: true, author: { login: "me" } }] } })).myReview).toBeNull();
  });

  it("takes the newest request of me or of a team still asked, and none on my own PR", () => {
    const timeline = { nodes: [
      { createdAt: "2026-10-21T10:00:00Z", requestedReviewer: { __typename: "User", isViewer: true } },
      { createdAt: "2026-10-22T10:00:00Z", requestedReviewer: { __typename: "Team", combinedSlug: "acme/edge" } },
      { createdAt: "2026-10-23T10:00:00Z", requestedReviewer: { __typename: "Team", combinedSlug: "acme/other" } },
      { createdAt: "2026-10-23T11:00:00Z", requestedReviewer: { __typename: "User", isViewer: false } },
      null,
    ] };
    const asks = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", combinedSlug: "acme/edge" } }] } };
    expect(toSummary(node({ ...asks, timelineItems: timeline })).requestedAt).toBe(at("2026-10-22T10:00:00Z"));
    expect(toSummary(node({ timelineItems: timeline })).requestedAt).toBe(at("2026-10-21T10:00:00Z"));
    expect(toSummary(node({ ...asks, timelineItems: timeline, viewerDidAuthor: true })).requestedAt).toBeNull();
    expect(toSummary(node()).requestedAt).toBeNull();
  });

  it("finds the first review by someone other than the author and bots", () => {
    const reviews = { nodes: [
      { state: "COMMENTED", submittedAt: "2026-10-20T11:00:00Z", author: { login: "sam" } },
      { state: "COMMENTED", submittedAt: "2026-10-20T12:00:00Z", author: { login: "copilot", __typename: "Bot" } },
      { state: "PENDING", submittedAt: null, author: { login: "ana" } },
      { state: "APPROVED", submittedAt: "2026-10-21T12:00:00Z", author: { login: "bo" } },
      { state: "COMMENTED", submittedAt: "2026-10-21T09:00:00Z", author: { login: "ana" } },
    ] };
    expect(toSummary(node({ reviews })).firstReviewAt).toBe(at("2026-10-21T09:00:00Z"));
    expect(toSummary(node()).firstReviewAt).toBeNull();
  });

  it("reads requests only on the request lists and the first review only on the author's", () => {
    expect(listFields("authored")).toContain("reviews(first: 20)");
    expect(listFields("authored")).not.toContain("timelineItems");
    for (const op of ["review_requested", "team_requested", "reviewed"] as const) {
      expect(listFields(op)).toContain("timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT]");
      expect(listFields(op)).not.toContain("reviews(first");
    }
    expect(listFields("mentioned")).not.toMatch(/timelineItems|reviews\(first/u);
    expect(searchQuery("reviewed", {})).toBe("is:pr archived:false sort:updated-desc is:open reviewed-by:@me -author:@me");
  });

  it("lists reviewed PRs with the request fields, on the server's host", async () => {
    const { calls, run } = recorder(() => ({ json: { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node({ timelineItems: { nodes: [] } }), {}] } } } }));
    const list = await new GithubAdapter(github("ghe.acme.io"), run).list("reviewed", {});
    expect(list).toMatchObject({ complete: true, rows: [{ number: 7, requestedAt: null }] });
    expect(calls[0]!.args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "ghe.acme.io"]);
    expect(calls[0]!.args.find((a) => a.startsWith("query="))).toContain("timelineItems");
    expect(calls[0]!.args).toContain("q=is:pr archived:false sort:updated-desc is:open reviewed-by:@me -author:@me");
  });

  it("tries a timed-out search page twice more from the same cursor, each time asking for half as many PRs", async () => {
    const first = (call: Call) => call.args.find((a) => a.startsWith("first="));
    const after = (call: Call) => call.args.find((a) => a.startsWith("after=")) ?? null;
    const page = (hasNextPage: boolean) => ({ json: { data: { search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "Y3Vyc29yOjI1" : null }, nodes: [node()] } } } });
    const answers = [page(true), { code: 1, stderr: "gh: HTTP 502" }, { code: 1, stderr: "unexpected end of JSON input" }, page(false)];
    const flaky = recorder(() => answers.shift());
    expect((await new GithubAdapter(github(), flaky.run).list("team_requested", {})).rows).toHaveLength(2);
    expect(flaky.calls.map(first)).toEqual(["first=25", "first=25", "first=12", "first=6"]);
    expect(flaky.calls.map(after)).toEqual([null, "after=Y3Vyc29yOjI1", "after=Y3Vyc29yOjI1", "after=Y3Vyc29yOjI1"]);
    const down = recorder(() => ({ code: 1, stderr: "gh: HTTP 504" }));
    await expect(new GithubAdapter(github(), down.run).list("mentioned", {})).rejects.toThrow(/HTTP 504/u);
    expect(down.calls).toHaveLength(3);
    const denied = recorder(() => ({ code: 1, stderr: "gh: HTTP 401" }));
    await expect(new GithubAdapter(github(), denied.run).list("mentioned", {})).rejects.toThrow(/HTTP 401/u);
    expect(denied.calls).toHaveLength(1);
  });

  it("stops a search at 300 PRs and says the list is incomplete", async () => {
    const pages = recorder((call) => {
      const size = Number(call.args.find((a) => a.startsWith("first="))!.slice("first=".length));
      return { json: { data: { search: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: Array.from({ length: size }, () => node()) } } } };
    });
    const list = await new GithubAdapter(github(), pages.run).list("review_requested", {});
    expect(list).toMatchObject({ complete: false });
    expect(list.rows).toHaveLength(300);
    expect(pages.calls).toHaveLength(12);
  });
});

describe("GitHub activity", () => {
  const who = (login: string) => ({ login, __typename: "User" });
  const activity = toActivity({
    headRefOid: "abc",
    reviews: { nodes: [{ id: "R1", state: "APPROVED", body: "ok", url: null, submittedAt: "2026-10-22T10:00:00Z", author: who("ana") }] },
    reviewThreads: { nodes: [
      { id: "T1", isResolved: false, path: "a.rs", line: 4, comments: { nodes: [{ id: "C1", body: "here", url: null, createdAt: "2026-10-22T11:00:00Z", author: who("tom") }] } },
      { id: "T2", isResolved: true, path: "b.rs", line: 1, comments: { nodes: [{ id: "C2", body: "done", url: null, createdAt: "2026-10-22T12:00:00Z", author: who("tom") }] } },
    ] },
    comments: { nodes: [{ id: "IC1", body: "hi", url: null, createdAt: "2026-10-22T13:00:00Z", author: who("bo") }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", id: "CK1", name: "lint", conclusion: "FAILURE", detailsUrl: "d", completedAt: "2026-10-22T14:00:00Z" },
      { __typename: "StatusContext", id: "SC1", context: "ci", state: "ERROR", targetUrl: "t", createdAt: "2026-10-22T15:00:00Z" },
    ] } } } }] },
  });

  it("keeps every id as before, and adds when, which thread and whether it is resolved", () => {
    expect(activity.items.map((i) => [i.id, i.at, i.thread, i.resolved])).toEqual([
      ["R1:APPROVED", at("2026-10-22T10:00:00Z"), null, null],
      ["T1:C1", at("2026-10-22T11:00:00Z"), "T1", false],
      ["T2:C2", at("2026-10-22T12:00:00Z"), "T2", true],
      ["IC1", at("2026-10-22T13:00:00Z"), null, null],
      ["CK1:abc", at("2026-10-22T14:00:00Z"), null, null],
      ["SC1:abc", at("2026-10-22T15:00:00Z"), null, null],
    ]);
  });
});

describe("GitHub merges", () => {
  const input = { head: "abc123", auto: false, deleteBranch: false };

  it("merges with each method, only at the head it was shown", async () => {
    const { calls, run } = recorder();
    const gh = new GithubAdapter(github(), run);
    for (const method of ["squash", "merge", "rebase"] as const) expect(await gh.merge("acme/api", 7, { ...input, method })).toEqual({ merged: true });
    expect(calls.map((c) => c.args)).toEqual([
      ["pr", "merge", "7", "-R", "acme/api", "--squash", "--match-head-commit", "abc123"],
      ["pr", "merge", "7", "-R", "acme/api", "--merge", "--match-head-commit", "abc123"],
      ["pr", "merge", "7", "-R", "acme/api", "--rebase", "--match-head-commit", "abc123"],
    ]);
  });

  it("turns on auto-merge, deletes the branch, sets the title, and names the host", async () => {
    const { calls, run } = recorder();
    const gh = new GithubAdapter(github("ghe.acme.io"), run);
    expect(await gh.merge("acme/api", 7, { ...input, method: "squash", auto: true, deleteBranch: true, subject: "Ship it (#7)" })).toEqual({ merged: false });
    await gh.cancelAutoMerge("acme/api", 7);
    expect(calls.map((c) => c.args)).toEqual([
      ["pr", "merge", "7", "-R", "ghe.acme.io/acme/api", "--squash", "--match-head-commit", "abc123", "--auto", "--delete-branch", "--subject", "Ship it (#7)"],
      ["pr", "merge", "7", "-R", "ghe.acme.io/acme/api", "--disable-auto"],
    ]);
  });

  it("says what failed", async () => {
    const { run } = recorder(() => ({ code: 1, stderr: "Head branch was modified. Review and try the merge again." }));
    await expect(new GithubAdapter(github(), run).merge("acme/api", 7, { ...input, method: "merge" })).rejects.toThrow(/gh exited 1: Head branch was modified/u);
  });
});

describe("GitHub merge options", () => {
  type Repo = Parameters<typeof toMergeOptions>[0];
  const repo = (pr: Partial<Repo["pullRequest"]> = {}, extra: Partial<Repo> = {}): Repo => ({
    squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: true, viewerDefaultMergeMethod: "MERGE",
    pullRequest: { isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", viewerCanEnableAutoMerge: true, reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...pr },
    ...extra,
  });
  const pending = { commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } };

  it("lists the allowed methods with the default first", () => {
    expect(toMergeOptions(repo())).toEqual({ methods: ["merge", "squash"], default: "merge", deleteBranch: true, canAuto: true, state: "clean", detail: null });
    expect(toMergeOptions(repo({}, { viewerDefaultMergeMethod: "REBASE", rebaseMergeAllowed: false, autoMergeAllowed: false }))).toMatchObject({ methods: ["squash", "merge"], default: "squash", canAuto: false });
    expect(toMergeOptions(repo({ viewerCanEnableAutoMerge: false })).canAuto).toBe(false);
  });

  it("says why it cannot merge", () => {
    const state = (pr: Partial<Repo["pullRequest"]>) => {
      const { state: s, detail } = toMergeOptions(repo(pr));
      return [s, detail];
    };
    expect(state({ mergeStateStatus: "HAS_HOOKS" })).toEqual(["clean", null]);
    expect(state({ isDraft: true, mergeStateStatus: "BLOCKED" })).toEqual(["blocked", "It is a draft."]);
    expect(state({ mergeStateStatus: "DRAFT" })).toEqual(["blocked", "It is a draft."]);
    expect(state({ mergeStateStatus: "DIRTY" })[0]).toBe("conflicts");
    expect(state({ mergeStateStatus: "UNKNOWN", mergeable: "CONFLICTING" })[0]).toBe("conflicts");
    expect(state({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" })).toEqual(["blocked", "It needs an approving review."]);
    expect(state({ mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" })).toEqual(["blocked", "A reviewer requested changes."]);
    expect(state({ mergeStateStatus: "BLOCKED", ...pending })).toEqual(["pending", "Required checks are still running."]);
    expect(state({ mergeStateStatus: "BLOCKED" })).toEqual(["blocked", "A required check or branch rule blocks it."]);
    expect(state({ mergeStateStatus: "BEHIND" })[0]).toBe("behind");
    expect(state({ mergeStateStatus: "UNSTABLE" })).toEqual(["pending", "Some checks have not passed."]);
    expect(state({ mergeStateStatus: "UNKNOWN", ...pending })[0]).toBe("pending");
    expect(state({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })[0]).toBe("unknown");
  });

  it("reads them through GraphQL on the server's host", async () => {
    const { calls, run } = recorder(() => ({ json: { data: { repository: repo() } } }));
    expect((await new GithubAdapter(github("ghe.acme.io"), run).mergeOptions("acme/api", 7)).state).toBe("clean");
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--hostname", "ghe.acme.io", "owner=acme", "name=api", "number=7"]));
    const missing = recorder(() => ({ json: { data: { repository: { ...repo(), pullRequest: null } } } }));
    await expect(new GithubAdapter(github(), missing.run).mergeOptions("acme/api", 7)).rejects.toThrow(/acme\/api#7 was not found/u);
  });
});

describe("GitHub comments and reviews", () => {
  const post = { verdict: "changes" as const, body: "Please fix.", head: "abc123", comments: [{ path: "a.rs", line: 4, body: "Off by one." }, { path: "b.rs", line: null, body: "Split this file.\nIt is long." }] };

  it("comments with the body on stdin", async () => {
    const { calls, run } = recorder();
    await new GithubAdapter(github("ghe.acme.io"), run).comment("acme/api", 7, "-x $(rm -rf /) `id`");
    expect(calls[0]).toMatchObject({ args: ["pr", "comment", "7", "-R", "ghe.acme.io/acme/api", "--body-file", "-"], stdin: "-x $(rm -rf /) `id`" });
  });

  it("posts one review with its line and file comments", async () => {
    const { calls, run } = recorder(() => ({ json: { id: 1 } }));
    expect(await new GithubAdapter(github("ghe.acme.io"), run).review("acme/api", 7, post)).toEqual({ placed: 2, inBody: 0 });
    expect(calls[0]!.args).toEqual(["api", "--hostname", "ghe.acme.io", "-X", "POST", "repos/acme/api/pulls/7/reviews", "--input", "-"]);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      commit_id: "abc123", body: "Please fix.", event: "REQUEST_CHANGES",
      comments: [{ path: "a.rs", line: 4, side: "RIGHT", body: "Off by one." }, { path: "b.rs", body: "Split this file.\nIt is long.", subject_type: "file" }],
    });
  });

  it("maps each verdict and leaves out an unknown head and an empty comment list", async () => {
    const { calls, run } = recorder();
    const gh = new GithubAdapter(github(), run);
    expect(await gh.review("acme/api", 7, { verdict: "approve", body: "", head: null, comments: [] })).toEqual({ placed: 0, inBody: 0 });
    await gh.review("acme/api", 7, { verdict: "comment", body: "Nice", head: null, comments: [] });
    expect(calls.map((c) => JSON.parse(c.stdin!))).toEqual([{ body: "", event: "APPROVE" }, { body: "Nice", event: "COMMENT" }]);
  });

  it("moves every comment into the body when GitHub cannot place a line", async () => {
    const { calls, run } = recorder((call) =>
      JSON.parse(call.stdin!).comments ? { code: 1, stderr: "gh: Unprocessable Entity (HTTP 422)", stdout: '{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}' } : { json: { id: 2 } });
    expect(await new GithubAdapter(github(), run).review("acme/api", 7, post)).toEqual({ placed: 0, inBody: 2 });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.stdin!)).toEqual({
      commit_id: "abc123", event: "REQUEST_CHANGES",
      body: "Please fix.\n\n- `a.rs:4` Off by one.\n- `b.rs` Split this file.\n  It is long.",
    });
  });

  it("does not retry other failures, and refuses an empty comment review", async () => {
    const { calls, run } = recorder(() => ({ code: 1, stderr: "gh: Not Found (HTTP 404)", stdout: '{"message":"Not Found"}' }));
    const gh = new GithubAdapter(github(), run);
    await expect(gh.review("acme/api", 7, post)).rejects.toThrow(/HTTP 404.*Not Found/u);
    expect(calls).toHaveLength(1);
    await expect(gh.review("acme/api", 7, { verdict: "comment", body: "  ", head: null, comments: [] })).rejects.toThrow(/needs a body or at least one comment/u);
    expect(calls).toHaveLength(1);
    const noLines = recorder(() => ({ code: 1, stderr: "gh: Unprocessable Entity (HTTP 422)", stdout: '{"message":"Can not approve your own pull request"}' }));
    await expect(new GithubAdapter(github(), noLines.run).review("acme/api", 7, { verdict: "approve", body: "", head: null, comments: [] })).rejects.toThrow(/approve your own/u);
    expect(noLines.calls).toHaveLength(1);
  });

  it("moves comments into the body only when GitHub refuses where one goes, never for a 422 about the review itself", async () => {
    for (const refusal of [
      '{"message":"Unprocessable Entity","errors":["No commit found for SHA: abc123"]}',
      '{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"invalid","field":"commit_id"}]}',
      '{"message":"Unprocessable Entity","errors":["User can only have one pending review per pull request"]}',
    ]) {
      const { calls, run } = recorder(() => ({ code: 1, stderr: "gh: Unprocessable Entity (HTTP 422)", stdout: refusal }));
      await expect(new GithubAdapter(github(), run).review("acme/api", 7, post)).rejects.toThrow(/HTTP 422/u);
      expect(calls).toHaveLength(1);
    }
    expect(isPlacementError('Validation Failed; {"resource":"PullRequestReviewComment","code":"invalid","field":"line"}')).toBe(true);
    expect(isPlacementError("pull_request_review_thread.line must be part of the diff")).toBe(true);
    expect(isPlacementError("Path could not be resolved")).toBe(true);
    expect(isPlacementError("pull_request_review_thread.start_line must precede the end line")).toBe(true);
    expect(isPlacementError("commit_id is not the head of the pull request")).toBe(false);
    expect(isPlacementError("Can not approve your own pull request")).toBe(false);
  });
});

describe("GitHub replies and resolving", () => {
  const vars = (call: Call) => Object.fromEntries(call.args.filter((a, i) => call.args[i - 1] === "-f").map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));

  it("replies in the thread by its node id", async () => {
    const { calls, run } = recorder(() => ({ json: { data: { addPullRequestReviewThreadReply: { comment: { id: "C9" } } } } }));
    await new GithubAdapter(github("ghe.acme.io"), run).reply("acme/api", 7, "PRRT_1", "Fixed in abc.\n\n```ts\nx = 1\n```");
    expect(calls[0]!.args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "ghe.acme.io"]);
    expect(vars(calls[0]!)).toMatchObject({ thread: "PRRT_1", body: "Fixed in abc.\n\n```ts\nx = 1\n```" });
    expect(vars(calls[0]!).query).toMatch(/^mutation\(\$thread: ID!, \$body: String!\) \{ addPullRequestReviewThreadReply\(input: \{ pullRequestReviewThreadId: \$thread, body: \$body \}\)/u);
  });

  it("resolves and reopens a thread", async () => {
    const { calls, run } = recorder((call) => {
      const field = vars(call).query!.includes("unresolveReviewThread") ? "unresolveReviewThread" : "resolveReviewThread";
      return { json: { data: { [field]: { thread: { isResolved: field === "resolveReviewThread" } } } } };
    });
    const gh = new GithubAdapter(github(), run);
    await gh.resolve("acme/api", 7, "PRRT_1", true);
    await gh.resolve("acme/api", 7, "PRRT_1", false);
    expect(calls.map((c) => vars(c).query!.match(/\{ (\w+)\(input: \{ threadId: \$thread \}\)/u)?.[1])).toEqual(["resolveReviewThread", "unresolveReviewThread"]);
    expect(calls.map((c) => vars(c).thread)).toEqual(["PRRT_1", "PRRT_1"]);
  });

  it("says what GitHub refused", async () => {
    const { run } = recorder(() => ({ json: { data: { resolveReviewThread: null }, errors: [{ message: "Resource not accessible by integration" }] } }));
    await expect(new GithubAdapter(github(), run).resolve("acme/api", 7, "PRRT_1", true)).rejects.toThrow(/GitHub: Resource not accessible/u);
  });

  it("offers every operation", () => {
    expect(new GithubAdapter(github()).operations()).toEqual(expect.arrayContaining(["reviewed", "merge_options", "merge", "comment", "review", "reply", "resolve"]));
  });
});

const forge = (commands: Record<string, string>) =>
  parseConfig({
    ...DEFAULT_CONFIG,
    servers: [{ id: "forge", name: "Forge", kind: "command", pattern: "^https://forge\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://forge.test/{repo}/pull/{number}", commands: { view: "v", ...commands } }],
  }).servers[0]!;
const WRITES = { merge: "m", comment: "c", review: "rv", reply: "rp", resolve: "rs" };
const ref = { SHUTTLE_REPO: "shop/world", SHUTTLE_NUMBER: "7", SHUTTLE_URL: "https://forge.test/shop/world/pull/7" };

describe("command server reads", () => {
  it("passes the new summary and activity fields through", async () => {
    const { run } = recorder((call) => {
      const op = call.env.SHUTTLE_OPERATION;
      if (op === "view") return { json: {
        repo: "shop/world", number: 7, title: "T", state: "merged", created_at: "2026-10-20T10:00:00Z", closed_at: 1792800000000,
        check_counts: { passed: 3, failed: 1, pending: 0, total: 4 }, my_review: { state: "changes", at: "2026-10-21T10:00:00Z", head: "h1" },
        auto_merge: false, author_bot: true, requested_at: "2026-10-20T11:00:00Z", first_review_at: "2026-10-20T12:00:00Z",
        reviewers: [{ login: "ana", state: "approved", at: "2026-10-22T10:00:00Z", head: "h2" }],
      } };
      if (op === "activity") return { json: { head: "h2", items: [{ id: "c1", kind: "thread", at: "2026-10-22T11:00:00Z", thread: "t-1", resolved: true }] } };
      if (op === "reviewed") return { json: [{ repo: "shop/world", number: 8, title: "U", state: "open", created_at: "2026-10-19T10:00:00Z" }] };
      return { code: 1 };
    });
    const adapter = new CommandAdapter(forge({ activity: "a", reviewed: "r" }), run);
    expect(await adapter.view("shop/world", 7)).toMatchObject({
      createdAt: at("2026-10-20T10:00:00Z"), closedAt: 1792800000000, checkCounts: { passed: 3, failed: 1, pending: 0, total: 4 },
      myReview: { verdict: "changes", at: at("2026-10-21T10:00:00Z"), head: "h1" }, autoMerge: false, authorBot: true,
      requestedAt: at("2026-10-20T11:00:00Z"), firstReviewAt: at("2026-10-20T12:00:00Z"),
      reviewers: [{ login: "ana", team: false, state: "approved", at: at("2026-10-22T10:00:00Z"), head: "h2" }],
    });
    expect((await adapter.activity("shop/world", 7)).items[0]).toMatchObject({ at: at("2026-10-22T11:00:00Z"), thread: "t-1", resolved: true });
    expect((await adapter.list("reviewed", {})).rows[0]).toMatchObject({ number: 8, createdAt: at("2026-10-19T10:00:00Z"), myReview: null, url: "https://forge.test/shop/world/pull/8" });
    expect(adapter.operations()).toEqual(["reviewed", "view", "activity"]);
  });
});

describe("command server merge options", () => {
  it("are the defaults without a command", async () => {
    const { calls, run } = recorder();
    expect(await new CommandAdapter(forge({}), run).mergeOptions("shop/world", 7)).toEqual({ methods: ["squash", "merge"], default: "squash", deleteBranch: false, canAuto: false, state: "unknown", detail: null });
    expect(calls).toHaveLength(0);
    expect(MERGE_DEFAULTS.methods).toEqual(["squash", "merge"]);
  });

  it("fill what the command leaves out, and put the default first", async () => {
    const answers: unknown[] = [{}, { methods: ["merge", "squash"], default: "squash", delete_branch: true, can_auto: true, state: "blocked", detail: "Needs a review." }, { methods: ["merge"] }, { methods: ["merge"], default: "squash" }, { state: "nope" }];
    const { calls, run } = recorder(() => ({ json: answers.shift() }));
    const adapter = new CommandAdapter(forge({ merge_options: "mo" }), run);
    expect(await adapter.mergeOptions("shop/world", 7)).toEqual({ methods: ["squash", "merge"], default: "squash", deleteBranch: false, canAuto: false, state: "unknown", detail: null });
    expect(calls[0]!.env).toMatchObject({ SHUTTLE_OPERATION: "merge_options", ...ref });
    expect(await adapter.mergeOptions("shop/world", 7)).toEqual({ methods: ["squash", "merge"], default: "squash", deleteBranch: true, canAuto: true, state: "blocked", detail: "Needs a review." });
    expect(await adapter.mergeOptions("shop/world", 7)).toMatchObject({ methods: ["merge"], default: "merge" });
    await expect(adapter.mergeOptions("shop/world", 7)).rejects.toThrow(/default squash is not one of its methods/u);
    await expect(adapter.mergeOptions("shop/world", 7)).rejects.toThrow(/wrong shape: state/u);
  });
});

describe("command server writes", () => {
  const envOf = (calls: Call[], op: string) => calls.find((c) => c.env.SHUTTLE_OPERATION === op)!.env;

  it("give each command the PR and what to write", async () => {
    const { calls, run } = recorder();
    const adapter = new CommandAdapter(forge(WRITES), run);
    expect(await adapter.merge("shop/world", 7, { method: "squash", head: "abc", auto: false, deleteBranch: true })).toEqual({ merged: true });
    expect(await adapter.merge("shop/world", 7, { method: "merge", head: "abc", auto: true, deleteBranch: false, subject: "Ship it" })).toEqual({ merged: false });
    await adapter.comment("shop/world", 7, "Looks good.");
    await adapter.reply("shop/world", 7, "t-1", "Done.");
    await adapter.resolve("shop/world", 7, "t-1", true);
    await adapter.resolve("shop/world", 7, "t-1", false);
    const merges = calls.filter((c) => c.env.SHUTTLE_OPERATION === "merge").map((c) => c.env);
    expect(merges[0]).toMatchObject({ ...ref, SHUTTLE_METHOD: "squash", SHUTTLE_HEAD: "abc", SHUTTLE_AUTO: "0", SHUTTLE_DELETE_BRANCH: "1", SHUTTLE_SUBJECT: "" });
    expect(merges[1]).toMatchObject({ SHUTTLE_METHOD: "merge", SHUTTLE_AUTO: "1", SHUTTLE_DELETE_BRANCH: "0", SHUTTLE_SUBJECT: "Ship it" });
    expect(envOf(calls, "comment")).toMatchObject({ ...ref, SHUTTLE_BODY: "Looks good." });
    expect(envOf(calls, "reply")).toMatchObject({ ...ref, SHUTTLE_THREAD: "t-1", SHUTTLE_BODY: "Done." });
    expect(calls.filter((c) => c.env.SHUTTLE_OPERATION === "resolve").map((c) => c.env.SHUTTLE_RESOLVED)).toEqual(["1", "0"]);
    expect((adapter as Adapter).cancelAutoMerge).toBeUndefined();
    expect(adapter.operations()).toEqual(["view", "merge", "comment", "review", "reply", "resolve"]);
  });

  it("pass a review's comments as JSON and read how many were placed", async () => {
    const answers = ["", '{"placed": 1, "in_body": 1}', "nope"];
    const { calls, run } = recorder(() => ({ stdout: answers.shift() }));
    const adapter = new CommandAdapter(forge(WRITES), run);
    const post = { verdict: "approve" as const, body: "LGTM", head: null, comments: [{ path: "a.rs", line: 4, body: "nit" }, { path: "b.rs", line: null, body: "file" }] };
    expect(await adapter.review("shop/world", 7, post)).toEqual({ placed: 2, inBody: 0 });
    expect(envOf(calls, "review")).toMatchObject({ ...ref, SHUTTLE_VERDICT: "approve", SHUTTLE_BODY: "LGTM", SHUTTLE_HEAD: "" });
    expect(JSON.parse(envOf(calls, "review").SHUTTLE_COMMENTS!)).toEqual([{ path: "a.rs", line: 4, body: "nit" }, { path: "b.rs", line: null, body: "file" }]);
    expect(await adapter.review("shop/world", 7, { ...post, head: "abc" })).toEqual({ placed: 1, inBody: 1 });
    expect(calls[1]!.env.SHUTTLE_HEAD).toBe("abc");
    await expect(adapter.review("shop/world", 7, post)).rejects.toThrow(/review did not print JSON/u);
  });

  it("fail without their command, and with the command's error", async () => {
    const { run } = recorder(() => ({ code: 3, stderr: "Delta has no auto-merge" }));
    await expect(new CommandAdapter(forge({}), run).comment("shop/world", 7, "x")).rejects.toThrow(/Forge has no comment command/u);
    await expect(new CommandAdapter(forge({}), run).review("shop/world", 7, { verdict: "approve", body: "", head: null, comments: [] })).rejects.toThrow(/has no review command/u);
    await expect(new CommandAdapter(forge(WRITES), run).merge("shop/world", 7, { method: "squash", head: "a", auto: true, deleteBranch: false })).rejects.toThrow(/merge exited 3: Delta has no auto-merge/u);
  });
});

const DELTA = fileURLToPath(new URL("../skills/shuttle/references/delta.sh", import.meta.url));
const hasJq = spawnSync("jq", ["--version"]).status === 0;

interface DtCall {
  args: string[];
  input?: unknown;
}

describe.skipIf(!hasJq)("delta.sh against a fake dt", () => {
  const dir = mkdtempSync(join(tmpdir(), "shuttle-dt-"));
  const log = join(dir, "calls.log");
  // Answers by path in the shapes Delta's REST API gave live; FAKE_DT_REVIEW_ERROR refuses a review that has comments.
  writeFileSync(join(dir, "dt"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : undefined;
fs.appendFileSync(process.env.FAKE_DT_LOG, JSON.stringify(input === undefined ? { args } : { args, input }) + "\\n");
const path = args[0] === "api" ? args[1].replace(/^repos\\/[^/]+\\/[^/]+\\//, "") : "";
const user = (login) => ({ login, type: "User" });
const answers = {
  "pulls/7": { number: 7, head: { sha: "h2" } },
  "pulls/7/reviews?per_page=100&page=1": [{ node_id: "R1", state: "CHANGES_REQUESTED", body: "Fix it", html_url: "r", submitted_at: "2026-10-22T10:00:00Z", user: user("ana") }],
  "pulls/7/comments?per_page=100&page=1": [
    { id: 11, node_id: "C11", thread_id: "t-1", in_reply_to_id: null, resolved: false, path: "a.rs", line: 4, body: "here", html_url: "c", created_at: "2026-10-22T11:00:00Z", user: user("ana") },
    { id: 12, node_id: "C12", thread_id: "t-1", in_reply_to_id: 11, resolved: false, path: "a.rs", line: 4, body: "done", html_url: "c", created_at: "2026-10-22T12:00:00Z", user: user("sam") },
  ],
  "issues/7/comments?per_page=100&page=1": [],
  "pulls/7/merge-readiness": {
    head: "h2", merge_state_status: "blocked", mergeable: true, viewer: { allowed_methods: ["merge"], can_merge: false },
    blockers: [{ code: "stacked" }, { code: "required_check_failing", context: "ci@x.iam:reviews" }, { code: "base_policy_denies", message: "main advances through the merge queue" }],
    status_check_rollup: { contexts: [
      { kind: "check", producer: "ci@x.iam", name: "reviews", status: "completed", conclusion: "failure", details_url: "d1" },
      { kind: "status", producer: "ci@x.iam", name: "Required CI", status: "in_progress", details_url: "d2" },
      { kind: "status", producer: "lint@x.iam", name: "lint", status: "completed", conclusion: "success", details_url: "d3" },
    ] },
  },
};
if (path === "pulls/7/merge-readiness" && process.env.FAKE_DT_NO_GATE) {
  console.error("Error: 503: merge gate unavailable");
  process.exit(1);
}
if (path === "pulls/7/reviews" && input && input.comments && process.env.FAKE_DT_REVIEW_ERROR) {
  console.error(process.env.FAKE_DT_REVIEW_ERROR);
  process.exit(1);
}
if (path in answers) console.log(JSON.stringify(answers[path]));
else if (path === "pulls/7/reviews") console.log("{}");
`);
  chmodSync(join(dir, "dt"), 0o755);
  const command = (extra = "") => `${extra}FAKE_DT_LOG=${shellQuote(log)} PATH=${shellQuote(dir)}:"$PATH" sh ${shellQuote(DELTA)}`;
  const ops = ["activity", "merge_options", "merge", "comment", "review", "reply", "resolve"];
  const delta = (extra = "") => new CommandAdapter(forge(Object.fromEntries(ops.map((op) => [op, command(extra)]))), runProcess);
  /** The calls since the last look. */
  const calls = (): DtCall[] => {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    writeFileSync(log, "");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as DtCall) : [];
  };
  const on = (repo: string) => ["--host", "https://delta.shopify.io", "-R", repo];
  const dt = (...args: string[]) => [...args, ...on("shop/world")];
  const argsOf = (list: DtCall[]) => list.map((c) => c.args);

  it("is valid shell", () => {
    expect(spawnSync("sh", ["-n", DELTA]).status).toBe(0);
  });

  it("works on the PR's own repository, and refuses one that is not owner/name", async () => {
    calls();
    await delta().comment("shop/other", 7, "Hi");
    await delta().resolve("shop/other", 7, "t-1", true);
    await delta().mergeOptions("shop/other", 7);
    expect(argsOf(calls())).toEqual([
      ["pr", "comment", "7", "--body=Hi", ...on("shop/other")],
      ["pr", "resolve", "7", "t-1", ...on("shop/other")],
      ["api", "repos/shop/other/pulls/7/merge-readiness", "-X", "GET", ...on("shop/other")],
    ]);
    for (const repo of ["a/b/c", "../x", "shop/world?x=1", "shop/.."]) await expect(delta().comment(repo, 7, "Hi")).rejects.toThrow(/is not owner\/name/u);
    expect(calls()).toEqual([]);
  });

  it("reads merge options from the merge gate", async () => {
    calls();
    expect(await delta().mergeOptions("shop/world", 7)).toEqual({
      methods: ["merge"], default: "merge", deleteBranch: false, canAuto: false, state: "blocked",
      detail: "It is part of a stack; reviews is failing; main advances through the merge queue.",
    });
    expect(argsOf(calls())).toEqual([dt("api", "repos/shop/world/pulls/7/merge-readiness", "-X", "GET")]);
  });

  it("sends failed checks from the merge gate in activity, named by check and head", async () => {
    const activity = await delta().activity("shop/world", 7);
    expect(activity.head).toBe("h2");
    expect(activity.items.map((i) => [i.id, i.kind, i.thread ?? null, i.resolved ?? null])).toEqual([
      ["R1:CHANGES_REQUESTED", "review", null, null],
      ["C11", "thread", "t-1", false],
      ["C12", "thread", "t-1", false],
      ["check:ci@x.iam:reviews:h2", "check", null, null],
    ]);
    expect(activity.items[3]).toMatchObject({ state: "failed", body: "reviews failed", url: "d1", bot: false });
    const withoutGate = await delta("FAKE_DT_NO_GATE=1 ").activity("shop/world", 7);
    expect(withoutGate.items.map((i) => i.id)).toEqual(["R1:CHANGES_REQUESTED", "C11", "C12"]);
  });

  it("merges with squash or merge at the head, and refuses what Delta cannot do", async () => {
    calls();
    const adapter = delta();
    await adapter.merge("shop/world", 7, { method: "squash", head: "abc", auto: false, deleteBranch: false, subject: "Title" });
    await adapter.merge("shop/world", 7, { method: "merge", head: "abc", auto: false, deleteBranch: false });
    await expect(adapter.merge("shop/world", 7, { method: "squash", head: "abc", auto: true, deleteBranch: false })).rejects.toThrow(/Delta has no auto-merge/u);
    await expect(adapter.merge("shop/world", 7, { method: "rebase", head: "abc", auto: false, deleteBranch: false })).rejects.toThrow(/squash or merge, not rebase/u);
    await expect(adapter.merge("shop/world", 7, { method: "merge", head: "abc", auto: false, deleteBranch: true })).rejects.toThrow(/cannot delete the branch/u);
    expect(argsOf(calls())).toEqual([dt("pr", "merge", "7", "--squash", "--sha", "abc"), dt("pr", "merge", "7", "--sha", "abc")]);
  });

  it("passes bodies as single arguments, never as shell", async () => {
    calls();
    const adapter = delta();
    const body = `-x $(touch ${join(dir, "pwned")}) "q" \`id\``;
    await adapter.comment("shop/world", 7, body);
    await adapter.reply("shop/world", 7, "t-1", "Done.");
    await adapter.resolve("shop/world", 7, "t-1", true);
    await adapter.resolve("shop/world", 7, "t-1", false);
    await expect(adapter.reply("shop/world", 7, "t-9", "x")).rejects.toThrow(/no review comment in thread t-9/u);
    expect(argsOf(calls())).toEqual([
      dt("pr", "comment", "7", `--body=${body}`),
      dt("api", "repos/shop/world/pulls/7/comments?per_page=100&page=1", "-X", "GET"),
      dt("pr", "comment", "7", "--reply-to", "11", "--body=Done."),
      dt("pr", "resolve", "7", "t-1"),
      dt("pr", "unresolve", "7", "t-1"),
      dt("api", "repos/shop/world/pulls/7/comments?per_page=100&page=1", "-X", "GET"),
    ]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  const reviews = dt("api", "repos/shop/world/pulls/7/reviews", "-X", "POST", "--input", "-");
  const post = { verdict: "changes" as const, body: "Fix it", head: "abc", comments: [{ path: "a.rs", line: 4, body: "here\nthere" }, { path: "b.rs", line: null, body: "file" }] };

  it("posts every review through the API on the head it was shown", async () => {
    calls();
    expect(await delta().review("shop/world", 7, { ...post, comments: [] })).toEqual({ placed: 0, inBody: 0 });
    expect(await delta().review("shop/world", 7, { verdict: "approve", body: "", head: "abc", comments: [] })).toEqual({ placed: 0, inBody: 0 });
    expect(await delta().review("shop/world", 7, post)).toEqual({ placed: 2, inBody: 0 });
    expect(await delta().review("shop/world", 7, { ...post, verdict: "comment", head: null, comments: [] })).toEqual({ placed: 0, inBody: 0 });
    expect(calls()).toEqual([
      { args: reviews, input: { event: "REQUEST_CHANGES", body: "Fix it", commit_id: "abc" } },
      { args: reviews, input: { event: "APPROVE", commit_id: "abc" } },
      { args: reviews, input: { event: "REQUEST_CHANGES", body: "Fix it", commit_id: "abc", comments: [{ path: "a.rs", line: 4, side: "RIGHT", body: "here\nthere" }, { path: "b.rs", body: "file", subject_type: "file" }] } },
      { args: reviews, input: { event: "COMMENT", body: "Fix it" } },
    ]);
    await expect(delta().review("shop/world", 7, { verdict: "comment", body: "", head: "abc", comments: [] })).rejects.toThrow(/needs a body or at least one comment/u);
    expect(calls()).toEqual([]);
  });

  it("moves the comments into the body, on the same head, only when Delta cannot place a line", async () => {
    calls();
    const placement = "FAKE_DT_REVIEW_ERROR='Error: 422: pull_request_review_thread.line must be part of the diff' ";
    expect(await delta(placement).review("shop/world", 7, post)).toEqual({ placed: 0, inBody: 2 });
    const [first, second] = calls();
    expect(first!.input).toMatchObject({ commit_id: "abc", comments: expect.any(Array) });
    expect(second).toEqual({ args: reviews, input: { event: "REQUEST_CHANGES", commit_id: "abc", body: "Fix it\n\n- `a.rs:4` here\n  there\n- `b.rs` file" } });
    for (const refusal of ["Error: 422: commit_id abc is not the head of the pull request", "Error: 422: you have a pending review", "Error: 500: line lookup failed"]) {
      await expect(delta(`FAKE_DT_REVIEW_ERROR=${shellQuote(refusal)} `).review("shop/world", 7, post)).rejects.toThrow(refusal);
      expect(calls()).toHaveLength(1);
    }
  });
});

describe("GitHub reviewers who are bots", () => {
  it("marks reviewers GitHub reports as a Bot, so Insights keeps them apart from people", () => {
    const summary = toSummary(node({
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Bot", login: "ci-reviewer" } }] },
      latestReviews: { nodes: [
        { state: "COMMENTED", submittedAt: "2026-10-22T10:00:00Z", commit: { oid: "abc" }, author: { login: "binks-code-reviewer", __typename: "Bot" } },
        { state: "APPROVED", submittedAt: "2026-10-22T11:00:00Z", commit: { oid: "abc" }, author: { login: "pascal", __typename: "User" } },
      ] },
    }));
    expect(summary.reviewers?.map((r) => [r.login, r.bot === true])).toEqual([["ci-reviewer", true], ["binks-code-reviewer", true], ["pascal", false]]);
  });
});

describe.skipIf(!hasJq)("delta.sh reviewers", () => {
  it("marks requested and reviewing accounts Delta types as Bot", () => {
    const script = readFileSync(DELTA, "utf8");
    const program = /^REVIEWERS='([\s\S]*?)'$/mu.exec(script)![1]!;
    const input = [
      { user: { login: "me" }, requested_reviewers: [{ login: "ci-reviewer", type: "Bot" }, { login: "sam", type: "User" }], requested_teams: [] },
      [
        { state: "COMMENTED", user: { login: "scanner", type: "Bot" }, submitted_at: "2026-10-22T10:00:00Z", commit_id: "abc" },
        { state: "APPROVED", user: { login: "ana", type: "User" }, submitted_at: "2026-10-22T11:00:00Z", commit_id: "abc" },
      ],
    ];
    const out = spawnSync("jq", ["-c", program], { input: JSON.stringify(input), encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    const reviewers = JSON.parse(out.stdout) as Array<{ login: string; bot: boolean }>;
    expect(reviewers.map((r) => [r.login, r.bot])).toEqual([["ci-reviewer", true], ["sam", false], ["ana", false], ["scanner", true]]);
  });
});
