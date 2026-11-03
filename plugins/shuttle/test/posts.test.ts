// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

const WRITE_SERVER = { ...TEST_SERVER, enabled: true, sep: "#" as const, commands: { ...TEST_SERVER.commands, comment: "c", review: "rv" } };
const SECOND_SERVER = { ...WRITE_SERVER, id: "lab", name: "Lab", pattern: "^https://lab\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://lab.test/{repo}/pull/{number}" };
const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
const KEY = (n: number, server = "forge") => `${server}:acme/app#${n}`;
const MINUTE = 60_000;

/** Two requests on the forge, with a review command; `servers` adds more. */
async function queue(servers: unknown[] = [WRITE_SERVER]) {
  const h = harness(testConfig({ servers: servers as never, autoReview: NO_AUTO }));
  h.answers.review = "";
  h.lists.review_requested = [pr(3, { head: "h1" }), pr(4, { head: "h1" })];
  await h.shuttle.sync();
  h.views[3] = pr(3, { head: "h1" });
  h.views[4] = pr(4, { head: "h1" });
  return h;
}

/** Holds the server's review command until `release`, so a test can look at a post while it posts. */
function gate(adapter: Adapter) {
  const real = adapter.review.bind(adapter);
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const keys: number[] = [];
  adapter.review = async (repo, number, post, signal) => {
    keys.push(number);
    await opened;
    return real(repo, number, post, signal);
  };
  return { release: () => open(), keys };
}

async function withDraft(h: Awaited<ReturnType<typeof queue>>, n = 3) {
  const { threadId } = await h.shuttle.review({ key: KEY(n) });
  await h.shuttle.saveDraft(threadId, KEY(n), { summary: "Two things", verdict: "changes", findings: [{ severity: "high", path: "a.go", line: 3, body: "Race" }, { severity: "low", path: "b.go", line: 9, body: "Name" }] });
  await h.shuttle.onThreadIdle(threadId);
  return { threadId, draftId: h.shuttle.detail(KEY(n)).draft!.id };
}

const reviewCalls = (h: Awaited<ReturnType<typeof queue>>) => h.runner.calls.filter((call) => call.operation === "review").map((call) => Number(call.env.SHUTTLE_NUMBER));

describe("the review queue", () => {
  it("queues a draft's review at once, posts it in the background, and follows the PR through", async () => {
    const h = await queue();
    const { draftId } = await withDraft(h);
    const held = gate(h.shuttle.adapter("forge"));
    const out = h.shuttle.queueReview(KEY(3), { verdict: "changes", body: "Two things", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    expect(out.post).toMatchObject({ key: KEY(3), display: "acme/app#3", serverName: "Forge", verdict: "changes", comments: 1, draftId, state: "queued" });
    expect(out.pr.next).toMatchObject({ kind: "posting", inbox: false });

    await Promise.resolve();
    expect(h.shuttle.view(KEY(3)).next).toMatchObject({ kind: "posting", label: "Posting your review", why: expect.stringMatching(/^Changes requested with 1 comment\. Started/u) });
    expect(h.shuttle.inbox().posting.map((v) => v.key)).toEqual([KEY(3)]);
    expect(h.shuttle.inbox().prs.map((v) => v.key)).not.toContain(KEY(3));

    held.release();
    await h.shuttle.postsSettled();
    const view = h.shuttle.view(KEY(3));
    expect(view.next.kind).toBe("reviewed");
    expect(view.post).toBeNull();
    expect(h.shuttle.detail(KEY(3)).draft).toBeNull();
    expect(h.shuttle.posts()).toEqual([expect.objectContaining({ id: out.post.id, state: "posted", placed: 1, inBody: 0 })]);
    expect(h.shuttle.inbox().posting).toEqual([]);
    expect(h.shuttle.activity(5).map((e) => e.text)).toContain("You requested changes on acme/app#3 with 1 comment.");
  });

  it("posts one review at a time on each server, in the order they were queued, and servers do not wait on each other", async () => {
    const h = await queue([WRITE_SERVER, SECOND_SERVER]);
    const forge = gate(h.shuttle.adapter("forge"));
    const first = h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [] }).post;
    const second = h.shuttle.queueReview(KEY(4), { verdict: "comment", body: "Nice", findings: [] }).post;
    h.shuttle.queueReview(KEY(3, "lab"), { verdict: "approve", body: "LGTM", findings: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forge.keys).toEqual([3]);
    expect(h.shuttle.posts().map((p) => [p.display, p.state])).toEqual([["acme/app#3", "posting"], ["acme/app#4", "queued"], ["acme/app#3", "posted"]]);
    expect(h.shuttle.view(KEY(4)).next).toMatchObject({ kind: "posting", label: "Your review is queued to post", more: [{ id: "cancel_post" }] });
    expect(h.shuttle.inbox().posting.map((v) => v.post!.id)).toEqual([first.id, second.id]);
    forge.release();
    await h.shuttle.postsSettled();
    expect(forge.keys).toEqual([3, 4]);
    expect(h.shuttle.posts().filter((p) => p.state === "posted")).toHaveLength(3);
  });

  it("puts a review tried again behind the reviews already waiting", async () => {
    const h = await queue();
    h.lists.review_requested = [pr(3, { head: "h1" }), pr(4, { head: "h1" }), pr(5, { head: "h1" })];
    await h.shuttle.sync();
    h.answers.review = new Error("503");
    const first = h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [] }).post;
    await h.shuttle.postsSettled();
    h.answers.review = "";
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueReview(KEY(4), { verdict: "approve", body: "LGTM", findings: [] });
    h.clock.now += 1000;
    h.shuttle.queueReview(KEY(5), { verdict: "approve", body: "LGTM", findings: [] });
    h.clock.now += 1000;
    h.shuttle.retryPost(first.id);
    expect(h.shuttle.inbox().posting.map((v) => v.key)).toEqual([KEY(4), KEY(5), KEY(3)]);
    held.release();
    await h.shuttle.postsSettled();
    expect(held.keys).toEqual([4, 5, 3]);
  });

  it("cancels a review that has not started posting, and refuses to cancel one that has", async () => {
    const h = await queue();
    const held = gate(h.shuttle.adapter("forge"));
    const first = h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [] }).post;
    const second = h.shuttle.queueReview(KEY(4), { verdict: "approve", body: "LGTM", findings: [] }).post;
    await Promise.resolve();
    expect(() => h.shuttle.cancelPost(first.id)).toThrow(/started posting/u);
    expect(h.shuttle.cancelPost(second.id).next.kind).toBe("not_reviewed");
    expect(() => h.shuttle.cancelPost(second.id)).toThrow(/already cancelled/u);
    held.release();
    await h.shuttle.postsSettled();
    expect(held.keys).toEqual([3]);
    expect(h.shuttle.activity(5).map((e) => e.text)).toContain("Cancelled your approval on acme/app#4 before it posted.");
  });

  it("brings a review the server refused back to the Inbox with why, keeps its draft, and tries it again", async () => {
    const h = await queue();
    const { draftId } = await withDraft(h);
    h.answers.review = new Error("422 line 9 is not part of the diff");
    const { post } = h.shuttle.queueReview(KEY(3), { verdict: "changes", body: "Two things", findings: [{ path: "b.go", line: 9, body: "Name" }], draftId });
    await h.shuttle.postsSettled();
    const failed = h.shuttle.view(KEY(3));
    expect(failed.post).toMatchObject({ id: post.id, state: "failed", error: expect.stringContaining("422 line 9 is not part of the diff") });
    expect(failed.next).toMatchObject({ kind: "post_failed", tone: "bad", inbox: true, primary: { id: "choose" }, more: [{ id: "retry_post" }, { id: "clear_post" }] });
    expect(failed.next.why).toMatch(/^Changes requested with 1 comment: Forge refused: /u);
    expect(h.shuttle.inbox().prs[0]!.key).toBe(KEY(3));
    expect(h.shuttle.detail(KEY(3)).draft?.id).toBe(draftId);
    expect(h.shuttle.activity(1)[0]!.text).toMatch(/^Your review of acme\/app#3 did not post: Forge refused: /u);

    h.answers.review = "";
    const again = h.shuttle.retryPost(post.id);
    expect(again.post).toMatchObject({ id: post.id, state: "queued", error: null });
    await h.shuttle.postsSettled();
    expect(h.shuttle.view(KEY(3))).toMatchObject({ post: null, next: { kind: "reviewed" } });
    expect(() => h.shuttle.retryPost(post.id)).toThrow(/Only a review that failed/u);
  });

  it("drops a failed review when you dismiss it or queue another for the PR", async () => {
    const h = await queue();
    h.answers.review = new Error("503");
    const one = h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [] }).post;
    await h.shuttle.postsSettled();
    expect(h.shuttle.view(KEY(3)).next).toMatchObject({ kind: "post_failed", primary: { id: "retry_post" }, more: [{ id: "clear_post" }] });
    expect(h.shuttle.clearPost(one.id).post).toBeNull();
    expect(h.shuttle.view(KEY(3)).next.kind).toBe("not_reviewed");

    h.shuttle.queueReview(KEY(4), { verdict: "approve", body: "LGTM", findings: [] });
    await h.shuttle.postsSettled();
    expect(h.shuttle.view(KEY(4)).next.kind).toBe("post_failed");
    h.answers.review = "";
    h.shuttle.queueReview(KEY(4), { verdict: "comment", body: "Looked again", findings: [] });
    expect(h.shuttle.view(KEY(4)).post?.state).not.toBe("failed");
    await h.shuttle.postsSettled();
    expect(h.shuttle.view(KEY(4))).toMatchObject({ post: null, next: { kind: "reviewed" } });
  });

  it("refuses at once what would not post, and a draft already in the queue cannot be queued again or discarded", async () => {
    const h = await queue();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    expect(() => h.shuttle.queueReview(KEY(1), { verdict: "approve", body: "LGTM", findings: [] })).toThrow(/your own PR/u);
    expect(() => h.shuttle.queueReview(KEY(3), { verdict: "comment", body: " ", findings: [] })).toThrow(/Write something/u);
    const { draftId } = await withDraft(h);
    h.lists.review_requested = [pr(3, { head: "h2" }), pr(4, { head: "h1" })];
    h.views[3] = pr(3, { head: "h2" });
    await h.shuttle.sync();
    expect(() => h.shuttle.queueReview(KEY(3), { verdict: "comment", body: "ok", findings: [], draftId })).toThrow(/confirm to post/u);
    expect(() => h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "ok", findings: [], draftId, staleOk: true })).toThrow(/before you approve/u);
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueReview(KEY(3), { verdict: "comment", body: "ok", findings: [], draftId, staleOk: true });
    expect(() => h.shuttle.queueReview(KEY(3), { verdict: "comment", body: "ok", findings: [], draftId, staleOk: true })).toThrow("A review of acme/app#3 is already posting; wait for it, or cancel it first");
    await expect(h.shuttle.discardDraft(KEY(3), draftId)).rejects.toThrow(/queued to post/u);
    expect(h.shuttle.posts()).toHaveLength(1);
    held.release();
    await h.shuttle.postsSettled();
  });

  it("queues one review of a PR at a time, and tries a failed one again only while no other waits", async () => {
    const h = await queue();
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueReview(KEY(3), { verdict: "comment", body: "First", findings: [] });
    h.shuttle.queueReview(KEY(4), { verdict: "comment", body: "First", findings: [] });
    expect(() => h.shuttle.queueReview(KEY(4), { verdict: "approve", body: "LGTM", findings: [] })).toThrow("A review of acme/app#4 is already queued to post; wait for it, or cancel it first");
    held.release();
    await h.shuttle.postsSettled();
    h.answers.review = new Error("503");
    const failed = h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [] }).post;
    await h.shuttle.postsSettled();
    const row = h.store.postById(failed.id)!;
    expect(row.state).toBe("failed");
    // A review queued since, here straight into the store, is waiting; trying the old one now would post two reviews.
    h.store.addPost({ pr_id: row.pr_id, server: "forge", draft_id: null, verdict: "comment", body: "Second", findings: "[]", stale_ok: 0 });
    expect(() => h.shuttle.retryPost(failed.id)).toThrow("A review of acme/app#3 is already queued to post; wait for it, or cancel it first");
  });

  it("keeps a queued draft when a new AI review starts, so the review you chose still posts", async () => {
    const h = await queue();
    const { draftId } = await withDraft(h);
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [], draftId });
    await h.shuttle.review({ key: KEY(3), newThread: true });
    held.release();
    await h.shuttle.postsSettled();
    expect(h.shuttle.posts()[0]).toMatchObject({ state: "posted" });
  });

  it("fails a review a stopped Shuttle left posting, since the server may have it, and resumes the ones still waiting", async () => {
    const h = await queue();
    const prId = (n: number) => h.store.prByKey(KEY(n))!.id;
    const half = h.store.addPost({ pr_id: prId(3), server: "forge", draft_id: null, verdict: "approve", body: "LGTM", findings: "[]", stale_ok: 0 });
    h.store.startPost(half.id);
    const waiting = h.store.addPost({ pr_id: prId(4), server: "forge", draft_id: null, verdict: "approve", body: "LGTM", findings: "[]", stale_ok: 0 });
    h.shuttle.resumePosts();
    await h.shuttle.postsSettled();
    expect(h.store.postById(half.id)).toMatchObject({ state: "failed", error: "Shuttle stopped while posting it, so Forge may or may not have it. Check the PR before you try again." });
    expect(h.store.postById(waiting.id)!.state).toBe("posted");
    expect(reviewCalls(h)).toEqual([4]);
    expect(h.shuttle.view(KEY(3)).next.kind).toBe("post_failed");
  });

  it("lists what waits or posts and what finished in the last 10 minutes", async () => {
    const h = await queue();
    const old = h.shuttle.queueReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [] }).post;
    await h.shuttle.postsSettled();
    h.clock.now += 11 * MINUTE;
    const recent = h.shuttle.queueReview(KEY(4), { verdict: "approve", body: "LGTM", findings: [] }).post;
    await h.shuttle.postsSettled();
    expect(h.shuttle.posts().map((p) => p.id)).toEqual([recent.id]);
    expect(h.shuttle.posts().map((p) => p.id)).not.toContain(old.id);
  });
});
