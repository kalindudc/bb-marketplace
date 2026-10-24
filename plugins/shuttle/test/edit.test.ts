// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GithubAdapter, toSummary as githubSummary } from "../src/adapters/github";
import type { RunOptions } from "../src/adapters/exec";
import { parseConfig, DEFAULT_CONFIG, type ServerConfig } from "../src/config";
import { CommandAdapter } from "../src/adapters/command";
import { harness, pr, TEST_SERVER, testConfig, fakeRunner } from "./helpers";

const EDITS = { ready: "rd", draft: "dr", close: "cl", reopen: "ro", edit_labels: "el", edit_reviewers: "er", edit_options: "eo" };

async function setup(commands: Record<string, string> = EDITS) {
  const h = harness(testConfig({ servers: [{ ...TEST_SERVER, commands: { ...TEST_SERVER.commands, ...commands } }] as never }));
  h.lists.authored = [pr(1, { author: "me", draft: true, labels: ["bug"] }), pr(2, { author: "me" })];
  h.lists.review_requested = [pr(3, { author: "ana" })];
  for (const op of Object.keys(EDITS)) h.answers[op] = "";
  await h.shuttle.sync();
  return h;
}

const callsOf = (h: Awaited<ReturnType<typeof setup>>, operation: string) => h.runner.calls.filter((c) => c.operation === operation);

describe("actions on a PR", () => {
  it("offers changes only on the user's own PRs, by state and by the server's commands", async () => {
    const h = await setup();
    expect(h.shuttle.view("forge:shop/world#1").actions).toEqual(["ready", "close", "labels", "reviewers"]);
    expect(h.shuttle.view("forge:shop/world#2").actions).toEqual(["draft", "close", "labels", "reviewers"]);
    expect(h.shuttle.view("forge:shop/world#3").actions).toEqual([]);
    const { draft: _draft, ...noDraft } = EDITS;
    const limited = await setup(noDraft);
    expect(limited.shuttle.view("forge:shop/world#2").actions).toEqual(["close", "labels", "reviewers"]);
  });

  it("reads labels from lists and keeps them when a later answer has none", async () => {
    const h = await setup();
    expect(h.shuttle.view("forge:shop/world#1").labels).toEqual([{ name: "bug", color: null }]);
    expect(h.shuttle.view("forge:shop/world#2").labels).toBeNull();
  });
});

describe("editPr", () => {
  it("marks a draft ready, records it, and reads the PR back", async () => {
    const h = await setup();
    h.views[1] = pr(1, { author: "me", body: "Hi", reviewers: [{ login: "ana", state: "requested" }] });
    const view = await h.shuttle.editPr("forge:shop/world#1", { kind: "ready" });
    expect(callsOf(h, "ready")[0]!.env).toMatchObject({ SHUTTLE_REPO: "shop/world", SHUTTLE_NUMBER: "1" });
    expect(view.state).toBe("open");
    expect(view.reviewers?.map(({ login, team, state }) => ({ login, team, state }))).toEqual([{ login: "ana", team: false, state: "requested" }]);
    expect(h.shuttle.activity()[0]!.text).toBe("Marked shop/world#1 ready for review.");
  });

  it("keeps the change on screen when reading the PR back fails", async () => {
    const h = await setup();
    const view = await h.shuttle.editPr("forge:shop/world#2", { kind: "close" });
    expect(view.state).toBe("closed");
    expect(h.shuttle.list("done").map((p) => p.key)).toContain("forge:shop/world#2");
  });

  it("passes labels and reviewers to the commands as lines, with teams apart", async () => {
    const h = await setup();
    await h.shuttle.editPr("forge:shop/world#1", { kind: "labels", add: ["needs tophat", "cache", "cache"], remove: ["bug", "cache"] });
    expect(callsOf(h, "edit_labels")[0]!.env).toMatchObject({ SHUTTLE_ADD: "needs tophat\ncache", SHUTTLE_REMOVE: "bug" });
    expect(h.shuttle.view("forge:shop/world#1").labels!.map((l) => l.name)).toEqual(["needs tophat", "cache"]);
    await h.shuttle.editPr("forge:shop/world#1", { kind: "reviewers", add: [{ login: "ana", team: false }, { login: "edge", team: true }], remove: [{ login: "bo", team: false }] });
    expect(callsOf(h, "edit_reviewers")[0]!.env).toMatchObject({ SHUTTLE_ADD: "ana", SHUTTLE_ADD_TEAMS: "edge", SHUTTLE_REMOVE: "bo", SHUTTLE_REMOVE_TEAMS: "" });
    expect(h.shuttle.view("forge:shop/world#1").reviewers).toEqual([{ login: "ana", team: false, state: "requested" }, { login: "edge", team: true, state: "requested" }]);
  });

  it("refuses other people's PRs, changes the state does not allow, and missing commands", async () => {
    const h = await setup();
    await expect(h.shuttle.editPr("forge:shop/world#3", { kind: "close" })).rejects.toThrow("not one of your PRs");
    await expect(h.shuttle.editPr("forge:shop/world#1", { kind: "reopen" })).rejects.toThrow("is draft, so it can't be changed that way");
    await expect(h.shuttle.editPr("forge:shop/world#1", { kind: "labels", add: [], remove: [] })).rejects.toThrow("nothing to change");
    const { draft: _draft, ...noDraft } = EDITS;
    const limited = await setup(noDraft);
    await expect(limited.shuttle.editPr("forge:shop/world#2", { kind: "draft" })).rejects.toThrow("Forge has no draft command");
    expect(h.runner.calls.some((c) => ["close", "reopen", "edit_labels"].includes(c.operation))).toBe(false);
  });

  it("reports a server's refusal and leaves the PR as it was", async () => {
    const h = await setup();
    h.answers.close = new Error("permission denied");
    await expect(h.shuttle.editPr("forge:shop/world#2", { kind: "close" })).rejects.toThrow("Forge refused the change: close exited 1: permission denied");
    expect(h.shuttle.view("forge:shop/world#2").state).toBe("open");
  });
});

describe("editOptions", () => {
  it("merges the server's answer with labels and reviewers seen on the repo and the user's teams", async () => {
    const h = await setup();
    h.lists.team_requested = [pr(4, { author: "cy", teams: ["@edge"] })];
    h.answers.edit_options = { labels: ["perf", { name: "bug", color: "#D73A4A", description: "Broken" }], people: ["ana", "me", "zed"] };
    await h.shuttle.sync();
    h.views[2] = pr(2, { author: "me", body: "", reviewers: [{ login: "bo", state: "approved" }, { login: "cdn", team: true, state: "requested" }] });
    await h.shuttle.lookup("forge:shop/world#2");
    const options = await h.shuttle.editOptions("forge:shop/world#1");
    expect(options.labels).toEqual([{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "perf", color: null, description: null }]);
    expect(options.people).toEqual(["ana", "zed", "bo"]);
    expect(options.teams).toEqual(["edge", "cdn"]);
  });
});

describe("the GitHub adapter's changes", () => {
  const server = parseConfig({ ...DEFAULT_CONFIG }).servers.find((s) => s.kind === "github") as ServerConfig;
  const recorder = () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[], _options: RunOptions) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    return { calls, run };
  };

  it("uses gh pr for the state and the REST API for labels and reviewers", async () => {
    const { calls, run } = recorder();
    const gh = new GithubAdapter({ ...server, hostname: undefined }, run);
    await gh.change("acme/api", 7, { kind: "draft" });
    await gh.change("acme/api", 7, { kind: "reopen" });
    await gh.change("acme/api", 7, { kind: "labels", add: ["a,b"], remove: ["needs tophat"] });
    await gh.change("acme/api", 7, { kind: "reviewers", add: [{ login: "ana", team: false }, { login: "acme/edge", team: true }], remove: [] });
    expect(calls).toEqual([
      ["pr", "ready", "7", "-R", "acme/api", "--undo"],
      ["pr", "reopen", "7", "-R", "acme/api"],
      ["api", "-X", "POST", "repos/acme/api/issues/7/labels", "-f", "labels[]=a,b"],
      ["api", "-X", "DELETE", "repos/acme/api/issues/7/labels/needs%20tophat"],
      ["api", "-X", "POST", "repos/acme/api/pulls/7/requested_reviewers", "-f", "reviewers[]=ana", "-f", "team_reviewers[]=edge"],
    ]);
  });

  it("names the host for GitHub Enterprise", async () => {
    const { calls, run } = recorder();
    await new GithubAdapter({ ...server, hostname: "ghe.acme.io" }, run).change("acme/api", 7, { kind: "ready" });
    expect(calls[0]).toEqual(["pr", "ready", "7", "-R", "ghe.acme.io/acme/api"]);
  });

  it("lists requested reviewers first and everyone else's latest review, without the author", () => {
    const node = {
      number: 7, title: "T", url: "u", isDraft: false, state: "OPEN", reviewDecision: null, headRefOid: null, headRefName: null, baseRefName: null,
      updatedAt: "2026-10-23T10:00:00Z", additions: 1, deletions: 1, changedFiles: 1, author: { login: "me" }, repository: { nameWithOwner: "acme/api" },
      commits: { nodes: [] }, labels: { nodes: [{ name: "bug", color: "D73A4A" }] },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "ana" } }, { requestedReviewer: { __typename: "Team", combinedSlug: "acme/edge" } }] },
      latestReviews: { nodes: [{ state: "CHANGES_REQUESTED", author: { login: "ana" } }, { state: "APPROVED", author: { login: "bo" } }, { state: "COMMENTED", author: { login: "me" } }] },
    } as const;
    const summary = githubSummary(node as never);
    expect(summary.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
    expect(summary.reviewers?.map(({ login, team, state }) => ({ login, team, state }))).toEqual([
      { login: "ana", team: false, state: "requested" },
      { login: "acme/edge", team: true, state: "requested" },
      { login: "bo", team: false, state: "approved" },
    ]);
  });
});

describe("a command server's answers", () => {
  it("accepts labels as names or objects and drops a colour it can't read", async () => {
    const runner = fakeRunner(() => ({ ...pr(1), body: "", labels: ["a", { name: "b", color: "#ABCDEF" }, { name: "c", color: "blue" }] }));
    const view = await new CommandAdapter(testConfig().servers[0]!, runner).view("shop/world", 1);
    expect(view.labels).toEqual([{ name: "a", color: null }, { name: "b", color: "abcdef" }, { name: "c", color: null }]);
    expect(view.reviewers).toBeNull();
  });
});
