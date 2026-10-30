// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseConfig, DEFAULT_CONFIG } from "../src/config";
import { linkKey, parseGitLink } from "../src/links";
import type { CheckInfo, CommitInfo } from "../src/adapters/adapter";
import type { CheckRun } from "../src/contract";
import { harness, pr, testConfig } from "./helpers";

const SERVERS = parseConfig({
  ...DEFAULT_CONFIG,
  servers: [
    { id: "github", name: "GitHub", kind: "github", commands: {} },
    { id: "delta", name: "Delta", kind: "command", pattern: "^https://delta\\.shopify\\.io/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://delta.shopify.io/{repo}/pull/{number}", commands: { view: "v" } },
  ],
}).servers;
const parse = (url: string) => parseGitLink(url, SERVERS);
const ref = (repo: string, number: number, server = "github") => ({ server, repo, number });

describe("git links", () => {
  it("reads a PR and each of its pages", () => {
    expect(parse("https://github.com/acme/api/pull/12")).toEqual({ kind: "pr", server: "github", repo: "acme/api", ref: ref("acme/api", 12), part: "overview" });
    expect(parse("https://github.com/acme/api/pull/12/files#diff-1a2b")).toMatchObject({ kind: "pr", part: "files" });
    expect(parse("https://github.com/acme/api/pull/12/commits")).toMatchObject({ kind: "pr", part: "commits" });
    expect(parse("https://github.com/acme/api/pull/12/checks")).toMatchObject({ kind: "pr", part: "checks" });
    expect(parse("https://delta.shopify.io/shop/world/pull/2261179")).toMatchObject({ kind: "pr", server: "delta", ref: ref("shop/world", 2261179, "delta") });
    expect(parse("https://github.com/acme/api/pull/123x")).toBeNull();
  });

  it("reads comments and reviews by their anchors", () => {
    expect(parse("https://github.com/acme/api/pull/12#issuecomment-991")).toMatchObject({ kind: "comment", anchor: "issuecomment-991", ref: ref("acme/api", 12) });
    expect(parse("https://github.com/acme/api/pull/12#discussion_r1500")).toMatchObject({ kind: "comment", anchor: "discussion_r1500" });
    expect(parse("https://github.com/acme/api/pull/12/files#r1500")).toMatchObject({ kind: "comment", anchor: "discussion_r1500" });
    expect(parse("https://github.com/acme/api/pull/12#pullrequestreview-77")).toMatchObject({ kind: "review", anchor: "pullrequestreview-77" });
  });

  it("reads commits on a PR and on their own, check runs and workflow runs", () => {
    expect(parse("https://github.com/acme/api/pull/12/commits/1a2b3c4d")).toMatchObject({ kind: "commit", sha: "1a2b3c4d", ref: ref("acme/api", 12) });
    expect(parse("https://github.com/acme/api/pull/12/changes/1a2b3c4d")).toMatchObject({ kind: "commit", sha: "1a2b3c4d" });
    expect(parse("https://github.com/acme/api/commit/1a2b3c4d5e6f")).toEqual({ kind: "commit", server: "github", repo: "acme/api", sha: "1a2b3c4d5e6f", ref: null });
    expect(parse("https://github.com/acme/api/pull/12/checks?check_run_id=555")).toMatchObject({ kind: "check", checkRun: 555, run: null, ref: ref("acme/api", 12) });
    expect(parse("https://github.com/acme/api/actions/runs/88/job/99")).toEqual({ kind: "check", server: "github", repo: "acme/api", run: 88, checkRun: 99, ref: null });
    expect(parse("https://github.com/acme/api/actions/runs/88")).toMatchObject({ kind: "check", run: 88, checkRun: null });
    expect(parse("https://github.com/acme/api/runs/555")).toMatchObject({ kind: "check", checkRun: 555 });
    expect(parse("https://delta.shopify.io/shop/world/commit/abcdef1")).toMatchObject({ kind: "commit", server: "delta", repo: "shop/world" });
  });

  it("matches a server's pattern only from the start of the link, even when the pattern has no ^", () => {
    const loose = parseConfig({ ...DEFAULT_CONFIG, servers: [{ id: "forge", name: "Forge", kind: "command", pattern: "https://forge\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://forge.test/{repo}/pull/{number}", commands: { view: "v" } }] }).servers;
    expect(parseGitLink("https://forge.test/a/b/pull/3", loose)).toMatchObject({ kind: "pr", repo: "a/b" });
    expect(parseGitLink("https://evil.example/?u=https://forge.test/a/b/pull/3", loose)).toBeNull();
  });

  it("leaves everything else alone", () => {
    for (const url of ["https://github.com/acme/api", "https://github.com/acme/api/issues/4", "https://github.com/acme/api/blob/main/a.ts", "https://example.com/acme/api/pull/1", "not a link"]) {
      expect(parse(url)).toBeNull();
    }
  });

  it("gives two links to one thing one key", () => {
    expect(linkKey(parse("https://github.com/acme/api/pull/12")!)).toBe(linkKey(parse("https://github.com/acme/api/pull/12/files")!));
    expect(linkKey(parse("https://github.com/acme/api/pull/12#issuecomment-1")!)).not.toBe(linkKey(parse("https://github.com/acme/api/pull/12")!));
  });
});

describe("link cards", () => {
  const LINK = (n: number, rest = "") => `https://forge.test/shop/world/pull/${n}${rest}`;

  it("shows a PR from Shuttle's copy, and says when it has not seen one, without asking the server", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    const calls = h.runner.calls.length;
    const card = await h.shuttle.linkCard(LINK(1, "/files"));
    expect(card).toMatchObject({ kind: "pr", label: "shop/world#1", tab: "changes", note: null });
    expect((await h.shuttle.linkCard(LINK(1))).tab).toBe("overview");
    expect((await h.shuttle.linkCard(LINK(1, "/checks"))).tab).toBe("checks");
    expect((await h.shuttle.linkCard(LINK(1, "/commits"))).tab).toBe("changes");
    expect(card.pr?.key).toBe("forge:shop/world#1");
    const unseen = await h.shuttle.linkCard(LINK(9));
    expect(unseen).toMatchObject({ pr: null, prKey: "forge:shop/world#9", note: "Shuttle hasn't seen shop/world#9 yet." });
    expect(h.runner.calls.length).toBe(calls);
    expect(h.shuttle.linkStates([LINK(1), LINK(9), "https://example.com"])).toEqual([
      { url: LINK(1), kind: "pr", state: "open" },
      { url: LINK(9), kind: "pr", state: null },
      { url: "https://example.com", kind: null, state: null },
    ]);
  });

  it("finds the comment and the review a link points at, with its thread and lines", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    h.activity[1] = { items: [
      { id: "r1", kind: "review", author: "ana", state: "changes requested", body: "Two things.", url: `${LINK(1)}#pullrequestreview-7`, review: "R7" },
      { id: "t1", kind: "thread", author: "ana", body: "Retry only on 504.", path: "gw.ts", line: 4, thread: "T1", url: `${LINK(1)}#discussion_r10`, review: "R7", hunk: "@@ -1 +1,2 @@\n a\n+b", at: 1 },
      { id: "t2", kind: "thread", author: "me", body: "Done.", path: "gw.ts", line: 4, thread: "T1", url: `${LINK(1)}#discussion_r11`, at: 2 },
      { id: "t3", kind: "thread", author: "ana", body: "And here.", path: "b.ts", line: 9, thread: "T2", resolved: true, url: `${LINK(1)}#discussion_r12`, review: "R7" },
    ] };
    await h.shuttle.sync();
    const reply = await h.shuttle.linkCard(LINK(1, "#discussion_r11"));
    expect(reply.comment).toMatchObject({ item: { id: "t2", body: "Done." }, replies: 1, resolved: false });
    expect(reply.comment?.item.hunk).toEqual([{ kind: "context", text: "a", line: 1 }, { kind: "add", text: "b", line: 2 }]);
    expect(reply.tab).toBe("conversation");
    const review = await h.shuttle.linkCard(LINK(1, "#pullrequestreview-7"));
    expect(review.review).toMatchObject({ item: { id: "r1" }, comments: 2, open: 1 });
    const gone = await h.shuttle.linkCard(LINK(1, "#issuecomment-404"));
    expect(gone).toMatchObject({ comment: null, note: "That comment is not on shop/world#1 any more, or Forge did not send it." });
  });

  it("places a commit on its PR from the PR's last read, and says what the agent fixed with it", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me", head: "abcdef1234", review: "changes" })];
    h.activity[1] = { items: [
      { id: "r1", kind: "review", author: "ana", state: "changes requested", body: "Fix it" },
      { id: "c2", kind: "comment", author: "sam", body: "And this" },
    ], commits: [{ sha: "abcdef1234", message: "Fix the retry", author: "me", at: "2026-10-23T11:00:00Z" }] };
    await h.shuttle.sync();
    h.port.addThread("thr_fixer", "Fixer");
    await h.shuttle.setAgent("forge:shop/world#1", { kind: "existing", threadId: "thr_fixer" }, "fix");
    const refOf = (body: string) => [...h.port.sent[0]!.text.matchAll(/\[ref ([0-9a-f]{8})\]([^[]*)/gu)].find((found) => found[2]!.includes(body))![1]!;
    const [refId, other] = [refOf("Fix it"), refOf("And this")];
    // A fix reported with an empty commit names no commit, so it is nobody's fix.
    await h.shuttle.recordOutcomes("thr_fixer", "forge:shop/world#1", [{ ref: refId!, outcome: "fixed", commit: "abcdef1" }, { ref: other!, outcome: "fixed", commit: "" }]);
    const onPr = await h.shuttle.linkCard(LINK(1, "/commits/abcdef1"));
    expect(onPr.commit).toMatchObject({ sha: "abcdef1234", message: "Fix the retry", head: true, fixes: [{ author: "ana", body: "Fix it" }] });
    // A commit link on its own still finds its PR by the PR's head.
    const alone = await h.shuttle.linkCard("https://forge.test/shop/world/commit/abcdef1");
    expect(alone).toMatchObject({ kind: "commit", label: "shop/world@abcdef1", tab: "changes" });
    expect(alone.pr?.key).toBe("forge:shop/world#1");
    // A PR whose server reported an empty head is nobody's commit.
    h.lists.authored = [...h.lists.authored!, pr(2, { author: "me", head: "" })];
    await h.shuttle.sync();
    expect(h.shuttle.linkStates(["https://forge.test/shop/world/commit/0000000"])).toEqual([{ url: "https://forge.test/shop/world/commit/0000000", kind: "commit", state: null }]);
    const stranger = await h.shuttle.linkCard("https://forge.test/shop/world/commit/0000000");
    expect(stranger).toMatchObject({ commit: null, pr: null, note: "Shuttle has no PR with 0000000, and Forge cannot be asked about commits here." });
  });

  describe("reads from the server", () => {
    const JOB = (n: number) => `https://forge.test/shop/world/actions/runs/88/job/${n}`;
    const run = (overrides: Partial<CheckRun> = {}): CheckRun => ({ name: "lint", group: null, state: "failed", detail: null, required: null, url: JOB(99), startedAt: null, completedAt: null, itemId: null, ...overrides });
    async function seen() {
      const h = harness();
      h.lists.authored = [pr(1, { author: "me", head: "abcdef1234" })];
      // Two checks share a name; only the URL says which is which.
      h.activity[1] = { items: [], checks: [
        { name: "lint", state: "failed", url: JOB(98), required: false },
        { name: "lint", state: "failed", url: JOB(99), required: true },
      ] };
      await h.shuttle.sync();
      await h.shuttle.conversation("forge:shop/world#1");
      return h;
    }

    it("places a check on its PR by the head, takes Required from the PR's own read by URL, and asks once a minute", async () => {
      const h = await seen();
      const reads: unknown[] = [];
      Object.assign(h.shuttle.adapter("forge"), { checkRun: async (repo: string, ids: unknown): Promise<CheckInfo> => { reads.push([repo, ids]); return { run: run(), head: "abcdef1234", prs: [] }; } });
      const card = await h.shuttle.linkCard(JOB(99));
      expect(reads).toEqual([["shop/world", { checkRun: 99, run: 88 }]]);
      expect(card).toMatchObject({ kind: "check", label: "shop/world#1", prKey: "forge:shop/world#1", tab: "checks" });
      expect(card.check).toMatchObject({ name: "lint", url: JOB(99), required: true });
      await h.shuttle.linkCard(JOB(99));
      expect(reads).toHaveLength(1);
      h.clock.now += 61_000;
      await h.shuttle.linkCard(JOB(99));
      expect(reads).toHaveLength(2);
    });

    it("places a check by the PRs the server names, and keeps a failed read for a minute before asking again", async () => {
      const h = await seen();
      let fail = true;
      let reads = 0;
      Object.assign(h.shuttle.adapter("forge"), { checkRun: async (): Promise<CheckInfo> => {
        reads += 1;
        if (fail) throw new Error("HTTP 502");
        return { run: run({ url: JOB(97), name: "test" }), head: null, prs: [1] };
      } });
      const failed = await h.shuttle.linkCard(JOB(97));
      expect(failed.note).toBe("Could not read the check from Forge: HTTP 502");
      expect(failed.check).toBeNull();
      fail = false;
      await h.shuttle.linkCard(JOB(97));
      expect(reads).toBe(1);
      h.clock.now += 61_000;
      const card = await h.shuttle.linkCard(JOB(97));
      expect(reads).toBe(2);
      expect(card.pr?.key).toBe("forge:shop/world#1");
      // Not in the PR's own read, so nothing says whether it is required.
      expect(card.check).toMatchObject({ name: "test", required: null });
    });

    it("reads a commit Shuttle cannot place from the server once a minute", async () => {
      const h = await seen();
      let reads = 0;
      Object.assign(h.shuttle.adapter("forge"), { commit: async (_repo: string, sha: string): Promise<CommitInfo> => {
        reads += 1;
        return { sha: `${sha}00`, message: "Elsewhere", author: "ana", at: null, additions: 1, deletions: 0, checks: null, prs: [] };
      } });
      const link = "https://forge.test/shop/world/commit/1234567";
      expect((await h.shuttle.linkCard(link)).commit).toMatchObject({ sha: "123456700", message: "Elsewhere", fixes: [] });
      await h.shuttle.linkCard(link);
      expect(reads).toBe(1);
    });
  });

  it("refuses a link none of its servers has", async () => {
    await expect(harness(testConfig()).shuttle.linkCard("https://example.com/a/b/pull/1")).rejects.toThrow("none of Shuttle's servers has that link");
  });
});
