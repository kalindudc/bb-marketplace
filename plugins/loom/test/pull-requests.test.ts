import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { PostRow, ThreadRow } from "../src/db/store";
import type { HostOutput } from "../src/host-contract";
import { Engine } from "../src/engine";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText, onPrWriterIdle, resumePrAsks, unchangedFix } from "../src/pull-requests";
import type { LoomSettings } from "../src/record";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { deliverHandBacks } from "../src/slots";
import { blockTicket, endThread, requeueTicket, resumeEnding, specOf } from "../src/workers";
import { checkOutHead, makeCtx, makeEngine, reachApproved, seedProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

type Feedback = Partial<Extract<HostOutput<"prFeedback">, { outcome: "ok" }>>;
type FeedbackCheck = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>["checks"][number];

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const posts = () => h.store.posts(ticket().id);
const dataOf = (outcome: string) => posts().filter((post) => post.kind === "merge" && (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome).map((post) => ({ post, data: JSON.parse(post.data_json) as Record<string, any> }));
// A forge that reports no checks has no CI for Loom to rely on.
const pr = (more: Doc = {}) => (doc: Doc) => {
  doc.merge = { strategy: "pr", ...more };
  if (more.forge?.kind === "none" || (more.forge?.kind === "command" && more.forge.feedback === undefined)) doc.checks.ci = false;
};
const ask = () => askForPrTexts(h.ctx, project(), spec());
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const TEXT = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.", commit_message: "Add the order row mapper\n\nMaps each order to one CSV row." };

/** Approved, asked, handed in and opened: the pull request is open as one commit. */
async function openPr(more: Doc = {}): Promise<ThreadRow> {
  await seedProject(h, pr(more));
  const worker = await reachApproved(h);
  await ask();
  handInPrText(h.ctx, worker.thread_id!, TEXT);
  await queue();
  return worker;
}

/** The worker changes a file, the checks pass and a reviewer approves the fix. */
async function approveFix(worker: ThreadRow, change = true): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  if (change) {
    worktree.dirty = true;
    worktree.changed = ["src/model/a.ts", "src/model/b.ts"];
  }
  submit(h.ctx, worker.thread_id!, "Fixed what the review asked.");
  await settleChecks(h.ctx);
  if (!change) return;
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "The fix holds.");
  await settleReviews(h.ctx);
}

const changesRequested: Feedback = { items: [{ key: "review:1:a", kind: "review", author: "alice", bot: false, body: "Rename the column.", url: "https://github.com/acme/shop/pull/1#r1", state: "changes_requested", path: null, line: null }] };

describe("writing the pull request", () => {
  it("asks the worker once per head after approval, and opens nothing until loom_pr comes", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await ask();
    await ask();
    const asks = h.bb.sent(worker.thread_id!).filter((text) => text.includes("loom_pr"));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("Write its pull request and hand it in with loom_pr({ title, body, commit_message })");
    expect(asks[0]).toContain("follow your own instructions and skills for pull request descriptions and commit messages");
    await queue();
    expect(ticket().state).toBe("approved");
    expect(h.host.callsTo("push")).toEqual([]);
  });

  it("opens the pull request with the worker's title and description, as one commit with its message", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await ask();
    expect(handInPrText(h.ctx, worker.thread_id!, TEXT)).toContain("Loom opens the pull request now with your text");
    await queue();

    const branch = ticket().branch!;
    expect(h.host.callsTo("prCommit")).toEqual([{ repo: "/repo", remote: "origin", branch, base: "origin/main", head: "c1", message: TEXT.commit_message }]);
    expect(h.host.callsTo("push")).toEqual([{ repo: "/repo", remote: "origin", src: "sq1", branch }]);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ head: branch, title: TEXT.title, body: `${TEXT.body}\n\n<!-- loom:begin -->\nOpened by Loom for CSV-1.\n<!-- loom:end -->`, draft: true });
    expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL, pr_branch: branch, pushed_sha: "sq1", pushed_at: h.clock.t });
    expect(dataOf("pr_text")[0]!.data).toMatchObject({ by: "worker", fix: false, title: TEXT.title, body: TEXT.body, commit: TEXT.commit_message });
    expect(dataOf("pr_opened")[0]!.post.body).toBe(`Opened pull request ${URL} as 1 commit (sq1).`);
  });

  it("refuses loom_pr before Loom asks, without a title and a body for a new pull request, and a second time", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    expect(() => handInPrText(h.ctx, worker.thread_id!, TEXT)).toThrow("Loom has not asked you for a pull request");
    await ask();
    expect(() => handInPrText(h.ctx, worker.thread_id!, { commit_message: "Subject" })).toThrow("needs a title and a body");
    handInPrText(h.ctx, worker.thread_id!, TEXT);
    expect(() => handInPrText(h.ctx, worker.thread_id!, TEXT)).toThrow("already in");
  });

  it("nudges a worker whose turn ends without loom_pr, then uses Loom's template", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await ask();
    expect(await onPrWriterIdle(h.ctx, worker)).toBe(true);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("your turn ended without loom_pr");
    await onPrWriterIdle(h.ctx, worker);
    await queue();
    expect(h.host.callsTo("prCommit")[0]!.message).toBe("CSV-1: Order rows");
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: "CSV-1: Order rows", body: expect.stringContaining("Acceptance criteria:") });
    expect(dataOf("pr_text")[0]).toMatchObject({ post: { author_kind: "loom", body: expect.stringContaining("the worker ended its turn twice without loom_pr") }, data: { by: "loom" } });
  });

  it("uses the template after 30 minutes, and at once when the worker is gone", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await ask();
    h.clock.advance(29 * 60_000);
    await ask();
    expect(dataOf("pr_text")).toEqual([]);
    h.clock.advance(60_000);
    await ask();
    expect(dataOf("pr_text")[0]!.data.reason).toBe("the worker did not hand it in within 30 minutes");

    h = makeCtx();
    await seedProject(h, pr());
    const other = await reachApproved(h);
    await endThread(h.ctx, h.store.thread(other.id)!, "gone", { commit: false, move: null });
    await ask();
    expect(dataOf("pr_text")[0]!.data.reason).toBe("its worker is gone");
    void worker;
  });

  it("gives an open ask a fresh clock on resume, and asks a stopped worker again", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await ask();
    h.clock.advance(40 * 60_000);
    await resumePrAsks(h.ctx, project().id);
    expect(JSON.parse(ticket().pr_ask_json!).at).toBe(h.clock.t);
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    await resumePrAsks(h.ctx, project().id);
    expect(ticket().pr_ask_json).toBeNull();
    await ask();
    expect(h.bb.sent(worker.thread_id!).filter((text) => text.includes("hand it in with loom_pr"))).toHaveLength(2);
  });

  it('opens from the template without asking on describe = "loom", and pushes the branch as it is on squash = false', async () => {
    await seedProject(h, pr({ describe: "loom", squash: false }));
    const worker = await reachApproved(h);
    await ask();
    expect(h.bb.sent(worker.thread_id!).some((text) => text.includes("loom_pr"))).toBe(false);
    await queue();
    expect(h.host.callsTo("prCommit")).toEqual([]);
    expect(h.host.callsTo("push")[0]).toMatchObject({ src: "c1" });
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "c1" });
  });
});

describe("following the pull request", () => {
  it("reads its checks and feedback through gh every 5 minutes and keeps the counts for the ticket page", async () => {
    await openPr();
    h.host.feedback.set(URL, { checks: [{ key: "check:1", name: "lint", state: "passed", url: null }, { key: "check:2", name: "test", state: "pending", url: null }] });
    await poll();
    expect(h.host.callsTo("prBatch")).toEqual([{ repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [1], feedback: true }]);
    expect(h.host.callsTo("prFeedback")).toEqual([]);
    expect(h.host.callsTo("prState")).toEqual([]);
    expect(JSON.parse(ticket().pr_status_json!)).toMatchObject({ passed: 1, pending: 1, failed: 0, at: h.clock.t });
    expect(JSON.parse(ticket().pr_meta_json!)).toEqual({ at: h.clock.t, draft: true, review: null, base: "main", mergeable: null, state: "OPEN" });
    expect(ticket().state).toBe("pr_open");
  });

  it("reads the feedback once per poll, falls back on no other read when GitHub fails it, and starts the fix round once a read succeeds", async () => {
    await openPr();
    h.host.feedback.set(URL, changesRequested);
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: gh: HTTP 502", transient: "server" }];
    await poll();
    expect(h.host.callsTo("prBatch").filter((call) => call.feedback)).toHaveLength(1);
    expect(h.host.callsTo("prState")).toEqual([]);
    expect(h.host.callsTo("prFeedback")).toEqual([]);
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0, pr_status_json: null });
    expect(JSON.parse(ticket().pr_poll_json!)).toMatchObject({ failures: 1 });

    await poll();
    expect(h.host.callsTo("prBatch").filter((call) => call.feedback)).toHaveLength(2);
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1, pr_poll_json: null });
  });

  it("waits out a feedback read that could not reach GitHub for the whole host, and starts the fix round once a read succeeds", async () => {
    await openPr();
    h.host.feedback.set(URL, changesRequested);
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com", transient: "network" }];
    await poll();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0, pr_status_json: null, pr_poll_json: null });
    expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ delayMs: 5 * 60_000, network: { failures: 1 } });
    expect(h.host.callsTo("prFeedback")).toEqual([]);

    await poll();
    expect(h.host.callsTo("prBatch").filter((call) => call.feedback)).toHaveLength(2);
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(h.ctx.forgeBackoffs.has("github.com")).toBe(false);
  });

  it("waits out a forge's feedback command that could not reach its host, backing off that host only", async () => {
    const DELTA = "https://delta.shopify.io/shop/world/pull/2313251";
    await openPr({ forge: { kind: "command", open: "delta open", state: "delta state", feedback: "delta feedback" } });
    h.store.updateTicket(ticket().id, { pr_url: DELTA });
    h.host.feedback.set(DELTA, changesRequested);
    h.host.scripted.prFeedback = [{ outcome: "unavailable", message: "The forge's feedback command failed (exit 1): Error: GET https://delta.shopify.io/api/v3/repos/shop/world/pulls/2313251\n\nCaused by:\n    2: dns error", transient: "network" }];
    await poll();
    expect(h.host.callsTo("prFeedback")).toHaveLength(1);
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });
    expect(h.ctx.forgeBackoffs.get("delta.shopify.io")).toMatchObject({ network: { failures: 1 } });
    expect(h.ctx.forgeBackoffs.has("github.com")).toBe(false);

    await poll();
    expect(h.host.callsTo("prFeedback")).toHaveLength(2);
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(h.ctx.forgeBackoffs.has("delta.shopify.io")).toBe(false);
  });

  it("holds a failed check while others run, until 30 minutes after the push", async () => {
    await openPr();
    h.host.feedback.set(URL, { checks: [{ key: "check:1", name: "lint", state: "failed", url: "https://ci/1" }, { key: "status:reviews", name: "reviews", state: "pending", url: null }] });
    await poll();
    expect(ticket().state).toBe("pr_open");
    h.clock.advance(20 * 60_000);
    await poll();
    expect(ticket().state).toBe("working");
    expect(dataOf("pr_feedback")[0]!.data).toMatchObject({ round: 1, checks: [{ name: "lint", url: "https://ci/1" }], items: [] });
  });

  it("sends no failed check back on a repo whose CI Loom ignores, and still sends its reviews and keeps the counts", async () => {
    await seedProject(h, (doc) => ((doc.merge = { strategy: "pr" }), (doc.checks.ci = false)));
    const worker = await reachApproved(h);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, TEXT);
    await queue();
    h.host.feedback.set(URL, { checks: [{ key: "check:1", name: "lint", state: "failed", url: "https://ci/1" }] });
    await poll();
    h.clock.advance(40 * 60_000);
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });
    expect(JSON.parse(ticket().pr_status_json!)).toMatchObject({ failed: 1 });
    expect(dataOf("pr_feedback")).toEqual([]);

    h.host.feedback.set(URL, { ...changesRequested, checks: [{ key: "check:1", name: "lint", state: "failed", url: "https://ci/1" }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(dataOf("pr_feedback")[0]!.data).toMatchObject({ checks: [], items: [{ author: "alice" }] });
  });

  it("holds a failed check only as long as Loom's checksSettleMinutes setting says", async () => {
    h.ctx.checksSettleMs = () => 10 * 60_000;
    await openPr();
    h.host.feedback.set(URL, { checks: [{ key: "check:1", name: "lint", state: "failed", url: "https://ci/1" }, { key: "status:reviews", name: "reviews", state: "pending", url: null }] });
    await poll();
    expect(ticket().state).toBe("pr_open");
    await poll();
    expect(ticket().state).toBe("working");
  });

  it("reads the settings through the engine: 30, 5 and 75 when they are not set", () => {
    const store = h.store;
    const engine = (settings?: () => LoomSettings) => new Engine({ store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects, ...(settings === undefined ? {} : { settings }) });
    expect(engine().ctx.checksSettleMs!()).toBe(30 * 60_000);
    expect(engine().ctx.checksQueuedMinutes!()).toBe(5);
    expect(engine().ctx.checksNearDonePercent!()).toBe(75);
    const set = engine(() => ({ doneHook: "", doneRecord: "summary", checksSettleMinutes: 45, checksQueuedMinutes: 0, checksNearDonePercent: 90 })).ctx;
    expect([set.checksSettleMs!(), set.checksQueuedMinutes!(), set.checksNearDonePercent!()]).toEqual([45 * 60_000, 0, 90]);
  });

  describe("which pending checks hold the failed ones", () => {
    const lint = { key: "check:1", name: "lint", state: "failed", url: "https://ci/1", started: true } as const;
    const check = (key: string, name: string, more: Partial<FeedbackCheck> = {}): FeedbackCheck => ({ key, name, state: "pending", url: null, started: true, ...more });
    const skippedOf = () => dataOf("pr_feedback")[0]!.data.skipped;
    /** The time of the next poll, which advances the clock by 5 minutes. */
    const nextPoll = () => h.clock.t + 5 * 60_000;

    it("stops waiting for a check still queued 5 minutes after the push, and tells the worker it did not wait for it", async () => {
      const worker = await openPr();
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "e2e", { started: false })] });
      await poll();
      expect(ticket().state).toBe("working");
      expect(skippedOf()).toEqual([{ name: "e2e", url: null, why: "queued", minutes: 5 }]);
      expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Still pending; Loom did not wait for them, so their results are not in yet:\n- e2e: still queued after 5 minutes");
      expect(posts().at(-1)!.body).toContain("- e2e: still queued after 5 minutes");
    });

    it("counts a queued check that appears on a later reading from that reading", async () => {
      await openPr();
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "build")] });
      await poll();
      expect(ticket().state).toBe("pr_open");
      h.host.feedback.set(URL, { checks: [lint, { ...check("check:2", "build"), state: "passed" }, check("check:3", "e2e", { started: false })] });
      await poll();
      expect(ticket().state).toBe("pr_open");
      expect(JSON.parse(ticket().pr_status_json!).queued).toEqual({ "check:3": h.clock.t });
      await poll();
      expect(ticket().state).toBe("working");
      expect(skippedOf()).toEqual([{ name: "e2e", url: null, why: "queued", minutes: 5 }]);
    });

    it("takes the queued limit from Loom's setting, and the spec's merge.checks_queued_minutes over it; 0 waits until the settle time", async () => {
      h.ctx.checksQueuedMinutes = () => 15;
      await openPr();
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "e2e", { started: false })] });
      await poll();
      await poll();
      expect(ticket().state).toBe("pr_open");
      await poll();
      expect(ticket().state).toBe("working");
      expect(skippedOf()).toEqual([{ name: "e2e", url: null, why: "queued", minutes: 15 }]);

      h = makeCtx();
      h.ctx.checksQueuedMinutes = () => 15;
      await openPr({ checks_queued_minutes: 0 });
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "e2e", { started: false })] });
      for (let index = 0; index < 5; index += 1) await poll();
      expect(ticket().state).toBe("pr_open");
      await poll();
      expect(ticket().state).toBe("working");
      expect(skippedOf()).toEqual([{ name: "e2e", url: null, why: "settled", minutes: 30 }]);
    });

    it("waits for a running GitHub Actions job only once 75% of its steps are done", async () => {
      await openPr();
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "test", { steps: { done: 3, total: 4 } })] });
      await poll();
      expect(ticket().state).toBe("pr_open");
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "test", { steps: { done: 1, total: 4 } })] });
      await poll();
      expect(ticket().state).toBe("working");
      expect(skippedOf()).toEqual([{ name: "test", url: null, why: "running", percent: 25 }]);
    });

    it("measures a running check against the median of its earlier passed runs on the same repository, and stops waiting for one past twice that", async () => {
      h.store.addCheckDurations("https://github.com/acme/shop", [8, 10, 12].map((minutes, index) => ({ name: "test", key: `check:old${index}`, durationMs: minutes * 60_000, at: index })));
      await openPr();
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "test", { startedAt: nextPoll() - 8 * 60_000 })] });
      await poll();
      expect(ticket().state).toBe("pr_open");
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "test", { startedAt: nextPoll() - 21 * 60_000 })] });
      await poll();
      expect(ticket().state).toBe("working");
      expect(skippedOf()).toEqual([{ name: "test", url: null, why: "overrun", percent: 210 }]);
    });

    it("keeps how long each passed check took, once per run", async () => {
      await openPr();
      const passed = { ...check("check:2", "test", { startedAt: 1_000, completedAt: 1_000 + 9 * 60_000 }), state: "passed" as const };
      h.host.feedback.set(URL, { checks: [passed, { ...check("check:3", "lint"), state: "passed" }] });
      await poll();
      await poll();
      expect(h.store.checkDurations("https://github.com/acme/shop", ["test", "lint"], 5)).toEqual(new Map([["test", [9 * 60_000]]]));
    });

    it("prefers the forge's own progress, and the spec's merge.checks_near_done_percent over Loom's setting; 0 waits for every running check", async () => {
      h.ctx.checksNearDonePercent = () => 95;
      await openPr({ checks_near_done_percent: 80 });
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "test", { progress: 85, steps: { done: 1, total: 4 } })] });
      await poll();
      expect(ticket().state).toBe("pr_open");

      h = makeCtx();
      await openPr({ checks_near_done_percent: 0 });
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "test", { progress: 5 })] });
      await poll();
      expect(ticket().state).toBe("pr_open");
    });

    it("keeps waiting for a running check it cannot measure and for a commit status, until the settle time", async () => {
      await openPr();
      h.host.feedback.set(URL, { checks: [lint, check("check:2", "deploy"), check("status:reviews", "reviews", { started: null })] });
      for (let index = 0; index < 5; index += 1) await poll();
      expect(ticket().state).toBe("pr_open");
      await poll();
      expect(skippedOf()).toEqual([
        { name: "deploy", url: null, why: "settled", minutes: 30 },
        { name: "reviews", url: null, why: "settled", minutes: 30 },
      ]);
    });
  });

  it("asks the worker to sign every comment it posts on the pull request with Loom's commentSignature setting", async () => {
    h.ctx.commentSignature = () => "<sub>Posted by Loom</sub>";
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain("Loom ends each reply with a blank line and this line:\n  <sub>Posted by Loom</sub>");
  });

  it("asks for no signature when the setting is empty", async () => {
    h.ctx.commentSignature = () => "  ";
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain("with loom_pr_reply({ item, text, resolve }), naming it by the key the fix round's message gives it, never with the forge's CLI");
    expect(message).not.toContain("Loom ends each reply");
  });

  it("reads the signature through the engine, Posted by Loom when it is not set", () => {
    const store = h.store;
    const engine = (settings?: () => { doneHook: string; doneRecord: string; commentSignature?: string }) => new Engine({ store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects, ...(settings === undefined ? {} : { settings }) });
    expect(engine().ctx.commentSignature!()).toBe("Posted by Loom");
    expect(engine(() => ({ doneHook: "", doneRecord: "summary", commentSignature: "Sent by an agent for me" })).ctx.commentSignature!()).toBe("Sent by an agent for me");
  });

  it("starts a fix round with reviews, threads and people's comments, leaves out bots' comments and the author's own, and sends each item once", async () => {
    const worker = await openPr();
    const items: Feedback["items"] = [
      changesRequested.items![0]!,
      { key: "thread:T1:9", kind: "thread", author: "binks", bot: true, body: "binks: The regex is unanchored.", url: null, state: null, path: "src/a.ts", line: 4 },
      { key: "comment:5:x", kind: "comment", author: "terraform-actuator", bot: true, body: "Plan: 1 to change.", url: null, state: null, path: null, line: null },
      { key: "comment:6:y", kind: "comment", author: "kalindudc", bot: false, body: "Answered above.", url: null, state: null, path: null, line: null },
      { key: "review:2:b", kind: "review", author: "bob", bot: false, body: "LGTM", url: null, state: "approved", path: null, line: null },
    ];
    h.host.feedback.set(URL, { items });
    await poll();

    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain("needs fixes (fix round 1; 1 of the 5 the pull request may start)");
    expect(message).toContain("Rename the column.");
    expect(message).toContain("Review thread on src/a.ts:4, last from binks");
    expect(message).not.toContain("Plan: 1 to change.");
    expect(message).toContain("- Review by alice (changes requested) (https://github.com/acme/shop/pull/1#r1), key `review:1:a`:");
    expect(message).toContain("Review thread on src/a.ts:4, last from binks, key `thread:T1:9`:");
    expect(message).toContain("Answer a review, a review thread or a comment on the pull request with loom_pr_reply");
    expect(dataOf("pr_feedback")[0]!.data).toMatchObject({ round: 1, human: false, ignored: { bots: 1, own: 1 } });
    expect(JSON.parse(ticket().pr_seen_json)).toEqual(expect.arrayContaining(items.map((item) => item.key)));

    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
    await queue();
    h.host.feedback.set(URL, { head: "sq2", items });
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1 });
  });

  it("blocks a fix round whose pull request merged into another branch while the worker fixed it, and pushes nothing", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
    const pushes = h.host.callsTo("push").length;
    h.host.prStates.set(URL, "MERGED");
    h.host.prMeta.set(URL, { base: "loom/csv/csv-0" });
    await queue();
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "Its pull request merged into the branch loom/csv/csv-0, not main, so its change is not on main. Put this change on main again." });
    expect(JSON.parse(ticket().pr_meta_json!)).toMatchObject({ state: "MERGED", base: "loom/csv/csv-0" });
    expect(dataOf("merged_elsewhere")).toHaveLength(1);
    expect(h.host.callsTo("push")).toHaveLength(pushes);
  });

  it("reads a command forge's base through its feedback command before a fix round's push, so a merge elsewhere blocks there too", async () => {
    const worker = await openPr({ forge: { kind: "command", open: "review open", state: "review state", feedback: "review feedback --json" } });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
    const reads = h.host.callsTo("prFeedback").length;
    h.host.prStates.set(URL, "MERGED");
    h.host.feedback.set(URL, { ...changesRequested, base: "loom/csv/csv-0" });
    await queue();
    expect(h.host.callsTo("prFeedback")).toHaveLength(reads + 1);
    expect(h.host.callsTo("prState")).toEqual([]);
    expect(ticket()).toMatchObject({ state: "blocked" });
    expect(dataOf("merged_elsewhere")).toHaveLength(1);
  });

  it("forgets what it read of a pull request it let go of once the ticket is requeued, and keeps it for one still open", async () => {
    await openPr();
    await poll();
    expect(ticket().pr_meta_json).not.toBeNull();
    h.store.updateTicket(ticket().id, { state: "blocked", blocked_reason: "Stuck." });
    await requeueTicket(h.ctx, "CSV-1", { note: "Again.", actor: "human", author: "human" });
    expect(ticket().pr_meta_json).not.toBeNull();
    h.store.updateTicket(ticket().id, { state: "blocked", blocked_reason: "Closed.", pushed_sha: null, pr_branch: null });
    await requeueTicket(h.ctx, "CSV-1", { note: "Again.", actor: "human", author: "human" });
    expect(ticket().pr_meta_json).toBeNull();
  });

  it("pushes an approved fix as one more commit on the pull request, after checking it is open, and opens no other pull request", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    const fixAsk = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(fixAsk).toContain("fix round 1 is approved. Write its commit message and hand it in with loom_pr({ commit_message })");
    expect(() => handInPrText(h.ctx, worker.thread_id!, { commit_message: " " })).toThrow("commit_message is empty");
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column\n\nAs alice asked." });
    await queue();

    // The check before the push is one GitHub read of this pull request alone, for its state and its base.
    expect(h.host.callsTo("prBatch").filter((call) => !call.feedback)).toEqual([{ repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [1], feedback: false }]);
    expect(h.host.callsTo("prState")).toEqual([]);
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ message: "Rename the column\n\nAs alice asked.", pushed: "sq1" });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ src: "sq2", branch: ticket().pr_branch });
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL, pushed_sha: "sq2", pr_status_json: null });
    expect(dataOf("pr_pushed")[0]!.post.body).toBe(`Pushed fix round 1 to ${URL} as 1 commit (sq2).`);
  });

  describe("asking the reviewers to review again", () => {
    const carol = { key: "thread:T2:3", kind: "thread" as const, author: "carol", bot: false, body: "carol: Why a Set here?", url: null, state: null, path: "src/b.ts", line: 9 };
    const pushFix = async (worker: ThreadRow) => {
      await approveFix(worker);
      await ask();
      handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
      await queue();
    };

    it("asks the people whose reviews and review threads the fix answered, once the fix is pushed, and not bots, commenters or approvers", async () => {
      const worker = await openPr();
      h.host.feedback.set(URL, {
        items: [
          changesRequested.items![0]!,
          { key: "thread:T1:9", kind: "thread", author: "binks", bot: true, body: "binks: The regex is unanchored.", url: null, state: null, path: "src/a.ts", line: 4 },
          carol,
          { key: "comment:7:z", kind: "comment", author: "dave", bot: false, body: "Can this ship today?", url: null, state: null, path: null, line: null },
          { key: "review:2:b", kind: "review", author: "bob", bot: false, body: "LGTM", url: null, state: "approved", path: null, line: null },
        ],
      });
      await poll();
      expect(dataOf("pr_feedback")[0]!.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ author: "binks", bot: true }), expect.objectContaining({ author: "alice", bot: false })]));
      expect(h.host.callsTo("prRequestReview")).toEqual([]);

      await pushFix(worker);
      expect(h.host.callsTo("prRequestReview")).toEqual([{ repo: "/repo", url: URL, reviewers: ["alice", "carol"] }]);
      expect(ticket().state).toBe("pr_open");
      expect(dataOf("review_requested")[0]).toMatchObject({ post: { body: "Asked alice and carol to review the pull request again." }, data: { url: URL, round: 1, requested: ["alice", "carol"], failed: [] } });
    });

    it("asks only the reviewers of the rounds since Loom last pushed or found nothing to push", async () => {
      const worker = await openPr();
      h.host.feedback.set(URL, changesRequested);
      await poll();
      await approveFix(worker, false);
      expect(ticket().state).toBe("pr_open");
      expect(h.host.callsTo("prRequestReview")).toEqual([]);

      h.host.feedback.set(URL, { items: [changesRequested.items![0]!, carol] });
      await poll();
      await pushFix(worker);
      expect(h.host.callsTo("prRequestReview").map((call) => call.reviewers)).toEqual([["carol"]]);

      h.host.feedback.set(URL, { head: "sq2", items: [changesRequested.items![0]!, { ...carol, key: "thread:T2:4" }, { ...changesRequested.items![0]!, key: "review:3:c", body: "Also the header." }] });
      await poll();
      await pushFix(worker);
      expect(h.host.callsTo("prRequestReview").map((call) => call.reviewers)).toEqual([["carol"], ["carol", "alice"]]);
    });

    it("asks no one after a round of failed checks alone, or the human's reply, or on a command forge", async () => {
      const worker = await openPr();
      h.host.feedback.set(URL, { checks: [{ key: "check:9", name: "lint", state: "failed", url: null }] });
      h.clock.advance(31 * 60_000);
      await poll();
      expect(ticket().state).toBe("working");
      await pushFix(worker);
      expect(dataOf("pr_pushed")).toHaveLength(1);
      expect(h.host.callsTo("prRequestReview")).toEqual([]);

      h = makeCtx();
      const commandWorker = await openPr({ forge: { kind: "command", open: "review open", state: "review state", feedback: "review feedback --json" } });
      h.host.feedback.set(URL, changesRequested);
      await poll();
      await pushFix(commandWorker);
      expect(dataOf("pr_pushed")).toHaveLength(1);
      expect(h.host.callsTo("prRequestReview")).toEqual([]);
    });

    it("posts whom it could not ask, and the fix stays pushed", async () => {
      const worker = await openPr();
      h.host.feedback.set(URL, { items: [changesRequested.items![0]!, carol] });
      await poll();
      h.host.scripted.prRequestReview = [{ outcome: "ok", requested: ["alice"], failed: [{ login: "carol", message: "Reviews may only be requested from collaborators. (HTTP 422)" }] }];
      await pushFix(worker);
      expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
      expect(dataOf("review_requested")[0]!.post.body).toBe("Asked alice to review the pull request again.\n\nLoom could not ask carol to review it again: Reviews may only be requested from collaborators. (HTTP 422)");

      h.host.feedback.set(URL, { head: "sq2", items: [{ ...carol, key: "thread:T2:5" }] });
      await poll();
      h.host.errors.prRequestReview = new Error("unknown method prRequestReview");
      await pushFix(worker);
      expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq3" });
      expect(dataOf("review_request_failed")[0]).toMatchObject({
        post: { body: "Loom could not ask carol to review the pull request again: unknown method prRequestReview" },
        data: { requested: [], failed: [{ login: "carol", message: "unknown method prRequestReview" }] },
      });
    });
  });

  it("tells the reviewer of a fix what the pull request's feedback asked", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
    worktree.dirty = true;
    submit(h.ctx, worker.thread_id!, "Renamed it.");
    await settleChecks(h.ctx);
    await spawnReviewers(h.ctx, project(), spec());
    const brief = h.bb.callsTo("spawnThread").at(-1)![0] as { prompt: string; detail?: string };
    expect(`${brief.prompt}\n${brief.detail ?? ""}`).toContain("## Pull request feedback");
    expect(`${brief.prompt}\n${brief.detail ?? ""}`).toContain("Rename the column.");
  });

  it("goes back to pr_open with no checks, review or push when a fix round changes nothing", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    const execs = h.host.callsTo("exec").length;
    await approveFix(worker, false);
    expect(ticket().state).toBe("pr_open");
    expect(h.host.callsTo("exec")).toHaveLength(execs);
    expect(dataOf("pr_unchanged")[0]!.post.body).toContain("changed nothing for fix round 1");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("nothing changed since the pull request's last commit");
  });

  describe("commits someone else pushed to the pull request's branch", () => {
    /** A fix round approved and its text handed in; meanwhile someone pushed theirs1 on top of Loom's sq1. */
    async function fixWithForeignTip(): Promise<ThreadRow> {
      const worker = await openPr();
      h.host.feedback.set(URL, changesRequested);
      await poll();
      await approveFix(worker);
      await ask();
      handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
      h.host.foreign.set(ticket().pr_branch!, "theirs1");
      h.host.ancestry.add("sq1..theirs1");
      return worker;
    }

    it("tells a worker on the project's machine to merge them itself at the start of a fix round", async () => {
      const worker = await openPr();
      h.host.foreign.set(ticket().pr_branch!, "theirs1");
      h.host.feedback.set(URL, { ...changesRequested, head: "theirs1" });
      await poll();
      expect(ticket()).toMatchObject({ state: "working", pushed_sha: "sq1" });
      expect(h.bb.sent(worker.thread_id!).at(-1)).toContain(`git fetch origin ${ticket().pr_branch}\` and \`git merge FETCH_HEAD\``);
      expect(h.host.callsTo("mergeOnto")).toEqual([]);
    });

    it("merges them into the worker's branch before it pushes the fix, against its last push, and runs the checks on the result", async () => {
      const worker = await fixWithForeignTip();
      const worktree = `/wt/${worker.environment_id}`;
      const head = ticket().head_sha!;
      const execs = h.host.callsTo("exec").length;
      await queue();

      expect(h.host.callsTo("fetchTip").at(-1)).toEqual({ repo: "/repo", remote: "origin", branch: ticket().pr_branch, base: "main", ref: "refs/loom/csv/csv-1/tip" });
      expect(h.host.callsTo("mergeOnto")).toEqual([{ repo: "/repo", head, ref: "theirs1", base: "sq1", message: "Merge the new commits on the pull request's branch into CSV-1 (Loom)", refs: [] }]);
      const merged = ticket().head_sha!;
      expect(merged).toMatch(/^lm/u);
      expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree, sha: merged });
      expect(h.host.callsTo("exec").length).toBeGreaterThan(execs);
      expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: merged, message: "Rename" });
      expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
      expect(dataOf("restacked").at(-1)!.data).toMatchObject({ tip: "theirs1", sha: merged });
      expect(dataOf("pr_pushed")).toHaveLength(1);
      expect(h.host.callsTo("push")).toHaveLength(2);
    });

    it("sends a conflict back to the worker, who merges the tip Loom fetched", async () => {
      const worker = await fixWithForeignTip();
      h.host.scripted.mergeOnto = [{ outcome: "conflict", files: ["src/model/a.ts"], sha: "lmx", tree: "lmx-tree" }];
      await queue();
      expect(ticket()).toMatchObject({ state: "working", pushed_sha: "sq1" });
      expect(dataOf("conflict").at(-1)!.data).toMatchObject({ files: ["src/model/a.ts"], tip: "theirs1" });
      expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("git merge --no-edit refs/loom/csv/csv-1/tip");
      expect(h.host.callsTo("resetHard")).toEqual([]);
      expect(h.host.callsTo("push")).toHaveLength(1);
    });

    it("leaves a worktree that holds other work alone", async () => {
      const worker = await fixWithForeignTip();
      h.host.worktree(`/wt/${worker.environment_id}`).dirty = true;
      await queue();
      expect(ticket().state).toBe("working");
      expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("left your worktree as it is: it has uncommitted changes");
      expect(h.host.callsTo("resetHard")).toEqual([]);
    });

    it("sends the fix back after merging three times while the branch kept moving", async () => {
      const worker = await fixWithForeignTip();
      const branch = ticket().pr_branch!;
      h.host.scripted.prCommit = ["theirs1", "theirs2", "theirs3", "theirs4"].map((tip) => ({ outcome: "diverged", tip }));
      h.host.scripted.fetchTip = ["theirs1", "theirs2", "theirs3"].map((sha) => ({ outcome: "ok", sha, tree: sha, mainBase: null }));
      h.host.foreign.set(branch, "theirs1");
      await queue();
      expect(h.host.callsTo("mergeOnto")).toHaveLength(3);
      expect(ticket().state).toBe("working");
      expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("kept getting commits Loom did not push while Loom merged them");
      expect(h.host.callsTo("push")).toHaveLength(1);
    });
  });

  it("completes the ticket when the pull request merged during a fix round, and blocks it with a fresh start when it closed", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    h.host.prStates.set(URL, "MERGED");
    await queue();
    expect(ticket().state).toBe("done");
    expect(h.host.callsTo("push")).toHaveLength(1);

    h = makeCtx();
    const other = await openPr();
    h.host.prStates.set(URL, "CLOSED");
    await poll();
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "the pull request was closed without merging", pr_branch: null, pushed_sha: null, pr_rounds: 0 });
    expect(h.store.thread(other.id)!.state).toBe("ended");
  });

  it("blocks the ticket when the feedback asks for more fix rounds than the spec allows", async () => {
    const worker = await openPr({ max_fix_rounds: 1 });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    await queue();
    h.host.feedback.set(URL, { checks: [{ key: "check:9", name: "lint", state: "failed", url: null }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "the pull request's checks and reviews needed more than 1 fix round" });
    expect(dataOf("pr_feedback").at(-1)!.data.overLimit).toBe(true);
  });

  it("claims the worker's ending with the limit decision, so a stop that is not confirmed yet still blocks the ticket later", async () => {
    const worker = await openPr({ max_fix_rounds: 1 });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    await queue();
    h.bb.stopConfirms = false;
    h.host.feedback.set(URL, { checks: [{ key: "check:9", name: "lint", state: "failed", url: null }] });
    await poll();
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ending", end_reason: "blocked" });
    expect(ticket()).toMatchObject({ state: "pr_open", blocked_reason: expect.stringContaining("more than 1 fix round") });
    h.bb.stopConfirms = true;
    await resumeEnding(h.ctx, h.store.thread(worker.id)!);
    expect(ticket().state).toBe("blocked");
  });

  it("keeps a fix round's message when bb does not take it, and sends it on the next tick", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    h.bb.sendError = new Error("bb is restarting");
    await poll();
    expect(ticket()).toMatchObject({ state: "working" });
    expect(JSON.parse(ticket().handback_json!)).toMatchObject({ thread: worker.thread_id, text: { summary: expect.stringContaining("fix round 1;") } });
    h.bb.sendError = null;
    await deliverHandBacks(h.ctx, project().id);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Rename the column.");
    expect(ticket().handback_json).toBeNull();
  });

  it("follows only merged and closed with max_fix_rounds = 0", async () => {
    await openPr({ max_fix_rounds: 0 });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(h.host.callsTo("prFeedback")).toEqual([]);
    expect(h.host.callsTo("prBatch")).toEqual([expect.objectContaining({ numbers: [1], feedback: false })]);
    expect(ticket().state).toBe("pr_open");
  });

  it("starts the next worker on the same pull request when the worker is gone, and pushes its fix to that branch", async () => {
    const worker = await openPr();
    const branch = ticket().pr_branch!;
    await endThread(h.ctx, h.store.thread(worker.id)!, "gone", { commit: false, move: null });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(ticket().state).toBe("queued");
    const next = await startWorker(h);
    const brief = h.bb.callsTo("spawnThread").at(-1)![0] as { prompt: string };
    expect(brief.prompt).toContain(`This ticket's pull request ${URL} is open.`);
    await approveFix(next);
    expect(ticket().branch).not.toBe(branch);
    await ask();
    handInPrText(h.ctx, next.thread_id!, { commit_message: "Rename" });
    await queue();
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ branch });
    expect(ticket().state).toBe("pr_open");
  });

  it("reads a command forge's feedback command, or only its state command when it has none", async () => {
    const forge = { kind: "command", open: "review open", state: "review state", feedback: "review feedback --json" };
    await openPr({ forge });
    await poll();
    expect(h.host.callsTo("prFeedback")).toEqual([{ repo: "/repo", url: URL, forge: { kind: "command", feedback: "review feedback --json" } }]);

    h = makeCtx();
    await openPr({ forge: { kind: "command", open: "review open", state: "review state" } });
    await poll();
    expect(h.host.callsTo("prFeedback")).toEqual([]);
    expect(h.host.callsTo("prState")[0]).toMatchObject({ forge: { kind: "command", state: "review state" } });
  });

  it("stores the draft flag, review and base a command forge's feedback command prints, null for those it leaves out, and blocks a pull request it says merged elsewhere", async () => {
    const forge = { kind: "command", open: "review open", state: "review state", feedback: "review feedback --json" };
    await openPr({ forge });
    await poll();
    expect(JSON.parse(ticket().pr_meta_json!)).toEqual({ at: h.clock.t, draft: null, review: null, base: null, mergeable: null, state: "OPEN" });

    h.host.feedback.set(URL, { draft: false, review: "APPROVED", base: "main", mergeable: true });
    await poll();
    expect(JSON.parse(ticket().pr_meta_json!)).toEqual({ at: h.clock.t, draft: false, review: "APPROVED", base: "main", mergeable: true, state: "OPEN" });

    h.host.feedback.set(URL, { state: "MERGED", base: "staging" });
    await poll();
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "Its pull request merged into the branch staging, not main, so its change is not on main. Put this change on main again." });
    expect(dataOf("merged_elsewhere")[0]!.data).toMatchObject({ branch: "staging", base: "main" });
  });

  it("completes a push-only forge's ticket once the remote base contains the commit Loom pushed", async () => {
    await openPr({ forge: { kind: "none" } });
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq1", pr_url: null });
    h.host.landed.add("sq1");
    await poll();
    expect(h.host.callsTo("landedOn")[0]).toMatchObject({ sha: "sq1" });
    expect(ticket().state).toBe("done");
  });
});

describe("a human reply on an open pull request", () => {
  it("starts a fix round that the worker gets with the reply", async () => {
    const e = makeEngine();
    h = e;
    const worker = await openPr();
    await e.engine.humanPost("CSV-1", "Also log the row count.");
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain("The human replied on the ticket about its open pull request (fix round 1)");
    expect(message).toContain("Also log the row count.");
    expect(dataOf("pr_feedback")[0]!.data).toMatchObject({ human: true, round: 1 });
  });

  it("leaves the reply on the ticket while the project is paused", async () => {
    const e = makeEngine();
    h = e;
    const worker = await openPr();
    h.store.setProjectState(project().id, "paused", "human");
    const before = h.bb.sent(worker.thread_id!).length;
    await e.engine.humanPost("CSV-1", "Also log the row count.");
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });
    expect(h.bb.sent(worker.thread_id!)).toHaveLength(before);
  });

  it("does not count the human's rounds toward the limit", async () => {
    const e = makeEngine();
    h = e;
    const worker = await openPr({ max_fix_rounds: 1 });
    await e.engine.humanPost("CSV-1", "Also log the row count.");
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Log the row count" });
    await queue();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 2 });
    expect(dataOf("pr_feedback").at(-1)!.data).toMatchObject({ counted: 1, overLimit: false });
  });
});

describe("a requeue of a ticket whose pull request stays open", () => {
  it("comes back as a fix round with a fresh limit, and asks the new worker for its own commit message", async () => {
    const worker = await openPr({ max_fix_rounds: 1 });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await blockTicket(h.ctx, ticket(), { reason: "I will explain the naming", needs: "", actor: "human" });
    expect(ticket().state).toBe("blocked");
    await requeueTicket(h.ctx, "CSV-1", { note: "Keep the old column name.", actor: "human", author: "human" });
    expect(ticket()).toMatchObject({ state: "queued", pr_rounds: 2, pr_ask_json: null, pr_text_json: null, pushed_sha: "sq1" });
    const next = await startWorker(h);
    await approveFix(next);
    await ask();
    expect(h.bb.sent(next.thread_id!).at(-1)).toContain("fix round 2 is approved. Write its commit message");
    handInPrText(h.ctx, next.thread_id!, { commit_message: "Keep the old column name" });
    await queue();
    h.host.feedback.set(URL, { checks: [{ key: "check:3", name: "lint", state: "failed", url: null }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 3 });
    void worker;
  });
});

describe("review again as is, for a ticket whose pull request stays open", () => {
  const branchAt = (sha: string) => h.host.refs.set(`refs/heads/${ticket().branch}`, sha);
  const again = (note = "") => requeueTicket(h.ctx, "CSV-1", { note, actor: "human", author: "human", review: true });

  /** Fix round 1 pushed, then a failed check over the limit of 1 blocks the ticket with the pull request open. */
  async function overTheLimit(): Promise<ThreadRow> {
    const worker = await openPr({ max_fix_rounds: 1 });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    await queue();
    h.host.feedback.set(URL, { checks: [{ key: "check:9", name: "bot status", state: "failed", url: null }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "blocked", pushed_sha: "sq2", head_sha: "c2", worker_thread_id: null });
    return worker;
  }

  it("goes straight back to pr_open when the branch has nothing the pull request lacks, with the fix rounds counted again, and its worker's thread comes back for the next one", async () => {
    const worker = await overTheLimit();
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    branchAt("c2");
    const back = await again("The bot status is advisory.");
    expect(back).toMatchObject({ state: "pr_open", pushed_sha: "sq2", pr_rounds: 1, blocked_reason: null, failures: 0, pr_poll_json: null, pr_checked_at: null, worker_thread_id: worker.thread_id, environment_id: null });
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "released", released_at: h.clock.t });
    expect(dataOf("pr_unchanged").at(-1)).toMatchObject({ post: { body: expect.stringContaining("Back on its pull request as it is") }, data: { sha: "sq2", again: true } });
    expect(dataOf("pr_unchanged").at(-1)!.post.body).toContain("Loom brings back the worker's thread, or starts a new worker from the branch when it cannot.");
    expect(posts().at(-1)).toMatchObject({ kind: "reply", author_kind: "human", body: "The bot status is advisory." });

    await poll();
    expect(ticket().state).toBe("pr_open");
    h.host.feedback.set(URL, { checks: [{ key: "check:9", name: "bot status", state: "failed", url: null }, { key: "check:10", name: "lint", state: "failed", url: null }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 2, worker_thread_id: worker.thread_id });
    expect(h.bb.callsTo("unarchive")).toContainEqual([worker.thread_id]);
    expect(dataOf("pr_feedback").at(-1)!.data).toMatchObject({ counted: 1, overLimit: false, checks: [{ name: "lint" }] });
  });

  it("goes back to review for a fix that passed the checks but was not pushed, and pushes it after approval", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
    worktree.dirty = true;
    submit(h.ctx, worker.thread_id!, "Renamed.");
    await settleChecks(h.ctx);
    expect(ticket()).toMatchObject({ state: "review", head_sha: "c2" });
    await blockTicket(h.ctx, ticket(), { reason: "Reviewers are down", needs: "", actor: "human" });
    branchAt("c2");
    expect(await again()).toMatchObject({ state: "review", head_sha: "c2", pushed_sha: "sq1" });

    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Holds.");
    await settleReviews(h.ctx);
    await ask();
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    expect(dataOf("pr_text").at(-1)!.data).toMatchObject({ by: "loom", fix: true, reason: "its worker is gone" });
  });

  it("refuses a fix round whose changes did not pass the checks", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    h.host.worktree(`/wt/${worker.environment_id}`).dirty = true;
    await blockTicket(h.ctx, ticket(), { reason: "Cannot rename", needs: "", actor: worker.thread_id! });
    branchAt(h.host.worktree(`/wt/${worker.environment_id}`).head);
    await expect(again()).rejects.toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("has changes since c1") });
  });
});

describe("unchangedFix", () => {
  const post = (data: object): PostRow => ({ id: 1, project_id: 1, ticket_id: 1, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body: "", data_json: JSON.stringify({ outcome: "pr_feedback", ...data }), at: 0 });

  it("compares trees, so a fix that comes home as a new commit with the same files changed nothing", () => {
    expect(unchangedFix([post({ head: "home1", tree: "t1" })], { sha: "c9", tree: "t1" })).toBe(true);
    expect(unchangedFix([post({ head: "home1", tree: "t1" })], { sha: "home1", tree: "t2" })).toBe(false);
  });

  it("still reads a feedback post from before trees were kept, by its head", () => {
    expect(unchangedFix([post({ head: "c1" })], { sha: "c1", tree: "t1" })).toBe(true);
    expect(unchangedFix([post({ head: "c1", tree: null })], { sha: "c2", tree: "t1" })).toBe(false);
  });
});
