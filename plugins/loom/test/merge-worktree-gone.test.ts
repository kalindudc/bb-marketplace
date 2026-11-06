// A merge step that needs the worker's worktree, when the worker's thread is still active but its environment is gone, as
// when its sandbox expired (LANE-16): the ticket leaves merging, the project keeps running, and the worker comes back with
// a restored environment, or a new worker takes the ticket from its branch.
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { readBehind } from "../src/fresh";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { advanceWakes } from "../src/release";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { specOf } from "../src/ctx";
import { checkOutHead, makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL1 = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const outcomes = (key = "CSV-1") => h.store.posts(ticket(key).id).flatMap((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome ?? []);
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const changesRequested = { items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] };

/** The worker's environment is destroyed, its thread still active and idle, as after its sandbox expired. */
function environmentGone(worker: ThreadRow): void {
  const id = h.store.thread(worker.id)!.environment_id!;
  h.bb.environments.set(id, { ...h.bb.environments.get(id)!, path: null, status: "destroyed" });
  h.bb.threads.get(worker.thread_id!)!.status = "idle";
}

async function prProject(edit?: (doc: Doc) => void): Promise<void> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr" };
    doc.ticket[1].depends_on = [];
    edit?.(doc);
  });
}

/** CSV-1's pull request opened at sq1, then a fix round it answered was approved: CSV-1 is approved again, for its push. */
async function fixRoundApproved(): Promise<ThreadRow> {
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
  await queue();
  expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq1", pr_url: URL1 });
  h.host.feedback.set(URL1, changesRequested);
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

/** bb restores the environment on the worker's branch, which holds the reviewed commit. */
async function restore(): Promise<void> {
  await advanceWakes(h.ctx, project().id);
  h.host.worktree("/wt/env_r1").head = ticket().head_sha!;
}

/** Someone else pushed to CSV-1's pull request branch, so its push must merge their commits in the worker's worktree first. */
function pushedByOthers(): void {
  h.host.foreign.set(ticket().pr_branch!, "theirs1");
  h.host.ancestry.add("sq1..theirs1");
}

describe("a merge whose worker's environment is gone", () => {
  it("LANE-16: takes the ticket out of merging, keeps the project running, and restores the worker's environment", async () => {
    await prProject();
    const worker = await fixRoundApproved();
    pushedByOthers();
    environmentGone(worker);
    await queue();
    expect(project().state).toBe("running");
    expect(ticket().state).toBe("approved");
    expect(outcomes()).toContain("worktree_gone");
    expect(h.store.thread(worker.id)).toMatchObject({ state: "active", released_at: expect.any(Number) });
    // While the worker comes back, the queue does not take the ticket again.
    await queue();
    expect(ticket().state).toBe("approved");
    await restore();
    expect(h.bb.callsTo("restoreEnvironment")).toEqual([[worker.thread_id]]);
    expect(h.store.thread(worker.id)).toMatchObject({ released_at: null, environment_id: "env_r1" });
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open" });
    expect(outcomes()).toContain("pr_pushed");
  });

  it("hands the ticket to a new worker from its branch when bb cannot restore the environment, and never pauses", async () => {
    await prProject();
    const worker = await fixRoundApproved();
    pushedByOthers();
    environmentGone(worker);
    h.bb.restorable = false;
    await queue();
    expect(ticket().state).toBe("approved");
    await advanceWakes(h.ctx, project().id);
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    await queue();
    expect(ticket()).toMatchObject({ state: "queued", worker_thread_id: null });
    expect(project().state).toBe("running");
  });

  it("lets the next approved ticket merge while the first one's worker comes back", async () => {
    await prProject();
    const worker = await fixRoundApproved();
    const second = await reachApproved(h, "CSV-2");
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, second.thread_id!, { title: "Export endpoint", body: "Why.", commit_message: "Serve the file" });
    pushedByOthers();
    environmentGone(worker);
    await queue();
    expect(ticket().state).toBe("approved");
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", pr_url: expect.any(String) });
    expect(project().state).toBe("running");
  });

  it("does the same for a catch-up of an open pull request with its base", async () => {
    await prProject((doc) => Object.assign(doc.merge, { describe: "loom", refresh_behind: 5000 }));
    const worker = await reachApproved(h);
    await queue();
    await poll();
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 12_374);
    await readBehind(h.ctx, project(), spec());
    environmentGone(worker);
    await queue();
    expect(project().state).toBe("running");
    expect(ticket().state).toBe("pr_open");
    expect(outcomes()).toContain("worktree_gone");
    await restore();
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open" });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ src: "sq2" });
  });
});
