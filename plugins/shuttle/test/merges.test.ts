// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

const WRITE_SERVER = { ...TEST_SERVER, enabled: true, sep: "#" as const, commands: { ...TEST_SERVER.commands, merge: "mg", merge_options: "mo", comment: "c" } };
const SECOND_SERVER = { ...WRITE_SERVER, id: "lab", name: "Lab", pattern: "^https://lab\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://lab.test/{repo}/pull/{number}" };
const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
const KEY = (n: number, server = "forge") => `${server}:acme/app#${n}`;
const MINUTE = 60_000;
const SQUASH = { method: "squash" as const, head: "h1", auto: false, deleteBranch: true };

type H = ReturnType<typeof harness>;

/** Merge commands that ran, by PR number and server. */
const merged = (h: H) => h.runner.calls.filter((call) => call.operation === "merge");

const mine = (n: number, extra: Record<string, unknown> = {}) => pr(n, { author: "me", review: "approved", head: "h1", ...extra });

/**
 * Two approved PRs of yours on the forge. Each reads back from its server as the merge commands that went through left
 * it: merged after a merge, with auto-merge on after an auto one, unless `stays` keeps it open as a merge queue would.
 */
async function queue(servers: Array<{ id: string }> = [WRITE_SERVER], stays = new Set<number>(), numbers = [1, 2]) {
  const h = harness(testConfig({ servers: servers as never, autoReview: NO_AUTO }));
  h.answers.merge = "";
  h.lists.authored = numbers.map((n) => mine(n));
  await h.shuttle.sync();
  const done = new Map<number, { auto: boolean }[]>();
  for (const server of servers) {
    const adapter = h.shuttle.adapter(server.id);
    const real = adapter.merge.bind(adapter);
    adapter.merge = async (repo, number, input, signal) => {
      const out = await real(repo, number, input, signal);
      done.set(number, [...(done.get(number) ?? []), { auto: input.auto }]);
      return out;
    };
  }
  for (const n of numbers) {
    Object.defineProperty(h.views, n, {
      configurable: true,
      get: () => {
        const went = done.get(n) ?? [];
        return mine(n, { state: went.some((m) => !m.auto) && !stays.has(n) ? "merged" : "open", auto_merge: went.some((m) => m.auto) });
      },
    });
  }
  return h;
}

/** Holds the server's merge command until `release`, so a test can look at a merge while it runs. */
function gate(adapter: Adapter) {
  const real = adapter.merge.bind(adapter);
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const numbers: number[] = [];
  adapter.merge = async (repo, number, input, signal) => {
    numbers.push(number);
    await opened;
    return real(repo, number, input, signal);
  };
  return { release: () => open(), numbers };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the merge queue", () => {
  it("queues a merge at once, merges it in the background, and follows the PR through", async () => {
    const h = await queue();
    const held = gate(h.shuttle.adapter("forge"));
    const out = h.shuttle.queueMerge(KEY(1), SQUASH);
    // The worker starts on it at once, since nothing waits ahead of it.
    expect(out.merge).toMatchObject({ key: KEY(1), display: "acme/app#1", serverName: "Forge", method: "squash", auto: false, deleteBranch: true, head: "h1", state: "merging", outcome: null });
    expect(out.pr.next).toMatchObject({ kind: "merging", label: "Merging", inbox: false });

    await tick();
    expect(h.shuttle.view(KEY(1)).next).toMatchObject({ kind: "merging", label: "Merging", why: expect.stringMatching(/^Squash and merge, and delete the branch\. Started/u) });
    expect(h.shuttle.inbox().merging.map((v) => v.key)).toEqual([KEY(1)]);
    expect(h.shuttle.inbox().prs.map((v) => v.key)).not.toContain(KEY(1));

    held.release();
    await h.shuttle.mergesSettled();
    const view = h.shuttle.view(KEY(1));
    expect(view).toMatchObject({ state: "merged", merge: null, next: { kind: "merged" } });
    expect(merged(h)[0]!.env).toMatchObject({ SHUTTLE_METHOD: "squash", SHUTTLE_HEAD: "h1", SHUTTLE_AUTO: "0", SHUTTLE_DELETE_BRANCH: "1" });
    expect(h.shuttle.merges()).toEqual([expect.objectContaining({ id: out.merge.id, state: "done", outcome: "merged" })]);
    expect(h.shuttle.inbox().merging).toEqual([]);
    expect(h.shuttle.activity(5).map((e) => e.text)).toContain("You merged acme/app#1 (squash, branch deleted).");
  });

  it("merges one at a time on each server, in the order they were queued, and servers do not wait on each other", async () => {
    const h = await queue([WRITE_SERVER, SECOND_SERVER]);
    const forge = gate(h.shuttle.adapter("forge"));
    const first = h.shuttle.queueMerge(KEY(1), SQUASH).merge;
    const second = h.shuttle.queueMerge(KEY(2), SQUASH).merge;
    h.shuttle.queueMerge(KEY(1, "lab"), SQUASH);
    await tick();
    await tick();
    expect(forge.numbers).toEqual([1]);
    expect(h.shuttle.merges().map((m) => [m.key, m.state])).toEqual([[KEY(1), "merging"], [KEY(2), "queued"], [KEY(1, "lab"), "done"]]);
    expect(h.shuttle.view(KEY(2)).next).toMatchObject({ kind: "merging", label: "Queued to merge", more: [{ id: "cancel_merge" }] });
    expect(h.shuttle.inbox().merging.map((v) => v.merge!.id)).toEqual([first.id, second.id]);
    forge.release();
    await h.shuttle.mergesSettled();
    expect(forge.numbers).toEqual([1, 2]);
    expect(h.shuttle.merges().filter((m) => m.state === "done")).toHaveLength(3);
  });

  it("puts a merge tried again behind the merges already waiting", async () => {
    const h = await queue([WRITE_SERVER], new Set(), [1, 2, 3]);
    h.answers.merge = new Error("503");
    const first = h.shuttle.queueMerge(KEY(1), SQUASH).merge;
    await h.shuttle.mergesSettled();
    h.answers.merge = "";
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueMerge(KEY(2), SQUASH);
    h.clock.now += 1000;
    h.shuttle.queueMerge(KEY(3), SQUASH);
    h.clock.now += 1000;
    h.shuttle.retryMerge(first.id);
    expect(h.shuttle.inbox().merging.map((v) => v.key)).toEqual([KEY(2), KEY(3), KEY(1)]);
    held.release();
    await h.shuttle.mergesSettled();
    expect(held.numbers).toEqual([2, 3, 1]);
  });

  it("lets the server's read-back say whether auto-merge is on", async () => {
    const h = await queue();
    Object.defineProperty(h.views, 2, { configurable: true, get: () => mine(2, { auto_merge: false }) });
    h.shuttle.queueMerge(KEY(2), { ...SQUASH, auto: true });
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(2))).toMatchObject({ autoMerge: false, merge: null });
    expect(h.shuttle.merges()[0]).toMatchObject({ state: "done", outcome: "auto_merge" });
    // A server whose read-back leaves the field out keeps what Shuttle asked for.
    Object.defineProperty(h.views, 2, { configurable: true, get: () => ({ ...mine(2), auto_merge: undefined }) });
    h.shuttle.queueMerge(KEY(2), { ...SQUASH, auto: true });
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(2)).autoMerge).toBe(true);
  });

  it("cancels a merge that has not started, and refuses to cancel one that has", async () => {
    const h = await queue();
    const held = gate(h.shuttle.adapter("forge"));
    const first = h.shuttle.queueMerge(KEY(1), SQUASH).merge;
    const second = h.shuttle.queueMerge(KEY(2), { ...SQUASH, auto: true }).merge;
    await tick();
    expect(() => h.shuttle.cancelMerge(first.id)).toThrow("The merge has started, so it can't be cancelled");
    expect(h.shuttle.cancelMerge(second.id).next.kind).toBe("ready_to_merge");
    expect(() => h.shuttle.cancelMerge(second.id)).toThrow("That auto-merge is already cancelled");
    held.release();
    await h.shuttle.mergesSettled();
    expect(held.numbers).toEqual([1]);
    expect(h.shuttle.activity(5).map((e) => e.text)).toContain("Cancelled the auto-merge of acme/app#2 before it started.");
  });

  it("brings a merge the server refused back to the Inbox with why, and tries it again", async () => {
    const h = await queue();
    h.answers.merge = new Error("Base branch was modified. Review and try the merge again.");
    const { merge } = h.shuttle.queueMerge(KEY(1), SQUASH);
    await h.shuttle.mergesSettled();
    const failed = h.shuttle.view(KEY(1));
    expect(failed.merge).toMatchObject({ id: merge.id, state: "failed", error: expect.stringContaining("Base branch was modified") });
    expect(failed.next).toMatchObject({ kind: "merge_failed", tone: "bad", label: "Your merge didn\u2019t go through", inbox: true, primary: { id: "retry_merge" }, more: [{ id: "merge" }, { id: "clear_merge" }] });
    expect(failed.next.why).toMatch(/^Squash and merge, and delete the branch: Forge refused: /u);
    expect(h.shuttle.inbox().prs[0]!.key).toBe(KEY(1));
    expect(h.shuttle.activity(1)[0]!.text).toMatch(/^Your merge of acme\/app#1 did not go through: Forge refused: /u);

    h.answers.merge = "";
    const again = h.shuttle.retryMerge(merge.id);
    expect(again.merge).toMatchObject({ id: merge.id, state: "merging", error: null });
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(1))).toMatchObject({ state: "merged", merge: null });
    expect(() => h.shuttle.retryMerge(merge.id)).toThrow("Only a merge that failed can be tried again");
  });

  it("reads the PR just before it merges, and does not merge a head with commits you did not see", async () => {
    const h = await queue();
    // Someone pushed since the last sync: Shuttle still has h1, the server has h2.
    Object.defineProperty(h.views, 1, { configurable: true, get: () => mine(1, { head: "h2" }) });
    const { merge } = h.shuttle.queueMerge(KEY(1), SQUASH);
    await h.shuttle.mergesSettled();
    expect(merged(h)).toEqual([]);
    const view = h.shuttle.view(KEY(1));
    expect(view.merge!.error).toBe("acme/app#1 has new commits since you chose to merge it at h1 (it is at h2 now); look at them, then merge again");
    // The same merge again would be refused, so the way on is to look and merge the new head.
    expect(view.next).toMatchObject({ kind: "merge_failed", primary: { id: "merge" }, more: [{ id: "clear_merge" }] });
    expect(() => h.shuttle.retryMerge(merge.id)).toThrow(/has new commits since you chose to merge it at h1/u);
  });

  it("refuses at once what could not merge", async () => {
    const h = await queue();
    h.lists.review_requested = [pr(3)];
    h.lists.authored = [pr(1, { author: "me", review: "approved", head: "h1" }), pr(2, { author: "me", review: "approved", head: "h1" }), pr(4, { author: "me", state: "draft", head: "h1" })];
    await h.shuttle.sync();
    expect(() => h.shuttle.queueMerge(KEY(3), { ...SQUASH, head: "head3" })).toThrow("acme/app#3 is not one of your PRs; Shuttle only merges your own");
    expect(() => h.shuttle.queueMerge(KEY(4), SQUASH)).toThrow("acme/app#4 is a draft; mark it ready for review, then merge it");
    expect(() => h.shuttle.queueMerge(KEY(1), { ...SQUASH, head: "h0" })).toThrow(/has new commits since you chose to merge it at h0/u);
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueMerge(KEY(1), SQUASH);
    h.shuttle.queueMerge(KEY(2), SQUASH);
    expect(() => h.shuttle.queueMerge(KEY(2), { ...SQUASH, auto: true })).toThrow("A merge of acme/app#2 is already queued; wait for it, or cancel it first");
    await tick();
    expect(() => h.shuttle.queueMerge(KEY(1), SQUASH)).toThrow("A merge of acme/app#1 is already under way; wait for it, or cancel it first");
    held.release();
    await h.shuttle.mergesSettled();

    const bare = harness(testConfig({ autoReview: NO_AUTO }));
    bare.lists.authored = [pr(1, { author: "me", head: "h1" })];
    await bare.shuttle.sync();
    expect(() => bare.shuttle.queueMerge(KEY(1), SQUASH)).toThrow("Forge has no merge command, so Shuttle can't merge there");
  });

  it("says so when the server takes the merge and the PR stays open, as in a repository's own merge queue", async () => {
    const h = await queue([WRITE_SERVER], new Set([1]));
    const { merge } = h.shuttle.queueMerge(KEY(1), SQUASH);
    await h.shuttle.mergesSettled();
    expect(h.shuttle.merges()).toEqual([expect.objectContaining({ id: merge.id, state: "done", outcome: "sent" })]);
    const texts = h.shuttle.activity(5).map((e) => e.text);
    expect(texts).toContain("Forge took the merge of acme/app#1, and it is still open: it may be waiting in the repository's merge queue.");
    expect(texts.some((text) => text.startsWith("You merged"))).toBe(false);
    // Not Ready to merge again, which would invite a second merge of a PR already in the server's queue.
    const sent = h.shuttle.view(KEY(1));
    expect(sent).toMatchObject({ state: "open", merge: { id: merge.id, state: "done", outcome: "sent" } });
    expect(sent.next).toMatchObject({ kind: "merging", label: "Sent to merge", inbox: false, more: [{ id: "merge" }] });
    expect(h.shuttle.inbox().merging).toEqual([]);
    expect(h.shuttle.inbox().prs.map((v) => v.key)).not.toContain(KEY(1));
    // New commits mean the server's queue has dropped it, or will: it is ready to merge again.
    h.lists.authored = [mine(1, { head: "h2" }), mine(2)];
    await h.shuttle.sync();
    expect(h.shuttle.view(KEY(1))).toMatchObject({ merge: null, next: { kind: "ready_to_merge" } });
  });

  it("turns on auto-merge in the background", async () => {
    const h = await queue();
    const held = gate(h.shuttle.adapter("forge"));
    h.shuttle.queueMerge(KEY(1), SQUASH);
    h.shuttle.queueMerge(KEY(2), { ...SQUASH, auto: true });
    expect(h.shuttle.view(KEY(2)).next).toMatchObject({ kind: "merging", label: "Auto-merge is queued to turn on", why: expect.stringMatching(/^Auto-merge with a squash, and delete the branch\. Queued just now; Shuttle does it after any merges ahead of it on Forge\.$/u) });
    held.release();
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(2))).toMatchObject({ state: "open", autoMerge: true, merge: null, next: { kind: "auto_merge" } });
    expect(h.shuttle.merges()[0]).toMatchObject({ state: "done", outcome: "auto_merge" });
  });

  it("drops a failed merge when you dismiss it, queue another, or the PR merges elsewhere", async () => {
    const h = await queue();
    h.answers.merge = new Error("503");
    const one = h.shuttle.queueMerge(KEY(1), SQUASH).merge;
    await h.shuttle.mergesSettled();
    expect(h.shuttle.clearMerge(one.id).merge).toBeNull();
    expect(h.shuttle.view(KEY(1)).next.kind).toBe("ready_to_merge");

    h.shuttle.queueMerge(KEY(2), SQUASH);
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(2)).next.kind).toBe("merge_failed");
    h.answers.merge = "";
    h.shuttle.queueMerge(KEY(2), { ...SQUASH, method: "merge" });
    expect(h.shuttle.view(KEY(2)).merge?.state).toBe("merging");
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(2))).toMatchObject({ state: "merged", merge: null });

    h.answers.merge = new Error("503");
    h.shuttle.queueMerge(KEY(1), SQUASH);
    await h.shuttle.mergesSettled();
    expect(h.shuttle.view(KEY(1)).next.kind).toBe("merge_failed");
    h.lists.authored = [mine(1, { state: "merged" })];
    h.clock.now += MINUTE;
    await h.shuttle.sync();
    expect(h.shuttle.view(KEY(1))).toMatchObject({ state: "merged", merge: null, next: { kind: "merged" } });
  });

  it("fails a merge a stopped Shuttle left under way, since it may have gone through, and resumes the ones still waiting", async () => {
    const h = await queue();
    const prId = (n: number) => h.store.prByKey(KEY(n))!.id;
    const half = h.store.addMerge({ pr_id: prId(1), server: "forge", method: "squash", head: "h1", auto: 0, delete_branch: 0, subject: null });
    h.store.startMerge(half.id);
    const waiting = h.store.addMerge({ pr_id: prId(2), server: "forge", method: "squash", head: "h1", auto: 0, delete_branch: 0, subject: null });
    h.shuttle.resumeMerges();
    await h.shuttle.mergesSettled();
    expect(h.store.mergeById(half.id)).toMatchObject({ state: "failed", error: "Shuttle stopped while it was under way, so Forge may or may not have merged it. Check the PR before you try again." });
    expect(h.store.mergeById(waiting.id)).toMatchObject({ state: "done", outcome: "merged" });
    expect(merged(h).map((call) => Number(call.env.SHUTTLE_NUMBER))).toEqual([2]);
    expect(h.shuttle.view(KEY(1)).next.kind).toBe("merge_failed");
  });

  it("lists what waits or merges and what finished in the last 10 minutes", async () => {
    const h = await queue();
    const old = h.shuttle.queueMerge(KEY(1), SQUASH).merge;
    await h.shuttle.mergesSettled();
    h.clock.now += 11 * MINUTE;
    const recent = h.shuttle.queueMerge(KEY(2), SQUASH).merge;
    await h.shuttle.mergesSettled();
    expect(h.shuttle.merges().map((m) => m.id)).toEqual([recent.id]);
    expect(h.shuttle.merges().map((m) => m.id)).not.toContain(old.id);
  });
});
