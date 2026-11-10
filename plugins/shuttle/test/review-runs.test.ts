// @vitest-environment node
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { REVIEW_QUIET_MS } from "../src/next";
import { endQuietReviews } from "../src/review-runs";
import { harness, pr, testConfig } from "./helpers";

const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
const KEY = "forge:acme/app#3";

/** A review of someone else's PR running in a thread Shuttle started, with two critics under it. */
async function reviewing() {
  const h = harness(testConfig({ autoReview: NO_AUTO }));
  h.lists.review_requested = [pr(3)];
  await h.shuttle.sync();
  const { threadId } = await h.shuttle.review({ key: KEY });
  h.port.addThread("thr_critic1", "Jon · critic", false, { status: "active" });
  h.port.addThread("thr_critic2", "Bob · critic", false, { status: "active" });
  h.port.children.set(threadId, ["thr_critic1", "thr_critic2"]);
  return { h, threadId };
}

const run = (h: ReturnType<typeof harness>) => h.shuttle.view(KEY).lastReview!;
const quiet = (h: ReturnType<typeof harness>) => endQuietReviews(h.shuttle);
const setStatus = (h: ReturnType<typeof harness>, id: string, patch: { status?: string; waiting?: boolean }) => h.port.threads.set(id, { ...h.port.threads.get(id)!, ...patch });

describe("a review run", () => {
  it("keeps running when its thread's turn ends while it waits on its critics", async () => {
    const { h, threadId } = await reviewing();
    await h.shuttle.onThreadIdle(threadId);
    expect(run(h)).toMatchObject({ state: "running", thread: "idle", endedBy: null });
    expect(h.shuttle.view(KEY).next).toMatchObject({ kind: "running", why: expect.stringContaining("Its thread is idle for now, perhaps waiting on its child threads.") });
    expect(h.shuttle.inbox().reviewing.map((v) => v.key)).toEqual([KEY]);
    expect(h.shuttle.inbox().prs).toEqual([]);
    // A critic reporting back gives the review thread a new turn; nothing about the review changes.
    h.shuttle.onThreadActive(threadId);
    await h.shuttle.onThreadIdle("thr_critic1", threadId);
    expect(run(h)).toMatchObject({ state: "running", thread: "working" });
  });

  it("ends when its thread hands back a draft, whatever the thread does next", async () => {
    const { h, threadId } = await reviewing();
    await h.shuttle.saveDraft(threadId, KEY, { summary: "One race", verdict: "changes", findings: [{ severity: "high", path: "a.go", line: 3, body: "Race" }] });
    expect(run(h)).toMatchObject({ state: "done", endedBy: "draft" });
    expect(h.shuttle.view(KEY).next.kind).toBe("post");
    h.shuttle.onThreadActive(threadId);
    expect(run(h).state).toBe("done");
  });

  it("ends when its thread says so, finished without a draft or unable to finish, with its words", async () => {
    const { h, threadId } = await reviewing();
    await h.shuttle.endReview(threadId, KEY, { note: "The change is a revert; nothing to add.", failed: false });
    expect(run(h)).toMatchObject({ state: "done", endedBy: "thread", note: "The change is a revert; nothing to add." });
    expect(h.shuttle.view(KEY).next).toMatchObject({ kind: "review_done", inbox: true, why: "Standard review finished in \u201cReview acme/app#3\u201d without a draft for Shuttle. It says: The change is a revert; nothing to add." });
    expect(h.shuttle.activity(1)[0]!.text).toBe("\u201cReview acme/app#3\u201d finished its review of acme/app#3 without a draft: The change is a revert; nothing to add.");
    await expect(h.shuttle.endReview(threadId, KEY, { note: "Again", failed: false })).rejects.toThrow("The review of acme/app#3 in this thread is already over: it finished");
    await expect(h.shuttle.endReview("thr_other", KEY, { note: "Hm", failed: false })).rejects.toThrow("No review of acme/app#3 runs in this thread");

    const second = await reviewing();
    await second.h.shuttle.endReview(second.threadId, KEY, { note: "The checkout is missing its submodules.", failed: true });
    expect(second.h.shuttle.view(KEY).next).toMatchObject({ kind: "review_failed", label: "The review couldn\u2019t finish", why: "\u201cReview acme/app#3\u201d says: The checkout is missing its submodules." });
  });

  it("goes quiet only after hours with nothing happening in the thread or its child threads, and not while one waits on you", async () => {
    const { h, threadId } = await reviewing();
    await h.shuttle.onThreadIdle(threadId);
    h.clock.now += REVIEW_QUIET_MS + 1;
    // A critic is still at work, so the review is too, and its clock starts again.
    expect(await quiet(h)).toBe(0);
    expect(run(h).state).toBe("running");

    setStatus(h, "thr_critic1", { status: "idle" });
    setStatus(h, "thr_critic2", { status: "idle" });
    h.clock.now += REVIEW_QUIET_MS - 1;
    expect(await quiet(h)).toBe(0);
    h.clock.now += 2;
    setStatus(h, threadId, { waiting: true });
    expect(await quiet(h)).toBe(0);

    setStatus(h, threadId, { waiting: false });
    h.clock.now += REVIEW_QUIET_MS + 1;
    expect(await quiet(h)).toBe(1);
    expect(run(h)).toMatchObject({ state: "failed", endedBy: "quiet" });
    expect(h.shuttle.view(KEY).next).toMatchObject({
      kind: "review_failed", inbox: true, label: "The review went quiet",
      why: "Nothing happened in \u201cReview acme/app#3\u201d or its child threads for 2 hours, and it handed back no draft.",
    });
  });

  it("counts a hidden thread at work under the review thread, such as another plugin's, as the review at work", async () => {
    const { h, threadId } = await reviewing();
    setStatus(h, "thr_critic1", { status: "idle" });
    setStatus(h, "thr_critic2", { status: "idle" });
    h.port.addThread("thr_hidden", "Flares: Review acme/app#3", false, { status: "active", hidden: true });
    h.port.children.set(threadId, [...(h.port.children.get(threadId) ?? []), "thr_hidden"]);
    await h.shuttle.onThreadIdle(threadId);
    h.clock.now += REVIEW_QUIET_MS + 1;
    expect(await quiet(h)).toBe(0);
    expect(run(h).state).toBe("running");
    setStatus(h, "thr_hidden", { status: "idle" });
    h.clock.now += REVIEW_QUIET_MS + 1;
    expect(await quiet(h)).toBe(1);
  });

  it("does not end a review as quiet when a draft or new activity comes while bb is asked", async () => {
    for (const late of ["draft", "activity"] as const) {
      const { h, threadId } = await reviewing();
      setStatus(h, "thr_critic1", { status: "idle" });
      setStatus(h, "thr_critic2", { status: "idle" });
      h.clock.now += REVIEW_QUIET_MS + 1;
      const real = h.port.threadsById.bind(h.port);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      h.port.threadsById = async (ids) => {
        await held;
        return real(ids);
      };
      const sweep = quiet(h);
      if (late === "draft") await h.shuttle.saveDraft(threadId, KEY, { summary: "Late", verdict: "comment", findings: [] });
      else h.shuttle.onThreadActive("thr_critic1", threadId);
      release();
      expect(await sweep).toBe(0);
      expect(run(h)).toMatchObject(late === "draft" ? { state: "done", endedBy: "draft" } : { state: "running", endedBy: null });
      expect(h.shuttle.activity(5).some((e) => e.text.includes("went quiet"))).toBe(false);
    }
  });

  it("keeps a review running while bb cannot say whether it is at work, and logs that once an hour", async () => {
    const { h } = await reviewing();
    h.port.threadsById = async () => {
      throw new Error("bb is down");
    };
    h.clock.now += REVIEW_QUIET_MS + 1;
    for (let i = 0; i < 3; i++) {
      expect(await quiet(h)).toBe(0);
      h.clock.now += 30_000;
    }
    expect(run(h).state).toBe("running");
    expect(h.port.logs.filter((text) => text.includes("bb is down"))).toHaveLength(1);
    h.clock.now += 3_600_000;
    await quiet(h);
    expect(h.port.logs.filter((text) => text.includes("bb is down"))).toHaveLength(2);
  });

  it("asks bb's list whether a thread waits on you, since a single read of a thread does not say", async () => {
    const { h, threadId } = await reviewing();
    setStatus(h, "thr_critic1", { status: "idle" });
    setStatus(h, "thr_critic2", { status: "idle" });
    setStatus(h, threadId, { waiting: true });
    h.port.getThread = async (id) => ({ ...h.port.threads.get(id)!, waiting: false });
    h.clock.now += REVIEW_QUIET_MS + 1;
    expect(await quiet(h)).toBe(0);
    expect(run(h).state).toBe("running");
  });

  it("counts a grandchild at work, and an event from a child, as the review at work", async () => {
    const { h, threadId } = await reviewing();
    setStatus(h, "thr_critic1", { status: "idle" });
    setStatus(h, "thr_critic2", { status: "idle" });
    h.port.addThread("thr_judge", "Judge", false, { status: "active" });
    h.port.children.set("thr_critic2", ["thr_judge"]);
    h.clock.now += REVIEW_QUIET_MS + 1;
    expect(await quiet(h)).toBe(0);

    setStatus(h, "thr_judge", { status: "idle" });
    h.clock.now += REVIEW_QUIET_MS - 1000;
    h.shuttle.onThreadActive("thr_critic1", threadId);
    h.clock.now += 2000;
    expect(await quiet(h)).toBe(0);
    expect(run(h).state).toBe("running");

    // The judge's own events name only its parent, a critic; the critic's earlier event linked it to the review thread.
    h.shuttle.onThreadActive("thr_critic2", threadId);
    h.clock.now += REVIEW_QUIET_MS - 1000;
    h.shuttle.onThreadActive("thr_judge", "thr_critic2");
    await h.shuttle.onThreadIdle("thr_judge", "thr_critic2");
    h.clock.now += 2000;
    expect(await quiet(h)).toBe(0);
    expect(run(h).state).toBe("running");
  });

  it("runs again when a thread that failed or went quiet gets back to work, but not after a draft or after it ended the review", async () => {
    const { h, threadId } = await reviewing();
    await h.shuttle.onThreadFailed(threadId);
    expect(h.shuttle.view(KEY).next).toMatchObject({ kind: "review_failed", label: "The review thread failed" });
    h.shuttle.onThreadActive(threadId);
    expect(run(h)).toMatchObject({ state: "running", endedBy: null });
    expect(h.shuttle.activity(1)[0]!.text).toBe("\u201cReview acme/app#3\u201d is at work again, so its review of acme/app#3 is running again.");

    setStatus(h, "thr_critic1", { status: "idle" });
    setStatus(h, "thr_critic2", { status: "idle" });
    await h.shuttle.onThreadIdle(threadId);
    h.clock.now += REVIEW_QUIET_MS + 1;
    await quiet(h);
    expect(run(h).endedBy).toBe("quiet");
    h.shuttle.onThreadActive(threadId);
    expect(run(h).state).toBe("running");

    await h.shuttle.endReview(threadId, KEY, { note: "Done.", failed: false });
    h.shuttle.onThreadActive(threadId);
    expect(run(h)).toMatchObject({ state: "done", endedBy: "thread" });
  });

  it("runs again when a review a turn's end closed before the upgrade gets back to work soon after, but not long after", async () => {
    const { h, threadId } = await reviewing();
    const id = h.store.lastReview(h.store.prByKey(KEY)!.id)!.id;
    // As the old rule left it: done at the turn's end, with nothing saying why.
    const endAtTurn = () => (h.store as unknown as { db: Database.Database }).db.prepare("UPDATE reviews SET state = 'done', finished_at = ?, ended_by = NULL WHERE id = ?").run(h.clock.now, id);
    endAtTurn();
    h.clock.now += REVIEW_QUIET_MS - 1;
    h.shuttle.onThreadActive(threadId);
    expect(run(h).state).toBe("running");

    endAtTurn();
    h.clock.now += REVIEW_QUIET_MS;
    h.shuttle.onThreadActive(threadId);
    expect(run(h).state).toBe("done");
  });

  it("ends an older review of the PR still running when a newer one starts, in the same thread or another", async () => {
    const { h, threadId } = await reviewing();
    const prId = h.store.prByKey(KEY)!.id;
    await h.shuttle.review({ key: KEY });
    await h.shuttle.review({ key: KEY, newThread: true });
    const runs = h.store.reviewsOf(prId);
    expect(runs.map((r) => [r.thread_id === threadId, r.state, r.ended_by])).toEqual([[true, "done", "replaced"], [true, "done", "replaced"], [false, "running", null]]);
    setStatus(h, "thr_critic1", { status: "idle" });
    setStatus(h, "thr_critic2", { status: "idle" });
    h.clock.now += REVIEW_QUIET_MS + 1;
    expect(await quiet(h)).toBe(1);
    expect(h.shuttle.activity(20).filter((e) => e.text.includes("went quiet"))).toHaveLength(1);
  });

  it("tells the review thread how to end without a draft", async () => {
    const { h } = await reviewing();
    expect(h.port.spawned[0]!.prompt).toContain("Shuttle counts the review as running until then, even while you wait on child threads such as critics; if it ends without a draft, call shuttle_review_done for forge:acme/app#3 and say why.");
  });
});

/** What bb says when a thread's workspace could not be set up: thread.failed with no environment left. */
const SETUP_FAILED = { error: "Provisioning thread failed", environmentId: null };
/** bb's thread after that: in error, with no workspace. */
const setupFailed = (h: ReturnType<typeof harness>, id: string) => h.port.threads.set(id, { ...h.port.threads.get(id)!, status: "error", hasWorkspace: false });

describe("a review whose thread could not be set up", () => {
  it("starts again in a new thread, twice at most, then says it gave up", async () => {
    const h = harness(testConfig({ autoReview: NO_AUTO }));
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    const { threadId: first } = await h.shuttle.review({ key: KEY, model: "m2", note: "Look at the retry loop." });
    setupFailed(h, first);
    await h.shuttle.onThreadFailed(first, SETUP_FAILED);

    expect(h.port.spawned.map((s) => s.threadId)).toEqual([first, "thr_spawned2"]);
    const second = h.port.spawned[1]!;
    // The same review: the same prompt, with the run's own model and note, in a new thread.
    expect(second).toMatchObject({ title: "Review acme/app#3", model: "m2", prompt: h.port.spawned[0]!.prompt });
    expect(second.prompt).toContain("Note from me: Look at the retry loop.");
    expect(h.store.reviewsOf(h.store.prByKey(KEY)!.id).map((r) => [r.thread_id, r.state, r.ended_by, r.trigger])).toEqual([
      [first, "failed", "setup", "manual"],
      ["thr_spawned2", "running", null, "manual"],
    ]);
    expect(run(h)).toMatchObject({ state: "running", thread: expect.anything() });
    const texts = h.shuttle.activity(5).map((e) => e.text);
    expect(texts).toContain("The review of acme/app#3 starts again in a new thread (try 2 of 3): \u201cReview acme/app#3\u201d could not set up its workspace.");

    setupFailed(h, "thr_spawned2");
    await h.shuttle.onThreadFailed("thr_spawned2", SETUP_FAILED);
    expect(h.port.spawned).toHaveLength(3);
    setupFailed(h, "thr_spawned3");
    await h.shuttle.onThreadFailed("thr_spawned3", SETUP_FAILED);
    expect(h.port.spawned).toHaveLength(3);
    expect(h.shuttle.activity(1)[0]!.text).toBe("Shuttle stopped starting the review of acme/app#3 again: 3 threads in a row could not set up their workspaces. Start it again once the machine or environment provider works.");
    expect(h.shuttle.view(KEY).next).toMatchObject({
      kind: "review_failed", label: "The review thread couldn\u2019t be set up",
      why: "bb could not set up the workspace of \u201cReview acme/app#3\u201d, so the review never started. Shuttle tried 3 times, each in a new thread.",
    });
    // A thread Shuttle started again elsewhere stays over; the last one runs again if you get it to work yourself.
    h.shuttle.onThreadActive(first);
    h.shuttle.onThreadActive("thr_spawned3");
    expect(h.store.reviewsOf(h.store.prByKey(KEY)!.id).map((r) => r.state)).toEqual(["failed", "failed", "running"]);
  });

  it("tries an auto review again as an auto review that the daily limit doesn't count", async () => {
    const h = harness(testConfig({ autoReview: { ...NO_AUTO, enabled: true, maxPerDay: 1 } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    const first = h.port.spawned[0]!.threadId;
    setupFailed(h, first);
    await h.shuttle.onThreadFailed(first, SETUP_FAILED);
    expect(h.port.spawned).toHaveLength(2);
    expect(run(h)).toMatchObject({ trigger: "auto", state: "running" });
    expect(h.store.autoReviewsSince(0)).toBe(1);
  });

  it("leaves an auto review failed while automations are paused or auto review is off, and still tries a manual one", async () => {
    for (const stop of ["paused", "off"] as const) {
      const h = harness(testConfig({ autoReview: { ...NO_AUTO, enabled: true } }));
      await h.shuttle.sync();
      h.clock.now += 60_000;
      h.lists.review_requested = [pr(3)];
      await h.shuttle.sync();
      const first = h.port.spawned[0]!.threadId;
      if (stop === "paused") h.settings.pauseAutomations = true;
      else h.store.saveConfig(testConfig({ autoReview: NO_AUTO }));
      setupFailed(h, first);
      await h.shuttle.onThreadFailed(first, SETUP_FAILED);
      expect(h.port.spawned).toHaveLength(1);
      expect(run(h)).toMatchObject({ state: "failed", endedBy: "setup" });
      const why = stop === "paused" ? "automations are paused" : "auto review is off";
      expect(h.shuttle.activity(1)[0]!.text).toBe(`\u201cReview acme/app#3\u201d could not set up its workspace. Shuttle did not start the auto review of acme/app#3 again: ${why}.`);

      await h.shuttle.review({ key: KEY });
      const manual = h.port.spawned[1]!.threadId;
      setupFailed(h, manual);
      await h.shuttle.onThreadFailed(manual, SETUP_FAILED);
      expect(h.port.spawned).toHaveLength(3);
    }
  });

  it("is not tried again after an agent's failure, a newer review, or a PR that closed", async () => {
    const agent = await reviewing();
    await agent.h.shuttle.onThreadFailed(agent.threadId, { error: "The provider stopped", environmentId: "env_1" });
    expect(agent.h.port.spawned).toHaveLength(1);
    expect(run(agent.h)).toMatchObject({ state: "failed", endedBy: "failed" });

    const newer = await reviewing();
    await newer.h.shuttle.review({ key: KEY, newThread: true });
    await newer.h.shuttle.onThreadFailed(newer.threadId, SETUP_FAILED);
    expect(newer.h.port.spawned).toHaveLength(2);

    const closed = await reviewing();
    (closed.h.store as unknown as { db: Database.Database }).db.prepare("UPDATE prs SET state = 'closed' WHERE id = ?").run(closed.h.store.prByKey(KEY)!.id);
    await closed.h.shuttle.onThreadFailed(closed.threadId, SETUP_FAILED);
    expect(closed.h.port.spawned).toHaveLength(1);
  });

  it("says so when the new thread cannot start, and leaves the review failed", async () => {
    const { h, threadId } = await reviewing();
    h.port.spawnError = new Error("bb is restarting");
    await h.shuttle.onThreadFailed(threadId, SETUP_FAILED);
    expect(run(h)).toMatchObject({ state: "failed", endedBy: "setup" });
    expect(h.shuttle.activity(1)[0]!.text).toBe("\u201cReview acme/app#3\u201d could not set up its workspace, and the review of acme/app#3 could not start again in a new thread: bb is restarting");
  });

  it("Try again starts a new thread instead of sending to the one that has no workspace", async () => {
    const { h, threadId } = await reviewing();
    h.port.spawnError = new Error("bb is restarting");
    setupFailed(h, threadId);
    await h.shuttle.onThreadFailed(threadId, SETUP_FAILED);
    h.port.spawnError = null;
    const again = await h.shuttle.review({ key: KEY });
    expect(again.threadId).toBe("thr_spawned2");
    expect(h.port.sent).toEqual([]);
    expect(h.shuttle.activity(5).map((e) => e.text)).toContain("The review of acme/app#3 went to a new thread: \u201cReview acme/app#3\u201d could not take it (its workspace was never set up).");
  });
});
