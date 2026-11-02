// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SpawnUnavailableError } from "../src/ports";
import { testConfig, harness, pr } from "./helpers";

describe("sync", () => {
  it("stores every list with its reason and marks authored PRs as mine", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" }), pr(2, { author: "me", state: "merged" })];
    h.lists.review_requested = [pr(3)];
    h.lists.team_requested = [pr(4, { teams: ["@acme/edge"] })];
    h.lists.mentioned = [pr(5)];
    await h.shuttle.sync();
    expect(h.shuttle.list("mine").map((p) => p.number)).toEqual([1]);
    expect(h.shuttle.list("done").map((p) => p.number)).toEqual([2]);
    const reviews = h.shuttle.list("reviews");
    expect(reviews.map((p) => p.number).sort()).toEqual([3, 4, 5]);
    expect(reviews.find((p) => p.number === 4)!).toMatchObject({ reasons: [{ reason: "team", teams: ["@acme/edge"] }], teams: ["edge"] });
    expect(h.shuttle.overview().servers[0]).toMatchObject({ ok: true, login: "me" });
    const closed = h.runner.calls.find((c) => c.operation === "authored" && c.env.SHUTTLE_STATE === "closed");
    expect(closed?.env.SHUTTLE_SINCE).toBe("2026-10-09");
  });

  it("drops a reason when the PR leaves that list, and keeps the old data when a list fails", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3), pr(6)];
    await h.shuttle.sync();
    h.lists.review_requested = [pr(6)];
    await h.shuttle.sync();
    expect(h.shuttle.list("reviews").map((p) => p.number)).toEqual([6]);
    h.lists.review_requested = new Error("boom") as unknown as unknown[];
    h.clock.now += 180_000;
    await h.shuttle.sync();
    expect(h.shuttle.list("reviews").map((p) => p.number)).toEqual([6]);
    const status = h.shuttle.overview().servers[0]!;
    expect(status.ok).toBe(false);
    expect(status.error).toContain("boom");
    expect(h.shuttle.list("reviews")[0]!.stale).toBe(true);
  });

  it("refreshes a linked PR that no list covers", async () => {
    const h = harness();
    h.views[9] = pr(9, { author: "dana" });
    h.port.addThread("thr_a");
    await h.shuttle.link("forge:acme/app#9", "thr_a");
    h.views[9] = pr(9, { author: "dana", state: "merged" });
    await h.shuttle.sync();
    expect(h.store.prByKey("forge:acme/app#9")!.state).toBe("merged");
  });
});

describe("auto review", () => {
  it("never reviews the requests that were already waiting at the first sync", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(0);
  });

  it("reviews a new request by name once, in the project that matches the repo, with the preset", async () => {
    const h = harness(testConfig({ presets: [{ id: "deep", name: "Deep", default: true, skill: "pr-reviewer", providerId: "pi", model: "m1", reasoningLevel: "high", workspace: "worktree", prompt: "Review {url} {skill_line}{view_command}" }] }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
    const spawned = h.port.spawned[0]!;
    expect(spawned).toMatchObject({ projectId: "proj_app", providerId: "pi", model: "m1", reasoningLevel: "high", workspace: { kind: "worktree" }, title: "Review acme/app#3" });
    expect(spawned.prompt).toMatch(/^Review https:\/\/forge\.test\/acme\/app\/pull\/3 Use the `pr-reviewer` skill for this review\.\nforge pr view 3 -R acme\/app\n\nWhen your review is ready, call the shuttle_review_draft tool for forge:acme\/app#3/u);
    const view = h.shuttle.view("forge:acme/app#3");
    expect(view.links).toEqual([{ threadId: spawned.threadId, title: "Review acme/app#3", role: "review", archived: false }]);
    expect(view.lastReview).toMatchObject({ trigger: "auto", state: "running" });
    h.clock.now += 60_000;
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
    h.shuttle.onThreadIdle(spawned.threadId);
    expect(h.shuttle.inbox().prs.map((p) => [p.number, p.next.kind])).toEqual([[3, "review_done"]]);
    h.shuttle.snooze(["forge:acme/app#3"], "update");
    expect(h.shuttle.inbox().prs).toEqual([]);
  });

  it("skips team requests, mentions, my own PRs, drafts and other repos unless configured", async () => {
    const h = harness(testConfig({ autoReview: { enabled: true, when: ["requested"], drafts: false, preset: "", repos: ["acme/*"], maxPerDay: 8, rerun: "never" } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3, { state: "draft" }), pr(4, { author: "me" }), pr(5, { repo: "other/repo" })];
    h.lists.team_requested = [pr(6)];
    h.lists.mentioned = [pr(7)];
    h.lists.authored = [pr(4, { author: "me" })];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(0);
  });

  it("stops at the daily limit and says so once", async () => {
    const h = harness(testConfig({ autoReview: { enabled: true, when: ["requested"], drafts: false, preset: "", repos: [], maxPerDay: 1, rerun: "never" } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_capped")).toHaveLength(1);
  });

  it("reviews again on a new head only when rerun is new_head", async () => {
    const h = harness(testConfig({ autoReview: { enabled: true, when: ["requested"], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "new_head" } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    h.lists.review_requested = [pr(3, { head: "newhead" })];
    await h.shuttle.sync();
    // The second run goes to the first one's thread.
    expect(h.port.spawned).toHaveLength(1);
    expect(h.store.reviewsOf(h.store.prByKey("forge:acme/app#3")!.id).map((r) => [r.thread_id, r.head])).toEqual([[h.port.spawned[0]!.threadId, "head3"], [h.port.spawned[0]!.threadId, "newhead"]]);
    expect(h.port.sent.map((s) => s.threadId)).toEqual([h.port.spawned[0]!.threadId]);
  });

  it("reviews a server without heads once, even with rerun on new heads", async () => {
    const h = harness(testConfig({ autoReview: { enabled: true, when: ["requested"], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "new_head" } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3, { head: null })];
    await h.shuttle.sync();
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
  });

  it("keeps reasons a capped list did not reach, so a request that comes back is not new", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    const before = h.store.reasons(h.store.prByKey("forge:acme/app#3")!.id)[0]!.since;
    h.store.replaceReasons("forge", "requested", [{ prId: h.store.prByKey("forge:acme/app#4")!.id, teams: [] }], false);
    expect(h.store.reasons(h.store.prByKey("forge:acme/app#3")!.id)[0]!.since).toBe(before);
  });

  it("pauses with the setting, and records a review that cannot start without retrying it", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.settings.pauseAutomations = true;
    h.lists.review_requested = [pr(3, { repo: "nowhere/unknown" })];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(0);
    h.settings.pauseAutomations = false;
    await h.shuttle.sync();
    await h.shuttle.sync();
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_failed")).toHaveLength(1);
  });

  it("waits while bb has no machine for a review, tries again at each sync, and gives up after an hour", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.port.spawnError = new SpawnUnavailableError("Already 4 sandboxes (the limit is 4)");
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    const waits = () => h.shuttle.activity().filter((e) => e.kind === "auto_waiting");
    expect(waits().map((e) => e.text).sort()).toEqual([
      "Auto review of acme/app#3 waits: Already 4 sandboxes (the limit is 4). Shuttle tries again at each sync for up to an hour.",
      "Auto review of acme/app#4 waits: Already 4 sandboxes (the limit is 4). Shuttle tries again at each sync for up to an hour.",
    ]);
    h.clock.now += 30 * 60_000;
    await h.shuttle.sync();
    expect(waits()).toHaveLength(2);
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_failed")).toHaveLength(0);

    h.port.spawnError = null;
    await h.shuttle.sync();
    expect(h.port.spawned.map((s) => s.title).sort()).toEqual(["Review acme/app#3", "Review acme/app#4"]);

    h.port.spawnError = new SpawnUnavailableError("Already 4 sandboxes (the limit is 4)");
    h.lists.review_requested = [pr(5)];
    await h.shuttle.sync();
    h.clock.now += 40 * 60_000;
    await h.shuttle.sync();
    h.clock.now += 21 * 60_000;
    await h.shuttle.sync();
    await h.shuttle.sync();
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_failed").map((e) => e.text)).toEqual([
      "Auto review of acme/app#5 could not start in an hour of waiting: Already 4 sandboxes (the limit is 4)",
    ]);
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_capped")).toHaveLength(0);
  });

  it("waits afresh for a review that comes back long after its last wait, instead of failing it at once", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.port.spawnError = new SpawnUnavailableError("no room");
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    // The request is withdrawn while the review waits, and comes back hours later.
    h.lists.review_requested = [];
    await h.shuttle.sync();
    h.clock.now += 3 * 3_600_000;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_waiting")).toHaveLength(2);
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_failed")).toHaveLength(0);
  });

  it("gives a review at least two syncs before it fails, when syncs are further apart than the hour", async () => {
    const h = harness();
    h.settings.syncMinutes = 120;
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.port.spawnError = new SpawnUnavailableError("no room");
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    h.clock.now += 120 * 60_000;
    await h.shuttle.sync();
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_waiting")).toHaveLength(1);
    expect(h.shuttle.activity().filter((e) => e.kind === "auto_failed").map((e) => e.text)).toEqual(["Auto review of acme/app#3 could not start in an hour of waiting: no room"]);
  });
});
