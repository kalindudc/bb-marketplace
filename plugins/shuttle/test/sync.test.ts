// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SyncStep } from "../src/contract";
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

describe("the lists of a server", () => {
  const steps = (h: ReturnType<typeof harness>) => JSON.parse(h.store.lastSyncRun("forge")!.steps) as SyncStep[];
  const closedSince = (h: ReturnType<typeof harness>) => h.runner.calls.filter((c) => c.operation === "authored" && c.env.SHUTTLE_STATE === "closed").map((c) => c.env.SHUTTLE_SINCE);

  it("keeps a PR that asks more teams than any one person belongs to, such as a monorepo change with 62 owners", async () => {
    const h = harness();
    const teams = Array.from({ length: 62 }, (_, i) => `@acme/team-${i}`);
    h.lists.team_requested = [pr(4, { teams }), pr(5, { teams: ["@acme/edge"] })];
    await h.shuttle.sync();
    expect(steps(h).find((s) => s.operation === "team_requested")).toMatchObject({ status: "ok", detail: "2 PRs" });
    expect(h.shuttle.list("reviews").find((p) => p.number === 4)!.teams).toHaveLength(62);
  });

  it("shows your open PRs as soon as their list lands, before the other lists answer", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    h.lists.review_requested = [pr(3)];
    const seen: number[][] = [];
    const publish = h.port.publish.bind(h.port);
    h.port.publish = (tags) => {
      seen.push(h.shuttle.list("mine").map((p) => p.number));
      publish(tags);
    };
    const slow = h.hold("review_requested");
    const sync = h.shuttle.sync();
    await slow.reached;
    await vi.waitFor(() => expect(seen).toContainEqual([1]));
    slow.release();
    await sync;
  });

  it("publishes once after each list, so each list shows when it lands", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    const publishes = h.port.publishes;
    await h.shuttle.sync();
    // The sync's start, open and closed PRs, three request lists, the server's end and the sync's end.
    expect(h.port.publishes - publishes).toBe(8);
  });

  it("keeps your open PRs when the closed list fails, and says which one failed", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    h.lists.authored_closed = new Error("authored printed JSON in the wrong shape: 0.number: Invalid input") as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.shuttle.list("mine").map((p) => p.number)).toEqual([1]);
    expect(steps(h).map((s) => [s.operation, s.status, s.detail])).toEqual([
      ["whoami", "ok", "Signed in as me"],
      ["authored", "ok", "1 open"],
      ["authored_closed", "failed", null],
      ["review_requested", "ok", "0 PRs"],
      ["team_requested", "ok", "0 PRs"],
      ["mentioned", "ok", "0 PRs"],
    ]);
    expect(h.shuttle.overview().servers[0]).toMatchObject({ state: "partial", failedSteps: ["authored_closed"] });
  });

  it("reads merged and closed PRs since the last read, with the whole window about once an hour", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me", state: "merged" })];
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    h.lists.authored = [pr(2, { author: "me", state: "closed" })];
    await h.shuttle.sync();
    // The first read was at 12:00, less a margin of five minutes: still that day.
    expect(closedSince(h)).toEqual(["2026-10-09", "2026-10-23"]);
    expect(steps(h).find((s) => s.operation === "authored_closed")!.detail).toBe("1 merged or closed since the last read");
    const reasons = (n: number) => h.store.reasons(h.store.prByKey(`forge:acme/app#${n}`)!.id).map((r) => r.reason);
    // A read since the last one did not see PR 1, which keeps its reason.
    expect([reasons(1), reasons(2)]).toEqual([["authored"], ["authored"]]);
    h.clock.now += 60 * 60_000;
    await h.shuttle.sync();
    expect(closedSince(h)).toEqual(["2026-10-09", "2026-10-23", "2026-10-09"]);
    expect([reasons(1), reasons(2)]).toEqual([[], ["authored"]]);
  });

  it("moves the closed read's checkpoint only after a read that came in full", async () => {
    const h = harness();
    const list = vi.spyOn(h.shuttle.adapter("forge"), "list");
    const sinceAt = () => list.mock.calls.filter((call) => call[1].state === "closed").map((call) => call[1].sinceAt);
    // The first read over the whole window is cut short, so the next one reads the whole window again.
    h.lists.authored_closed = { items: [], complete: false } as unknown as unknown[];
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    expect(sinceAt()).toEqual(["2026-10-09T12:00:00+00:00", "2026-10-09T12:03:00+00:00"]);
    // A read since the last one that is cut short leaves the next read starting where it did.
    h.lists.authored_closed = [];
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    h.lists.authored_closed = { items: [], complete: false } as unknown as unknown[];
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    expect(sinceAt().slice(2)).toEqual(["2026-10-09T12:06:00+00:00", "2026-10-23T12:01:00+00:00", "2026-10-23T12:01:00+00:00"]);
  });

  it("reads the whole Done window at the next sync after it changes", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    h.settings.doneDays = 30;
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    expect(closedSince(h)).toEqual(["2026-10-09", "2026-09-23", "2026-10-23"]);
  });

  it("reads a PR of yours that left the open list on its own when the closed read since the last one did not bring it", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" }), pr(2, { author: "me" }), pr(3, { author: "me" })];
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    // All three left the open list, and the closed read since the last one missed them.
    h.lists.authored = [];
    h.views[1] = pr(1, { author: "me", state: "merged", updated_at: "2026-10-23T12:02:00Z" });
    h.views[2] = pr(2, { author: "dana" });
    await h.shuttle.sync();
    const reasons = (n: number) => h.store.reasons(h.store.prByKey(`forge:acme/app#${n}`)!.id).map((r) => r.reason);
    expect(h.runner.calls.filter((c) => c.operation === "view").map((c) => Number(c.env.SHUTTLE_NUMBER)).sort()).toEqual([1, 2, 3]);
    // Merged: it is yours, in Done. Someone else's now: not yours. Not read: it keeps its reason and waits.
    expect([reasons(1), reasons(2), reasons(3)]).toEqual([["authored"], [], ["authored"]]);
    expect(h.shuttle.list("done").map((p) => p.number)).toEqual([1]);
    expect(h.shuttle.list("mine").map((p) => p.number)).not.toContain(1);
    // The read over the whole window confirms PR 3 is gone.
    h.clock.now += 60 * 60_000;
    await h.shuttle.sync();
    expect(reasons(3)).toEqual([]);
  });

  it("asks GitHub for closed PRs from the exact time of the last read, less the margin", async () => {
    const h = harness();
    await h.shuttle.sync();
    const list = vi.spyOn(h.shuttle.adapter("forge"), "list");
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    expect(list.mock.calls.find((call) => call[1].state === "closed")?.[1]).toEqual({ state: "closed", since: "2026-10-23", sinceAt: "2026-10-23T11:55:00+00:00" });
  });

  it("moves a PR of yours that merged elsewhere from Mine to Done when the closed list brings it", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" }), pr(2, { author: "me" })];
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    h.lists.authored = [pr(1, { author: "me" }), pr(2, { author: "me", state: "merged" })];
    await h.shuttle.sync();
    expect(h.shuttle.list("mine").map((p) => p.number)).toEqual([1]);
    expect(h.shuttle.list("done").map((p) => p.number)).toEqual([2]);
  });

  it("reads linked PRs a few at a time, and still reads each one once", async () => {
    const h = harness();
    h.port.addThread("thr_a");
    for (const n of [7, 8, 9, 10]) {
      h.views[n] = pr(n, { author: "dana" });
      await h.shuttle.link(`forge:acme/app#${n}`, "thr_a", "reference");
    }
    h.clock.now += 180_000;
    const held = [h.hold("view"), h.hold("view"), h.hold("view")];
    const before = h.runner.calls.filter((c) => c.operation === "view").length;
    const sync = h.shuttle.sync();
    await Promise.all(held.map((hold) => hold.reached));
    expect(h.runner.calls.filter((c) => c.operation === "view").length - before).toBe(3);
    for (const hold of held) hold.release();
    await sync;
    expect(h.runner.calls.filter((c) => c.operation === "view").length - before).toBe(4);
    expect(steps(h).find((s) => s.operation === "refresh")).toMatchObject({ status: "ok", detail: "4 PRs" });
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
    await h.shuttle.onThreadIdle(spawned.threadId);
    expect(h.shuttle.inbox().prs).toEqual([]);
    await h.shuttle.endReview(spawned.threadId, "forge:acme/app#3", { note: "It looks fine.", failed: false });
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
