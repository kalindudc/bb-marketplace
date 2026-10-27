// A running project whose approved spec version moves its threads onto new machines or off them: every ticket in flight
// keeps working. Decisions about a thread that already runs follow where it runs and where its ticket's head is, never the
// spec's placement for new threads.
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { isReleased, releaseIdleWorkers } from "../src/release";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { blockTicket, onThreadGone, onWorkerIdle, requeueTicket, resumeWork, spawnWorker, specOf } from "../src/workers";
import { BOXES, GIT_WORKTREE_PROVIDER, checkOutHead, makeCtx, reachApproved, reachReview, seedMachineProject, seedProject, specToml, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
  h.bb.machineProviderList = [BOXES];
  h.bb.compositionList = [{ ...GIT_WORKTREE_PROVIDER, id: "boxed-trees", displayName: "Trees on boxes", pluginId: "boxes", machineProviderId: "boxes" }];
});

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const spawns = () => h.bb.callsTo("spawnThread").map(([args]) => args as SpawnArgs);
const workerSpawns = () => spawns().filter((args) => args.metadata.role === "worker");
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const URL1 = "https://github.com/acme/shop/pull/1";
const changesRequested = { items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] };
const worktreeOf = (row: ThreadRow) => `/wt/${h.store.thread(row.id)!.environment_id}`;
const dirty = (row: ThreadRow) => {
  const worktree = h.host.worktree(worktreeOf(row));
  worktree.dirty = true;
  worktree.changed = ["src/export/a.ts"];
};
const submitted = async (row: ThreadRow) => {
  submit(h.ctx, row.thread_id!, "Done");
  await settleChecks(h.ctx);
};
const moved = (row: ThreadRow, seq: number) => h.bb.systemErrors.set(row.thread_id!, { code: "machine_maintenance", message: "Machine preservation is interrupting this turn.", seq, at: 0 });

const pr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom" });
const onMachines = (doc: Doc) => {
  pr(doc);
  doc.environment = { provider: "git-worktree", machine: { provider: "boxes" } };
};
// Workers on machines of their own, reviewers on the project's machine.
const workersOnMachines = (doc: Doc) => {
  pr(doc);
  doc.environment = { provider: "boxed-trees", machine: { provider: "boxes" }, reviewer: { provider: "git-worktree" } };
};

/** Proposes the spec with `edit` as a revision of the running project, and approves it. */
async function moveTo(edit: (doc: Doc) => void): Promise<void> {
  await h.projects.propose({ toml: specToml(edit), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
  await h.projects.approve("csv", "human");
  expect(project().pending_version).toBeNull();
}

describe("review, after a move", () => {
  it("onto machines: starts a reviewer on the project's machine from the worker's branch, where the head was made", async () => {
    await seedProject(h, pr);
    await reachReview(h);
    const branch = ticketOf(h, "CSV-1").branch;
    await moveTo(workersOnMachines);
    await spawnReviewers(h.ctx, project(), spec());
    expect(spawns().at(-1)).toMatchObject({ baseBranch: branch, environment: undefined });
  });

  it("off machines: starts a reviewer on the project's machine from the home branch, where the head came home", async () => {
    await seedMachineProject(h, onMachines);
    await reachReview(h);
    expect(ticketOf(h, "CSV-1").head_sha).toMatch(/^home/u);
    await moveTo(pr);
    await spawnReviewers(h.ctx, project(), spec());
    expect(spawns().at(-1)).toMatchObject({ baseBranch: "loom/csv/csv-1-home", environment: undefined });
  });
});

/** CSV-1's pull request open, its worker idle; then released, with its environment torn down. */
async function releasedFirst(seed: () => Promise<unknown>): Promise<ThreadRow> {
  await seed();
  const worker = await reachApproved(h);
  await queue();
  expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_url: URL1 });
  h.bb.threads.get(worker.thread_id!)!.status = "idle";
  await releaseIdleWorkers(h.ctx, project(), spec());
  expect(isReleased(h.store.thread(worker.id))).toBe(true);
  h.bb.environments.get(worker.environment_id!)!.status = "destroyed";
  return h.store.thread(worker.id)!;
}

/** CSV-2 stacked on CSV-1's open pull request, reviewed and approved, its own pull request open; its worker stays live. */
async function stackedSecond(): Promise<ThreadRow> {
  await reachApproved(h, "CSV-1");
  await queue();
  await spawnWorker(h.ctx, project(), spec(), ticketOf(h, "CSV-2"));
  const worker = h.store.threads({ ticketId: ticketOf(h, "CSV-2").id, role: "worker" }).at(-1)!;
  if (h.store.thread(worker.id)!.resume_json !== null) await resumeWork(h.ctx, worker.thread_id!);
  dirty(worker);
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

describe("a ticket in working or checking, after a move", () => {
  it("onto machines: the live worker's submit runs its checks on the project's machine and carries nothing", async () => {
    await seedProject(h, pr);
    const row = await startWorker(h);
    await moveTo(onMachines);
    dirty(row);
    h.host.calls = [];
    await submitted(row);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: h.host.worktree(worktreeOf(row)).head });
    expect(h.host.callsTo("exportChanges")).toEqual([]);
    expect(h.host.callsTo("importCommit")).toEqual([]);
  });

  it("onto machines: the next attempt starts on a new machine and resumes the last worker's branch with loom_resume", async () => {
    await seedProject(h, pr);
    const row = await startWorker(h);
    await moveTo(onMachines);
    dirty(row);
    await onThreadGone(h.ctx, row.thread_id!);
    const { branch } = ticketOf(h, "CSV-1");
    h.host.refs.set(`refs/heads/${branch}`, h.host.worktree(worktreeOf(row)).head);
    const next = await startWorker(h);
    expect(workerSpawns().at(-1)!.environment).toMatchObject({ machine: { providerId: "boxes" } });
    expect(JSON.parse(next.resume_json!)).toMatchObject({ sha: h.host.worktree(worktreeOf(row)).head });
  });

  it("off machines: the live worker keeps its machine, a move of it is not counted, and its work still comes home", async () => {
    await seedMachineProject(h, onMachines);
    const first = await startWorker(h);
    dirty(first);
    await onThreadGone(h.ctx, first.thread_id!);
    const row = await startWorker(h);
    expect(row.resume_json).not.toBeNull();
    await moveTo(pr);

    moved(row, 7);
    await onWorkerIdle(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", idle_count: 0, maintenance_seq: 7 });
    await resumeWork(h.ctx, row.thread_id!);
    dirty(row);
    h.host.calls = [];
    await submitted(row);
    expect(h.host.callsTo("importCommit").at(-1)).toMatchObject({ refs: ["refs/heads/loom/csv/csv-1-home", "refs/loom/csv/csv-1/reviewed"] });
    expect(ticketOf(h, "CSV-1").head_sha).toMatch(/^home/u);
  });
});

describe("an open pull request, after a move", () => {
  it("onto machines: a released worker comes back for a fix round on the project's machine, where bb restores it", async () => {
    const worker = await releasedFirst(() => seedProject(h, pr));
    await moveTo(onMachines);
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    expect(h.bb.callsTo("restoreEnvironment")).toEqual([[worker.thread_id]]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", worker_thread_id: worker.thread_id });
    expect(workerSpawns()).toHaveLength(1);
  });

  it("off machines: a released worker, whose machine is gone, is taken over on the project's machine from the home branch", async () => {
    await releasedFirst(() => seedMachineProject(h, onMachines));
    h.bb.restorable = false;
    await moveTo(pr);
    h.host.feedback.set(URL1, changesRequested);
    await poll();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", worker_thread_id: null });
    expect(h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!.body).toBe("The worker's thread cannot come back with an environment (bb cannot restore its environment), so a new worker takes over from the work Loom brought home; it can read the earlier worker's conversation.");
    await startWorker(h);
    expect(workerSpawns().at(-1)).toMatchObject({ baseBranch: "loom/csv/csv-1-home", environment: undefined });
  });

  it("onto machines: a stacked ticket's live worker on the project's machine still takes its dependency's new commit in its own worktree", async () => {
    await seedProject(h, pr);
    const worker = await stackedSecond();
    await moveTo(onMachines);
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();
    expect(h.host.callsTo("merge").at(-1)).toMatchObject({ worktree: worktreeOf(worker), ref: "sq7" });
    expect(h.host.callsTo("mergeOnto")).toEqual([]);
  });

  it("off machines: a stacked ticket's live worker on a machine gets its dependency's new commit merged on the checkout and carried in", async () => {
    await seedMachineProject(h, onMachines);
    const worker = await stackedSecond();
    await moveTo(pr);
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();
    expect(h.host.callsTo("mergeOnto").at(-1)).toMatchObject({ ref: "sq7" });
    expect(h.host.callsTo("carryStart").at(-1)).toMatchObject({ worktree: worktreeOf(worker) });
    expect(h.host.callsTo("merge")).toEqual([]);
    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
  });
});

describe("stacked children, after a move", () => {
  it("onto machines: a queued child starts on a new machine and carries in the commit it is stacked on with loom_resume", async () => {
    await seedProject(h, pr);
    await reachApproved(h, "CSV-1");
    await queue();
    await moveTo(onMachines);
    const row = await startWorker(h, "CSV-2");
    expect(workerSpawns().at(-1)).toMatchObject({ baseBranch: "origin/main", environment: { machine: { providerId: "boxes" } } });
    expect(JSON.parse(row.resume_json!)).toMatchObject({ sha: "sq1" });
  });

  it("off machines: a child's next worker starts on the project's machine from the home branch, which builds on the commit it is stacked on", async () => {
    await seedMachineProject(h, onMachines);
    await reachApproved(h, "CSV-1");
    await queue();
    await spawnWorker(h.ctx, project(), spec(), ticketOf(h, "CSV-2"));
    const worker = h.store.threads({ ticketId: ticketOf(h, "CSV-2").id, role: "worker" }).at(-1)!;
    await resumeWork(h.ctx, worker.thread_id!);
    dirty(worker);
    await submitted(worker);
    expect(h.host.callsTo("importCommit").at(-1)).toMatchObject({ parent: "sq1" });
    await moveTo(pr);
    await blockTicket(h.ctx, ticketOf(h, "CSV-2"), { reason: "Stop", needs: "", actor: "human" });
    await requeueTicket(h.ctx, "CSV-2", { note: "", actor: "human", author: "human" });
    await startWorker(h, "CSV-2");
    expect(workerSpawns().at(-1)).toMatchObject({ baseBranch: "loom/csv/csv-2-home", environment: undefined });
  });
});

