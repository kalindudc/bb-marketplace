// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import { SpawnUnavailableError } from "../src/ports";
import { toSettings } from "../src/settings";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

const KEY = "forge:acme/app#3";
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

async function finishCleanup(h: Awaited<ReturnType<typeof reviewed>>["h"], threadId: string) {
  const prompt = [...h.port.sent].reverse().find((sent) => sent.threadId === threadId)!.text;
  const marker = prompt.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
  h.port.outputs.set(threadId, marker);
  h.shuttle.onThreadActive(threadId);
  await h.shuttle.onThreadIdle(threadId, null, marker);
}

describe("archiving Shuttle's review threads", () => {
  it("gives a posted review one cleanup turn before archiving it and its children", async () => {
    const { h, threadId, draftId } = await reviewed();
    expect(h.port.lifecycle).toEqual([]);
    await h.shuttle.submitReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent).toHaveLength(1);
    expect(h.port.sent[0]).toMatchObject({ threadId, options: { mode: "queue-if-active" } });
    expect(h.port.sent[0]!.text).toContain("temporary files");
    // Another idle event or sync is not proof the cleanup turn finished.
    await h.shuttle.onThreadIdle(threadId);
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent).toHaveLength(1);
    await finishCleanup(h, threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
    expect(archivedIds(h)).toEqual(["thr_critic1", "thr_critic2", threadId].sort());
    expect(lastEvent(h, "archived")).toBe("Archived the review thread \u201cReview acme/app#3\u201d and its 2 child threads: you posted its review.");
    expect(h.shuttle.view(KEY).reviewThread).toEqual({ threadId, title: "Review acme/app#3", archived: true });
    // A later sync finds nothing more to do.
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("checks a run again by its id rather than listing every run again", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    const listed = vi.spyOn(h.store, "unarchivedReviewRuns");
    await finishCleanup(h, threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier review's unconfirmed cleanup when a newer review in the same thread is discarded", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    expect(h.port.sent).toHaveLength(1);
    const firstMarker = h.port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    h.clock.now += 60_000;
    h.views[3] = pr(3, { head: "h2" });
    await h.shuttle.sync();
    const again = await h.shuttle.review({ key: KEY });
    expect(again.threadId).toBe(threadId);
    await h.shuttle.saveDraft(threadId, KEY, { summary: "Fixed", verdict: "comment", findings: [] });
    await h.shuttle.onThreadIdle(threadId);
    await h.shuttle.discardDraft(KEY, h.shuttle.detail(KEY).draft!.id);
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent.filter((sent) => sent.text.includes("[shuttle:review-cleanup:"))).toHaveLength(1);
    h.shuttle.onThreadActive(threadId);
    await h.shuttle.onThreadIdle(threadId, null, firstMarker);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("does not archive a reused thread that started work while its earlier cleanup's output was read", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    const firstMarker = h.port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    h.clock.now += 60_000;
    h.views[3] = pr(3, { head: "h2" });
    await h.shuttle.sync();
    await h.shuttle.review({ key: KEY });
    await h.shuttle.saveDraft(threadId, KEY, { summary: "Fixed", verdict: "comment", findings: [] });
    await h.shuttle.onThreadIdle(threadId);
    await h.shuttle.discardDraft(KEY, h.shuttle.detail(KEY).draft!.id);
    expect(h.port.lifecycle).toEqual([]);
    // The user starts a follow-up turn while Shuttle reads the output that confirms the earlier cleanup.
    h.port.threadOutput = async () => {
      h.port.threads.get(threadId)!.status = "active";
      return firstMarker;
    };
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
  });

  it("still gives cleanup when a draft posted and a newer draft of the same run is then discarded", async () => {
    const { h, threadId, draftId } = await reviewed();
    const adapter = h.shuttle.adapter("forge");
    const post = adapter.review.bind(adapter);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    adapter.review = async (...args) => { await held; return post(...args); };
    h.shuttle.queueReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    await h.shuttle.saveDraft(threadId, KEY, { summary: "One more", verdict: "comment", findings: [] });
    release();
    await h.shuttle.postsSettled();
    expect(h.store.draftById(draftId)).toMatchObject({ state: "posted" });
    expect(h.port.lifecycle).toEqual([]);
    await h.shuttle.discardDraft(KEY, h.shuttle.detail(KEY).draft!.id);
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent.at(-1)).toMatchObject({ threadId });
    expect(h.port.sent.at(-1)!.text).toContain("[shuttle:review-cleanup:");
    await finishCleanup(h, threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("waits for a thread that is still writing before sending its separate cleanup turn", async () => {
    const { h, threadId, draftId } = await reviewed();
    h.shuttle.onThreadActive(threadId);
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent).toEqual([]);
    await h.shuttle.onThreadIdle(threadId);
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent).toHaveLength(1);
    await finishCleanup(h, threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("appends the configurable cleanup instructions without replacing the built-in prompt", async () => {
    const { h, threadId, draftId } = await reviewed();
    const extra = "Use cortex_update to mark the review task done with a link to the posted review.";
    Object.assign(h.settings, toSettings({ reviewCleanupPrompt: `  ${extra}  ` }));
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    expect(h.port.sent[0]!.text).toContain(extra);
    expect(h.port.sent[0]!.text).toContain("temporary files");
    expect(toSettings({}).reviewCleanupPrompt).toBe("");
    await finishCleanup(h, threadId);
    expect(archivedIds(h)).toContain(threadId);
  });

  it("gives queued posts the same cleanup turn and never duplicates it during concurrent syncs", async () => {
    const { h, threadId, draftId } = await reviewed();
    h.shuttle.queueReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    await h.shuttle.postsSettled();
    await Promise.all([h.shuttle.archiveReviewThreads(), h.shuttle.archiveReviewThreads()]);
    expect(h.shuttle.posts()[0]!.state).toBe("posted");
    expect(h.port.sent).toHaveLength(1);
    expect(h.port.lifecycle).toEqual([]);
    await finishCleanup(h, threadId);
    expect(archivedIds(h)).toContain(threadId);
  });

  it("keeps a failed cleanup unarchived, even if the PR then merges", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    await h.shuttle.onThreadFailed(threadId, { error: "cleanup failed" });
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, status: "error" });
    h.views[3] = pr(3, { head: "h1", state: "merged" });
    await h.shuttle.lookup(KEY);
    await h.shuttle.closedSettled();
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.sent).toHaveLength(1);
    // A manually resumed cleanup can still finish it.
    await finishCleanup(h, threadId);
    expect(archivedIds(h)).toContain(threadId);
  });

  it("keeps a cleanup whose send failed available without blindly sending it again", async () => {
    const { h, threadId, draftId } = await reviewed();
    h.port.failSendTo.add(threadId);
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    await h.shuttle.sync();
    expect(h.shuttle.detail(KEY).draft).toBeNull();
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.logs.join("\n")).toContain("cleanup");
    expect(h.port.logs.join("\n")).toContain("thread is gone");
  });

  it("recovers a cleanup completion missed during a restart from the thread's output", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    const marker = h.port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    h.port.outputs.set(threadId, `Cleaned up.\n${marker}`);
    await h.shuttle.sync();
    expect(h.port.sent).toHaveLength(1);
    expect(archivedIds(h)).toContain(threadId);
  });

  it("waits for cleanup's child threads and queued messages before archiving", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    h.port.threads.set("thr_critic1", { ...h.port.threads.get("thr_critic1")!, status: "active" });
    await finishCleanup(h, threadId);
    expect(h.port.lifecycle).toEqual([]);
    h.port.threads.set("thr_critic1", { ...h.port.threads.get("thr_critic1")!, status: "idle" });
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, queuedMessageCount: 1 });
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([]);
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, queuedMessageCount: 0 });
    await h.shuttle.archiveReviewThreads();
    expect(archivedIds(h)).toContain(threadId);
  });

  it("does not send cleanup turns when automatic archiving is disabled", async () => {
    const { h, draftId } = await reviewed();
    h.settings.archiveReviewThreads = false;
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    await h.shuttle.sync();
    expect(h.port.sent).toEqual([]);
    expect(h.port.lifecycle).toEqual([]);
  });

  it("does not restart a failed review when its cleanup turn becomes active", async () => {
    const h = harness(testConfig({ servers: [WRITE_SERVER], autoReview: NO_AUTO }));
    h.answers.review = "";
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    const { threadId } = await h.shuttle.review({ key: KEY });
    await h.shuttle.onThreadFailed(threadId, { error: "review interrupted" });
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, status: "error" });
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "Reviewed manually", findings: [] });
    expect(h.port.sent).toHaveLength(1);
    h.shuttle.onThreadActive(threadId);
    expect(h.shuttle.view(KEY).lastReview!.state).toBe("failed");
    await finishCleanup(h, threadId);
    expect(archivedIds(h)).toContain(threadId);
  });

  it("rechecks new drafts after awaiting cleanup output", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    const marker = h.port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    h.port.threadOutput = async () => {
      await h.shuttle.saveDraft(threadId, KEY, { summary: "Revised review", verdict: "comment", findings: [] });
      return marker;
    };
    await h.shuttle.archiveReviewThreads();
    expect(h.shuttle.detail(KEY).draft!.summary).toBe("Revised review");
    expect(h.port.lifecycle).toEqual([]);
  });

  it("rechecks other open PR links after awaiting cleanup output", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    const marker = h.port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    h.views[4] = pr(4);
    await h.shuttle.lookup("forge:acme/app#4");
    h.port.threadOutput = async () => {
      await h.shuttle.link("forge:acme/app#4", threadId, "owner");
      return marker;
    };
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([]);
  });

  it.each(["owner", "archiving disabled"])("rechecks %s after awaiting cleanup output", async (change) => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.submitReview(KEY, { verdict: "comment", body: "ok", findings: [], draftId });
    const marker = h.port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    h.port.threadOutput = async () => {
      if (change === "owner") await h.shuttle.link(KEY, threadId, "owner");
      else h.settings.archiveReviewThreads = false;
      return marker;
    };
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([]);
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
    const two = (await h.shuttle.review({ key: "forge:acme/app#4" })).threadId;
    await h.shuttle.onThreadIdle(one);
    await h.shuttle.onThreadIdle(two);
    await h.shuttle.endReview(one, KEY, { note: "Read it in the thread.", failed: false });
    await h.shuttle.endReview(two, "forge:acme/app#4", { note: "Read it in the thread.", failed: false });
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
    h.clock.now += 60_000;
    h.views[3] = pr(3);
    await h.shuttle.submitReview(KEY, { verdict: "approve", body: "LGTM", findings: [] });
    expect(h.port.lifecycle).toEqual([]);
    await finishCleanup(h, one);
    expect(h.port.lifecycle).toEqual([`archive ${one}`]);
    expect(lastEvent(h, "archived")).toBe("Archived the review thread \u201cReview acme/app#3\u201d: you reviewed the PR.");
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

  it("archives a PR's review threads as soon as any read sees it merge, its draft unposted, without waiting for a sync", async () => {
    const { h, threadId } = await reviewed();
    h.views[3] = pr(3, { head: "h1", state: "merged" });
    // Opening the PR in Shuttle reads it from its server.
    await h.shuttle.lookup(KEY);
    await h.shuttle.closedSettled();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
    expect(archivedIds(h)).toEqual(["thr_critic1", "thr_critic2", threadId].sort());
    expect(lastEvent(h, "archived")).toBe("Archived the review thread \u201cReview acme/app#3\u201d and its 2 child threads: the PR merged.");
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("archives every review thread of a PR that closed, failed ones too", async () => {
    const { h, threadId } = await reviewed();
    const second = (await h.shuttle.review({ key: KEY, newThread: true })).threadId;
    await h.shuttle.onThreadFailed(second, { error: "the model refused" });
    h.port.threads.set(second, { ...h.port.threads.get(second)!, status: "error" });
    h.lists.review_requested = [];
    h.views[3] = pr(3, { head: "h1", state: "closed" });
    await h.shuttle.sync();
    expect(h.port.lifecycle.sort()).toEqual([`archive ${second}`, `archive ${threadId}`].sort());
  });

  it("leaves a merged PR's review thread while bb says it or a thread under it works, though Shuttle last heard it idle", async () => {
    const { h, threadId } = await reviewed();
    const setStatus = (id: string, status: string) => h.port.threads.set(id, { ...h.port.threads.get(id)!, status });
    setStatus(threadId, "active");
    h.views[3] = pr(3, { head: "h1", state: "merged" });
    await h.shuttle.lookup(KEY);
    await h.shuttle.closedSettled();
    expect(h.port.lifecycle).toEqual([]);
    setStatus(threadId, "idle");
    setStatus("thr_critic2", "active");
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([]);
    h.port.threads.set("thr_critic2", { ...h.port.threads.get("thr_critic2")!, status: "idle", waiting: true });
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([]);
    h.port.threads.set("thr_critic2", { ...h.port.threads.get("thr_critic2")!, waiting: false });
    // A critic's own helper at work holds it too: bb would archive it along with the rest.
    h.port.addThread("thr_helper", "Helper", false, { status: "active" });
    h.port.children.set("thr_critic1", ["thr_helper"]);
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([]);
    setStatus("thr_helper", "idle");
    await h.shuttle.archiveReviewThreads();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("waits for a hidden thread at work under the review thread, which bb lists only when asked, but never counts it as a critic", async () => {
    const { h, threadId, draftId } = await reviewed();
    h.port.addThread("thr_hidden", "Flares: Review acme/app#3", false, { status: "active", hidden: true });
    h.port.children.set(threadId, ["thr_critic1", "thr_critic2", "thr_hidden"]);
    expect((await h.port.childThreads(threadId)).map((t) => t.id)).toEqual(["thr_critic1", "thr_critic2"]);
    await h.shuttle.submitReview(KEY, { verdict: "changes", body: "One race", findings: [{ path: "a.go", line: 3, body: "Race" }], draftId });
    await h.shuttle.archiveReviewThreads();
    // Neither the cleanup turn nor the archive starts while the hidden thread works.
    expect(h.port.sent).toHaveLength(0);
    expect(h.port.lifecycle).toEqual([]);
    h.port.threads.set("thr_hidden", { ...h.port.threads.get("thr_hidden")!, status: "idle" });
    await h.shuttle.archiveReviewThreads();
    await finishCleanup(h, threadId);
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("leaves a merged PR's review thread that bb cannot answer for, or that is another open PR's agent", async () => {
    const { h, threadId } = await reviewed();
    const threadsById = h.port.threadsById.bind(h.port);
    h.port.threadsById = async () => {
      throw new Error("bb is restarting");
    };
    h.lists.review_requested = [];
    h.views[3] = pr(3, { head: "h1", state: "merged" });
    await h.shuttle.lookup(KEY);
    await h.shuttle.closedSettled();
    expect(h.port.lifecycle).toEqual([]);
    expect(h.port.logs.at(-1)).toContain("bb is restarting");
    h.port.threadsById = threadsById;

    // The review thread became the agent of another PR, still open.
    h.views[4] = pr(4);
    await h.shuttle.lookup("forge:acme/app#4");
    await h.shuttle.link("forge:acme/app#4", threadId, "owner");
    await h.shuttle.archiveReviewThreads();
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([]);
    // Once that PR merges too, the next sync finds the thread free.
    h.views[4] = pr(4, { state: "merged" });
    await h.shuttle.lookup("forge:acme/app#4");
    await h.shuttle.sync();
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
  });

  it("leaves a review that still runs when its PR merges, and archives its thread once it hands back its draft", async () => {
    const h = harness(testConfig({ servers: [WRITE_SERVER], autoReview: NO_AUTO }));
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    const { threadId } = await h.shuttle.review({ key: KEY });
    h.views[3] = pr(3, { state: "merged" });
    await h.shuttle.lookup(KEY);
    await h.shuttle.closedSettled();
    expect(h.port.lifecycle).toEqual([]);
    await h.shuttle.saveDraft(threadId, KEY, { summary: "Late", verdict: "comment", findings: [] });
    await h.shuttle.onThreadIdle(threadId);
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
    await finishCleanup(h, threadId);
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
    expect(lastEvent(h, "review")).toBe("Review of acme/app#3 started with Standard review in \u201cReview acme/app#3\u201d, brought back from the archive.");
    // The run in the brought-back thread is Shuttle's too, so it is archived when it is done.
    await h.shuttle.onThreadIdle(threadId);
    await h.shuttle.endReview(threadId, KEY, { note: "Nothing new since the last review.", failed: false });
    h.views[3] = pr(3, { head: "h2" });
    await h.shuttle.submitReview(KEY, { verdict: "approve", body: "LGTM", findings: [] });
    expect(h.port.lifecycle.at(-1)).toBe(`unarchive ${threadId}`);
    await finishCleanup(h, threadId);
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

  it("starts a new thread, without bringing the old one back, when bb removed the old one's machine", async () => {
    const { h, threadId, draftId } = await reviewed();
    await h.shuttle.discardDraft(KEY, draftId);
    h.port.threads.set(threadId, { ...h.port.threads.get(threadId)!, machineRemoved: true });
    // Until the new thread starts, nothing went anywhere, so nothing says it did.
    h.port.spawnError = new SpawnUnavailableError("no room for another machine");
    await expect(h.shuttle.review({ key: KEY })).rejects.toThrow("no room for another machine");
    expect(lastEvent(h, "revive_failed")).toBeUndefined();
    h.port.spawnError = null;
    expect((await h.shuttle.review({ key: KEY })).threadId).toBe("thr_spawned2");
    expect(h.port.lifecycle).toEqual([`archive ${threadId}`]);
    expect(lastEvent(h, "revive_failed")).toBe("The review of acme/app#3 went to a new thread: \u201cReview acme/app#3\u201d could not take it (bb removed its machine after it was archived).");
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
    expect(lastEvent(other.h, "revive_failed")).toBe("The review of acme/app#3 went to a new thread: \u201cReview acme/app#3\u201d could not take it (it runs on pi, and this review asks for claude-code).");

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
