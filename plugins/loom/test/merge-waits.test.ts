// One error policy for host calls and forge commands: a failure worth waiting out (a host call that got no answer, a
// server error, a rate limit, a network failure or a timeout) keeps the ticket where it is and tries again. An hour of a
// ticket's own failures blocks that ticket; the project's machine or a forge never blocks or pauses anything; only a
// failure of the whole project pauses it. The fixtures are pause reasons two real projects hit.
import { holdingSends } from "../src/carry-hold";
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { Engine } from "../src/engine";
import { hostCallTransient, nextMergeWait } from "../src/forge-waits";
import { retryOf } from "../src/retry-wait";
import { stepFailed } from "../src/retry";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { boardCards } from "../src/rpc";
import { stackOf } from "../src/stack";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { specOf } from "../src/ctx";
import { checkOutHead, makeCtx, makeEngine, reachApproved, reachReview, seedMachineProject, seedProject, ticketOf, withDocsTicket, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const MINUTE = 60_000;
const URL1 = "https://github.com/acme/shop/pull/1";
const DEADLINE = "host plugin call 1f46e1e1-6061-4d69-81e2-afb2e9ac216c exceeded its deadline";
const RATE_LIMITED = "The forge's open command printed no pull request URL: Error: 429: other changes to acme/shop's pull requests, reviews, checks or settings were still being saved after 30s, so nothing was changed; retry shortly";
const COMMAND_FORGE = { kind: "command", open: "review-cli open", state: "review-cli state", feedback: "review-cli feedback" };
const changesRequested = { items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] };

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const waitOf = (key = "CSV-1") => retryOf(ticket(key), "merge");
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

/**
 * CSV-1's worker on a machine of its own, its pull request open at sq1 and its fix round approved, with someone else's
 * commit theirs1 on the branch. On a repo that does not rely on CI, so the clean merge is carried and checked in the
 * worker's worktree rather than pushed from the project's machine.
 */
async function fixOnMachineWithForeignTip(): Promise<ThreadRow> {
  await seedMachineProject(h, (doc) => {
    doc.merge = { strategy: "pr", stack: false };
    doc.checks.ci = false;
  });
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
    "Host is suspended",
    // bb retires the old host plugin generation while a plugin update starts the new one, which may time out its startup.
    "host plugin loom generation 958cfa03-7186-47e3-9428-ffb4b2bff84f is retired",
    "host plugin loom startup timed out",
    "host plugin transport is unavailable",
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
    expect(waitOf()).toEqual({ step: "merge", failures: 1, since: first, until: first + MINUTE, message: DEADLINE, kind: "unknown", scope: "host" });
    expect(systemPosts()).toEqual([
      `Merging CSV-1 got no answer from the project's machine, so Loom cannot tell whether it ran: ${DEADLINE}. Each step first checks what is already done, so nothing is done twice. Loom tries again in 1m, waiting longer after each failure up to 15m. A problem of the project's machine never blocks this ticket or pauses the project.`,
    ]);
    expect(warnings("Merging CSV-1 failed 1 time in a row")).toHaveLength(1);

    h.clock.advance(MINUTE - 1000);
    await queue();
    expect(h.host.callsTo("merge")).toHaveLength(1);

    h.clock.advance(1000);
    await queue();
    expect(h.host.callsTo("merge")).toHaveLength(2);
    expect(ticket()).toMatchObject({ state: "done", retry_json: null });
    expect(systemPosts()).toHaveLength(1);
  });

  it("tries again after 1, 2, 5, 10 and 15 minutes, and after an hour says so once more, never pausing the project", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.errors.merge = new Error("host plugin worker exited (1)");
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
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(ticket()).toMatchObject({ state: "merging" });
    expect(waitOf()).toMatchObject({ failures: 8, noted: true });
    expect(systemPosts()).toEqual([
      expect.stringContaining("Merging CSV-1 got no answer from the project's machine"),
      "Merging CSV-1 has failed 8 times in a row over 1h 3m, because of the project's machine: host plugin worker exited (1). Loom keeps trying every 15m; a problem of the project's machine never blocks this ticket or pauses the project.",
    ]);
    h.clock.advance(15 * MINUTE);
    await queue();
    expect(systemPosts()).toHaveLength(2);
    expect(warnings("Merging CSV-1 failed")).toHaveLength(9);

    h.host.errors.merge = null;
    h.clock.advance(15 * MINUTE);
    await queue();
    expect(ticket()).toMatchObject({ state: "done", retry_json: null });
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
    expect(ticket("CSV-1")).toMatchObject({ state: "done", retry_json: null });
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
    const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", stack: false, ...more });

    it("waits at least 15 minutes when the open command printed a rate limit instead of a URL, then opens without pushing again", async () => {
      await seedProject(h, pr({ forge: COMMAND_FORGE }));
      await reachApproved(h);
      h.host.scripted.prCreate = [{ outcome: "unavailable", message: RATE_LIMITED, transient: "rate_limit" }];
      await queue();
      const first = h.clock.t;
      expect(project().state).toBe("running");
      expect(waitOf()).toMatchObject({ failures: 1, since: first, until: first + 15 * MINUTE, message: RATE_LIMITED, scope: "forge" });
      expect(systemPosts()[0]).toContain("Loom tries again in 15m");

      h.clock.advance(14 * MINUTE);
      await queue();
      expect(h.host.callsTo("prCreate")).toHaveLength(1);
      h.clock.advance(MINUTE);
      await queue();
      expect(h.host.callsTo("push")).toHaveLength(1);
      expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL1, retry_json: null });
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
        "Merging CSV-1 failed with what looks like a temporary error: The forge's feedback command took longer than 2 minutes. Loom tries again in 1m, waiting longer after each failure up to 15m, and blocks this ticket only if it keeps failing for 1h. The project keeps running.",
      );

      h.clock.advance(MINUTE);
      await queue();
      expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1, retry_json: null });
    });

    it("waits out a read of the pull request branch whose host call ran out of time before a push, on a machine", async () => {
      await seedMachineProject(h, (doc) => (doc.merge = { strategy: "pr", stack: false }));
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
      expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2", retry_json: null });
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

  describe("pauses only for the whole project", () => {
    const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", stack: false, ...more });

    it("on a missing login and an open command that printed no URL, saying what to fix", async () => {
      await seedProject(h, pr());
      await reachApproved(h);
      const signedOut = "gh pr create failed: To get started with GitHub CLI, please run:  gh auth login";
      h.host.scripted.prCreate = [{ outcome: "unavailable", message: signedOut }];
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: `Merging CSV-1 stopped: ${signedOut}. Sign in on the project's machine (for gh, \`gh auth login\`; for git, the remote's credentials), then resume the project.`, triage_pending: 1 });
      expect(ticket()).toMatchObject({ state: "merging", retry_json: null });

      resume();
      h.host.scripted.prCreate = [{ outcome: "unavailable", message: "The forge's open command printed no pull request URL: created" }];
      await queue();
      expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringMatching(/^Merging CSV-1 stopped: The forge's open command printed no pull request URL: created\. Fix the forge command so it prints what the spec reference describes, then resume the project\. The command is in the spec\./u) });
      expect(systemPosts()).toEqual([]);
    });

    it("blocks the ticket alone for a host call the contract refused, and the project keeps running", async () => {
      await seedProject(h, (doc) => {
        pr()(doc);
        withDocsTicket(doc);
      });
      await reachApproved(h);
      h.host.scripted.prCreate = [Object.assign(new Error("host rpc input validation failed: must be a pull request URL"), { code: "invalid_input" })];
      await queue();
      expect(project().state).toBe("running");
      expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "Merging CSV-1 failed, and trying again would not help: host rpc input validation failed: must be a pull request URL.", retry_json: null, merge_step_json: null });
      expect(h.store.posts(ticket().id).filter((post) => post.kind === "block").map((post) => post.body)).toEqual([ticket().blocked_reason]);
      expect(project().triage_pending).toBe(1);
    });

    it("waits on a repo with no checkout, without pausing", async () => {
      await seedProject(h);
      await reachApproved(h);
      h.bb.checkout = null;
      await queue();
      expect(project().state).toBe("running");
      expect(ticket().state).toBe("merging");
      expect(waitOf()).toMatchObject({ failures: 1, scope: "host", message: expect.stringContaining("no checkout") });
    });

    it("blocks the ticket after five tries of an error no rule names, taking the merge out, and the queue goes on", async () => {
      await seedProject(h, withDocsTicket);
      await reachApproved(h, "CSV-1");
      await reachApproved(h, "CSV-3");
      const odd = "git merge c1 failed (128): fatal: refusing to merge unrelated histories";
      h.host.errors.merge = new Error(odd);
      await queue();
      for (const minutes of [1, 2, 5, 10]) {
        h.clock.advance(minutes * MINUTE);
        await queue();
      }
      expect(h.host.callsTo("merge")).toHaveLength(5);
      expect(project().state).toBe("running");
      expect(ticket("CSV-1")).toMatchObject({ state: "blocked", blocked_reason: `Merging CSV-1 failed 5 times in a row over 18m: ${odd}. Loom blocked this ticket; the rest of the project keeps running.`, retry_json: null, merge_before: null });
      expect(systemPosts("CSV-1")).toEqual([expect.stringContaining("since it does not recognize this error, blocks this ticket if 5 tries in a row fail")]);

      h.host.errors.merge = null;
      await queue();
      expect(ticket("CSV-3").state).toBe("done");
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
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: step.sha, head_tree: step.tree, pushed_sha: "sq2", merge_step_json: null, retry_json: null });
    expect(mergePosts().map((post) => JSON.parse(post.data_json).outcome)).toContain("restacked");
  });

  it("waits for the worker's thread to end its turn before it carries the merge in, writing nothing meanwhile", async () => {
    const worker = await fixOnMachineWithForeignTip();
    h.bb.threads.get(worker.thread_id!)!.status = "active";
    const carries = h.host.callsTo("carryStart").length;
    const sent = h.bb.sent(worker.thread_id!).length;
    await queue();
    expect(h.host.callsTo("carryStart")).toHaveLength(carries);
    expect(ticket()).toMatchObject({ state: "merging", pushed_sha: "sq1" });
    expect(waitOf()).toMatchObject({ failures: 1, message: expect.stringContaining("not idle (active)") });
    expect(h.bb.sent(worker.thread_id!)).toHaveLength(sent);

    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    h.clock.advance(MINUTE);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
  });

  it("holds Loom's own messages to the worker while it carries into its worktree, and sends them once the carry is over", async () => {
    const worker = await fixOnMachineWithForeignTip();
    h.ctx.bb = holdingSends(h.bb);
    const sent = () => h.bb.sent(worker.thread_id!).filter((text) => text.includes("a note during the carry"));
    let during: string[] | null = null;
    // Not awaited: a held send settles only once the carry is over and bb has taken it.
    h.host.before.carryFinish = () => {
      void h.ctx.bb.send(worker.thread_id!, "a note during the carry");
      during = sent();
    };
    await queue();
    expect(h.host.callsTo("carryFinish")).toHaveLength(1);
    expect(during).toEqual([]);
    expect(sent()).toEqual(["a note during the carry"]);
  });

  it("carries only while bb reports the worker's thread idle: a thread in error waits, and gets Loom's retry first", async () => {
    const worker = await fixOnMachineWithForeignTip();
    h.ctx.bb = holdingSends(h.bb);
    const thread = h.bb.threads.get(worker.thread_id!)!;
    thread.status = "error";
    const carries = h.host.callsTo("carryStart").length;
    await queue();
    expect(h.host.callsTo("carryStart")).toHaveLength(carries);
    expect(ticket()).toMatchObject({ state: "merging", pushed_sha: "sq1" });
    expect(waitOf()).toMatchObject({ failures: 1, message: expect.stringContaining("not idle") });
    // No carry is under way while it waits, so Loom's own retry of the failed turn goes out at once.
    await h.ctx.bb.retryTurn(worker.thread_id!, "req_1", h.clock.t + MINUTE);
    expect(h.bb.callsTo("retryTurn")).toEqual([[worker.thread_id, "req_1", h.clock.t + MINUTE]]);

    thread.status = "idle";
    h.clock.advance(MINUTE);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
  });

  it("blocks only that ticket after an hour of its worker's thread in error, rather than waiting on it forever, and the project keeps running", async () => {
    const worker = await fixOnMachineWithForeignTip();
    h.bb.threads.get(worker.thread_id!)!.status = "error";
    for (let minute = 0; minute <= 75 && ticket().state !== "blocked"; minute += 5) {
      await queue();
      h.clock.advance(5 * MINUTE);
    }
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(ticket()).toMatchObject({ state: "blocked", pushed_sha: "sq1", merge_step_json: null, blocked_reason: expect.stringMatching(/^Merging CSV-1 failed \d+ times in a row over 1h.*not idle \(error\)/u) });
  });

  it("waits, and hands nothing back, when a carry already under way loses its transport", async () => {
    const worker = await fixOnMachineWithForeignTip();
    h.host.scripted.carryFinish = [Object.assign(new Error("transport failed"), { code: "transport_error" })];
    await queue();
    expect(h.host.callsTo("carryAbort")).toHaveLength(1);
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "merging", pushed_sha: "sq1" });
    expect(waitOf()).toMatchObject({ failures: 1, message: expect.stringContaining("transport failed; Loom left the worktree as it is") });
    expect(h.bb.sent(worker.thread_id!).join("\n")).not.toContain("transport failed");

    h.clock.advance(MINUTE);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
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
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: "lm1", message: `Merge ${ticket("CSV-1").pr_branch} into ${ticket("CSV-2").pr_branch}` });
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
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: "lm1", message: `Merge ${ticket("CSV-1").pr_branch} into ${ticket("CSV-2").pr_branch}` });
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
    expect(ticket()).toMatchObject({ state: "pr_open", retry_json: null });
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
    expect(mergePosts().filter((post) => post.body.includes("could not ask")).map((post) => post.body)).toEqual([`Loom could not ask alice to review the pull request again: ${DEADLINE}`]);
  });

  it("posts once, naming the after_open commands it did not run, and runs none again, when one got no answer", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", forge: { ...COMMAND_FORGE, after_open: ["ci-cli run", "ci-cli notify"] } }));
    await reachApproved(h);
    h.host.execResults = [new Error(DEADLINE)];
    await queue();
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "pr_open", retry_json: null });
    const failed = mergePosts().filter((post) => JSON.parse(post.data_json).outcome === "after_open_failed");
    expect(failed.map((post) => post.body)).toEqual([
      `The after_open command \`ci-cli run\` got no answer from the project's machine, so Loom cannot tell whether it ran, and does not run it again: ${DEADLINE} Loom did not run \`ci-cli notify\` after it either.\n\nThe pull request ${URL1} is open; nothing else changed.`,
    ]);
    await queue();
    expect(h.host.callsTo("exec").filter((input) => input.command.startsWith("ci-cli"))).toHaveLength(1);
  });

  it("waits out a push whose git process ran out of time on the machine", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", stack: false }));
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
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", stack: false, forge: COMMAND_FORGE }));
    await reachApproved(h);
    h.host.scripted.prCreate = [{ outcome: "unavailable", message: RATE_LIMITED, transient: "rate_limit" }];
    await queue();
    expect(waitOf()).not.toBeNull();
    await e.engine.block("CSV-1", "Not this way", "human");
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "Not this way", retry_json: null, merge_step_json: null });
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
    expect(ticket()).toMatchObject({ state: "cancelled", retry_json: null });
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
  const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", max_fix_rounds: 0, ...more });
  const readWait = () => retryOf(ticket(), "read");
  const commandForge = (doc: Doc) => {
    pr({ forge: { kind: "command", open: "review-cli open", state: "review-cli state" } })(doc);
    doc.checks.ci = false;
  };

  it("waits on the project's machine when the command forge's read ran out of time, and after an hour says so once more, never pausing", async () => {
    await seedProject(h, commandForge);
    await reachApproved(h);
    await queue();
    const deadline = "host plugin call cb6707d4-28ec-4bd7-b592-6f9d15ce5799 exceeded its deadline";
    h.host.errors.prState = new Error(deadline);
    await poll();
    expect(project().state).toBe("running");
    expect(readWait()).toMatchObject({ step: "read", failures: 1, message: deadline, kind: "unknown", scope: "host" });
    expect(systemPosts()).toEqual([
      `Reading the pull request of CSV-1 got no answer from the project's machine, so Loom cannot tell whether it ran: ${deadline}. Each step first checks what is already done, so nothing is done twice. Loom tries again in 5m, waiting longer after each failure up to 15m. A problem of the project's machine never blocks this ticket or pauses the project.`,
    ]);
    for (let i = 0; i < 6; i += 1) await poll(15);
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(ticket().state).toBe("pr_open");
    expect(systemPosts()).toHaveLength(2);
    expect(systemPosts()[1]).toMatch(/^Reading the pull request of CSV-1 has failed 5 times in a row over 1h, because of the project's machine/u);
  });

  it("waits for each ticket of a GitHub batch whose host worker crashed", async () => {
    await seedProject(h, pr(), "running");
    await reachApproved(h);
    await queue();
    h.host.scripted.prBatch = [new Error("host plugin worker exited (1)")];
    await poll();
    expect(project().state).toBe("running");
    expect(readWait()).toMatchObject({ failures: 1, message: "host plugin worker exited (1)" });
    await poll();
    expect(ticket().retry_json).toBeNull();
  });

  // LANE and OTLP paused after each Loom update: bb retired the old host plugin generation in the middle of a read.
  it.each([
    "host plugin loom generation b8fb7249-25dc-4876-a611-f5331fbe1ad8 is retired",
    "host plugin loom startup timed out",
    "host plugin worker exited (1)",
    "Host is not connected",
    "Host is suspended",
  ])("waits out a GitHub batch that got %s for as long as it lasts, never pausing or blocking", async (message) => {
    await seedProject(h, pr(), "running");
    await reachApproved(h);
    await queue();
    h.host.errors.prBatch = new Error(message);
    await poll();
    expect(project().state).toBe("running");
    expect(readWait()).toMatchObject({ failures: 1, message, scope: "host" });
    for (let i = 0; i < 8; i += 1) await poll(15);
    expect(project().state).toBe("running");
    expect(ticket().state).toBe("pr_open");
    h.host.errors.prBatch = null;
    await poll(15);
    expect(ticket().retry_json).toBeNull();
  });

  it.each([
    ["host plugin loom generation b8fb7249-25dc-4876-a611-f5331fbe1ad8 is retired", false],
    ["host plugin loom generation b8fb7249-25dc-4876-a611-f5331fbe1ad8 is retired", true],
    ["host plugin worker exited (0)", false],
    ["host plugin worker exited (0)", true],
  ])("abandons a batch before disposal runs: %s (previous read: %s)", async (message, previousRead) => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr(), "running");
    await reachApproved(h);
    await queue();
    await reachApproved(h, "CSV-2");
    await queue();
    h.store.updateTicket(ticket("CSV-2").id, { pr_url: "https://github.com/acme/other/pull/2" });
    if (previousRead) await poll();
    else h.store.updateTicket(ticket().id, { pr_checked_at: null });
    const before = [ticket(), ticket("CSV-2")];
    const posts = before.map((row) => h.store.posts(row.id));
    const answers = new Map(h.ctx.prReads?.last);
    const calls = h.host.calls.length;
    h.clock.advance(5 * MINUTE);
    h.host.before.prBatch = () => {
      expect(e.ctx.disposed()).toBe(false);
      throw new Error(message);
    };

    await e.engine.tick();

    for (const [index, row] of before.entries()) {
      expect(h.store.ticket(row.id)).toMatchObject({ state: "pr_open", retry_json: null, pr_checked_at: row.pr_checked_at });
      expect(h.store.posts(row.id)).toEqual(posts[index]);
    }
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(warnings("Reading the pull request")).toEqual([]);
    expect(h.host.calls.slice(calls).map((call) => call.method)).toEqual(["prBatch"]);
    expect(h.ctx.prReads?.last).toEqual(answers);
    await e.engine.dispose();

    delete h.host.before.prBatch;
    const fresh = new Engine({ store: h.store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects });
    await fresh.tick();

    expect(h.host.callsTo("prBatch").slice(-2).map((input) => input.name)).toEqual(["shop", "other"]);
    expect(ticket()).toMatchObject({ retry_json: null, pr_checked_at: h.clock.t });
    expect(ticket("CSV-2")).toMatchObject({ retry_json: null, pr_checked_at: h.clock.t });
    expect(project().state).toBe("running");
    await fresh.dispose();
  });

  it.each(["prBatch", "prState"] as const)("retries a live engine's clean worker stop on the next tick: %s", async (method) => {
    const e = makeEngine();
    h = e;
    await seedProject(h, method === "prState" ? commandForge : pr());
    await reachApproved(h);
    await queue();
    const checkedAt = ticket().pr_checked_at;
    const reads = h.host.callsTo(method).length;
    const posts = h.store.posts(ticket().id);
    const answers = new Map(h.ctx.prReads?.last);
    h.clock.advance(5 * MINUTE);
    h.host.scripted[method] = [new Error("host plugin worker exited (0)")];

    await e.engine.tick();

    expect(e.ctx.disposed()).toBe(false);
    expect(ticket()).toMatchObject({ state: "pr_open", retry_json: null, pr_checked_at: checkedAt });
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(h.store.posts(ticket().id)).toEqual(posts);
    expect(warnings("Reading the pull request")).toEqual([]);
    expect(h.host.callsTo(method)).toHaveLength(reads + 1);
    expect(h.ctx.prReads?.last).toEqual(answers);
    expect(h.bb.callsTo("log").filter(([level, message]) => level === "info" && String(message).includes("host plugin worker exited (0)"))).toHaveLength(1);
    h.clock.advance(15_000);
    await e.engine.tick();

    expect(h.host.callsTo(method)).toHaveLength(reads + 2);
    expect(ticket()).toMatchObject({ retry_json: null, pr_checked_at: h.clock.t });
    await e.engine.dispose();
  });

  it.each(["prState", "landedOn"] as const)("abandons a single read before disposal runs: %s", async (method) => {
    const e = makeEngine();
    h = e;
    await seedProject(h, method === "prState" ? commandForge : pr({ forge: { kind: "none" } }));
    await reachApproved(h);
    await queue();
    const checkedAt = ticket().pr_checked_at;
    const posts = h.store.posts(ticket().id);
    const answers = new Map(h.ctx.prReads?.last);
    let callsAtFailure = 0;
    h.clock.advance(5 * MINUTE);
    h.host.before[method] = () => {
      callsAtFailure = h.host.calls.length;
      expect(e.ctx.disposed()).toBe(false);
      throw new Error("host plugin loom generation x is retired");
    };

    await e.engine.tick();

    expect(e.ctx.disposed()).toBe(true);
    expect(ticket()).toMatchObject({ state: "pr_open", retry_json: null, pr_checked_at: checkedAt });
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(h.store.posts(ticket().id)).toEqual(posts);
    expect(warnings("Reading the pull request")).toEqual([]);
    expect(h.host.calls).toHaveLength(callsAtFailure);
    expect(h.ctx.prReads?.last).toEqual(answers);
    await e.engine.dispose();

    delete h.host.before[method];
    const fresh = new Engine({ store: h.store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects });
    await fresh.tick();
    expect(ticket()).toMatchObject({ retry_json: null, pr_checked_at: h.clock.t });
    await fresh.dispose();
  });

  it.each(["host", "hostDirect"] as const)("retires the engine before rethrowing from %s, even for a non-forge call", async (port) => {
    const e = makeEngine();
    const error = new Error("host plugin loom generation x is retired");
    e.host.errors.worktreeState = error;
    expect(e.ctx.disposed()).toBe(false);

    await expect(e.ctx[port].call("host_1", "worktreeState", { worktree: "/repo", base: "main" })).rejects.toBe(error);

    expect(e.ctx.disposed()).toBe(true);
    await e.engine.dispose();
  });

  it("does not change an existing retry or post when a live step loses a cleanly stopped worker", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    const before = ticket();
    const posts = h.store.posts(before.id);
    const logs = h.bb.callsTo("log").length;
    for (let i = 0; i < 2; i += 1) {
      expect(await stepFailed(h.ctx, before, "merge", new Error("host plugin worker exited (0)"), { what: "Merging CSV-1" })).toBe("wait");
    }

    expect(ticket()).toEqual(before);
    expect(h.store.posts(before.id)).toEqual(posts);
    expect(h.bb.callsTo("log").slice(logs)).toEqual([["info", expect.stringContaining("host plugin worker exited (0)")]]);
  });

  it("keeps a live engine running through a real host transport outage", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    h.host.errors.prBatch = Object.assign(new Error("Plugin RPC request failed"), { code: "transport_error" });
    for (let i = 0; i < 8; i += 1) {
      h.clock.advance(15 * MINUTE);
      await e.engine.tick();
    }
    expect(e.ctx.disposed()).toBe(false);
    expect(readWait()).toMatchObject({ failures: 8, scope: "host" });
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    h.host.errors.prBatch = null;
    h.clock.advance(15 * MINUTE);
    await e.engine.tick();
    expect(ticket().retry_json).toBeNull();
    await e.engine.dispose();
  });

  it.each([
    ["host plugin loom generation b8fb7249-25dc-4876-a611-f5331fbe1ad8 is retired", false],
    ["host plugin loom generation b8fb7249-25dc-4876-a611-f5331fbe1ad8 is retired", true],
    ["host plugin worker exited (0)", false],
    ["host plugin worker exited (0)", true],
  ])("leaves a disposed batch due for its replacement engine: %s (previous read: %s)", async (message, previousRead) => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr(), "running");
    await reachApproved(h);
    await queue();
    if (previousRead) await poll();
    else h.store.updateTicket(ticket().id, { pr_checked_at: null });
    const checkedAt = ticket().pr_checked_at;
    const reads = h.host.callsTo("prBatch").length;
    h.clock.advance(5 * MINUTE);
    h.host.before.prBatch = () => {
      void e.engine.dispose();
      throw new Error(message);
    };

    await e.engine.tick();

    expect(ticket()).toMatchObject({ state: "pr_open", retry_json: null, pr_checked_at: checkedAt });
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(systemPosts()).toEqual([]);
    expect(warnings("Reading the pull request")).toEqual([]);
    expect(h.host.callsTo("prBatch")).toHaveLength(reads + 1);

    delete h.host.before.prBatch;
    const fresh = new Engine({ store: h.store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects });
    await fresh.tick();

    expect(h.host.callsTo("prBatch")).toHaveLength(reads + 2);
    expect(ticket()).toMatchObject({ retry_json: null, pr_checked_at: h.clock.t });
    expect(project().state).toBe("running");
    await fresh.dispose();
  });

  it("leaves a disposed command forge read due for its replacement engine", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, commandForge);
    await reachApproved(h);
    await queue();
    const checkedAt = ticket().pr_checked_at;
    const reads = h.host.callsTo("prState").length;
    h.clock.advance(5 * MINUTE);
    h.host.before.prState = () => {
      void e.engine.dispose();
      throw new Error("host plugin loom generation 958cfa03-7186-47e3-9428-ffb4b2bff84f is retired");
    };

    await e.engine.tick();

    expect(ticket()).toMatchObject({ state: "pr_open", retry_json: null, pr_checked_at: checkedAt });
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(systemPosts()).toEqual([]);
    delete h.host.before.prState;
    const fresh = new Engine({ store: h.store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects });
    await fresh.tick();
    expect(h.host.callsTo("prState")).toHaveLength(reads + 2);
    expect(ticket().pr_checked_at).toBe(h.clock.t);
    await fresh.dispose();
  });

  it.each(["running", "paused"] as const)("stops a %s project's pass when disposed during its usage read", async (state) => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    if (state === "paused") h.store.setProjectState(project().id, "paused", "human");
    h.clock.advance(5 * MINUTE);
    const calls = h.host.calls.length;
    const usage = h.bb.threadUsage.bind(h.bb);
    h.bb.threadUsage = async (threadId) => {
      void e.engine.dispose();
      return usage(threadId);
    };

    await e.engine.tick();

    expect(h.host.calls).toHaveLength(calls);
    expect(project().state).toBe(state);
  });

  it.each(["host plugin worker exited (0)", "HTTP 401: Bad credentials", "a failure with no matching rule"])("does not record any step's failure after disposal: %s", async (message) => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    await e.engine.dispose();
    const before = ticket();
    const posts = h.store.posts(before.id);

    expect(await stepFailed(h.ctx, before, "merge", new Error(message), { what: "Merging CSV-1" })).toBe("wait");

    expect(ticket()).toEqual(before);
    expect(h.store.posts(before.id)).toEqual(posts);
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(warnings("Merging CSV-1")).toEqual([]);
  });

  it("waits out a command forge's read whose host plugin generation was retired, as during a plugin update", async () => {
    await seedProject(h, commandForge);
    await reachApproved(h);
    await queue();
    const retired = "host plugin loom generation 958cfa03-7186-47e3-9428-ffb4b2bff84f is retired";
    h.host.errors.prState = new Error(retired);
    await poll();
    expect(project().state).toBe("running");
    expect(readWait()).toMatchObject({ failures: 1, message: retired });
    h.host.errors.prState = null;
    await poll(5);
    expect(ticket().retry_json).toBeNull();
    expect(project().state).toBe("running");
  });

  it("blocks the ticket alone when the forge answers its read with a server error for an hour", async () => {
    await seedProject(h, pr(), "running");
    await reachApproved(h);
    await queue();
    h.host.scripted.prBatch = Array.from({ length: 20 }, () => ({ outcome: "unavailable" as const, message: "gh api graphql failed: gh: HTTP 502", transient: "server" as const }));
    await poll();
    expect(systemPosts()).toEqual([expect.stringContaining("and blocks this ticket only if it keeps failing for 1h")]);
    for (let i = 0; i < 5; i += 1) await poll(15);
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: expect.stringMatching(/^Reading the pull request of CSV-1 failed 5 times in a row over 1h: gh api graphql failed: gh: HTTP 502\. Loom blocked this ticket/u) });
  });

  it("still pauses on a read gh answered with a missing login, saying what to fix", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    const signedOut = "gh api graphql failed: To get started with GitHub CLI, please run: gh auth login";
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: signedOut }];
    await poll();
    expect(project()).toMatchObject({ state: "paused", system_reason: `Reading the pull request of CSV-1 stopped: ${signedOut}. Sign in on the project's machine (for gh, \`gh auth login\`; for git, the remote's credentials), then resume the project.` });
  });
});

describe("the review diff", () => {
  const reviewers = () => h.store.threads({ ticketId: ticket().id, role: "reviewer" });

  it("waits and tries again on the merge's steps when its read gets no answer, for as long as it lasts", async () => {
    await seedProject(h);
    await reachReview(h);
    h.host.errors.diff = new Error(DEADLINE);
    await spawnReviewers(h.ctx, project(), spec());
    expect(project().state).toBe("running");
    expect(reviewers()).toEqual([]);
    expect(systemPosts()).toEqual([
      `Reading the diff of CSV-1 for review got no answer from the project's machine, so Loom cannot tell whether it ran: ${DEADLINE}. Each step first checks what is already done, so nothing is done twice. Loom tries again in 1m, waiting longer after each failure up to 15m. A problem of the project's machine never blocks this ticket or pauses the project.`,
    ]);
    await spawnReviewers(h.ctx, project(), spec());
    expect(h.host.callsTo("diff")).toHaveLength(1);

    for (const minutes of [1, 2, 5, 10, 15, 15, 15]) {
      h.clock.advance(minutes * MINUTE);
      await spawnReviewers(h.ctx, project(), spec());
    }
    expect(h.host.callsTo("diff")).toHaveLength(8);
    expect(project().state).toBe("running");
    expect(ticket().state).toBe("review");
    expect(systemPosts()).toHaveLength(2);

    h.host.errors.diff = null;
    h.clock.advance(15 * MINUTE);
    await spawnReviewers(h.ctx, project(), spec());
    expect(reviewers()).toHaveLength(1);
    expect(ticket().retry_json).toBeNull();
  });

  it("starts the reviewer once a read works, and blocks the ticket alone on a diff git cannot make", async () => {
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
    expect(project().state).toBe("running");
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: "Reading the diff of CSV-1 for review failed, and trying again would not help: git diff --stat --no-color main...c1 -- failed (128): fatal: bad revision." });
  });
});

describe("the retry wait on the page", () => {
  it("is on the waiting ticket's board card, and on no other", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    const cards = boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec());
    expect(cards.find((card) => card.key === "CSV-1")!.retry).toEqual({ step: "merge", failures: 1, since: h.clock.t, until: h.clock.t + MINUTE, message: DEADLINE, kind: "unknown" });
    expect(cards.find((card) => card.key === "CSV-2")!.retry).toBeNull();
  });
});
