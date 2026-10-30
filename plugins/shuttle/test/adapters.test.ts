// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterError, type Adapter } from "../src/adapters/adapter";
import { CommandAdapter, MERGE_DEFAULTS } from "../src/adapters/command";
import { runProcess, shellQuote, type RunOptions, type RunResult } from "../src/adapters/exec";
import { checkRunOf, GithubAdapter, isPlacementError, listFields, searchQuery, timelineOf, toActivity, toMergeOptions, toSummary } from "../src/adapters/github";
import { hunkLines } from "../src/model";
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
    const gaveUp = await new GithubAdapter(github(), down.run).list("mentioned", {}).catch((error: unknown) => error);
    expect(gaveUp).toBeInstanceOf(AdapterError);
    // A sync does not try again on top of these tries.
    expect((gaveUp as AdapterError).detail).toEqual({ command: "gh api graphql", exit: 1, output: "gh: HTTP 504", retried: true });
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
    expect(activity.details).toBeNull();
  });

  it("asks for the PR view's details only with detail, so watching stays light", async () => {
    const empty = { headRefOid: "abc", reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] }, commits: { nodes: [] } };
    const { calls, run } = recorder(() => ({ json: { data: { repository: { pullRequest: empty } } } }));
    const gh = new GithubAdapter(github(), run);
    await gh.activity("acme/api", 7);
    await gh.activity("acme/api", 7, undefined, { detail: true });
    const query = (index: number) => calls[index]!.args.find((arg) => arg.startsWith("query="))!;
    for (const field of ["files(first: 100)", "commitList: commits(last: 100)", "timelineItems(", "mergeStateStatus", "diffHunk", "isRequired"]) {
      expect(query(0)).not.toContain(field);
      expect(query(1)).toContain(field);
    }
  });

  it("reads every check, the commits, the files, the timeline, the merge state and each thread's hunk with detail", () => {
    const detailed = toActivity({
      headRefOid: "abc",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [{
        id: "T1", isResolved: false, path: "a.rs", line: 2, first: { nodes: [{ diffHunk: "@@ -1,2 +1,3 @@\n fn a() {\n+  b();\n }" }] },
        comments: { nodes: [
          { id: "C1", body: "here", url: null, createdAt: "2026-10-22T11:00:00Z", author: who("tom"), pullRequestReview: { id: "PRR1" } },
          { id: "C2", body: "and", url: null, createdAt: "2026-10-22T11:05:00Z", author: who("ana"), pullRequestReview: { id: "PRR2" } },
        ] },
      }] },
      comments: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 130, nodes: [
        { __typename: "CheckRun", id: "CK1", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "d", startedAt: "2026-10-22T13:58:00Z", completedAt: "2026-10-22T14:00:00Z", isRequired: true, checkSuite: { workflowRun: { workflow: { name: "CI" } }, app: { name: "GitHub Actions" } } },
        { __typename: "CheckRun", id: "CK2", name: "e2e", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, startedAt: "2026-10-22T13:59:00Z", completedAt: null, isRequired: false, checkSuite: { workflowRun: null, app: { name: "Buildkite" } } },
        { __typename: "StatusContext", id: "SC1", context: "deploy", state: "SUCCESS", targetUrl: "t", createdAt: "2026-10-22T15:00:00Z", description: "Preview is up", isRequired: false },
      ] } } } }] },
      isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED",
      commitList: { totalCount: 140, nodes: [{ commit: { oid: "abc1234def", messageHeadline: "Fix it", committedDate: "2026-10-22T12:00:00Z", author: { name: "Tom", user: { login: "tom" } } } }] },
      files: { totalCount: 2400, nodes: [{ path: "a.rs", additions: 3, deletions: 1, changeType: "MODIFIED" }, { path: "b.rs", additions: 0, deletions: 9, changeType: "DELETED" }] },
      timelineItems: { nodes: [{ __typename: "ReviewRequestedEvent", createdAt: "2026-10-22T09:00:00Z", actor: { login: "sam" }, requestedReviewer: { __typename: "Team", combinedSlug: "acme/web" } }] },
    });
    const [first, second] = detailed.items;
    expect(first).toMatchObject({ id: "T1:C1", hunk: "@@ -1,2 +1,3 @@\n fn a() {\n+  b();\n }", review: "PRR1" });
    expect(second).toMatchObject({ id: "T1:C2", review: "PRR2" });
    expect(second).not.toHaveProperty("hunk");
    expect(detailed.items.find((i) => i.kind === "check")!.id).toBe("CK1:abc");
    expect(detailed.details).toEqual({
      checks: { total: 130, items: [
        { name: "lint", group: "CI", state: "failed", detail: "timed out", required: true, url: "d", startedAt: at("2026-10-22T13:58:00Z"), completedAt: at("2026-10-22T14:00:00Z"), itemId: "CK1:abc" },
        { name: "e2e", group: "Buildkite", state: "running", detail: "in progress", required: false, url: null, startedAt: at("2026-10-22T13:59:00Z"), completedAt: null, itemId: null },
        { name: "deploy", group: null, state: "passed", detail: "Preview is up", required: false, url: "t", startedAt: at("2026-10-22T15:00:00Z"), completedAt: null, itemId: null },
      ] },
      commits: { total: 140, items: [{ sha: "abc1234def", message: "Fix it", author: "tom", at: at("2026-10-22T12:00:00Z") }] },
      files: { total: 2400, items: [{ path: "a.rs", additions: 3, deletions: 1, change: "modified" }, { path: "b.rs", additions: 0, deletions: 9, change: "removed" }] },
      timeline: [{ kind: "review_requested", at: at("2026-10-22T09:00:00Z"), actor: "sam", subject: "@acme/web", detail: null }],
      merge: { state: "blocked", detail: "A reviewer requested changes." },
    });
  });

  it("names how each check ended in the server's words", () => {
    const run = (status: string, conclusion: string | null) => checkRunOf({ __typename: "CheckRun", id: "X", name: "n", status, conclusion }, "h");
    expect(["SUCCESS", "NEUTRAL", "SKIPPED", "STALE", "FAILURE", "CANCELLED", "ACTION_REQUIRED"].map((c) => [run("COMPLETED", c).state, run("COMPLETED", c).detail])).toEqual([
      ["passed", null], ["passed", "neutral"], ["skipped", null], ["skipped", "stale"], ["failed", null], ["failed", "cancelled"], ["failed", "action required"],
    ]);
    expect([run("QUEUED", null).state, run("QUEUED", null).detail]).toEqual(["running", "queued"]);
    const status = (state: string) => checkRunOf({ __typename: "StatusContext", id: "S", context: "ci", state }, "h").state;
    expect(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].map(status)).toEqual(["passed", "failed", "failed", "running", "running"]);
  });

  it("keeps a merge's close out of the timeline, but not a close of its own", () => {
    const event = (__typename: string, createdAt: string, extra = {}) => ({ __typename, createdAt, actor: { login: "sam" }, ...extra });
    expect(timelineOf([
      event("ClosedEvent", "2026-10-20T10:00:00Z"),
      event("ReopenedEvent", "2026-10-21T10:00:00Z"),
      event("LabeledEvent", "2026-10-21T11:00:00Z", { label: { name: "ship" } }),
      event("HeadRefForcePushedEvent", "2026-10-21T12:00:00Z", { beforeCommit: { abbreviatedOid: "aaa1111" }, afterCommit: { abbreviatedOid: "bbb2222" } }),
      event("MergedEvent", "2026-10-22T10:00:00Z", { commit: { abbreviatedOid: "ccc3333" }, mergeRefName: "main" }),
      event("ClosedEvent", "2026-10-22T10:00:01Z"),
      null,
    ]).map((e) => [e.kind, e.subject, e.detail])).toEqual([
      ["closed", null, null], ["reopened", null, null], ["labeled", "ship", null], ["force_pushed", "bbb2222", "aaa1111"], ["merged", "ccc3333", "main"],
    ]);
  });
});

describe("GitHub reads for link cards", () => {
  it("reads a commit with its checks and its PRs", async () => {
    const { calls, run } = recorder(() => ({ json: { data: { repository: { object: {
      __typename: "Commit", oid: "1a2b3c4d5e", messageHeadline: "Fix the retry", committedDate: "2026-10-22T10:00:00Z", additions: 4, deletions: 1,
      author: { name: "Ana", user: { login: "ana" } }, statusCheckRollup: { state: "FAILURE" }, associatedPullRequests: { nodes: [{ number: 12 }] },
    } } } } }));
    expect(await new GithubAdapter(github(), run).commit("acme/api", "1a2b3c4")).toEqual({
      sha: "1a2b3c4d5e", message: "Fix the retry", author: "ana", at: at("2026-10-22T10:00:00Z"), additions: 4, deletions: 1, checks: "failed", prs: [12],
    });
    expect(calls[0]!.args).toContain("sha=1a2b3c4");
  });

  it("reads a check run by id, and a workflow run when the link names only the run", async () => {
    const { calls, run } = recorder((call) => (call.args.some((arg) => arg.includes("check-runs"))
      ? { json: { name: "lint", status: "completed", conclusion: "timed_out", html_url: "https://github.com/acme/api/runs/5", started_at: "2026-10-22T10:00:00Z", completed_at: "2026-10-22T10:02:00Z", head_sha: "h1", app: { name: "GitHub Actions" }, pull_requests: [{ number: 12 }] } }
      : { json: { name: "CI", display_title: "Fix the retry", status: "in_progress", conclusion: null, html_url: "https://github.com/acme/api/actions/runs/8", event: "pull_request", run_started_at: "2026-10-22T10:00:00Z", updated_at: "2026-10-22T10:01:00Z", head_sha: "h1", pull_requests: [] } }));
    const gh = new GithubAdapter(github(), run);
    expect(await gh.checkRun("acme/api", { checkRun: 5, run: 8 })).toMatchObject({
      run: { name: "lint", group: "GitHub Actions", state: "failed", detail: "timed out", url: "https://github.com/acme/api/runs/5", startedAt: at("2026-10-22T10:00:00Z"), completedAt: at("2026-10-22T10:02:00Z") },
      head: "h1", prs: [12],
    });
    expect(await gh.checkRun("acme/api", { checkRun: null, run: 8 })).toMatchObject({ run: { name: "CI · Fix the retry", group: "CI · on pull request", state: "running", completedAt: null }, prs: [] });
    expect(calls.map((call) => call.args.at(-1))).toEqual(["repos/acme/api/check-runs/5", "repos/acme/api/actions/runs/8"]);
  });
});

describe("diff hunks", () => {
  it("keeps the last lines, numbered as in the new file, and skips the no-newline note", () => {
    expect(hunkLines("@@ -10,4 +20,5 @@ fn main\n ctx\n-old\n+new\n+more\n\\ No newline at end of file\n tail", 3)).toEqual([
      { kind: "add", text: "new", line: 21 },
      { kind: "add", text: "more", line: 22 },
      { kind: "context", text: "tail", line: 23 },
    ]);
    expect(hunkLines("@@ -1 +1 @@\n-gone")).toEqual([{ kind: "del", text: "gone", line: null }]);
    expect(hunkLines("no header")).toBeNull();
    expect(hunkLines(null)).toBeNull();
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
    expect((await adapter.activity("shop/world", 7)).details).toBeNull();
    expect((await adapter.list("reviewed", {})).rows[0]).toMatchObject({ number: 8, createdAt: at("2026-10-19T10:00:00Z"), myReview: null, url: "https://forge.test/shop/world/pull/8" });
    expect(adapter.operations()).toEqual(["reviewed", "view", "activity"]);
  });
});

describe("command server PR details", () => {
  it("asks with SHUTTLE_DETAIL and reads every part it prints", async () => {
    const { calls, run } = recorder(() => ({ json: {
      head: "h2",
      items: [{ id: "c1", kind: "thread", hunk: "@@ -1 +1,2 @@\n a\n+b", review: 12 }],
      checks: [{ name: "ci", state: "failed", started_at: "2026-10-22T10:00:00Z", item: "check:ci:h2" }],
      commits: { total: 300, items: [{ sha: "abc", message: "Fix", at: "2026-10-22T09:00:00Z" }] },
      files: { total: 1500, items: [{ path: "a.rs", additions: 1, deletions: 0 }] },
      timeline: [{ kind: "labeled", at: "2026-10-22T08:00:00Z", actor: "sam", subject: "ship" }, { kind: "closed", at: null }],
      merge: { state: "conflicts", detail: "It has conflicts." },
    } }));
    const adapter = new CommandAdapter(forge({ activity: "a" }), run);
    const activity = await adapter.activity("shop/world", 7, undefined, { detail: true });
    expect(calls[0]!.env).toMatchObject({ SHUTTLE_OPERATION: "activity", SHUTTLE_DETAIL: "1" });
    expect(activity.items[0]).toMatchObject({ hunk: "@@ -1 +1,2 @@\n a\n+b", review: "12" });
    expect(activity.details).toEqual({
      checks: { total: 1, items: [{ name: "ci", group: null, state: "failed", detail: null, required: null, url: null, startedAt: at("2026-10-22T10:00:00Z"), completedAt: null, itemId: "check:ci:h2" }] },
      commits: { total: 300, items: [{ sha: "abc", message: "Fix", author: null, at: at("2026-10-22T09:00:00Z") }] },
      files: { total: 1500, items: [{ path: "a.rs", additions: 1, deletions: 0, change: "modified" }] },
      timeline: [{ kind: "labeled", at: at("2026-10-22T08:00:00Z"), actor: "sam", subject: "ship", detail: null }],
      merge: { state: "conflicts", detail: "It has conflicts." },
    });
    await adapter.activity("shop/world", 7);
    expect(calls[1]!.env).not.toHaveProperty("SHUTTLE_DETAIL");
  });

  it("gives every command the folder of the adapter scripts that ship with this copy", async () => {
    const { calls, run } = recorder(() => ({ json: { items: [] } }));
    await new CommandAdapter(forge({ activity: "a" }), run).activity("shop/world", 7);
    const dir = calls[0]!.env.SHUTTLE_SCRIPTS!;
    expect(dir).toBe(fileURLToPath(new URL("../skills/shuttle/references", import.meta.url)));
    expect(spawnSync("/bin/sh", ["-c", 'test -d "$SHUTTLE_SCRIPTS"'], { env: { ...process.env, SHUTTLE_SCRIPTS: dir } }).status).toBe(0);
  });

  it("takes a hunk of any length, and cuts long lists to what the view keeps instead of failing the read", async () => {
    const hunk = `@@ -1,3 +1,4000 @@\n${Array.from({ length: 4000 }, (_, i) => `+line ${i}`).join("\n")}`;
    const commits = Array.from({ length: 150 }, (_, i) => ({ sha: `c${i}`, message: `m${i}` }));
    const files = Array.from({ length: 150 }, (_, i) => ({ path: `f${i}.rs` }));
    const checks = Array.from({ length: 150 }, (_, i) => ({ name: `ci ${i}`, state: i === 149 ? "failed" : "passed" }));
    const { run } = recorder(() => ({ json: { items: [{ id: "t1", kind: "thread", hunk }], commits, files: { total: 900, items: files }, checks } }));
    const activity = await new CommandAdapter(forge({ activity: "a" }), run).activity("shop/world", 7, undefined, { detail: true });
    expect(hunk.length).toBeGreaterThan(20_000);
    expect(activity.items[0]!.hunk).toBe(hunk);
    expect(activity.details?.commits).toMatchObject({ total: 150 });
    expect(activity.details?.commits?.items.map((c) => c.sha)).toEqual(commits.slice(-100).map((c) => c.sha));
    expect(activity.details?.files?.total).toBe(900);
    expect(activity.details?.files?.items.map((f) => f.path)).toEqual(files.slice(0, 100).map((f) => f.path));
    // Every check is kept, so the failing one at the end still shows.
    expect(activity.details?.checks?.items).toHaveLength(150);
    expect(activity.details?.checks?.items.at(-1)).toMatchObject({ name: "ci 149", state: "failed" });
  });

  it("refuses a details part in the wrong shape, like any other field", async () => {
    const { run } = recorder(() => ({ json: { items: [], checks: [{ name: "ci", state: "exploded" }] } }));
    await expect(new CommandAdapter(forge({ activity: "a" }), run).activity("shop/world", 7, undefined, { detail: true })).rejects.toThrow(/activity printed JSON in the wrong shape: checks/u);
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
if (process.env.FAKE_DT_DOWN) {
  console.error(process.env.FAKE_DT_DOWN);
  process.exit(1);
}
if (process.env.FAKE_DT_QUIET) {
  console.error(process.env.FAKE_DT_QUIET);
  process.exit(0);
}
const path = args[0] === "api" ? args[1].replace(/^repos\\/[^/]+\\/[^/]+\\//, "") : "";
if (process.env.FAKE_DT_PULL_DOWN && path === "pulls/7") {
  console.error(process.env.FAKE_DT_PULL_DOWN);
  process.exit(1);
}
const user = (login) => ({ login, type: "User" });
const answers = {
  "pulls/7": { number: 7, head: { sha: "h2" }, base: { sha: "b1" }, commits: 2, changed_files: 1800 },
  "pulls/8": { number: 8, head: { sha: "h8" }, base: { sha: "b8" }, commits: 1, changed_files: 2 },
  "pulls/8/reviews?per_page=100&page=1": [],
  "pulls/8/comments?per_page=100&page=1": [],
  "issues/8/comments?per_page=100&page=1": [],
  "compare/b8...h8?per_page=100": {
    total_commits: 1,
    commits: [{ sha: "c8", commit: { message: "Small\\n\\nBody", author: { name: "Ana" }, committer: { date: "2026-10-21T10:00:00+00:00" } }, author: { login: "ana" } }],
    files: [{ filename: "a.rs", status: "added", additions: 5, deletions: 0 }, { filename: "b.rs", status: "renamed", additions: 1, deletions: 1 }],
  },
  "pulls/7/reviews?per_page=100&page=1": [{ id: 901, node_id: "R1", state: "CHANGES_REQUESTED", body: "Fix it", html_url: "r", submitted_at: "2026-10-22T10:00:00Z", user: user("ana") }],
  "pulls/7/comments?per_page=100&page=1": [
    { id: 11, node_id: "C11", thread_id: "t-1", in_reply_to_id: null, resolved: false, path: "a.rs", line: 4, body: "here", html_url: "c", created_at: "2026-10-22T11:00:00Z", user: user("ana"), diff_hunk: "@@ -1,3 +1,4 @@\\n a\\n+b", pull_request_review_id: 901 },
    { id: 12, node_id: "C12", thread_id: "t-1", in_reply_to_id: 11, resolved: false, path: "a.rs", line: 4, body: "done", html_url: "c", created_at: "2026-10-22T12:00:00Z", user: user("sam"), diff_hunk: "@@ -1,3 +1,4 @@\\n a\\n+b", pull_request_review_id: 902 },
  ],
  "pulls/7/commits?per_page=100&page=1": [
    { sha: "c1", commit: { message: "Start\\n\\nLong body", author: { name: "Ana" }, committer: { date: "2026-10-21T10:00:00Z" } }, author: { login: "ana" } },
    { sha: "c2", commit: { message: "Fix", author: { name: "Sam" }, committer: { date: "2026-10-21T11:00:00Z" } }, author: null },
  ],
  "pulls/7/files?per_page=100": [{ filename: "a.rs", status: "modified", additions: 3, deletions: 1, patch: "@@ never read @@" }, { filename: "b.rs", status: "removed", additions: 0, deletions: 4 }],
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

  it("fails with dt's own error when dt fails, instead of printing nothing", async () => {
    const down = (error: string) => {
      const extra = `FAKE_DT_DOWN=${shellQuote(error)} SHUTTLE_DELTA_TEAMS=edge,web `;
      return new CommandAdapter(forge({ whoami: command(extra), authored: command(extra), team_requested: command(extra), merge_options: command(extra), reply: command(extra) }), runProcess);
    };
    const restarting = "Error: 503: walgit: the host serving this repository is restarting; retry in a few seconds";
    const adapter = down(restarting);
    const attempts = [() => adapter.whoami(), () => adapter.list("authored", { state: "open" }), () => adapter.list("team_requested", {}), () => adapter.mergeOptions("shop/world", 7), () => adapter.reply("shop/world", 7, "t-1", "ok")];
    for (const attempt of attempts) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).detail).toMatchObject({ exit: 1, output: restarting });
    }
    const signedOut = await down("Error: 401: walgit: unauthorized").whoami().catch((e: unknown) => e as AdapterError);
    expect((signedOut as AdapterError).detail.output).toBe("Error: 401: walgit: unauthorized\ndelta.sh: Delta did not accept your sign-in; run `dt auth login`, then sync again");
    // One of activity's parallel reads fails: the others finish first, then the read fails with its error.
    const pullDown = new CommandAdapter(forge({ activity: command("FAKE_DT_PULL_DOWN='Error: 503: walgit: restarting' ") }), runProcess);
    const partial = await pullDown.activity("shop/world", 7).catch((e: unknown) => e as AdapterError);
    expect((partial as AdapterError).detail).toMatchObject({ exit: 1, output: "Error: 503: walgit: restarting" });
    // dt exits 0 but answers nothing: what it said on stderr still reaches Shuttle.
    const quiet = new CommandAdapter(forge({ whoami: command("FAKE_DT_QUIET='warning: token refresh failed' ") }), runProcess);
    await expect(quiet.whoami()).rejects.toThrow("whoami printed nothing: warning: token refresh failed");
    calls();
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

  it("adds every check, the commits, the first files, the merge state and thread hunks with SHUTTLE_DETAIL", async () => {
    calls();
    const activity = await delta().activity("shop/world", 7, undefined, { detail: true });
    expect(argsOf(calls()).map((args) => args[1])).toEqual(expect.arrayContaining(["repos/shop/world/pulls/7/files?per_page=100", "repos/shop/world/pulls/7/commits?per_page=100&page=1"]));
    expect(activity.items.map((i) => [i.id, i.review ?? null, i.hunk ?? null])).toEqual([
      ["R1:CHANGES_REQUESTED", "901", null],
      ["C11", "901", "@@ -1,3 +1,4 @@\n a\n+b"],
      ["C12", "902", null],
      ["check:ci@x.iam:reviews:h2", null, null],
    ]);
    expect(activity.details).toEqual({
      checks: { total: 3, items: [
        { name: "reviews", group: "ci", state: "failed", detail: null, required: null, url: "d1", startedAt: null, completedAt: null, itemId: "check:ci@x.iam:reviews:h2" },
        { name: "Required CI", group: "ci", state: "running", detail: "in progress", required: null, url: "d2", startedAt: null, completedAt: null, itemId: null },
        { name: "lint", group: "lint", state: "passed", detail: null, required: null, url: "d3", startedAt: null, completedAt: null, itemId: null },
      ] },
      commits: { total: 2, items: [{ sha: "c1", message: "Start", author: "ana", at: at("2026-10-21T10:00:00Z") }, { sha: "c2", message: "Fix", author: "Sam", at: at("2026-10-21T11:00:00Z") }] },
      files: { total: 1800, items: [{ path: "a.rs", additions: 3, deletions: 1, change: "modified" }, { path: "b.rs", additions: 0, deletions: 4, change: "removed" }] },
      timeline: null,
      merge: { state: "blocked", detail: "It is part of a stack; reviews is failing; main advances through the merge queue." },
    });
    // 1800 files is too many to compare: the files endpoint's first page and the commits instead.
    expect(argsOf(calls()).map((args) => args[1]).filter((path) => path.includes("compare"))).toEqual([]);
    // Without SHUTTLE_DETAIL, nothing more is read than before.
    const light = await delta().activity("shop/world", 7);
    expect(light.details).toBeNull();
    expect(argsOf(calls()).map((args) => args[1]).filter((path) => /files|commits/u.test(path))).toEqual([]);
  });

  it("reads a small PR's commits and files in one compare, without their patches", async () => {
    calls();
    const activity = await delta().activity("shop/world", 8, undefined, { detail: true });
    const read = argsOf(calls()).map((args) => args[1]).filter((path) => /files|commits|compare/u.test(path));
    expect(read).toEqual(["repos/shop/world/compare/b8...h8?per_page=100"]);
    expect(activity.details?.commits).toEqual({ total: 1, items: [{ sha: "c8", message: "Small", author: "ana", at: at("2026-10-21T10:00:00Z") }] });
    expect(activity.details?.files).toEqual({ total: 2, items: [{ path: "a.rs", additions: 5, deletions: 0, change: "added" }, { path: "b.rs", additions: 1, deletions: 1, change: "renamed" }] });
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
