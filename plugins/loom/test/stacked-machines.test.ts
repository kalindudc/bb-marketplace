import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { reviewerBrief, workerBrief } from "../src/prompts";
import { isReleased, releaseIdleWorkers } from "../src/release";
import { approve, checkOutReview, settleReviews, spawnReviewers } from "../src/review";
import { stackOf } from "../src/stack";
import { resumeWork, specOf } from "../src/workers";
import { checkOutHead, makeCtx, reachApproved, seedMachineProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL1 = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const spawns = () => h.bb.callsTo("spawnThread").map(([args]) => args as SpawnArgs);
const outcomes = (key: string) => h.store.posts(ticketOf(h, key).id).flatMap((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome ?? []);
const worktreeOf = (row: ThreadRow) => `/wt/${h.store.thread(row.id)!.environment_id}`;
const onHost = (row: ThreadRow) => h.bb.environments.get(h.store.thread(row.id)!.environment_id!)!.hostId;
const callsOn = (hostId: string) => h.host.calls.filter((call) => call.hostId === hostId).map((call) => call.method);

/** Every worker and reviewer on a new machine, stacking pull requests; CSV-1's pull request is open at sq1. */
async function openFirst(edit?: (doc: Doc) => void): Promise<void> {
  await seedMachineProject(h, (doc) => {
    doc.merge = { strategy: "pr", describe: "loom" };
    edit?.(doc);
  });
  await reachApproved(h, "CSV-1");
  await queue();
  expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pushed_sha: "sq1", pr_url: URL1 });
}

/** CSV-2's worker on its machine, after loom_resume put CSV-1's pull request in its worktree, with changes of its own. */
async function startSecond(): Promise<ThreadRow> {
  const { spawnWorker } = await import("../src/workers");
  await spawnWorker(h.ctx, project(), spec(), ticketOf(h, "CSV-2"));
  const row = h.store.threads({ ticketId: ticketOf(h, "CSV-2").id, role: "worker" }).at(-1)!;
  await resumeWork(h.ctx, row.thread_id!);
  const worktree = h.host.worktree(worktreeOf(row));
  worktree.dirty = true;
  worktree.changed = ["src/export/a.ts"];
  return h.store.thread(row.id)!;
}

function dirty(row: ThreadRow): void {
  const worktree = h.host.worktree(worktreeOf(row));
  worktree.dirty = true;
  worktree.changed = ["src/model/b.ts"];
}

async function submitted(row: ThreadRow): Promise<void> {
  submit(h.ctx, row.thread_id!, "Done");
  await settleChecks(h.ctx);
}

/** CSV-2 reviewed on a machine of its own, approved, and its pull request open on CSV-1's branch. */
async function stacked(): Promise<ThreadRow> {
  await openFirst();
  const worker = await startSecond();
  await submitted(worker);
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticketOf(h, "CSV-2").id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "Looks good");
  await settleReviews(h.ctx);
  await queue();
  expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
  return h.store.thread(worker.id)!;
}

describe("a stacked ticket on a machine of its own", () => {
  it("starts at the fresh base on its machine, and loom_resume carries in its dependency's pull request commit", async () => {
    await openFirst();
    const { spawnWorker } = await import("../src/workers");
    await spawnWorker(h.ctx, project(), spec(), ticketOf(h, "CSV-2"));
    const row = h.store.threads({ ticketId: ticketOf(h, "CSV-2").id, role: "worker" }).at(-1)!;

    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ commits: ["sq1"] });
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq1" }, base: "sq1" });
    expect(spawns().at(-1)!.baseBranch).toBe("origin/main");
    expect(JSON.parse(row.resume_json!)).toMatchObject({ sha: "sq1" });
    expect(spawns().at(-1)!.prompt).toContain("## First step");

    await resumeWork(h.ctx, row.thread_id!);
    expect(h.store.thread(row.id)!.resume_json).toBeNull();
    expect(h.host.callsTo("exportChanges").at(-1)).toMatchObject({ head: "sq1" });
    expect(callsOn(onHost(row))).toContain("carryFinish");
  });

  it("measures its scope from the tree of the commit it is stacked on, and brings its work home on that commit", async () => {
    await openFirst();
    const worker = await startSecond();
    h.host.calls = [];
    await submitted(worker);

    const states = h.host.calls.filter((call) => call.method === "worktreeState").map((call) => call.input as { worktree: string; base: string; baseTree?: string });
    expect(states.filter((state) => state.worktree === worktreeOf(worker))).toEqual(expect.arrayContaining([{ worktree: worktreeOf(worker), base: "origin/main", baseTree: h.host.trees.get("sq1") }]));
    expect(h.host.callsTo("refTip")).toContainEqual({ repo: "/repo", ref: "sq1" });
    expect(h.host.callsTo("importCommit").at(-1)).toMatchObject({ parent: "sq1", refs: ["refs/heads/loom/csv/csv-2-home", "refs/loom/csv/csv-2/reviewed"] });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "review", head_sha: expect.stringMatching(/^home/u) });
  });

  it("refuses a submit whose branch no longer holds the commit it is stacked on, and brings nothing home", async () => {
    await openFirst();
    const worker = await startSecond();
    h.host.worktree(worktreeOf(worker)).onBase = false;
    h.host.calls = [];
    await submitted(worker);

    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 1 });
    expect(h.store.posts(ticketOf(h, "CSV-2").id).filter((post) => post.kind === "check").at(-1)!.body).toContain("FAIL scope check");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("no longer has the commit Loom put first");
    expect(h.host.callsTo("importCommit")).toEqual([]);
  });

  it("is reviewed against the commit it is stacked on, and its pull request opens on its dependency's branch", async () => {
    await openFirst();
    const worker = await startSecond();
    await submitted(worker);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticketOf(h, "CSV-2").id, role: "reviewer" }).at(-1)!;
    expect(h.host.callsTo("diff").at(-1)).toMatchObject({ base: "sq1", head: ticketOf(h, "CSV-2").head_sha });
    await checkOutReview(h.ctx, reviewer.thread_id!);
    h.host.calls = [];
    await approve(h.ctx, reviewer.thread_id!, "Looks good");
    await settleReviews(h.ctx);
    expect(h.host.callsTo("worktreeState")).toEqual([{ worktree: worktreeOf(reviewer), base: "origin/main" }]);
    expect(ticketOf(h, "CSV-2").state).toBe("approved");

    await queue();
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ base: "sq1", head: ticketOf(h, "CSV-2").head_sha });
    expect(h.host.callsTo("prCreate").at(-1)).toMatchObject({ base: ticketOf(h, "CSV-1").pr_branch });
  });

  it("keeps its worker, and so its machine, while a dependency is open, and lets it go once every dependency merged", async () => {
    const worker = await stacked();
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    await releaseIdleWorkers(h.ctx, project(), spec());
    expect(isReleased(h.store.thread(worker.id))).toBe(false);

    h.host.prStates.set(URL1, "MERGED");
    await poll();
    h.host.remoteBase = "base001";
    await queue();
    expect(ticketOf(h, "CSV-2").pr_base).toBe("main");
    await releaseIdleWorkers(h.ctx, project(), spec());
    expect(isReleased(h.store.thread(worker.id))).toBe(true);
  });
});

describe("catching up with the dependency on a machine", () => {
  it("merges the dependency's new commit on the project's checkout, carries the result in, runs the checks there and pushes, with no new review", async () => {
    const worker = await stacked();
    const before = ticketOf(h, "CSV-2");
    const reviewers = h.store.threads({ role: "reviewer" }).length;
    h.host.calls = [];
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();

    const ticket = ticketOf(h, "CSV-2");
    expect(h.host.callsTo("merge")).toEqual([]);
    expect(h.host.callsTo("mergeOnto")).toEqual([{ repo: "/repo", head: before.head_sha, ref: "sq7", message: "Merge CSV-1's pull request into CSV-2 (Loom)", refs: ["refs/heads/loom/csv/csv-2-home", "refs/loom/csv/csv-2/reviewed"] }]);
    expect(h.host.callsTo("carryStart").at(-1)).toMatchObject({ worktree: worktreeOf(worker), replaces: before.head_tree });
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: worktreeOf(worker), command: "npm test" });
    expect(ticket).toMatchObject({ state: "pr_open", head_sha: "lm1", head_tree: "lm1-tree", pr_rounds: 0 });
    expect(stackOf(ticket)).toMatchObject({ deps: { "CSV-1": "sq7" }, base: "sq7" });
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ base: "sq7", head: "lm1" });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ branch: ticket.pr_branch });
    expect(outcomes("CSV-2").slice(-2)).toEqual(["restacked", "pr_pushed"]);
    expect(h.store.threads({ role: "reviewer" })).toHaveLength(reviewers);
  });

  it("follows the dependency's fix round for a failed CI check: once that fix is pushed, the dependent's branch and pull request move onto it", async () => {
    await stacked();
    const first = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "worker" }).at(-1)!;
    h.host.feedback.set(URL1, { checks: [{ key: "check:9", name: "integration tests", state: "failed", url: "https://ci/9" }] });
    await poll();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(h.bb.sent(first.thread_id!).at(-1)).toContain("integration tests");

    dirty(first);
    await submitted(first);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Fixed");
    await settleReviews(h.ctx);
    h.host.calls = [];
    await queue();
    const fixed = ticketOf(h, "CSV-1").pushed_sha!;
    expect(fixed).not.toBe("sq1");
    await queue();

    expect(h.host.callsTo("mergeOnto").at(-1)).toMatchObject({ ref: fixed });
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: { "CSV-1": fixed }, base: fixed });
    expect(outcomes("CSV-2").slice(-2)).toEqual(["restacked", "pr_pushed"]);
  });

  it("takes the base branch once the dependency merges, and moves the pull request to it", async () => {
    await stacked();
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    h.host.remoteBase = "base001";
    await queue();

    expect(h.host.callsTo("mergeOnto").at(-1)).toMatchObject({ ref: "base001" });
    expect(h.host.callsTo("prRetarget")).toEqual([{ repo: "/repo", url: "https://github.com/acme/shop/pull/2", base: "main", forge: { kind: "gh" } }]);
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: {}, base: "base001" });
  });

  it("carries a conflict in with its markers, sends it back, and refuses a submit until the markers are gone", async () => {
    const worker = await stacked();
    const pushes = h.host.callsTo("push").length;
    h.host.scripted.mergeOnto = [{ outcome: "conflict", files: ["src/export/a.ts"], sha: "cf1", tree: "cf1-tree" }];
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();

    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 0 });
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq7" }, base: "sq7", markers: ["src/export/a.ts"] });
    expect(h.host.callsTo("exportChanges").at(-1)).toMatchObject({ head: "cf1" });
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("conflict markers");
    expect(sent).toContain("src/export/a.ts");
    expect(sent).not.toContain("git merge");

    const worktree = h.host.worktree(worktreeOf(worker));
    worktree.dirty = true;
    h.host.scripted.conflictMarkers = [{ files: ["src/export/a.ts"] }];
    const imports = h.host.callsTo("importCommit").length;
    const runs = h.host.callsTo("exec").length;
    await submitted(worker);
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 1 });
    expect(h.store.posts(ticketOf(h, "CSV-2").id).filter((post) => post.kind === "check").at(-1)!.body).toContain("FAIL conflict check");
    expect(h.host.callsTo("importCommit")).toHaveLength(imports);
    expect(h.host.callsTo("exec")).toHaveLength(runs);

    worktree.dirty = true;
    await submitted(worker);
    expect(h.host.callsTo("conflictMarkers").at(-1)).toEqual({ worktree: worktreeOf(worker), paths: ["src/export/a.ts"] });
    expect(ticketOf(h, "CSV-2").state).toBe("review");
    expect(h.host.callsTo("importCommit").at(-1)).toMatchObject({ parent: "sq7" });
    expect(stackOf(ticketOf(h, "CSV-2"))!.markers).toBeUndefined();
    expect(h.host.callsTo("push")).toHaveLength(pushes);
  });

  it("sends a failing check on the carried result back to the worker, and pushes nothing", async () => {
    const worker = await stacked();
    const pushes = h.host.callsTo("push").length;
    h.host.execResults = [{ exitCode: 1, output: "1 test failed" }];
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();

    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 1 });
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq7" }, base: "sq7" });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Loom merged CSV-1's pull request into your branch, and then the check \"npm test\" exited with 1");
    expect(h.host.callsTo("push")).toHaveLength(pushes);
  });

  it("sends the work back, pushing nothing, when the worker's worktree holds other work than the reviewed one", async () => {
    const worker = await stacked();
    const pushes = h.host.callsTo("push").length;
    h.host.scripted.carryStart = [{ outcome: "unavailable", message: "The worktree /wt/x has uncommitted changes, so Loom cannot put the work in it: notes.txt. Stash or discard them, then try again" }];
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();

    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 0 });
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq1" } });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("notes.txt");
    expect(h.host.callsTo("push")).toHaveLength(pushes);
  });
});

describe("the briefs of a stacked ticket on a machine of its own", () => {
  it("tells its first worker that loom_resume puts its dependency's pull request in first, and to keep that commit", async () => {
    await openFirst();
    const { spawnWorker } = await import("../src/workers");
    await spawnWorker(h.ctx, project(), spec(), ticketOf(h, "CSV-2"));
    const brief = spawns().at(-1)!.prompt;
    expect(brief).toContain("Call loom_resume before anything else. It puts the pull request of CSV-1, which this ticket builds on, in this worktree as one commit on the base, carried from the project's machine; loom_submit is refused until you have.");
    expect(brief).toContain(`- CSV-1 "Order rows": its pull request ${URL1} is open and not merged yet, at commit sq1. This worktree starts on it once loom_resume has put it in.`);
    expect(brief).toContain("do not rebase, reset or squash over it, and do not merge or rebase onto the base branch yourself");
    expect(brief).toContain("Loom merges the new commits on the project's machine and puts the result in this worktree as commits of its own, then runs your checks");
    expect(brief).not.toContain("git fetch");
  });

  it("tells a worker that takes over an open pull request that must catch up to submit the work as it is", async () => {
    await openFirst();
    const tickets = h.store.tickets(project().id).map((row) => (row.key === "CSV-1" ? { ...row, pushed_sha: "sq7" } : row));
    const ticket = { ...ticketOf(h, "CSV-2"), pushed_sha: "sq2", pr_branch: "loom/csv/csv-2-1", pr_url: "https://github.com/acme/shop/pull/2", stack_json: JSON.stringify({ deps: { "CSV-1": "sq1" }, base: "sq1", synced: 0, cross: {} }) };
    const brief = workerBrief({ project: project(), spec: spec(), ticket, posts: [], resume: true, tickets: [...tickets.filter((row) => row.key !== "CSV-2"), ticket], remote: true, resumePending: true });
    expect(brief).toContain("Loom must bring this pull request up to date with its dependencies' new commits before it pushes again. Unless a post since the last push asks for a fix, check that the work still holds and call loom_submit with it as it is; after review, Loom merges those commits in, runs the checks and pushes.");
    expect(brief).toContain("It puts the pull request of CSV-1, which this ticket builds on, in this worktree as one commit on the base, with the work earlier workers left on this ticket as one more on top, carried from the project's machine");
  });

  it("tells a reviewer on a machine of its own where the changes to judge start in its worktree", async () => {
    await openFirst();
    const worker = await startSecond();
    await submitted(worker);
    const ticket = ticketOf(h, "CSV-2");
    const diff = { stat: "", patch: "", truncated: false };
    const remote = reviewerBrief({ project: project(), spec: spec(), ticket, round: 1, diff, checkPost: null, earlierReviews: [], prFeedback: null, remote: true });
    expect(remote).toContain("loom_checkout puts their work in as the commit before HEAD, so `git diff HEAD~1` shows the changes to judge.");
    const local = reviewerBrief({ project: project(), spec: spec(), ticket, round: 1, diff, checkPost: null, earlierReviews: [], prFeedback: null });
    expect(local).not.toContain("git diff HEAD~1");
  });
});

