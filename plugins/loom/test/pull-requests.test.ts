import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, deliverFixRounds, handInPrText, onPrWriterIdle, resumePrAsks } from "../src/pull-requests";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { blockTicket, endThread, requeueTicket, resumeEnding, specOf } from "../src/workers";
import { checkOutHead, makeCtx, makeEngine, reachApproved, seedProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

type Feedback = Partial<Extract<HostOutput<"prFeedback">, { outcome: "ok" }>>;

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
const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", ...more });
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
    expect(handInPrText(h.ctx, worker.thread_id!, TEXT)).toContain("Loom opens the pull request with your text now");
    await queue();

    const branch = ticket().branch!;
    expect(h.host.callsTo("prCommit")).toEqual([{ repo: "/repo", remote: "origin", branch, base: "origin/main", head: "c1", message: TEXT.commit_message }]);
    expect(h.host.callsTo("push")).toEqual([{ repo: "/repo", remote: "origin", src: "sq1", branch }]);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ head: branch, title: TEXT.title, body: `${TEXT.body}\n\nOpened by Loom for CSV-1.`, draft: true });
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
    expect(h.host.callsTo("prFeedback")).toEqual([{ repo: "/repo", url: URL, forge: { kind: "gh" } }]);
    expect(h.host.callsTo("prState")).toEqual([]);
    expect(JSON.parse(ticket().pr_status_json!)).toMatchObject({ passed: 1, pending: 1, failed: 0, at: h.clock.t });
    expect(ticket().state).toBe("pr_open");
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
    expect(message).toContain("You may answer review comments on the pull request with the forge's CLI");
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

    expect(h.host.callsTo("prState")).toEqual([{ repo: "/repo", url: URL, forge: { kind: "gh" } }]);
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ message: "Rename the column\n\nAs alice asked.", pushed: "sq1" });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ src: "sq2", branch: ticket().pr_branch });
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL, pushed_sha: "sq2", pr_status_json: null });
    expect(dataOf("pr_pushed")[0]!.post.body).toBe(`Pushed fix round 1 to ${URL} as 1 commit (sq2).`);
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

  it("sends the fix back to the worker when the pull request's branch has commits Loom did not push", async () => {
    const worker = await openPr();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    await approveFix(worker);
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    h.host.foreign.add(ticket().pr_branch!);
    await queue();
    expect(ticket().state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("has commits Loom did not push");
    expect(h.host.callsTo("push")).toHaveLength(1);
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
    expect(JSON.parse(ticket().pr_deliver_json!)).toMatchObject({ thread: worker.thread_id, text: { summary: expect.stringContaining("fix round 1;") } });
    h.bb.sendError = null;
    await deliverFixRounds(h.ctx, project());
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Rename the column.");
    expect(ticket().pr_deliver_json).toBeNull();
  });

  it("follows only merged and closed with max_fix_rounds = 0", async () => {
    await openPr({ max_fix_rounds: 0 });
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(h.host.callsTo("prFeedback")).toEqual([]);
    expect(h.host.callsTo("prState")).toHaveLength(1);
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
