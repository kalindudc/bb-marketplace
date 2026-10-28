import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadRow } from "../src/db/store";
import { readBehind, refreshDue } from "../src/fresh";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { metaOf } from "../src/pr-meta";
import { isReleased, releaseIdleWorkers, wakeForRestacks } from "../src/release";
import { specOf } from "../src/workers";
import { makeCtx, makeEngine, reachApproved, seedMachineProject, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL1 = "https://github.com/acme/shop/pull/1";
const DEADLINE = "host plugin call 1f46e1e1-6061-4d69-81e2-afb2e9ac216c exceeded its deadline";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const row = (id: number) => h.store.thread(id)!;
const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", refresh_behind: 5000, ...more });
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const count = () => readBehind(h.ctx, project(), spec());
const behind = (key = "CSV-1") => metaOf(ticket(key))?.behind;
const lastPost = (key = "CSV-1") => h.store.posts(ticket(key).id).at(-1)!;

/** CSV-1's pull request is open at sq1, and a poll has read it. */
async function openPr(more: Doc = {}): Promise<ThreadRow> {
  await seedProject(h, pr(more));
  const worker = await reachApproved(h);
  await queue();
  expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq1", pr_url: URL1 });
  await poll();
  return row(worker.id);
}

describe("counting how far an open pull request is behind its base", () => {
  it("counts on the checkout, fetching the base at most every 30 minutes, recounts a pull request pushed since, and keeps the count across polls", async () => {
    await openPr();
    h.host.behind.set("sq1", 12_374);
    await count();
    expect(h.host.callsTo("behindBase")).toEqual([{ repo: "/repo", remote: "origin", base: "main", fetch: true, shas: ["sq1"] }]);
    expect(behind()).toEqual({ commits: 12_374, sha: "sq1", tip: "base000", at: h.clock.t });

    await poll();
    expect(metaOf(ticket())).toMatchObject({ at: h.clock.t, state: "OPEN", behind: { commits: 12_374, sha: "sq1" } });
    h.clock.advance(10 * 60_000);
    await count();
    expect(h.host.callsTo("behindBase")).toHaveLength(1);

    h.store.updateTicket(ticket().id, { pushed_sha: "sq9" });
    h.host.behind.set("sq9", 3);
    await count();
    expect(h.host.callsTo("behindBase").at(-1)).toEqual({ repo: "/repo", remote: "origin", base: "main", fetch: false, shas: ["sq9"] });
    expect(behind()).toMatchObject({ commits: 3, sha: "sq9" });

    h.clock.advance(30 * 60_000);
    await count();
    expect(h.host.callsTo("behindBase").at(-1)).toMatchObject({ fetch: true, shas: ["sq9"] });
  });

  it("reads nothing on a repo that does not set refresh_behind, nor while no pull request is open or read yet", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    await reachApproved(h);
    await queue();
    await poll();
    await count();
    expect(h.host.callsTo("behindBase")).toEqual([]);

    h = makeCtx();
    await seedProject(h, pr());
    await count();
    await reachApproved(h);
    await queue();
    await count();
    expect(h.host.callsTo("behindBase")).toEqual([]);
  });

  it("logs a count that fails, leaves the meta as it was, and tries again with the next fetch", async () => {
    await openPr();
    h.host.scripted.behindBase = [{ outcome: "unavailable", message: "git fetch from origin failed: offline", transient: "network" }];
    await count();
    expect(behind()).toBeUndefined();
    expect(h.bb.callsTo("log").at(-1)).toEqual(["warn", "Could not count how far csv's open pull requests are behind origin/main: git fetch from origin failed: offline"]);
    expect(project().state).toBe("running");
    h.clock.advance(60_000);
    await count();
    expect(h.host.callsTo("behindBase")).toHaveLength(1);
    h.clock.advance(30 * 60_000);
    await count();
    expect(h.host.callsTo("behindBase").at(-1)).toMatchObject({ fetch: true });
    expect(behind()).toMatchObject({ commits: 0, sha: "sq1" });
  });

  it("is read by the engine's tick once a poll has read the pull request", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr());
    await reachApproved(h);
    await e.engine.tick();
    await settleMerges(h.ctx);
    h.clock.advance(5 * 60_000);
    await e.engine.tick();
    await e.engine.tick();
    expect(h.host.callsTo("behindBase")).toEqual([{ repo: "/repo", remote: "origin", base: "main", fetch: true, shas: ["sq1"] }]);
  });
});

describe("what is due a refresh", () => {
  it("is an open pull request on its repo's base that lacks refresh_behind commits, or that the forge read as conflicting after Loom's last push", async () => {
    await openPr();
    h.host.behind.set("sq1", 4_999);
    await count();
    expect(refreshDue(spec(), ticket())).toBeNull();
    h.host.behind.set("sq1", 5_000);
    h.clock.advance(30 * 60_000);
    await count();
    expect(refreshDue(spec(), ticket())).toEqual({ behind: 5_000, conflict: false, tip: "base000" });

    h.host.prMeta.set(URL1, { ...h.host.prMeta.get(URL1), mergeable: false });
    await poll();
    expect(refreshDue(spec(), ticket())).toEqual({ behind: 5_000, conflict: true, tip: "base000" });
    h.store.updateTicket(ticket().id, { pushed_at: h.clock.t + 1, pushed_sha: "sq9" });
    expect(refreshDue(spec(), ticket())).toBeNull();
  });

  it("waits for Loom's own count, whose fetched tip the refresh merges, even when the forge says the pull request conflicts, and leaves one whose pushed commit has that tip", async () => {
    await openPr();
    h.host.prMeta.set(URL1, { ...h.host.prMeta.get(URL1), mergeable: false });
    await poll();
    expect(refreshDue(spec(), ticket())).toBeNull();
    h.host.behind.set("sq1", 3);
    await count();
    expect(refreshDue(spec(), ticket())).toEqual({ behind: null, conflict: true, tip: "base000" });
    h.host.behind.set("sq1", 0);
    h.clock.advance(30 * 60_000);
    await count();
    expect(refreshDue(spec(), ticket())).toBeNull();
  });

  it("leaves a stacked pull request, a ticket whose work goes back to its worker, and one pushed since Loom counted it", async () => {
    await openPr();
    await reachApproved(h, "CSV-2");
    await queue();
    await poll();
    const second = ticket("CSV-2");
    expect(second.pr_base).toBe(ticket().pr_branch);
    h.host.behind.set(second.pushed_sha!, 9_999);
    h.host.behind.set("sq1", 9_999);
    h.clock.advance(30 * 60_000);
    await count();
    expect(behind("CSV-2")).toMatchObject({ commits: 9_999 });
    expect(refreshDue(spec(), second)).toBeNull();
    expect(refreshDue(spec(), ticket())).not.toBeNull();
    expect(refreshDue(spec(), { ...ticket(), handback_json: "{}" })).toBeNull();
    expect(refreshDue(spec(), { ...ticket(), pushed_sha: "sq9" })).toBeNull();
  });
});

describe("refreshing an open pull request", () => {
  it("merges the base into a branch that lacks refresh_behind commits of it, runs the checks in the worker's worktree and pushes, with no new review", async () => {
    const worker = await openPr();
    const head = ticket().head_sha!;
    const reviewers = h.store.threads({ role: "reviewer" }).length;
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 12_374);
    await count();
    await queue();

    expect(h.host.callsTo("stackBase")).toEqual([{ repo: "/repo", branch: "loom/csv/csv-1-stack", commits: ["base001"], message: "Loom: origin/main for CSV-1" }]);
    expect(h.host.callsTo("mergeOnto").at(-1)).toEqual({ repo: "/repo", head, ref: "base001", message: "Merge origin/main into CSV-1 (Loom)", refs: [] });
    expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree: `/wt/${worker.environment_id}`, sha: "lm1" });
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: `/wt/${worker.environment_id}`, command: "npm test" });
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: "lm1", base: "base001", message: "CSV-1: merge origin/main (Loom)", pushed: "sq1" });
    const after = ticket();
    expect(after).toMatchObject({ state: "pr_open", head_sha: "lm1", pushed_sha: "sq2", pr_rounds: 0, pr_url: URL1 });
    expect(h.host.callsTo("push").at(-1)).toEqual({ repo: "/repo", remote: "origin", src: "sq2", branch: after.pr_branch });
    expect(lastPost().body).toBe("CSV-1's branch lacked 12,374 commits of origin/main, so Loom merged origin/main into it, ran its checks and pushed sq2.");
    expect(JSON.parse(lastPost().data_json)).toMatchObject({ outcome: "pr_pushed", sha: "sq2", restack: true, refresh: { behind: 12_374, conflict: false } });
    expect(h.store.threads({ role: "reviewer" })).toHaveLength(reviewers);
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(h.host.callsTo("prRetarget")).toEqual([]);

    await count();
    expect(behind()).toMatchObject({ sha: "sq2", commits: 0, tip: "base001" });
    await queue();
    expect(h.host.callsTo("mergeOnto")).toHaveLength(1);
    expect(h.host.callsTo("behindBase").filter((call) => call.fetch)).toHaveLength(1);
  });

  it("pushes a commit that takes the base when the merge leaves the branch's files as they were, so it is not behind any more", async () => {
    const worker = await openPr();
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 6_000);
    await count();
    // The base's new commits change nothing in the end, such as an edit and its revert.
    h.host.scripted.mergeOnto = [{ outcome: "merged", sha: "lm7", tree: "same-tree", already: false }];
    h.host.trees.set("lm7", "same-tree").set("sq1", "same-tree");
    await queue();

    expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree: `/wt/${worker.environment_id}`, sha: "lm7" });
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ head: "lm7", base: "base001", pushed: "sq1" });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ src: "sq2" });
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: "lm7", pushed_sha: "sq2" });
    expect(lastPost().body).toBe("CSV-1's branch lacked 6,000 commits of origin/main, so Loom merged origin/main into it, ran its checks and pushed sq2.");
    await count();
    expect(behind()).toMatchObject({ sha: "sq2", commits: 0 });
    expect(refreshDue(spec(), ticket())).toBeNull();
  });

  it("pushes a commit that takes the base, with no merge or checks, when the ticket's work has the base already", async () => {
    await openPr();
    const head = ticket().head_sha!;
    h.host.remoteBase = "base001";
    h.host.ancestry.add(`base001..${head}`);
    h.host.behind.set("sq1", 6_000);
    await count();
    const checks = h.host.callsTo("exec").length;
    await queue();

    expect(h.host.callsTo("resetHard")).toEqual([]);
    expect(h.host.callsTo("exec")).toHaveLength(checks);
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: head, pushed_sha: "sq2" });
    expect(lastPost().body).toBe("CSV-1's branch lacked 6,000 commits of origin/main; the ticket's work had origin/main already, so Loom pushed sq2, which takes it, with no checks to run.");
  });

  it("refreshes a pull request the forge says conflicts, and forgets that read once it pushed", async () => {
    await openPr();
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 3);
    h.host.prMeta.set(URL1, { ...h.host.prMeta.get(URL1), mergeable: false });
    await poll();
    await count();
    await queue();
    expect(lastPost().body).toBe("CSV-1's pull request conflicted with origin/main, so Loom merged origin/main into it, ran its checks and pushed sq2.");
    expect(metaOf(ticket())).toMatchObject({ mergeable: null });
    expect(refreshDue(spec(), ticket())).toBeNull();
  });

  it("sends a conflict back to the worker with the files named, and pushes nothing", async () => {
    const worker = await openPr();
    h.host.behind.set("sq1", 6_000);
    h.host.remoteBase = "base001";
    await count();
    const pushes = h.host.callsTo("push").length;
    h.host.scripted.mergeOnto = [{ outcome: "conflict", files: ["src/model/a.ts"], sha: "lm9", tree: "lm9-tree" }];
    await queue();

    expect(ticket()).toMatchObject({ state: "working", check_failures: 0, pushed_sha: "sq1" });
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    expect(lastPost().body).toBe("Merging origin/main into CSV-1's branch conflicted in: src/model/a.ts.");
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("Loom could not bring your branch up to date with origin/main");
    expect(sent).toContain("src/model/a.ts");
  });

  it("keeps a worker whose pull request is due, and brings a released one back first", async () => {
    const worker = await openPr();
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    h.host.behind.set("sq1", 6_000);
    h.host.remoteBase = "base001";
    await count();
    await releaseIdleWorkers(h.ctx, project(), spec());
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null });

    h.host.behind.set("sq1", 0);
    h.clock.advance(30 * 60_000);
    await count();
    await releaseIdleWorkers(h.ctx, project(), spec());
    expect(isReleased(row(worker.id))).toBe(true);
    h.bb.environments.get(worker.environment_id!)!.status = "destroyed";

    h.host.behind.set("sq1", 6_000);
    h.clock.advance(30 * 60_000);
    await count();
    await queue();
    expect(h.host.callsTo("mergeOnto")).toEqual([]);
    await wakeForRestacks(h.ctx, project(), spec());
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null, environment_id: "env_r1" });
    h.host.worktrees.set("/wt/env_r1", { ...h.host.worktree(`/wt/${worker.environment_id}`) });
    await queue();
    expect(h.host.callsTo("mergeOnto").at(-1)).toMatchObject({ ref: "base001" });
    expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree: "/wt/env_r1", sha: "lm1" });
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: "lm1", pushed_sha: "sq2", worker_thread_id: worker.thread_id });
  });

  it("finishes a refresh whose merge or whose move into the worktree got no answer, running its checks on the next run", async () => {
    const worker = await openPr();
    const head = ticket().head_sha!;
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 6_000);
    await count();
    h.host.lost.mergeOnto = [new Error(DEADLINE)];
    await queue();
    expect(ticket()).toMatchObject({ state: "merging", head_sha: head, merge_step_json: null });
    expect(h.host.worktree(`/wt/${worker.environment_id}`).head).toBe(head);

    h.host.lost.resetHard = [new Error(DEADLINE)];
    h.clock.advance(60_000);
    await queue();
    expect(ticket()).toMatchObject({ state: "merging", head_sha: head });
    expect(JSON.parse(ticket().merge_step_json!)).toMatchObject({ kind: "restack", from: head, sha: "lm2", remote: false });
    expect(h.host.worktree(`/wt/${worker.environment_id}`).head).toBe("lm2");
    const checks = h.host.callsTo("exec").length;

    h.clock.advance(2 * 60_000);
    await queue();
    expect(h.host.callsTo("mergeOnto")).toHaveLength(2);
    expect(h.host.callsTo("exec").slice(checks)).toEqual([expect.objectContaining({ cwd: `/wt/${worker.environment_id}`, command: "npm test" })]);
    expect(ticket()).toMatchObject({ state: "pr_open", head_sha: "lm2", pushed_sha: "sq2", merge_step_json: null });
    expect(lastPost().body).toBe("CSV-1's branch lacked 6,000 commits of origin/main, so Loom merged origin/main into it, ran its checks and pushed sq2.");
  });

  it("runs the forge's after_push once for the refresh's push, and not again when the merge runs again after it", async () => {
    await openPr({ forge: { kind: "gh", after_push: ["ci start"] } });
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 6_000);
    await count();
    h.host.lost.push = [new Error(DEADLINE)];
    await queue();
    const hooks = () => h.host.callsTo("exec").filter((call) => call.command === "ci start");
    expect(ticket().state).toBe("merging");
    expect(hooks()).toEqual([]);

    h.clock.advance(60_000);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    expect(h.host.callsTo("push").map((call) => call.src)).toEqual(["sq1", "sq2", "sq2"]);
    expect(hooks()).toEqual([expect.objectContaining({ env: expect.objectContaining({ LOOM_URL: URL1, LOOM_SHA: "sq2" }) })]);
    await queue();
    expect(hooks()).toHaveLength(1);
  });

  it("merges the base tip the count fetched, so every fetch of the base keeps to one per 30 minutes per repo", async () => {
    await seedProject(h, (doc) => {
      pr()(doc);
      doc.ticket[1].depends_on = [];
    });
    await reachApproved(h, "CSV-1");
    await queue();
    await reachApproved(h, "CSV-2");
    await queue();
    await poll();
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 6_000);
    h.host.behind.set("sq2", 7_000);
    await count();
    await queue();
    await queue();

    expect(h.host.callsTo("behindBase").filter((call) => call.fetch)).toHaveLength(1);
    expect(h.host.callsTo("stackBase").map((call) => [call.commits, call.base])).toEqual([
      [["base001"], undefined],
      [["base001"], undefined],
    ]);
    expect(h.host.callsTo("fetchBranch")).toEqual([]);
    expect(h.host.callsTo("fetchTip")).toEqual([]);
    expect([ticket("CSV-1").pushed_sha, ticket("CSV-2").pushed_sha]).toEqual(["sq3", "sq4"]);
  });

  it("takes a ticket just approved for its first pull request before older pull requests that are only due a refresh", async () => {
    await seedProject(h, (doc) => {
      pr()(doc);
      doc.ticket[1].depends_on = [];
    });
    await reachApproved(h, "CSV-1");
    await queue();
    await poll();
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 6_000);
    await count();
    h.clock.advance(60_000);
    await reachApproved(h, "CSV-2");
    expect(ticket("CSV-1").state_at).toBeLessThan(ticket("CSV-2").state_at);

    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    expect(ticket("CSV-1")).toMatchObject({ state: "pr_open", pushed_sha: "sq1" });
    await queue();
    expect(ticket("CSV-1")).toMatchObject({ state: "pr_open", pushed_sha: "sq3" });
  });

  it("merges on the project's machine and carries the result, as linear commits, to a worker on a machine of its own", async () => {
    await seedMachineProject(h, (doc) => Object.assign(doc.merge, { describe: "loom", refresh_behind: 100 }));
    const worker = await reachApproved(h);
    await queue();
    await poll();
    h.host.remoteBase = "base001";
    h.host.behind.set("sq1", 250);
    await count();
    await queue();

    const head = h.store.ticketByKey("CSV-1")!.head_sha;
    expect(h.host.callsTo("mergeOnto").at(-1)).toMatchObject({ repo: "/repo", ref: "base001", message: "Merge origin/main into CSV-1 (Loom)" });
    expect(h.host.callsTo("merge")).toEqual([]);
    expect(h.host.callsTo("carryFinish").at(-1)).toMatchObject({ worktree: `/wt/${worker.environment_id}` });
    expect(head).toMatch(/^lm/u);
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
    expect(lastPost().body).toBe("CSV-1's branch lacked 250 commits of origin/main, so Loom merged origin/main into it, ran its checks and pushed sq2.");
  });
});
