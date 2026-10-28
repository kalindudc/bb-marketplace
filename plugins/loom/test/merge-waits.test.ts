// One error policy for host calls and forge commands: a failure worth waiting out (a host call that got no answer, a
// server error, a rate limit, a network failure or a timeout) keeps the ticket where it is and tries again, and only an
// hour of them pauses the project. The fixtures are pause reasons two real projects hit.
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { hostCallTransient, mergeWaitOf, nextMergeWait } from "../src/forge-waits";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { boardCards } from "../src/rpc";
import { stackOf } from "../src/stack";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { specOf } from "../src/workers";
import { checkOutHead, makeCtx, makeEngine, reachApproved, reachReview, seedMachineProject, seedProject, ticketOf, withDocsTicket, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const MINUTE = 60_000;
const URL1 = "https://github.com/acme/shop/pull/1";
const DEADLINE = "host plugin call 1f46e1e1-6061-4d69-81e2-afb2e9ac216c exceeded its deadline";
const RATE_LIMITED = "The forge's open command printed no pull request URL: Error: 429: other changes to shop/world's pull requests, reviews, checks or settings were still being saved after 30s, so nothing was changed; retry shortly";
const COMMAND_FORGE = { kind: "command", open: "review-cli open", state: "review-cli state", feedback: "review-cli feedback" };
const changesRequested = { items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] };

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const waitOf = (key = "CSV-1") => mergeWaitOf(ticket(key));
const systemPosts = (key = "CSV-1") => h.store.posts(ticket(key).id).filter((post) => post.kind === "system").map((post) => post.body);
const warnings = (text: string) => h.bb.callsTo("log").filter(([level, message]) => level === "warn" && String(message).includes(text));
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async (minutes = 5) => {
  h.clock.advance(minutes * MINUTE);
  await pollPullRequests(h.ctx, project());
};
const resume = () => h.store.setProjectState(project().id, "running", "human");
const stepOf = (key = "CSV-1") => JSON.parse(ticket(key).merge_step_json ?? "null") as { kind: string; from: string; sha: string; tree: string | null; tip?: string; remote: boolean; checked?: boolean } | null;
const mergePosts = (key = "CSV-1") => h.store.posts(ticket(key).id).filter((post) => post.kind === "merge");

/** CSV-1's worker on a machine of its own, its pull request open at sq1 and its fix round approved, with someone else's commit theirs1 on the branch. */
async function fixOnMachineWithForeignTip(): Promise<ThreadRow> {
  await seedMachineProject(h, (doc) => (doc.merge = { strategy: "pr", stack: false, release_workers: false }));
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
  await queue();
  h.bb.threads.get(worker.thread_id!)!.status = "idle";
  h.host.feedback.set(URL1, changesRequested);
  await poll();
  await fixAndApprove(worker);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
  h.host.foreign.set(ticket().pr_branch!, "theirs1");
  h.host.ancestry.add("sq1..theirs1");
  return worker;
}

/** The worker fixes what the pull request's feedback asked for, submits, and a reviewer approves. */
async function fixAndApprove(worker: ThreadRow): Promise<void> {
  const worktree = h.host.worktree(`/wt/${h.store.thread(worker.id)!.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/a.ts"];
  submit(h.ctx, worker.thread_id!, "Renamed it.");
  await settleChecks(h.ctx);
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "The fix holds.");
  await settleReviews(h.ctx);
}

describe("hostCallTransient", () => {
  it.each([
    "host plugin call cb6707d4-28ec-4bd7-b592-6f9d15ce5799 exceeded its deadline",
    "host plugin call cb6707d4-28ec-4bd7-b592-6f9d15ce5799 reached its deadline before dispatch",
    "host plugin worker exited (0)",
    "Host plugin worker exited unexpectedly",
    "Host plugin worker failed to start",
    "host plugin loom worker is unavailable",
    "host plugin manager is shutting down",
    "Host is not connected",
    "Host daemon is not connected",
    "Timed out waiting for command result",
    "git push took too long",
    "git merge-tree took too long",
    "gh api took too long",
  ])("waits out a call that got no answer: %s", (message) => {
    expect(hostCallTransient(new Error(message))).toEqual({ transient: "server" });
  });

  it("waits out the SDK's transport error, whatever its message", () => {
    expect(hostCallTransient(Object.assign(new Error("Plugin RPC request failed"), { code: "transport_error" }))).toEqual({ transient: "server" });
  });

  it.each([
    ["host rpc input validation failed: must be a path inside the repository", undefined],
    ["host rpc output validation failed: Invalid input", undefined],
    ['unknown host rpc method "fetchTip"', undefined],
    ["git merge 5e9fd7d9 failed (128): fatal: You have not concluded your merge (MERGE_HEAD exists).", "handler_error"],
    ["host plugin call x exceeded its deadline", "invalid_output"],
    ["host plugin call x exceeded its deadline", "unknown_method"],
    ["host plugin call x exceeded its deadline", "invalid_input"],
  ])("pauses on an answer: %s (%s)", (message, code) => {
    expect(hostCallTransient(code === undefined ? new Error(message) : Object.assign(new Error(message), { code }))).toBeNull();
  });
});

describe("nextMergeWait", () => {
  it("waits 1, 2, 5 and 10 minutes, then every 15, from the first failure of the streak", () => {
    let wait = null as ReturnType<typeof nextMergeWait> | null;
    const delays: number[] = [];
    for (let at = 0; delays.length < 7; at = wait!.until) {
      wait = nextMergeWait(wait, { now: at, message: "x", transient: "server" });
      delays.push((wait.until - at) / MINUTE);
    }
    expect(delays).toEqual([1, 2, 5, 10, 15, 15, 15]);
    expect(wait).toMatchObject({ failures: 7, since: 0 });
  });

  it("waits at least 15 minutes after a rate limit, and at least the time the forge named", () => {
    expect(nextMergeWait(null, { now: 0, message: "x", transient: "rate_limit" }).until).toBe(15 * MINUTE);
    expect(nextMergeWait(null, { now: 0, message: "x", transient: "rate_limit", retryAfterMs: 40 * MINUTE }).until).toBe(40 * MINUTE);
  });
});

describe("a merge that fails in a way worth waiting out", () => {
  it("keeps the ticket in merging after a host call deadline, posts once, and merges when the wait ends", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    const first = h.clock.t;

    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(ticket()).toMatchObject({ state: "merging" });
    expect(waitOf()).toEqual({ failures: 1, since: first, until: first + MINUTE, message: DEADLINE });
    expect(systemPosts()).toEqual([
      `Merging CSV-1 failed with what looks like a temporary error: ${DEADLINE}. Loom tries again in 1m, waiting longer after each failure up to 15m, and pauses the project only if it keeps failing for 1h.`,
    ]);
    expect(warnings("Merging CSV-1 failed 1 time in a row")).toHaveLength(1);

    h.clock.advance(MINUTE - 1000);
    await queue();
    expect(h.host.callsTo("merge")).toHaveLength(1);

    h.clock.advance(1000);
    await queue();
    expect(h.host.callsTo("merge")).toHaveLength(2);
    expect(ticket()).toMatchObject({ state: "done", merge_wait_json: null });
    expect(systemPosts()).toHaveLength(1);
  });

  it("tries again after 1, 2, 5, 10 and 15 minutes, and pauses after an hour, naming the ticket, the error and how long", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.errors.merge = new Error("host plugin worker exited (0)");
    await queue();
    for (const minutes of [1, 2, 5, 10, 15, 15]) {
      h.clock.advance(minutes * MINUTE - 1000);
      await queue();
      const before = h.host.callsTo("merge").length;
      h.clock.advance(1000);
      await queue();
      expect(h.host.callsTo("merge"), `after ${minutes} more minutes`).toHaveLength(before + 1);
      expect(project().state).toBe("running");
    }
    expect(waitOf()).toMatchObject({ failures: 7 });
    expect(systemPosts()).toHaveLength(1);

    h.clock.advance(15 * MINUTE);
    await queue();
    expect(project()).toMatchObject({
      state: "paused",
      system_reason: "Merging CSV-1 failed 8 times in a row over 1h 3m: host plugin worker exited (0). Resume once the project's machine and the forge answer again.",
      triage_pending: 1,
    });
    expect(ticket()).toMatchObject({ state: "merging", merge_wait_json: null });
    expect(warnings("Merging CSV-1 failed")).toHaveLength(8);

    h.host.errors.merge = null;
    resume();
    await queue();
    expect(ticket().state).toBe("done");
  });

  it("holds the whole queue while the ticket waits, and a success ends the streak, so a later failure posts again", async () => {
    await seedProject(h, withDocsTicket);
    await reachApproved(h, "CSV-1");
    await reachApproved(h, "CSV-3");
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    expect([ticket("CSV-1").state, ticket("CSV-3").state]).toEqual(["merging", "approved"]);
    await queue();
    expect(ticket("CSV-3").state).toBe("approved");

    h.clock.advance(MINUTE);
    await queue();
    expect(ticket("CSV-1")).toMatchObject({ state: "done", merge_wait_json: null });
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    expect(ticket("CSV-3")).toMatchObject({ state: "merging" });
    expect(waitOf("CSV-3")).toMatchObject({ failures: 1 });
    expect(systemPosts("CSV-3")).toHaveLength(1);
  });

  it("runs the merge in the engine's first pass after the wait ends", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h);
    await reachApproved(h);
    h.host.scripted.merge = [new Error(DEADLINE)];
    await e.engine.tick();
    await settleMerges(h.ctx);
    expect(ticket().state).toBe("merging");
    await e.engine.tick();
    await settleMerges(h.ctx);
    expect(h.host.callsTo("merge")).toHaveLength(1);

    h.clock.advance(MINUTE);
    await e.engine.tick();
    await settleMerges(h.ctx);
    expect(ticket().state).toBe("done");
  });

  describe("on the pull request strategy", () => {
    const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, stack: false, ...more });

    it("waits at least 15 minutes when the open command printed a rate limit instead of a URL, then pushes again and opens", async () => {
      await seedProject(h, pr({ forge: COMMAND_FORGE }));
      await reachApproved(h);
      h.host.scripted.prCreate = [{ outcome: "unavailable", message: RATE_LIMITED, transient: "rate_limit" }];
      await queue();
      const first = h.clock.t;
      expect(project().state).toBe("running");
      expect(waitOf()).toEqual({ failures: 1, since: first, until: first + 15 * MINUTE, message: RATE_LIMITED });
      expect(systemPosts()[0]).toContain("Loom tries again in 15m");

      h.clock.advance(14 * MINUTE);
      await queue();
      expect(h.host.callsTo("prCreate")).toHaveLength(1);
      h.clock.advance(MINUTE);
      await queue();
      expect(h.host.callsTo("push")).toHaveLength(2);
      expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL1, merge_wait_json: null });
    });

    it("waits out a fix round whose feedback command took too long, then pushes the fix", async () => {
      await seedProject(h, pr({ forge: COMMAND_FORGE }));
      const worker = await reachApproved(h);
      await queue();
      h.host.feedback.set(URL1, changesRequested);
      await poll();
      expect(ticket().state).toBe("working");
      await fixAndApprove(worker);
      h.host.scripted.prFeedback = [{ outcome: "unavailable", message: "The forge's feedback command took longer than 2 minutes: ", transient: "server" }];
      await queue();
      expect(project().state).toBe("running");
      expect(ticket()).toMatchObject({ state: "merging" });
      expect(waitOf()).toMatchObject({ failures: 1, message: "The forge's feedback command took longer than 2 minutes: " });
      expect(systemPosts().at(-1)).toBe(
        "Merging CSV-1 failed with what looks like a temporary error: The forge's feedback command took longer than 2 minutes. Loom tries again in 1m, waiting longer after each failure up to 15m, and pauses the project only if it keeps failing for 1h.",
      );

      h.clock.advance(MINUTE);
      await queue();
      expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1, merge_wait_json: null });
    });

    it("waits out a read of the pull request branch whose host call ran out of time before a push, on a machine", async () => {
      await seedMachineProject(h, (doc) => (doc.merge = { strategy: "pr", stack: false, release_workers: false }));
      const worker = await reachApproved(h);
      await askForPrTexts(h.ctx, project(), spec());
      handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
      await queue();
      h.bb.threads.get(worker.thread_id!)!.status = "idle";
      h.host.feedback.set(URL1, changesRequested);
      await poll();
      await fixAndApprove(worker);
      await askForPrTexts(h.ctx, project(), spec());
      handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
      h.host.foreign.set(ticket().pr_branch!, "theirs1");
      h.host.ancestry.add("sq1..theirs1");
      const deadline = "host plugin call 49806682-190a-4717-a14c-422c7a208820 exceeded its deadline";
      h.host.scripted.fetchTip = [new Error(deadline)];
      await queue();
      expect(project().state).toBe("running");
      expect(waitOf()).toMatchObject({ failures: 1, message: `Reading CSV-1's pull request branch stopped: ${deadline}` });

      h.clock.advance(MINUTE);
      await queue();
      expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2", merge_wait_json: null });
    });

    it("waits out a push that could not reach the remote", async () => {
      await seedProject(h, pr());
      await reachApproved(h);
      h.host.scripted.push = [{ outcome: "unavailable", message: "git push to origin failed: fatal: unable to access 'https://github.com/acme/shop.git/': Could not resolve host: github.com", transient: "network" }];
      await queue();
      expect(project().state).toBe("running");
      expect(waitOf()).toMatchObject({ failures: 1 });
    });
  });

  describe("still pauses", () => {
    const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, stack: false, ...more });

    it("on a missing login, an open command that printed no URL, and a host call the contract refused", async () => {
      await seedProject(h, pr());
      await reachApproved(h);
      const signedOut = "gh pr create failed: To get started with GitHub CLI, please run:  gh auth login";
      h.host.scripted.prCreate = [{ outcome: "unavailable", message: signedOut }];
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: signedOut });
      expect(ticket().merge_wait_json).toBeNull();

      resume();
      h.host.scripted.prCreate = [{ outcome: "unavailable", message: "The forge's open command printed no pull request URL: created" }];
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: "The forge's open command printed no pull request URL: created" });

      resume();
      h.host.scripted.prCreate = [new Error("host rpc input validation failed: must be a pull request URL")];
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: "Merging CSV-1 stopped: host rpc input validation failed: must be a pull request URL" });
      expect(systemPosts()).toEqual([]);
    });

    it("on a repo with no checkout", async () => {
      await seedProject(h);
      await reachApproved(h);
      h.bb.checkout = null;
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringContaining("no checkout") });
    });

    it("on a failure that is not worth waiting out, ending a streak, so a resume merges at once", async () => {
      await seedProject(h);
      await reachApproved(h);
      h.host.scripted.merge = [new Error(DEADLINE), new Error("git merge c1 failed (128): fatal: refusing to merge unrelated histories")];
      await queue();
      h.clock.advance(MINUTE);
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: "Merging CSV-1 stopped: git merge c1 failed (128): fatal: refusing to merge unrelated histories" });
      expect(ticket()).toMatchObject({ state: "merging", merge_wait_json: null });
      resume();
      await queue();
      expect(ticket().state).toBe("done");
    });
  });
});

describe("a merge into a worker's worktree that has a merge the worker has not finished", () => {
  it("hands the ticket back to its worker, leaving the worktree as it is, instead of pausing the project", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    expect(ticket("CSV-2").state).toBe("pr_open");
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    const pushes = h.host.callsTo("push").length;
    h.host.worktree(`/wt/${worker.environment_id}`).unfinishedMerge = true;
    await queue();

    expect(project().state).toBe("running");
    expect(ticket("CSV-2")).toMatchObject({ state: "working", check_failures: 0 });
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    expect(h.host.callsTo("resetHard")).toEqual([]);
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("Your worktree has a merge you have not finished. Finish it with git commit, or abort it with git merge --abort, then call loom_submit.");
    const post = h.store.posts(ticket("CSV-2").id).filter((each) => each.kind === "merge").at(-1)!;
    expect(JSON.parse(post.data_json)).toMatchObject({ outcome: "unfinished" });
    expect(stackOf(ticket("CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq1" } });
  });
});

describe("a merge that runs again after its checks got no answer", () => {
  it("finishes the merge of someone else's commits it carried to a worker on a machine, and pushes that merge, never the older head on their tip", async () => {
    await fixOnMachineWithForeignTip();
    const head = ticket().head_sha!;
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "merging", head_sha: head, pushed_sha: "sq1" });
    const step = stepOf()!;
    expect(step).toMatchObject({ kind: "tip", from: head, tip: "theirs1", remote: true });

    h.clock.advance(MINUTE);
    await queue();
    expect(h.host.callsTo("mergeOnto")).toHaveLength(1);
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: step.sha, pushed: "theirs1" });
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: step.sha, head_tree: step.tree, pushed_sha: "sq2", merge_step_json: null, merge_wait_json: null });
    expect(mergePosts().map((post) => JSON.parse(post.data_json).outcome)).toContain("restacked");
  });

  it("waits, and hands nothing back, when carrying the merge to the worker's machine got no answer", async () => {
    const worker = await fixOnMachineWithForeignTip();
    h.host.scripted.carryStart = [new Error(DEADLINE)];
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "merging", pushed_sha: "sq1" });
    expect(waitOf()).toMatchObject({ failures: 1 });
    expect(h.bb.sent(worker.thread_id!).join("\n")).not.toContain("left your worktree as it is");

    h.clock.advance(MINUTE);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
  });

  it("finishes a restack in the worker's worktree on the checkout's machine, reruns its checks and pushes the merge, never the older head", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    const head = ticket("CSV-2").head_sha!;
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "merging", head_sha: head });
    expect(stepOf("CSV-2")).toMatchObject({ kind: "restack", from: head, sha: "lm1", remote: false });
    const checks = h.host.callsTo("exec").length;

    h.clock.advance(MINUTE);
    await queue();
    expect(h.host.callsTo("mergeOnto")).toHaveLength(1);
    expect(h.host.callsTo("exec").slice(checks)).toEqual([expect.objectContaining({ cwd: `/wt/${worker.environment_id}`, command: "npm test" })]);
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", head_sha: "lm1", merge_step_json: null });
    expect(stackOf(ticket("CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq7" } });
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: "lm1", message: "CSV-2: merge CSV-1's pull request (Loom)" });
  });

  it("finishes a restack whose move into the worker's worktree got no answer, running its checks, instead of taking the merge for unknown work", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    const head = ticket("CSV-2").head_sha!;
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    h.host.lost.resetHard = [new Error(DEADLINE)];
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "merging", head_sha: head });
    expect(stepOf("CSV-2")).toMatchObject({ kind: "restack", from: head, sha: "lm1" });
    expect(h.host.worktree(`/wt/${worker.environment_id}`).head).toBe("lm1");

    h.clock.advance(MINUTE);
    await queue();
    expect(h.host.callsTo("mergeOnto")).toHaveLength(1);
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: `/wt/${worker.environment_id}`, command: "npm test" });
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", head_sha: "lm1", merge_step_json: null });
    expect(h.bb.sent(worker.thread_id!).join("\n")).not.toContain("left your worktree as it is");
  });

  it("pushes a restack whose checks passed when the push got no answer, on the next run, with no new merge or checks", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    await reachApproved(h, "CSV-2");
    await queue();
    const pushed = ticket("CSV-2").pushed_sha;
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    const pushes = h.host.callsTo("push").length;
    h.host.scripted.push = [new Error(DEADLINE)];
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "merging", head_sha: "lm1", pushed_sha: pushed });
    expect(stepOf("CSV-2")).toMatchObject({ from: "lm1", checked: true });
    const checks = h.host.callsTo("exec").length;

    h.clock.advance(MINUTE);
    await queue();
    expect(h.host.callsTo("push")).toHaveLength(pushes + 2);
    expect(h.host.callsTo("mergeOnto")).toHaveLength(1);
    expect(h.host.callsTo("exec")).toHaveLength(checks);
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: "lm1", message: "CSV-2: merge CSV-1's pull request (Loom)" });
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", head_sha: "lm1", merge_step_json: null });
    expect(ticket("CSV-2").pushed_sha).not.toBe(pushed);
  });

  it("waits, and hands nothing back, when the worker's machine could not fetch the base to carry the merge onto", async () => {
    await fixOnMachineWithForeignTip();
    h.host.scripted.carryStart = [{ outcome: "unavailable", message: "The base commit base000 is not on this machine, and git fetch origin base000 did not bring it: ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known", transient: "network" }];
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "merging", pushed_sha: "sq1" });
    expect(waitOf()).toMatchObject({ failures: 1 });
    expect(stepOf()).toMatchObject({ kind: "tip" });
    h.clock.advance(MINUTE);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
  });

  it("hands the ticket back untouched when the worker's worktree changed under a merge it has not finished", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    const resets = h.host.callsTo("resetHard").length;
    h.host.worktree(`/wt/${worker.environment_id}`).head = "x9";
    h.clock.advance(MINUTE);
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "working", merge_step_json: null });
    expect(h.host.callsTo("resetHard")).toHaveLength(resets);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("left your worktree as it is: its HEAD is x9");
  });

  it("hands the ticket back, resetting nothing, when a worker's worktree on the checkout's machine has a merge with nothing left to resolve", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", stack: false }));
    const worker = await reachApproved(h);
    await queue();
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    await fixAndApprove(worker);
    h.host.foreign.set(ticket().pr_branch!, "theirs1");
    h.host.ancestry.add("sq1..theirs1");
    h.host.worktree(`/wt/${worker.environment_id}`).unfinishedMerge = true;
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "working", merge_step_json: null, pushed_sha: "sq1" });
    expect(h.host.callsTo("resetHard")).toEqual([]);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Your worktree has a merge you have not finished.");
  });
});

describe("steps that are not run again", () => {
  it("posts once and completes the push when asking for reviews again got no answer", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", stack: false }));
    const worker = await reachApproved(h);
    await queue();
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    await fixAndApprove(worker);
    h.host.scripted.prRequestReview = [new Error(DEADLINE)];
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "pr_open", merge_wait_json: null });
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
    expect(mergePosts().filter((post) => post.body.includes("could not ask")).map((post) => post.body)).toEqual([`Loom could not ask alice to review the pull request again: ${DEADLINE}`]);
  });

  it("posts once, naming the after_open commands it did not run, and runs none again, when one got no answer", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, forge: { ...COMMAND_FORGE, after_open: ["ci-cli run", "ci-cli notify"] } }));
    await reachApproved(h);
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "pr_open", merge_wait_json: null });
    const failed = mergePosts().filter((post) => JSON.parse(post.data_json).outcome === "after_open_failed");
    expect(failed.map((post) => post.body)).toEqual([
      `The after_open command \`ci-cli run\` got no answer from the project's machine, so Loom cannot tell whether it ran, and does not run it again: ${DEADLINE} Loom did not run \`ci-cli notify\` after it either.\n\nThe pull request ${URL1} is open; nothing else changed.`,
    ]);
    await queue();
    expect(h.host.callsTo("exec").filter((input) => input.command.startsWith("ci-cli"))).toHaveLength(1);
  });

  it("waits out a push whose git process ran out of time on the machine", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, stack: false }));
    await reachApproved(h);
    h.host.scripted.push = [new Error("git push took too long")];
    await queue();
    expect(project().state).toBe("running");
    expect(waitOf()).toMatchObject({ failures: 1, message: "git push took too long" });
  });
});

describe("blocking or cancelling a ticket whose merge waits", () => {
  it("blocks a ticket that waits to open its pull request, and ends the wait", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, stack: false, forge: COMMAND_FORGE }));
    await reachApproved(h);
    h.host.scripted.prCreate = [{ outcome: "unavailable", message: RATE_LIMITED, transient: "rate_limit" }];
    await queue();
    expect(waitOf()).not.toBeNull();
    await e.engine.block("CSV-1", "Not this way", "human");
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "Not this way", merge_wait_json: null, merge_step_json: null });
    expect(project().state).toBe("running");
  });

  it("cancels a waiting merge on the integration strategy, taking its unchecked merge back out of the integration branch", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, (doc) => (doc.checks.after_merge = ["npm run e2e"]));
    await reachApproved(h);
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    expect(ticket()).toMatchObject({ state: "merging", merge_before: "base000" });
    expect(h.host.worktree("/data/worktrees/csv").head).toBe("m1");

    await e.engine.cancel("CSV-1", "Dropped", "human");
    expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree: "/data/worktrees/csv", sha: "base000" });
    expect(h.host.worktree("/data/worktrees/csv").head).toBe("base000");
    expect(ticket()).toMatchObject({ state: "cancelled", merge_wait_json: null });
  });

  it("refuses, leaving the ticket merging, when the integration branch cannot be read to take the merge out", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, (doc) => (doc.checks.after_merge = ["npm run e2e"]));
    await reachApproved(h);
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    h.host.errors.worktreeState = new Error(DEADLINE);
    await expect(e.engine.block("CSV-1", "stop", "human")).rejects.toMatchObject({ code: "loom_unavailable", message: `Loom could not take CSV-1's merge back out of its integration branch: ${DEADLINE}` });
    expect(ticket()).toMatchObject({ state: "merging", merge_before: "base000" });
    expect(waitOf()).not.toBeNull();
  });
});

describe("a pull request read whose host call got no answer", () => {
  const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0, ...more });

  it("waits as a server error when the command forge's read ran out of time, and pauses only after an hour", async () => {
    await seedProject(h, (doc) => {
      pr({ forge: { kind: "command", open: "review-cli open", state: "review-cli state" } })(doc);
      doc.checks.ci = false;
    });
    await reachApproved(h);
    await queue();
    const deadline = "host plugin call cb6707d4-28ec-4bd7-b592-6f9d15ce5799 exceeded its deadline";
    h.host.errors.prState = new Error(deadline);
    await poll();
    expect(project().state).toBe("running");
    expect(JSON.parse(ticket().pr_poll_json!)).toMatchObject({ failures: 1, message: deadline });
    expect(systemPosts()).toEqual([
      `Reading the pull request failed with what looks like a temporary error on the project's machine: ${deadline}. Loom reads it again in 5m, waiting longer after each failure up to 30m, and pauses the project only if the reads keep failing for 1h.`,
    ]);
    for (const minutes of [5, 10, 20, 30]) await poll(minutes);
    expect(project()).toMatchObject({
      state: "paused",
      system_reason: `Reading the pull request ${URL1} of CSV-1 failed 5 times in a row over 1h 5m: ${deadline}. Resume once the project's machine answers again.`,
    });
  });

  it("waits for each ticket of a GitHub batch whose host worker exited, as during a plugin update", async () => {
    await seedProject(h, pr(), "running");
    await reachApproved(h);
    await queue();
    h.host.scripted.prBatch = [new Error("host plugin worker exited (0)")];
    await poll();
    expect(project().state).toBe("running");
    expect(JSON.parse(ticket().pr_poll_json!)).toMatchObject({ failures: 1, message: "host plugin worker exited (0)" });
    await poll();
    expect(ticket().pr_poll_json).toBeNull();
  });

  it("still pauses on a read gh answered with a missing login", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    const signedOut = "gh api graphql failed: To get started with GitHub CLI, please run: gh auth login";
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: signedOut }];
    await poll();
    expect(project()).toMatchObject({ state: "paused", system_reason: signedOut });
  });
});

describe("the review diff", () => {
  const reviewers = () => h.store.threads({ ticketId: ticket().id, role: "reviewer" });

  it("waits and tries again on the merge's steps when its read gets no answer, and pauses only after an hour", async () => {
    await seedProject(h);
    await reachReview(h);
    h.host.errors.diff = new Error(DEADLINE);
    await spawnReviewers(h.ctx, project(), spec());
    expect(project().state).toBe("running");
    expect(reviewers()).toEqual([]);
    expect(systemPosts()).toEqual([
      `Reading the diff of CSV-1 for review failed with what looks like a temporary error: ${DEADLINE}. Loom tries again in 1m, waiting longer after each failure up to 15m, and pauses the project only if it keeps failing for 1h.`,
    ]);
    await spawnReviewers(h.ctx, project(), spec());
    expect(h.host.callsTo("diff")).toHaveLength(1);

    for (const minutes of [1, 2, 5, 10, 15, 15]) {
      h.clock.advance(minutes * MINUTE);
      await spawnReviewers(h.ctx, project(), spec());
    }
    expect(h.host.callsTo("diff")).toHaveLength(7);
    expect(project().state).toBe("running");
    h.clock.advance(15 * MINUTE);
    await spawnReviewers(h.ctx, project(), spec());
    expect(project()).toMatchObject({ state: "paused", system_reason: `Reading the diff of CSV-1 for review failed 8 times in a row over 1h 3m: ${DEADLINE}. Resume once the project's machine and the forge answer again.` });

    h.host.errors.diff = null;
    resume();
    await spawnReviewers(h.ctx, project(), spec());
    expect(reviewers()).toHaveLength(1);
  });

  it("starts the reviewer once a read works, and still pauses on a diff git cannot make", async () => {
    await seedProject(h);
    await reachReview(h);
    h.host.scripted.diff = [new Error(DEADLINE)];
    await spawnReviewers(h.ctx, project(), spec());
    h.clock.advance(MINUTE);
    await spawnReviewers(h.ctx, project(), spec());
    expect(reviewers()).toHaveLength(1);

    await seedProject((h = makeCtx()));
    await reachReview(h);
    h.host.scripted.diff = [new Error("git diff --stat --no-color main...c1 -- failed (128): fatal: bad revision")];
    await spawnReviewers(h.ctx, project(), spec());
    expect(project()).toMatchObject({ state: "paused", system_reason: "Could not read the diff of CSV-1 for review: git diff --stat --no-color main...c1 -- failed (128): fatal: bad revision" });
  });
});

describe("the merge wait on the page", () => {
  it("is on the waiting ticket's board card, and on no other", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    const cards = boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec());
    expect(cards.find((card) => card.key === "CSV-1")!.mergeWait).toEqual({ failures: 1, since: h.clock.t, until: h.clock.t + MINUTE, message: DEADLINE });
    expect(cards.find((card) => card.key === "CSV-2")!.mergeWait).toBeNull();
  });
});
