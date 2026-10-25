// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

const KEY = "forge:shop/world#3";
const WRITE_SERVER = { ...TEST_SERVER, enabled: true, sep: "#" as const, commands: { ...TEST_SERVER.commands, comment: "c", review: "rv" } };
const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
const PRESET = { id: "std", name: "Standard review", default: true, skill: "", workspace: "worktree" as const, providerId: "pi", model: "gpt-6-sol", reasoningLevel: "xhigh", prompt: "Review {url} at {head}.{note}" };

/** Someone else's PR with a finished review: its thread has two critic children and a draft waiting. */
async function reviewed(presets = [PRESET]) {
  const h = harness(testConfig({ servers: [WRITE_SERVER], autoReview: NO_AUTO, presets }));
  h.answers.review = "";
  h.answers.comment = "";
  h.lists.review_requested = [pr(3, { head: "h1" })];
  await h.shuttle.sync();
  h.views[3] = pr(3, { head: "h1" });
  const { threadId } = await h.shuttle.review({ key: KEY });
  h.port.addThread("thr_critic1", "Jon · critic");
  h.port.addThread("thr_critic2", "Bob · critic");
  h.port.children.set(threadId, ["thr_critic1", "thr_critic2"]);
  await h.shuttle.saveDraft(threadId, KEY, { summary: "One race", verdict: "changes", findings: [{ severity: "high", path: "a.go", line: 3, body: "Race" }] });
  await h.shuttle.onThreadIdle(threadId);
  const draftId = h.shuttle.detail(KEY).draft!.id;
  return { h, threadId, draftId };
}

const archivedIds = (h: Awaited<ReturnType<typeof reviewed>>["h"]) => [...h.port.threads.values()].filter((t) => t.archived).map((t) => t.id).sort();
const lastEvent = (h: Awaited<ReturnType<typeof reviewed>>["h"], kind: string) => h.shuttle.activity().find((e) => e.kind === kind)?.text;

describe("archiving Shuttle's review threads", () => {
  it("archives the thread with its child threads once its review is posted, and not while its draft waits", async () => {
    const { h, threadId, draftId } = await reviewed();
    expect(h.port.lifecycle).toEqual([]);
    await h.shuttle.submitReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
    expect(archivedIds(h)).toEqual(["thr_critic1", "thr_critic2", threadId].sort());
    expect(lastEvent(h, "archived")).toBe("Archived the review thread \u201cReview shop/world#3\u201d and its 2 child threads: you posted its review.");
    expect(h.shuttle.view(KEY).reviewThread).toEqual({ threadId, title: "Review shop/world#3", archived: true });
    // A later sync finds nothing more to do.
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("waits for a thread that is still writing when its draft is posted, and archives it once it is idle", async () => {
    const { h, threadId, draftId } = await reviewed();
    h.shuttle.onThreadActive(threadId);
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    expect(h.port.lifecycle).toEqual([]);
    await h.shuttle.onThreadIdle(threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("archives on a discard, and Undo brings back the thread but not its children", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.discardDraft(KEY, draftId);
    expect(lastEvent(h, "archived")).toContain("you discarded its draft");
    await h.shuttle.restoreDraft(KEY, draftId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`, `unarchive ${threadId}`]);
    expect(archivedIds(h)).toEqual(["thr_critic1", "thr_critic2"]);
    expect(h.shuttle.view(KEY)).toMatchObject({ next: { kind: "post" }, reviewThread: { threadId, archived: false } });
  });

  it("archives a finished review without a draft once you review the PR, or once it merges", async () => {
    const h = harness(testConfig({ servers: [WRITE_SERVER], autoReview: NO_AUTO }));
    h.answers.review = "";
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    const one = (await h.shuttle.review({ key: KEY })).threadId;
    const two = (await h.shuttle.review({ key: "forge:shop/world#4" })).threadId;
    await h.shuttle.onThreadIdle(one);
    await h.shuttle.onThreadIdle(two);
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
    h.clock.now += 60_000;
    h.views[3] = pr(3);
    await h.shuttle.submitReview(KEY, { verdict: "approve", body: "LGTM", findings: [] });
    expect(h.port.lifecycle).toEqual([`archive ${one}`]);
    expect(lastEvent(h, "archived")).toBe("Archived the review thread \u201cReview shop/world#3\u201d: you reviewed the PR.");
    h.lists.review_requested = [pr(3)];
    h.views[4] = pr(4, { state: "merged" });
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([`archive ${one}`, `archive ${two}`]);
    expect(lastEvent(h, "archived")).toContain("the PR merged");
  });

  it("leaves a thread alone that waits on you, became the PR's agent, or that you picked yourself", async () => {
    const { h, threadId, draftId } = await reviewed();
    h.shuttle.onInteractionPending(threadId);
    await h.shuttle.discardDraft(KEY, draftId);
    expect(h.port.lifecycle).toEqual([]);
    await h.shuttle.onThreadIdle(threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);

    const picked = harness(testConfig({ servers: [WRITE_SERVER], autoReview: NO_AUTO }));
    picked.lists.review_requested = [pr(3)];
    await picked.shuttle.sync();
    picked.port.addThread("thr_mine", "My notes");
    await picked.shuttle.link(KEY, "thr_mine", "reference");
    await picked.shuttle.review({ key: KEY, threadId: "thr_mine" });
    await picked.shuttle.onThreadIdle("thr_mine");
    picked.views[3] = pr(3, { state: "closed" });
    picked.lists.review_requested = [];
    await picked.shuttle.sync();
    expect(picked.port.lifecycle).toEqual([]);
    expect(picked.shuttle.view(KEY).reviewThread).toBeNull();
  });

  it("does not archive again a thread you brought back yourself, until its next review", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.discardDraft(KEY, draftId);
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, archived: false });
    await h.shuttle.onThreadArchived(threadId);
    h.store.setThreadArchived(threadId, false);
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("archives nothing when the setting is off", async () => {
    const { h, draftId } = await reviewed();
    h.settings.archiveReviewThreads = false;
    await h.shuttle.discardDraft(KEY, draftId);
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
  });
});

describe("reviving a review thread for the PR's next review", () => {
  it("brings the archived thread back without its children, with the preset's model, instead of starting one", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    h.lists.review_requested = [pr(3, { head: "h2" })];
    await h.shuttle.sync();
    h.port.sent = [];
    expect(await h.shuttle.review({ key: KEY })).toEqual({ threadId, revived: true });
    expect(h.port.spawned).toHaveLength(1);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`, `unarchive ${threadId}`]);
    expect(archivedIds(h)).toEqual(["thr_critic1", "thr_critic2"]);
    expect(h.port.sent).toHaveLength(1);
    expect(h.port.sent[0]).toMatchObject({ threadId, options: { model: "gpt-6-sol", reasoningLevel: "xhigh" } });
    expect(h.port.sent[0]!.text).toContain("at h2.");
    expect(h.shuttle.view(KEY)).toMatchObject({ reviewThread: { threadId, archived: false }, lastReview: { threadId, state: "running", head: "h2" } });
    expect(lastEvent(h, "review")).toBe("Review of shop/world#3 started with Standard review in \u201cReview shop/world#3\u201d, brought back from the archive.");
    // The run in the brought-back thread is Shuttle's too, so it is archived when it is done.
    await h.shuttle.onThreadIdle(threadId);
    h.views[3] = pr(3, { head: "h2" });
    await h.shuttle.submitReview(KEY, { verdict: "approve", body: "LGTM", findings: [] });
    expect(h.port.lifecycle.at(-1)).toBe(`archive ${threadId}`);
  });

  it("asks bb to build the workspace again when it was removed after the archive", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.discardDraft(KEY, draftId);
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, canRestoreEnvironment: true });
    await h.shuttle.review({ key: KEY });
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`, `unarchive ${threadId}`, `restore ${threadId}`]);
    expect(h.port.sent.at(-1)!.threadId).toBe(threadId);
  });

  it("sends to a review thread that is not archived, as the last one's", async () => {
    const { h, threadId } = await reviewed();
    expect(await h.shuttle.review({ key: KEY })).toEqual({ threadId, revived: false });
    expect(h.port.spawned).toHaveLength(1);
    expect(h.port.lifecycle).toEqual([]);
  });

  it("starts a new thread when asked, when the old one is gone or runs another agent, or when it refuses the review", async () => {
    const asked = await reviewed();
    const fresh = await asked.h.shuttle.review({ key: KEY, newThread: true });
    expect(fresh.threadId).not.toBe(asked.threadId);
    expect(asked.h.shuttle.view(KEY).reviewThread?.threadId).toBe(fresh.threadId);

    const gone = await reviewed();
    gone.h.port.threads.delete(gone.threadId);
    expect((await gone.h.shuttle.review({ key: KEY })).threadId).toBe("thr_spawned2");

    const other = await reviewed([{ ...PRESET, id: "claude", default: false, providerId: "claude-code" }, PRESET]);
    expect((await other.h.shuttle.review({ key: KEY, presetId: "claude" })).threadId).toBe("thr_spawned2");
    expect(lastEvent(other.h, "revive_failed")).toBe("The review of shop/world#3 went to a new thread: \u201cReview shop/world#3\u201d could not take it (it runs on pi, and this review asks for claude-code).");

    const refused = await reviewed();
    await refused.h.shuttle.discardDraft(KEY, refused.draftId);
    refused.h.port.failSendTo.add(refused.threadId);
    expect((await refused.h.shuttle.review({ key: KEY })).threadId).toBe("thr_spawned2");
    // Brought back, refused, and put back in the archive.
    expect(refused.h.port.lifecycle).toEqual([`archive ${refused.threadId}`, `unarchive ${refused.threadId}`, `archive ${refused.threadId}`]);
    expect(refused.h.port.threads.get(refused.threadId)!.archived).toBe(true);
  });
});

describe("the 0.3.2 migration", () => {
  it("marks the threads Shuttle spawned for reviews, and not an owner thread a review reused", () => {
    const db = new Database(":memory:");
    const first = MIGRATIONS.indexOf("ALTER TABLE reviews ADD COLUMN own_thread INTEGER NOT NULL DEFAULT 0");
    expect(first).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, first)) db.exec(sql);
    db.exec("INSERT INTO links (pr_id, thread_id, role, created_at) VALUES (1, 'thr_review', 'review', 0), (1, 'thr_owner', 'owner', 0)");
    const run = db.prepare("INSERT INTO reviews (pr_id, thread_id, preset, trigger, head, state, created_at) VALUES (1, ?, 'Std', 'manual', 'h', 'done', ?)");
    run.run("thr_review", 1);
    run.run("thr_owner", 2);
    run.run("thr_review", 3);
    for (const sql of MIGRATIONS.slice(first)) db.exec(sql);
    expect(db.prepare("SELECT thread_id, own_thread, archived_at FROM reviews ORDER BY id").all()).toEqual([
      { thread_id: "thr_review", own_thread: 1, archived_at: null },
      { thread_id: "thr_owner", own_thread: 0, archived_at: null },
      { thread_id: "thr_review", own_thread: 1, archived_at: null },
    ]);
  });
});
