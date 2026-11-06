// The rules the forward fixes kept coming back to, as scenarios over the fakes: a side effect on a pull request (a push,
// an after_push command, a review request, a merge post) belongs to the commit Loom pushed and happens once, even when
// Loom restarts in the middle of the merge, the restack or the fix round; and work that goes back to a worker reaches it
// once, whether the worker is live, released, or lost its environment.
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import { specOf, type EngineCtx } from "../src/ctx";
import { Store, type ThreadRow } from "../src/db/store";
import { readBehind } from "../src/fresh";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { Projects } from "../src/projects";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { advanceWakes, isReleased, releaseIdleWorkers } from "../src/release";
import { deliverHandBacks } from "../src/slots";
import { approve, requestChanges, settleReviews, spawnReviewers } from "../src/review";
import { checkOutHead, makeCtx, reachApproved, reachReview, seedProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

const DEADLINE = "host plugin call 1f46e1e1-6061-4d69-81e2-afb2e9ac216c exceeded its deadline";
const URL1 = "https://github.com/acme/shop/pull/1";

let h: EngineHarness & { db: ReturnType<typeof makeCtx>["db"] };
beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const outcomes = (key = "CSV-1") => h.store.posts(ticket(key).id).flatMap((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome ?? []);
const hooks = () => h.host.callsTo("exec").filter((call) => call.command === "ci start");
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};

/** Loom restarts: a new store over the same database, and none of the engine's memory, as after a plugin reload. */
function restart(): void {
  const store = new Store(h.db, h.clock.now);
  const ctx: EngineCtx = { ...h.ctx, store, forgeBackoffs: new Map() };
  h = { ...h, store, ctx, projects: new Projects({ store, bb: h.bb, now: h.clock.now, host: h.host }) };
}

async function prProject(more: Doc = {}): Promise<void> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr", forge: { kind: "gh", after_push: ["ci start"] }, ...more };
    doc.ticket[1].depends_on = [];
  });
}

/** CSV-1's pull request opened at sq1; alice asked for changes, the worker made them and the reviewers approved: CSV-1 waits for its push. */
async function fixRoundApproved(): Promise<ThreadRow> {
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
  await queue();
  expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq1", pr_url: URL1 });
  h.host.feedback.set(URL1, { items: [{ key: "review:1:a", kind: "review", author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] });
  await poll();
  expect(ticket().state).toBe("working");
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/a.ts"];
  submit(h.ctx, worker.thread_id!, "Renamed it.");
  await settleChecks(h.ctx);
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "The fix holds.");
  await settleReviews(h.ctx);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
  expect(ticket().state).toBe("approved");
  return h.store.thread(worker.id)!;
}

describe("a fix round's push when Loom restarts in the middle of it", () => {
  it("pushes the same commit again, and runs after_push, asks for reviews and posts the push once", async () => {
    await prProject();
    await fixRoundApproved();
    const before = { hooks: hooks().length, asks: h.host.callsTo("prRequestReview").length };
    h.host.lost.push = [new Error(DEADLINE)];
    await queue();
    expect(ticket().state).toBe("merging");
    expect(ticket().pushed_sha).toBe("sq1");

    restart();
    h.clock.advance(60_000);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    expect(h.host.callsTo("push").map((call) => call.src)).toEqual(["sq1", "sq2", "sq2"]);
    expect(hooks().slice(before.hooks)).toEqual([expect.objectContaining({ env: expect.objectContaining({ LOOM_SHA: "sq2" }) })]);
    expect(h.host.callsTo("prRequestReview").slice(before.asks)).toEqual([expect.objectContaining({ url: URL1, reviewers: ["alice"] })]);
    expect(outcomes().filter((outcome) => outcome === "pr_pushed")).toHaveLength(1);

    restart();
    await queue();
    await poll();
    expect(hooks().slice(before.hooks)).toHaveLength(1);
    expect(h.host.callsTo("prRequestReview").slice(before.asks)).toHaveLength(1);
    expect(h.host.callsTo("push")).toHaveLength(3);
  });
});

describe("a refresh of an open pull request when Loom restarts in the middle of it", () => {
  it("finishes the merge it already put in the worker's worktree, checks it once and pushes it once", async () => {
    await prProject({ describe: "loom", refresh_behind: 5000 });
    const worker = await reachApproved(h);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq1" });
    await poll();
    const head = ticket().head_sha!;
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 6_000);
    await readBehind(h.ctx, project(), spec());
    h.host.lost.resetHard = [new Error(DEADLINE)];
    await queue();
    expect(ticket()).toMatchObject({ state: "merging", head_sha: head });
    expect(JSON.parse(ticket().merge_step_json!)).toMatchObject({ kind: "restack", from: head, sha: "lm1" });
    const merges = h.host.callsTo("mergeOnto").length;
    const checks = h.host.callsTo("exec").filter((call) => call.command === "npm test").length;

    restart();
    h.clock.advance(2 * 60_000);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: "lm1", pushed_sha: "sq2", merge_step_json: null });
    expect(h.host.callsTo("mergeOnto")).toHaveLength(merges);
    expect(h.host.callsTo("exec").filter((call) => call.command === "npm test" && call.cwd === `/wt/${worker.environment_id}`)).toHaveLength(checks + 1);
    expect(hooks()).toEqual([expect.objectContaining({ env: expect.objectContaining({ LOOM_SHA: "sq2" }) })]);

    restart();
    await queue();
    expect(h.host.callsTo("push").map((call) => call.src)).toEqual(["sq1", "sq2"]);
    expect(hooks()).toHaveLength(1);
  });
});

describe("work that goes back to the ticket's worker", () => {
  it("reaches a live worker once, when the send failed and Loom restarted before it tried again", async () => {
    await prProject();
    const worker = await reachApproved(h);
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
    await queue();
    const sent = () => h.bb.sent(worker.thread_id!).filter((text) => text.includes("fix round 1"));
    h.bb.sendError = new Error("bb is restarting");
    h.host.feedback.set(URL1, { items: [{ key: "review:1:a", kind: "review", author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] });
    await poll();
    expect(ticket().state).toBe("working");
    expect(ticket().handback_json).not.toBeNull();
    expect(sent()).toHaveLength(1);

    h.bb.sendError = null;
    restart();
    await deliverHandBacks(h.ctx, project().id);
    expect(sent()).toHaveLength(2);
    expect(ticket().handback_json).toBeNull();
    await deliverHandBacks(h.ctx, project().id);
    restart();
    await deliverHandBacks(h.ctx, project().id);
    expect(sent()).toHaveLength(2);
  });

  it("reaches a released worker once, after Loom restarted while bb restored its environment", async () => {
    await prProject();
    const worker = await reachApproved(h);
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
    await queue();
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    await releaseIdleWorkers(h.ctx, project(), spec());
    expect(isReleased(h.store.thread(worker.id)!)).toBe(true);
    h.bb.environments.get(worker.environment_id!)!.status = "destroyed";
    const sent = () => h.bb.sent(worker.thread_id!).filter((text) => text.includes("Rename the column."));

    h.bb.restoreResult = "provisioning";
    h.host.feedback.set(URL1, { items: [{ key: "review:1:a", kind: "review", author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1, worker_thread_id: worker.thread_id });
    expect(sent()).toEqual([]);

    restart();
    h.bb.environments.get("env_r1")!.status = "ready";
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    await advanceWakes(h.ctx, project().id);
    await deliverHandBacks(h.ctx, project().id);
    expect(sent()).toHaveLength(1);
    restart();
    await advanceWakes(h.ctx, project().id);
    await deliverHandBacks(h.ctx, project().id);
    expect(sent()).toHaveLength(1);
    expect(h.bb.callsTo("restoreEnvironment")).toEqual([[worker.thread_id]]);
  });
});

describe("the work a reviewer judges", () => {
  it("is the reviewed tree, not a commit id: another commit with that tree passes, and other work does not, across a restart", async () => {
    await seedProject(h);
    await reachReview(h);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    const tree = ticket().head_tree!;
    expect(tree).not.toBeNull();
    restart();
    const worktree = h.host.worktree(`/wt/${reviewer.environment_id}`);
    worktree.head = "carried1";
    h.host.trees.set("carried1", "other-tree");
    await expect(approve(h.ctx, reviewer.thread_id!, "Looks right.")).rejects.toThrow(/Call loom_checkout first/u);
    h.host.trees.set("carried1", tree);
    await approve(h.ctx, reviewer.thread_id!, "Looks right.");
    await settleReviews(h.ctx);
    expect(ticket().state).toBe("approved");
  });

  it("refuses changes requested on other work than the reviewed tree", async () => {
    await seedProject(h);
    await reachReview(h);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    h.host.worktree(`/wt/${reviewer.environment_id}`).head = "elsewhere1";
    await expect(requestChanges(h.ctx, reviewer.thread_id!, "Wrong.", [{ severity: "blocking", title: "Wrong work", detail: "No.", file: "src/model/a.ts", line: 1 }])).rejects.toThrow(/Call loom_checkout first/u);
  });
});

describe("the base a ticket's own work is measured from", () => {
  it("is the commit a stacked ticket started on, kept across a restart, and the repo's base for one that is not stacked", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    expect(ticket("CSV-1")).toMatchObject({ state: "pr_open", pushed_sha: "sq1" });
    const own = h.host.callsTo("worktreeState").filter((input) => input.worktree === "/wt/env_1");
    expect(own.map((input) => input.base)).toContain("origin/main");

    const worker = await startWorker(h, "CSV-2");
    restart();
    const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
    worktree.dirty = true;
    worktree.changed = ["src/export/a.ts"];
    h.host.calls = [];
    submit(h.ctx, worker.thread_id!, "Done");
    await settleChecks(h.ctx);
    expect(ticket("CSV-2").state).toBe("review");
    expect(h.host.callsTo("worktreeState").filter((input) => input.worktree === `/wt/${worker.environment_id}`).map((input) => input.base)).toEqual(expect.arrayContaining(["sq1"]));
    expect(h.host.callsTo("worktreeState").map((input) => input.base)).not.toContain("origin/main");
  });
});

