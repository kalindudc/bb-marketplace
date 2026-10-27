// Commits someone else pushed to the pull request branch of a ticket whose worker runs on a machine of its own, which
// can neither fetch that branch nor keep a merge of it: Loom merges them on the project's checkout and carries the result.
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { isReleased, releaseIdleWorkers } from "../src/release";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { stackOf } from "../src/stack";
import { resumeWork, spawnWorker, specOf } from "../src/workers";
import { checkOutHead, makeCtx, reachApproved, seedMachineProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL1 = "https://github.com/acme/shop/pull/1";
const HOME = "refs/heads/loom/csv/csv-1-home";
const REVIEWED = "refs/loom/csv/csv-1/reviewed";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const worktreeOf = (row: ThreadRow) => `/wt/${h.store.thread(row.id)!.environment_id}`;
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const outcomes = (key = "CSV-1") => h.store.posts(ticket(key).id).flatMap((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome ?? []);
const dataOf = (outcome: string, key = "CSV-1") =>
  h.store
    .posts(ticket(key).id)
    .map((post) => ({ post, data: JSON.parse(post.data_json) as Record<string, any> }))
    .filter(({ data }) => data.outcome === outcome);
const changesRequested = { items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] };

/** CSV-1's worker on a machine of its own, with its pull request open at sq1, whose branch someone then pushed theirs1 to. */
async function openOnMachine(more: Doc = {}): Promise<ThreadRow> {
  await seedMachineProject(h, (doc) => (doc.merge = { strategy: "pr", stack: false, ...more }));
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
  await queue();
  expect(ticket()).toMatchObject({ state: "pr_open", head_sha: "home1", head_tree: "c1", pushed_sha: "sq1" });
  h.bb.threads.get(worker.thread_id!)!.status = "idle";
  return h.store.thread(worker.id)!;
}

function pushedByOthers(): void {
  h.host.foreign.set(ticket().pr_branch!, "theirs1");
  h.host.ancestry.add("sq1..theirs1");
}

/** The worker fixes, submits from its machine, a reviewer approves and the worker hands in its commit message. */
async function fixAndApprove(worker: ThreadRow): Promise<void> {
  const worktree = h.host.worktree(worktreeOf(worker));
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
}

describe("a fix round whose pull request branch has commits Loom did not push, on a machine", () => {
  it("merges them into the head on the checkout against Loom's last push, carries the result to the live worker, and builds the next push on them", async () => {
    const worker = await openOnMachine({ release_workers: false });
    pushedByOthers();
    h.host.feedback.set(URL1, { ...changesRequested, head: "theirs1" });
    await poll();

    expect(h.host.callsTo("mergeOnto")).toEqual([{ repo: "/repo", head: "home1", ref: "theirs1", base: "sq1", message: "Merge the new commits on the pull request's branch into CSV-1 (Loom)", refs: [] }]);
    const merged = ticket().head_sha!;
    expect(h.host.callsTo("carryStart").at(-1)).toMatchObject({ worktree: worktreeOf(worker), replaces: "c1", tree: `${merged}-tree` });
    expect(h.host.callsTo("pointRefs")).toEqual([{ repo: "/repo", sha: merged, refs: [HOME, REVIEWED] }]);
    expect(ticket()).toMatchObject({ state: "working", head_tree: `${merged}-tree`, pushed_sha: "theirs1" });
    expect(dataOf("tip_merged")[0]!.data).toMatchObject({ tip: "theirs1", sha: merged, carried: true });
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("Loom merged them into your branch on the project's machine");
    expect(sent).not.toContain("git fetch");
    expect(sent).not.toContain("git merge");

    await fixAndApprove(worker);
    await queue();
    expect(h.host.callsTo("mergeOnto")).toHaveLength(1);
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ pushed: "theirs1", message: "Rename the column" });
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    expect(outcomes().slice(-2)).toEqual(["pr_pushed", "review_requested"]);
  });

  it("leaves the merge on the home branch for a released worker, whose replacement resumes from it", async () => {
    const worker = await openOnMachine();
    await releaseIdleWorkers(h.ctx, project(), spec());
    expect(isReleased(h.store.thread(worker.id))).toBe(true);
    h.bb.environments.get(worker.environment_id!)!.status = "destroyed";
    h.bb.restorable = false;
    pushedByOthers();
    h.host.feedback.set(URL1, { ...changesRequested, head: "theirs1" });
    const carries = h.host.callsTo("carryStart").length;
    await poll();

    const merged = ticket().head_sha!;
    expect(merged).toMatch(/^lm/u);
    expect(h.host.callsTo("carryStart")).toHaveLength(carries);
    expect(h.host.refs.get(HOME)).toBe(merged);
    expect(ticket()).toMatchObject({ state: "queued", pushed_sha: "theirs1" });
    expect(dataOf("tip_merged")[0]!.data).toMatchObject({ carried: false });

    const next = await startWorker(h);
    expect(JSON.parse(next.resume_json!)).toMatchObject({ sha: merged, tree: `${merged}-tree` });
    await resumeWork(h.ctx, next.thread_id!);
    expect(h.host.callsTo("exportChanges").at(-1)).toMatchObject({ head: merged });
  });

  it("tells the worker Loom merges them when it pushes, when the carry cannot go in, and changes nothing", async () => {
    const worker = await openOnMachine({ release_workers: false });
    pushedByOthers();
    h.host.scripted.carryStart = [{ outcome: "unavailable", message: "The worktree has uncommitted changes" }];
    h.host.feedback.set(URL1, { ...changesRequested, head: "theirs1" });
    await poll();

    expect(ticket()).toMatchObject({ state: "working", head_sha: "home1", pushed_sha: "sq1" });
    expect(h.host.callsTo("pointRefs")).toEqual([]);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("when Loom pushes your fix, it merges them into your branch first");
  });
});

describe("a push whose pull request branch got commits Loom did not push, on a machine", () => {
  it("merges them on the checkout, carries the result in, runs the checks there and pushes on them, with no new review", async () => {
    const worker = await openOnMachine({ release_workers: false });
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    await fixAndApprove(worker);
    const head = ticket().head_sha!;
    const tree = ticket().head_tree!;
    const reviewers = h.store.threads({ role: "reviewer" }).length;
    pushedByOthers();
    await queue();

    expect(h.host.callsTo("mergeOnto")).toEqual([{ repo: "/repo", head, ref: "theirs1", base: "sq1", message: "Merge the new commits on the pull request's branch into CSV-1 (Loom)", refs: [] }]);
    const merged = ticket().head_sha!;
    expect(h.host.callsTo("carryStart").at(-1)).toMatchObject({ worktree: worktreeOf(worker), replaces: tree });
    expect(h.host.callsTo("pointRefs").at(-1)).toEqual({ repo: "/repo", sha: merged, refs: [HOME, REVIEWED] });
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: worktreeOf(worker) });
    expect(h.host.callsTo("resetHard")).toEqual([]);
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: merged, pushed: "theirs1" });
    expect(ticket()).toMatchObject({ state: "pr_open", head_tree: `${merged}-tree`, pushed_sha: "sq2" });
    expect(outcomes().slice(-3)).toEqual(["restacked", "pr_pushed", "review_requested"]);
    expect(h.store.threads({ role: "reviewer" })).toHaveLength(reviewers);
  });

  it("carries a conflict in with its markers and sends it back, building the next merge on the tip", async () => {
    const worker = await openOnMachine({ release_workers: false });
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    await fixAndApprove(worker);
    const pushes = h.host.callsTo("push").length;
    pushedByOthers();
    h.host.scripted.mergeOnto = [{ outcome: "conflict", files: ["src/model/a.ts"], sha: "cf1", tree: "cf1-tree" }];
    await queue();

    expect(ticket()).toMatchObject({ state: "working", pushed_sha: "theirs1", check_failures: 0 });
    expect(stackOf(ticket())).toMatchObject({ markers: ["src/model/a.ts"] });
    expect(h.host.callsTo("exportChanges").at(-1)).toMatchObject({ head: "cf1" });
    expect(h.host.callsTo("pointRefs").at(-1)).toEqual({ repo: "/repo", sha: "cf1", refs: [HOME] });
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("conflict markers");
    expect(sent).not.toContain("git merge");
  });

  it("sends a failing check on the merge back to the worker, counting it, with the merge kept in its worktree", async () => {
    const worker = await openOnMachine({ release_workers: false });
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    await fixAndApprove(worker);
    pushedByOthers();
    h.host.execResults = [{ exitCode: 1, output: "1 failing" }];
    await queue();

    expect(ticket()).toMatchObject({ state: "working", pushed_sha: "theirs1", check_failures: 1 });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Loom merged the new commits on the pull request's branch into your branch, and then the check");
  });
});

describe("a stacked ticket whose pull request branch got base branch commits its stack base lacks, on a machine", () => {
  /** CSV-2 stacked on CSV-1's open pull request, both on machines of their own, CSV-2's pull request open too. */
  async function stacked(): Promise<ThreadRow> {
    await seedMachineProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h, "CSV-1");
    await queue();
    await spawnWorker(h.ctx, project(), spec(), ticket("CSV-2"));
    const worker = h.store.threads({ ticketId: ticket("CSV-2").id, role: "worker" }).at(-1)!;
    await resumeWork(h.ctx, worker.thread_id!);
    const worktree = h.host.worktree(worktreeOf(worker));
    worktree.dirty = true;
    worktree.changed = ["src/export/a.ts"];
    submit(h.ctx, worker.thread_id!, "Done");
    await settleChecks(h.ctx);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket("CSV-2").id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Looks good");
    await settleReviews(h.ctx);
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    return h.store.thread(worker.id)!;
  }

  it("waits for the push at the fix round, then takes the base branch into its stack base before it merges them", async () => {
    const worker = await stacked();
    const branch = ticket("CSV-2").pr_branch!;
    h.host.foreign.set(branch, "theirs1");
    h.host.ancestry.add("sq2..theirs1");
    h.host.tipBases.set("theirs1", "main9");
    h.host.feedback.set("https://github.com/acme/shop/pull/2", { ...changesRequested, head: "theirs1" });
    await poll();

    expect(ticket("CSV-2")).toMatchObject({ state: "working", pushed_sha: "sq2" });
    expect(h.host.callsTo("mergeOnto")).toEqual([]);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("when Loom pushes your fix, it merges them into your branch first");

    const worktree = h.host.worktree(worktreeOf(worker));
    worktree.dirty = true;
    worktree.changed = ["src/export/a.ts"];
    submit(h.ctx, worker.thread_id!, "Renamed it.");
    await settleChecks(h.ctx);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket("CSV-2").id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Fixed");
    await settleReviews(h.ctx);
    h.host.remoteBase = "base001";
    h.host.calls = [];
    await queue();

    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ commits: ["sq1"], base: { remote: "origin", branch: "main" } });
    const merges = h.host.callsTo("mergeOnto");
    expect(merges.map((call) => call.ref)).toEqual([h.host.stackBranches.get("loom/csv/csv-2-stack"), "theirs1"]);
    expect(merges[1]).toMatchObject({ base: "sq2" });
    expect(stackOf(ticket("CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq1" } });
    expect(outcomes("CSV-2").slice(-4)).toEqual(["restacked", "restacked", "pr_pushed", "review_requested"]);
  });
});
