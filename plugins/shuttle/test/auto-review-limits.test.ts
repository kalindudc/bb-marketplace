// @vitest-environment node
import { describe, expect, it } from "vitest";
import { harness, pr, testConfig, type Harness } from "./helpers";

const AUTO = { enabled: true, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 50, rerun: "never" as const };
const DAY = 86_400_000;
/** After Shuttle's first sync: 52 days before the clock that `watchedFor60Days` leaves. */
const OLD = "2026-10-31T10:00:00Z";
const RECENT = "2026-12-20T10:00:00Z";
const REFUSED = new Error("Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.");
const idOf = (h: Harness, n: number) => h.store.prByKey(`forge:acme/app#${n}`)!.id;
const reviewed = (h: Harness) => h.port.spawned.map((s) => s.title);

/** Shuttle's first sync sets the server's baseline; then 60 days go by. */
async function watchedFor60Days(h: Harness) {
  await h.shuttle.sync();
  h.clock.now += 60 * DAY;
}

/** The first sync lists the request, the next one comes back empty, as when the server refused the IP, then it is back. */
async function flap(h: Harness, rows: unknown[]) {
  h.lists.review_requested = rows;
  await h.shuttle.sync();
  h.clock.now += 3 * 60_000;
  h.lists.review_requested = [];
  await h.shuttle.sync();
  h.clock.now += 3 * 60_000;
  h.lists.review_requested = rows;
  await h.shuttle.sync();
}

describe("auto review of idle PRs", () => {
  it("does not take an old request that a server listed again for a new one", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    await watchedFor60Days(h);
    await flap(h, [pr(3, { updated_at: OLD, requested_at: OLD })]);
    expect(h.port.spawned).toHaveLength(0);
    const idle = h.shuttle.activity().filter((e) => e.kind === "auto_idle");
    expect(idle.map((e) => e.text)).toEqual(["Auto review left acme/app#3 to you: nothing happened on it for 52 days, and you were asked on 2026-10-31. Start a review yourself if it needs one."]);
    await h.shuttle.sync();
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_idle")).toHaveLength(1);
    expect(h.shuttle.inbox().autoQueue).toEqual([]);
  });

  it("reviews such a PR with idleDays at 0, as before", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, idleDays: 0 } }));
    await watchedFor60Days(h);
    await flap(h, [pr(3, { updated_at: OLD, requested_at: OLD })]);
    expect(reviewed(h)).toEqual(["Review acme/app#3"]);
  });

  it("reviews an idle PR when you were asked within the window, or when the server says nothing of when", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    await watchedFor60Days(h);
    h.lists.review_requested = [pr(3, { updated_at: OLD, requested_at: RECENT }), pr(4, { updated_at: OLD })];
    await h.shuttle.sync();
    expect(reviewed(h).sort()).toEqual(["Review acme/app#3", "Review acme/app#4"]);
  });

  it("reviews an old request on a PR that was updated within the window", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    await watchedFor60Days(h);
    await flap(h, [pr(3, { updated_at: RECENT, requested_at: OLD })]);
    expect(reviewed(h)).toEqual(["Review acme/app#3"]);
  });

  it("never takes a request the server says came before Shuttle's first sync for a new one, however late it is seen", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, idleDays: 0 } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3, { requested_at: "2026-10-22T09:00:00Z" }), pr(4, { requested_at: "2026-10-23T12:00:30Z" })];
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#4"]);
    expect(h.shuttle.inbox().autoQueue).toEqual([]);
  });
});

describe("the never auto review list", () => {
  it("never starts an auto review on a listed PR, and takes links and keys", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    await h.shuttle.sync();
    expect(h.shuttle.skipAutoReview(["https://forge.test/acme/app/pull/3", "forge:acme/app!5"], true)).toEqual({ skipPrs: ["forge:acme/app#3", "forge:acme/app#5"] });
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4), pr(5)];
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#4"]);
    expect(h.shuttle.inbox().autoQueue).toEqual([]);
    // A review you start yourself still runs.
    await h.shuttle.review({ key: "forge:acme/app#3" });
    expect(reviewed(h)).toEqual(["Review acme/app#4", "Review acme/app#3"]);
    expect(h.shuttle.skipAutoReview(["forge:acme/app#5"], false)).toEqual({ skipPrs: ["forge:acme/app#3"] });
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#4", "Review acme/app#3", "Review acme/app#5"]);
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_skip").map((e) => e.text)).toEqual([
      "Auto review can start on acme/app#5 again.",
      "Auto review never starts on forge:acme/app#5 now; a review you start yourself still runs.",
      "Auto review never starts on forge:acme/app#3 now; a review you start yourself still runs.",
    ]);
  });

  it("writes nothing when the list already says so", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, skipPrs: ["forge:acme/app#3"] } }));
    const publishes = h.port.publishes;
    expect(h.shuttle.skipAutoReview(["forge:acme/app#3"], true)).toEqual({ skipPrs: ["forge:acme/app#3"] });
    expect(h.port.publishes).toBe(publishes);
  });

  it("matches keys whatever their case, as the server does", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, skipPrs: ["forge:Acme/App#3"] } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#4"]);
  });

  it("reads the list again before each start, so a PR added while a batch starts is left alone", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4), pr(5)];
    const held = h.port.holdSpawn();
    const syncing = h.shuttle.sync();
    await held.entered;
    h.shuttle.skipAutoReview(["forge:acme/app#4"], true);
    held.release();
    await syncing;
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#5"]);
  });

  it("starts no more of a batch once automations are paused", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4)];
    const held = h.port.holdSpawn();
    const syncing = h.shuttle.sync();
    await held.entered;
    h.settings.pauseAutomations = true;
    held.release();
    await syncing;
    expect(reviewed(h)).toEqual(["Review acme/app#3"]);
  });

  it("refuses a key the config cannot hold", () => {
    expect(() => testConfig({ autoReview: { ...AUTO, skipPrs: ["acme/app#3"] } })).toThrow(/must be a PR key/u);
  });
});

describe("auto reviews at once", () => {
  it("starts at most maxRunning, queues the rest in order, and lets you start a queued one yourself", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, maxRunning: 2 } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4), pr(5), pr(6)];
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#4"]);
    expect(h.shuttle.inbox()).toMatchObject({ autoRunning: 2 });
    expect(h.shuttle.inbox().autoQueue.map((p) => p.number)).toEqual([5, 6]);
    // By hand it starts at once, and does not count toward the limit.
    await h.shuttle.review({ key: "forge:acme/app#6" });
    expect(h.shuttle.inbox().autoQueue.map((p) => p.number)).toEqual([5]);
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#4", "Review acme/app#6"]);
    await h.shuttle.endReview(h.port.spawned[0]!.threadId, "forge:acme/app#3", { note: "Fine.", failed: false });
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#4", "Review acme/app#6", "Review acme/app#5"]);
    expect(h.shuttle.inbox()).toMatchObject({ autoRunning: 2, autoQueue: [] });
  });

  it("starts the longest asked first", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, maxRunning: 1 } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3, { requested_at: "2026-10-23T12:00:40Z" }), pr(4, { requested_at: "2026-10-23T12:00:20Z" })];
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#4"]);
  });

  it("keeps the place of a review that starts again after its thread could not be set up", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, maxRunning: 1 } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    const first = h.port.spawned[0]!.threadId;
    h.port.threads.set(first, { ...h.port.threads.get(first)!, status: "error", hasWorkspace: false });
    const held = h.port.holdSpawn();
    const retry = h.shuttle.onThreadFailed(first, { error: "Provisioning thread failed", environmentId: null });
    await held.entered;
    // bb is still setting up the new thread: the place is taken.
    await h.shuttle.sync();
    expect(h.shuttle.inbox().autoQueue.map((p) => p.number)).toEqual([4]);
    held.release();
    await retry;
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#3"]);
    expect(h.store.runningAutoReviews()).toBe(1);
  });
});

describe("stopping reviews", () => {
  async function running(h: Harness, numbers: number[]) {
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = numbers.map((n) => pr(n));
    await h.shuttle.sync();
    return h.port.spawned.map((s) => s.threadId);
  }

  it("stops every running review, the threads at work under them, and never starts them again on the same head", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    const [a, b] = await running(h, [3, 4]);
    h.port.addThread("thr_critic", "Critic", false, { status: "active" });
    h.port.addThread("thr_done", "Done critic");
    h.port.children.set(a!, ["thr_critic", "thr_done"]);
    const result = await h.shuttle.stopReviews();
    expect(result.stopped.map((p) => p.number)).toEqual([3, 4]);
    expect(result.failed).toEqual([]);
    // The threads under it first, so none of them reports back and wakes it.
    expect(h.port.lifecycle).toEqual(["stop thr_critic", `stop ${a}`, `stop ${b}`]);
    for (const n of [3, 4]) expect(h.store.reviewsOf(idOf(h, n)).map((r) => [r.state, r.ended_by])).toEqual([["done", "stopped"]]);
    // The PR reads as if the review had not run: back to a request for you.
    expect(h.shuttle.view("forge:acme/app#3").next.kind).toBe("not_reviewed");
    await h.shuttle.sync();
    await h.shuttle.onThreadIdle(a!);
    expect(h.port.spawned).toHaveLength(2);
    expect(h.store.reviewsOf(idOf(h, 3)).map((r) => r.state)).toEqual(["done"]);
    expect(h.shuttle.activity().filter((e) => e.kind === "review_stopped").map((e) => e.text)).toEqual(["You stopped the review of acme/app#4.", "You stopped the review of acme/app#3."]);
  });

  it("stops only the PRs named, and archives their threads when asked", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    const [a, b] = await running(h, [3, 4]);
    const result = await h.shuttle.stopReviews(["forge:acme/app#4"], true);
    expect(result.stopped.map((p) => p.number)).toEqual([4]);
    expect(h.port.lifecycle).toEqual([`stop ${b}`, `archive ${b}`]);
    expect(h.port.threads.get(b!)?.archived).toBe(true);
    expect(h.store.reviewsOf(idOf(h, 3)).map((r) => r.state)).toEqual(["running"]);
    expect(h.port.threads.get(a!)?.archived).toBe(false);
  });

  it("ends the review even when bb will not stop its thread, and says so", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    const [a] = await running(h, [3]);
    h.port.failStop.add(a!);
    const result = await h.shuttle.stopReviews();
    expect(result.failed).toEqual([{ threadId: a, step: "stop", error: "stop refused" }]);
    expect(h.store.reviewsOf(idOf(h, 3)).map((r) => r.ended_by)).toEqual(["stopped"]);
    expect(h.shuttle.activity().find((e) => e.kind === "review_stopped")?.text).toBe("You stopped the review of acme/app#3; bb could not stop \u201cReview acme/app#3\u201d: stop refused");
    // Stopping it again tries bb once more.
    h.port.failStop.clear();
    const again = await h.shuttle.stopReviews(["forge:acme/app#3"]);
    expect(again).toMatchObject({ stopped: [{ number: 3 }], failed: [] });
    expect(h.port.lifecycle).toEqual([`stop ${a}`]);
    expect(h.shuttle.activity(1)[0]!.text).toBe("You stopped again the review of acme/app#3.");
  });

  it("stops every child it can when one refuses, and tells a refused archive from a refused stop", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    const [a] = await running(h, [3]);
    for (const id of ["thr_c1", "thr_c2"]) h.port.addThread(id, id, false, { status: "active" });
    h.port.children.set(a!, ["thr_c1", "thr_c2"]);
    h.port.failStop.add("thr_c2");
    h.port.failArchive = true;
    const result = await h.shuttle.stopReviews(undefined, true);
    expect(h.port.lifecycle).toEqual(["stop thr_c1", `stop ${a}`]);
    expect(result.failed).toEqual([{ threadId: "thr_c2", step: "stop", error: "stop refused" }, { threadId: a, step: "archive", error: "archive refused" }]);
    expect(h.shuttle.activity(1)[0]!.text).toBe("You stopped the review of acme/app#3; bb could not archive \u201cReview acme/app#3\u201d: archive refused; bb could not stop a thread under it: stop refused");
  });

  it("refuses a draft that a stopped review hands back, so auto post never sees it", async () => {
    const h = harness(testConfig({ autoReview: AUTO }));
    const [a] = await running(h, [3]);
    await h.shuttle.stopReviews();
    await expect(h.shuttle.saveDraft(a!, "forge:acme/app#3", { summary: "Late", verdict: "comment", findings: [], assessment: { risk: "low", concerns: [] } })).rejects.toThrow(/the user stopped this review/u);
    expect(h.store.pastDrafts(idOf(h, 3))).toEqual([]);
  });

  it("frees a place for the queue", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, maxRunning: 1 } }));
    await running(h, [3, 4]);
    expect(reviewed(h)).toEqual(["Review acme/app#3"]);
    await h.shuttle.stopReviews(["forge:acme/app#3"]);
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#4"]);
  });
});

describe("a list that leaves PRs out", () => {
  const requested = (h: Harness, n: number) => h.store.reasons(idOf(h, n)).filter((r) => r.reason === "requested");
  const step = (h: Harness, operation: string) => (JSON.parse(h.store.syncRuns("forge", 0).at(-1)!.steps) as Array<{ operation: string; status: string; detail: string }>).find((s) => s.operation === operation);

  it("keeps a request the server cannot show, so it is not new when the list brings it back", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, idleDays: 0 } }));
    // Waiting at the first sync, so never auto reviewed.
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    const since = requested(h, 3)[0]!.since;
    h.clock.now += 3 * 60_000;
    h.lists.review_requested = [];
    h.views[3] = REFUSED;
    h.views[4] = REFUSED;
    await h.shuttle.sync();
    expect(requested(h, 3)).toMatchObject([{ since, unlisted_since: h.clock.now }]);
    expect(step(h, "review_requested")).toMatchObject({ status: "ok", detail: "0 PRs; 2 PRs it left out are checked before they go" });
    expect(step(h, "refresh")).toMatchObject({ status: "failed" });
    expect(step(h, "refresh")!.detail).toMatch(/2 PRs the lists left out keep their place until Shuttle can read them$/u);
    expect(h.shuttle.list("reviews").map((p) => p.number).sort()).toEqual([3, 4]);
    // The list is back: the request is the one from before, marked as listed again.
    h.clock.now += 3 * 60_000;
    h.lists.review_requested = [pr(3, { head: "newhead" }), pr(4)];
    await h.shuttle.sync();
    expect(requested(h, 3)).toMatchObject([{ since, unlisted_since: null }]);
    expect(h.store.requests(0).filter((r) => r.pr_id === idOf(h, 3))).toHaveLength(1);
    expect(reviewed(h)).toEqual([]);
  });

  it("lets go of a request once the PR's own read shows the server sees it", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    h.lists.review_requested = [];
    h.views[3] = pr(3);
    await h.shuttle.sync();
    expect(requested(h, 3)).toEqual([]);
    expect(h.store.requests(0).filter((r) => r.pr_id === idOf(h, 3)).map((r) => r.gone_at)).toEqual([h.clock.now]);
  });

  it("lets go without a read when another list brought the PR, or the server says it is gone", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    h.lists.review_requested = [];
    h.lists.mentioned = [pr(3)];
    h.views[4] = new Error("GraphQL: Could not resolve to a PullRequest with the number of 4.");
    await h.shuttle.sync();
    expect(h.runner.calls.filter((c) => c.operation === "view").map((c) => c.env.SHUTTLE_NUMBER)).toEqual(["4"]);
    expect([requested(h, 3), requested(h, 4)]).toEqual([[], []]);
  });

  it("takes the list at its word after a day of the server refusing the PR", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    h.lists.review_requested = [];
    h.views[3] = REFUSED;
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    h.clock.now += 23 * 3_600_000;
    await h.shuttle.sync();
    expect(requested(h, 3)).toHaveLength(1);
    h.clock.now += 3_600_000;
    await h.shuttle.sync();
    expect(requested(h, 3)).toEqual([]);
  });

  it("starts no auto review on a request the list left out until a list brings it again", async () => {
    const h = harness(testConfig({ autoReview: { ...AUTO, maxRunning: 1 } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    await h.shuttle.stopReviews(["forge:acme/app#3"]);
    h.clock.now += 3 * 60_000;
    h.lists.review_requested = [];
    h.views[3] = REFUSED;
    h.views[4] = REFUSED;
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3"]);
    expect(h.shuttle.inbox().autoQueue).toEqual([]);
    h.clock.now += 3 * 60_000;
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    expect(reviewed(h)).toEqual(["Review acme/app#3", "Review acme/app#4"]);
  });

  it("reads linked and tracked PRs first, and checks a few left out ones at each sync", async () => {
    const h = harness();
    const numbers = Array.from({ length: 35 }, (_, i) => i + 10);
    h.lists.review_requested = numbers.map((n) => pr(n));
    await h.shuttle.sync();
    h.lists.review_requested = [];
    for (const n of numbers) h.views[n] = REFUSED;
    h.views[5] = pr(5);
    await h.shuttle.lookup("forge:acme/app#5");
    h.shuttle.track("forge:acme/app#5", true);
    const before = h.runner.calls.length;
    const reads = () => h.runner.calls.slice(before).filter((c) => c.operation === "view").map((c) => Number(c.env.SHUTTLE_NUMBER));
    for (let i = 0; i < 3; i++) {
      h.clock.now += 3 * 60_000;
      await h.shuttle.sync();
    }
    expect(reads().filter((n) => n === 5)).toHaveLength(3);
    // 10 a sync, and a different 10 each time.
    const checked = reads().filter((n) => n !== 5);
    expect(checked).toHaveLength(30);
    expect(new Set(checked).size).toBe(30);
  });

  it("lets go of your open PR the server keeps refusing after a day, as for requests", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    h.lists.authored = [];
    h.views[1] = REFUSED;
    const authored = () => h.store.reasons(idOf(h, 1)).filter((r) => r.reason === "authored");
    h.clock.now += 61 * 60_000;
    await h.shuttle.sync();
    const since = authored()[0]!.unlisted_since;
    expect(since).toBe(h.clock.now);
    for (let hour = 0; hour < 23; hour++) {
      h.clock.now += 61 * 60_000;
      await h.shuttle.sync();
    }
    // Each hourly full read keeps the time the lists first left it out.
    expect(authored()).toMatchObject([{ unlisted_since: since }]);
    h.clock.now += 61 * 60_000;
    await h.shuttle.sync();
    expect(authored()).toEqual([]);
  });

  it("keeps your open PR that a full read of your lists left out until its own read shows the server sees it", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" }), pr(2, { author: "me" }), pr(3, { author: "me" })];
    await h.shuttle.sync();
    h.lists.authored = [];
    h.views[1] = REFUSED;
    h.views[2] = pr(2, { author: "me" });
    h.views[3] = pr(3, { author: "me", state: "merged", updated_at: "2026-10-23T13:00:00Z" });
    h.clock.now += 61 * 60_000;
    await h.shuttle.sync();
    const authored = (n: number) => h.store.reasons(idOf(h, n)).filter((r) => r.reason === "authored").length;
    // Refused: it keeps the reason. Seen open but in no list: it goes, as before. Merged: it stays, in Done.
    expect([authored(1), authored(2), authored(3)]).toEqual([1, 0, 1]);
    expect(h.shuttle.list("done").map((p) => p.number)).toEqual([3]);
  });
});
