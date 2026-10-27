import { beforeEach, describe, expect, it } from "vitest";
import { ticketActivity } from "../src/activity";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { boardCards } from "../src/rpc";
import { stackOf } from "../src/stack";
import { noteUpstreamChanges } from "../src/upstream";
import { specOf } from "../src/workers";
import { makeCtx, makeEngine, reachApproved, seedProject, seedRepoProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

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
const pr = (edit?: (doc: Doc) => void) => (doc: Doc) => {
  doc.merge = { strategy: "pr", describe: "loom" };
  edit?.(doc);
};
const outcomes = (key: string) => h.store.posts(ticketOf(h, key).id).flatMap((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome ?? []);
const lastSpawn = () => h.bb.callsTo("spawnThread").at(-1)![0] as SpawnArgs;
const URL1 = "https://github.com/acme/shop/pull/1";

/** CSV-1's pull request is open at sq1. */
async function openFirst(edit?: (doc: Doc) => void): Promise<void> {
  await seedProject(h, pr(edit));
  await reachApproved(h, "CSV-1");
  await queue();
  expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pushed_sha: "sq1", pr_url: URL1 });
}

describe("starting on an open pull request", () => {
  it("starts a dependent on its dependency's pull request commit, through a branch Loom points at it", async () => {
    await openFirst();
    await startWorker(h, "CSV-2");

    expect(h.host.callsTo("stackBase")).toEqual([{ repo: "/repo", branch: "loom/csv/csv-2-stack", commits: ["sq1"], message: "Loom: CSV-1 for CSV-2" }]);
    expect(lastSpawn().baseBranch).toBe("loom/csv/csv-2-stack");
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: { "CSV-1": "sq1" }, base: "sq1", cross: {} });
    const brief = lastSpawn().prompt;
    expect(brief).toContain("## Dependencies");
    expect(brief).toContain(`- CSV-1 "Order rows": its pull request ${URL1} is open and not merged yet, at commit sq1. This worktree starts on it`);
    expect(brief).toContain("Loom merges the new commits into your branch and runs your checks");
  });

  it("waits for the merge when the spec sets merge.stack = false", async () => {
    await openFirst((doc) => (doc.merge.stack = false));
    await startWorker(h, "CSV-2");
    expect(ticketOf(h, "CSV-2").state).toBe("queued");
    expect(h.host.callsTo("stackBase")).toEqual([]);
  });

  it("is started by the engine's tick once the dependency's pull request opens", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(h, pr());
    await reachApproved(h, "CSV-1");
    await e.engine.tick();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
    await e.engine.tick();
    expect(ticketOf(h, "CSV-2").state).toBe("working");
    expect(lastSpawn().baseBranch).toBe("loom/csv/csv-2-stack");
  });

  it("waits, with one post, when its dependencies' commits conflict with each other, until one of them changes", async () => {
    await seedProject(h, pr((doc) => {
      doc.ticket[1].depends_on = [];
      doc.ticket.push({ ref: "csv-both", title: "Both", body: "Use both.", acceptance: ["WHEN both exist THE SYSTEM SHALL use them"], scope: ["src/both/**"], depends_on: ["csv-model", "csv-export"] });
    }));
    await reachApproved(h, "CSV-1");
    await queue();
    await reachApproved(h, "CSV-2");
    await queue();
    h.host.scripted.stackBase = [{ outcome: "conflict", files: ["src/shared.ts"] }];
    await startWorker(h, "CSV-3");

    expect(ticketOf(h, "CSV-3").state).toBe("queued");
    const posts = h.store.posts(ticketOf(h, "CSV-3").id).filter((post) => post.kind === "system");
    expect(posts.map((post) => post.body)).toEqual(["Loom cannot start CSV-3 on its dependencies' pull requests: CSV-1 and CSV-2 conflict with each other in src/shared.ts. It starts once one of them changes or merges."]);

    const e = new (await import("../src/engine")).Engine({ store: h.store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects });
    await (e as unknown as { spawnReady(id: number): Promise<void> }).spawnReady(project().id);
    expect(ticketOf(h, "CSV-3").state).toBe("queued");
    expect(h.host.callsTo("stackBase")).toHaveLength(1);

    h.store.updateTicket(ticketOf(h, "CSV-2").id, { pushed_sha: "sq9" });
    await startWorker(h, "CSV-3");
    expect(ticketOf(h, "CSV-3").state).toBe("working");
    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ commits: ["sq1", "sq9"] });
  });
});

describe("a stacked ticket's review and pull request", () => {
  it("measures its scope and its reviewers' diff from the stack, and opens its pull request on the dependency's branch", async () => {
    await openFirst();
    await reachApproved(h, "CSV-2");
    const states = h.host.callsTo("worktreeState").filter((input) => input.worktree === `/wt/${ticketOf(h, "CSV-2").environment_id}`);
    expect(states.map((input) => input.base)).toContain("sq1");
    expect(h.host.callsTo("diff").at(-1)).toMatchObject({ base: "sq1" });
    const reviewerBrief = (h.bb.callsTo("spawnThread").at(-1)![0] as SpawnArgs).prompt;
    expect(reviewerBrief).toContain("## Stacked work");

    await queue();
    const first = ticketOf(h, "CSV-1");
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ base: "sq1" });
    const created = h.host.callsTo("prCreate").at(-1)!;
    expect(created.base).toBe(first.pr_branch);
    expect(created.body).toContain(`Stacked on ${URL1} (CSV-1): merge that one first. Loom moves this pull request to main when it merges.`);
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "pr_open", pr_base: first.pr_branch });
  });
});

describe("catching up with the dependency", () => {
  async function stacked(edit?: (doc: Doc) => void) {
    await openFirst(edit);
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
    return worker;
  }

  it("merges the dependency's new commit, runs the checks and pushes, with no new review", async () => {
    const worker = await stacked();
    const reviewers = h.store.threads({ role: "reviewer" }).length;
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();

    const ticket = ticketOf(h, "CSV-2");
    expect(h.host.callsTo("merge").at(-1)).toEqual({ worktree: `/wt/${worker.environment_id}`, ref: "sq7", message: "Merge CSV-1's pull request into CSV-2 (Loom)" });
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: `/wt/${worker.environment_id}`, command: "npm test" });
    expect(ticket).toMatchObject({ state: "pr_open", head_sha: "m1", pr_rounds: 0 });
    expect(stackOf(ticket)).toMatchObject({ deps: { "CSV-1": "sq7" }, base: "sq7" });
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ base: "sq7", head: "m1", message: "CSV-2: merge CSV-1's pull request (Loom)" });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ branch: ticket.pr_branch });
    expect(outcomes("CSV-2").slice(-2)).toEqual(["restacked", "pr_pushed"]);
    expect(h.store.threads({ role: "reviewer" })).toHaveLength(reviewers);

    await queue();
    expect(h.host.callsTo("merge")).toHaveLength(1);
  });

  it("takes the base branch and moves the pull request to it once the dependency merges", async () => {
    await stacked();
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    h.host.remoteBase = "base001";
    await queue();

    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ commits: [], base: { remote: "origin", branch: "main" } });
    expect(h.host.callsTo("merge").at(-1)).toMatchObject({ ref: "base001" });
    expect(h.host.callsTo("prRetarget")).toEqual([{ repo: "/repo", url: "https://github.com/acme/shop/pull/2", base: "main" }]);
    const ticket = ticketOf(h, "CSV-2");
    expect(ticket).toMatchObject({ state: "pr_open", pr_base: "main" });
    expect(stackOf(ticket)).toMatchObject({ deps: {}, base: "base001" });
    expect(outcomes("CSV-2").slice(-3)).toEqual(["restacked", "pr_pushed", "retargeted"]);
  });

  it("gives the base fetch, the pull request commit and the push the repo's git network timeout when the spec sets one", async () => {
    await stacked((doc) => (doc.merge.git_network_timeout_seconds = 240));
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    h.host.remoteBase = "base001";
    await queue();

    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ base: { remote: "origin", branch: "main" }, networkTimeoutMs: 240_000 });
    expect(h.host.callsTo("prCommit").at(-1)).toMatchObject({ networkTimeoutMs: 240_000 });
    expect(h.host.callsTo("push").at(-1)).toMatchObject({ networkTimeoutMs: 240_000 });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "pr_open", pr_base: "main" });
  });

  const COMMAND_FORGE = {
    kind: "command",
    open: "review create",
    state: "review state",
    retarget: 'review edit "$LOOM_PR_NUMBER" --base "$LOOM_BASE"',
    after_push: ['ci run --branch "$LOOM_HEAD"', '[ "$LOOM_BASE" != main ] || review ready "$LOOM_PR_NUMBER"'],
  };
  const onCommandForge = (doc: Doc) => {
    doc.merge.forge = COMMAND_FORGE;
    doc.checks.ci = false;
  };

  it("moves the pull request with the forge's retarget command, then runs after_push on the new base", async () => {
    await stacked(onCommandForge);
    const url = ticketOf(h, "CSV-2").pr_url!;
    const execs = h.host.callsTo("exec").length;
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    h.host.remoteBase = "base001";
    await queue();

    const ticket = ticketOf(h, "CSV-2");
    expect(ticket).toMatchObject({ state: "pr_open", pr_base: "main" });
    const ran = h.host.callsTo("exec").slice(execs).filter((call) => call.cwd === "/repo");
    expect(ran.map((call) => call.command)).toEqual([COMMAND_FORGE.retarget, ...COMMAND_FORGE.after_push]);
    expect(ran[0]!.env).toEqual({ LOOM_URL: url, LOOM_PR_NUMBER: "2", LOOM_BASE: "main" });
    expect(ran[1]!.env).toEqual({ LOOM_URL: url, LOOM_PR_NUMBER: "2", LOOM_HEAD: ticket.pr_branch, LOOM_BASE: "main", LOOM_SHA: ticket.pushed_sha });
    expect(h.host.callsTo("prRetarget")).toEqual([]);
    expect(outcomes("CSV-2").slice(-3)).toEqual(["restacked", "pr_pushed", "retargeted"]);
  });

  it("runs after_push after a catch-up push while the pull request still builds on its dependency's branch", async () => {
    await stacked(onCommandForge);
    const execs = h.host.callsTo("exec").length;
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();

    const ticket = ticketOf(h, "CSV-2");
    const hooks = h.host.callsTo("exec").slice(execs).filter((call) => call.cwd === "/repo");
    expect(hooks.map((call) => call.command)).toEqual(COMMAND_FORGE.after_push);
    expect(hooks[0]!.env).toMatchObject({ LOOM_BASE: ticketOf(h, "CSV-1").pr_branch, LOOM_SHA: ticket.pushed_sha });
  });

  it("gives after_open the branch a stacked pull request opened on as LOOM_BASE, not the repo's base", async () => {
    await stacked((doc) => {
      onCommandForge(doc);
      doc.merge.forge.after_open = ['[ "$LOOM_BASE" != main ] || review ready "$LOOM_PR_NUMBER"'];
    });
    const opened = h.host.callsTo("exec").filter((call) => call.command.startsWith('[ "$LOOM_BASE"') && call.env?.LOOM_PR_NUMBER !== undefined && call.env.LOOM_SHA === undefined);
    expect(opened.map((call) => call.env!.LOOM_BASE)).toEqual(["main", ticketOf(h, "CSV-1").pr_branch]);
  });

  it("asks the human to move the pull request when the retarget command fails, and does not pause", async () => {
    await stacked(onCommandForge);
    h.host.onExec = (input) => {
      if (input.command.startsWith("review edit")) h.host.execResults.unshift({ exitCode: 2, output: "delta is down" });
      if (input.command.startsWith("ci run")) h.host.execResults.unshift({ exitCode: 1, output: "ci refused" });
    };
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    h.host.remoteBase = "base001";
    await queue();

    expect(project().state).toBe("running");
    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
    const posts = h.store.posts(ticketOf(h, "CSV-2").id).filter((post) => post.kind === "merge").slice(-2);
    expect(posts[0]!.body).toContain("but the retarget command `review edit");
    expect(posts[0]!.body).toContain("delta is down");
    expect(posts[0]!.body).toContain("Change its base to main by hand.");
    expect(JSON.parse(posts[0]!.data_json!)).toMatchObject({ outcome: "retarget_failed", base: "main" });
    expect(posts[1]!.body).toContain('The after_push command `ci run --branch "$LOOM_HEAD"` failed (exit 1)');
    expect(JSON.parse(posts[1]!.data_json!)).toMatchObject({ outcome: "after_push_failed" });
  });

  it("sends a conflict back to the worker with the branch to merge, and pushes nothing", async () => {
    const worker = await stacked();
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    const pushes = h.host.callsTo("push").length;
    h.host.scripted.merge = [{ outcome: "conflict", files: ["src/export/a.ts"] }];
    await queue();

    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 0 });
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("Loom could not bring your branch up to date with CSV-1's pull request");
    expect(sent).toContain("git merge --no-edit loom/csv/csv-2-stack");
    expect(h.host.stackBranches.get("loom/csv/csv-2-stack")).toBe("sq7");
  });

  it("sends a failing check after the merge back to the worker, and keeps the merge", async () => {
    const worker = await stacked();
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    h.host.execResults = [{ exitCode: 1, output: "1 test failed" }];
    await queue();

    const ticket = ticketOf(h, "CSV-2");
    expect(ticket).toMatchObject({ state: "working", check_failures: 1 });
    expect(stackOf(ticket)).toMatchObject({ deps: { "CSV-1": "sq7" } });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Loom merged CSV-1's pull request into your branch, and then the check \"npm test\" exited with 1");
  });

  it("does not catch up while the worker is gone", async () => {
    const worker = await stacked();
    h.store.updateThread(worker.id, { state: "ended" });
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq7" });
    await queue();
    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
    expect(h.host.callsTo("merge")).toEqual([]);
  });
});

describe("a pull request that merged into another branch", () => {
  const mergedElsewhere = (key: string) => h.store.posts(ticketOf(h, key).id).filter((post) => post.kind === "merge" && (JSON.parse(post.data_json) as { outcome?: string }).outcome === "merged_elsewhere");

  it("blocks a stacked ticket whose pull request merged into its dependency's branch, naming that ticket, instead of completing it", async () => {
    await openFirst();
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    const [first, second] = [ticketOf(h, "CSV-1"), ticketOf(h, "CSV-2")];
    expect(second.pr_base).toBe(first.pr_branch);
    h.host.prStates.set(second.pr_url!, "MERGED");
    await poll();

    const reason = `Its pull request merged into CSV-1's branch (${first.pr_branch}), not main, so its change is not on main. Merge CSV-1's pull request first, then put this change on main again.`;
    const ticket = ticketOf(h, "CSV-2");
    expect(ticket).toMatchObject({ state: "blocked", blocked_reason: reason, pr_branch: null, pushed_sha: null });
    expect(JSON.parse(ticket.pr_meta_json!)).toEqual({ at: h.clock.t, draft: true, review: null, base: first.pr_branch, state: "MERGED" });
    const [post] = mergedElsewhere("CSV-2");
    expect(JSON.parse(post!.data_json)).toEqual({ outcome: "merged_elsewhere", url: second.pr_url, branch: first.pr_branch, base: "main", ticket: "CSV-1" });
    expect(post!.body).toBe(`The pull request ${second.pr_url} merged into CSV-1's branch (${first.pr_branch}), not main, so Loom did not complete CSV-2.`);
    expect(h.store.posts(ticket.id).filter((each) => each.kind === "block").map((each) => each.body)).toEqual([reason]);
    expect(project().triage_pending).toBe(1);
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");

    const attempt = ticketActivity({ state: ticket.state, posts: h.store.posts(ticket.id), threads: h.store.threads({ ticketId: ticket.id }), runs: h.store.runs(ticket.id) }).attempts.at(-1)!;
    expect(attempt).toMatchObject({ outcome: "blocked", line: `Blocked: Its pull request merged into CSV-1's branch (${first.pr_branch}), not main, so its change is not on main.` });
    expect(attempt.pipeline.pr.at(-1)).toBe("fail");
  });

  it("names the branch alone when no ticket's pull request is on it", async () => {
    await openFirst();
    h.host.prMeta.set(URL1, { base: "release-2" });
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "Its pull request merged into the branch release-2, not main, so its change is not on main. Put this change on main again." });
    expect(JSON.parse(mergedElsewhere("CSV-1")[0]!.data_json)).toMatchObject({ branch: "release-2", base: "main", ticket: null });
  });

  it("completes a stacked ticket whose pull request merged into main once Loom moved it there", async () => {
    await openFirst();
    await reachApproved(h, "CSV-2");
    await queue();
    h.host.prStates.set(URL1, "MERGED");
    await poll();
    await queue();
    const second = ticketOf(h, "CSV-2");
    expect(second.pr_base).toBe("main");
    h.host.prStates.set(second.pr_url!, "MERGED");
    await poll();
    expect(ticketOf(h, "CSV-2").state).toBe("done");
    expect(JSON.parse(ticketOf(h, "CSV-2").pr_meta_json!)).toMatchObject({ base: "main", state: "MERGED" });
    expect(mergedElsewhere("CSV-2")).toEqual([]);
  });

  it("completes the ticket as before when the forge does not say which branch the pull request merged into", async () => {
    await openFirst();
    await reachApproved(h, "CSV-2");
    await queue();
    const second = ticketOf(h, "CSV-2");
    h.host.prMeta.set(second.pr_url!, { base: null });
    h.host.prStates.set(second.pr_url!, "MERGED");
    await poll();
    expect(ticketOf(h, "CSV-2").state).toBe("done");
  });
});

describe("a ticket with two open dependencies", () => {
  it("starts on both, holds its pull request until one merges, has the other take the base branch, then opens on it", async () => {
    await seedProject(h, pr((doc) => {
      doc.ticket[1].depends_on = [];
      doc.ticket.push({ ref: "csv-both", title: "Both", body: "Use both.", acceptance: ["WHEN both exist THE SYSTEM SHALL use them"], scope: ["src/both/**"], depends_on: ["csv-model", "csv-export"] });
    }));
    await reachApproved(h, "CSV-1");
    await queue();
    await reachApproved(h, "CSV-2");
    await queue();
    const [first, second] = [ticketOf(h, "CSV-1"), ticketOf(h, "CSV-2")];

    await reachApproved(h, "CSV-3");
    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ commits: [first.pushed_sha, second.pushed_sha] });
    expect(stackOf(ticketOf(h, "CSV-3"))).toMatchObject({ deps: { "CSV-1": first.pushed_sha, "CSV-2": second.pushed_sha }, base: "st1" });

    await queue();
    await queue();
    expect(ticketOf(h, "CSV-3").state).toBe("approved");
    expect(outcomes("CSV-3").filter((outcome) => outcome === "held")).toHaveLength(1);
    const card = boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec()).find((each) => each.key === "CSV-3")!;
    expect(card).toMatchObject({ stackedOn: ["CSV-1", "CSV-2"], holding: "Its pull request opens once all but one of CSV-1, CSV-2 merge" });

    h.host.prStates.set(second.pr_url!, "MERGED");
    await poll();
    h.host.remoteBase = "base002";
    await queue();
    // CSV-1 takes the base branch first, so CSV-3's pull request does not show CSV-2's merged work as its own.
    expect(h.host.callsTo("merge").at(-1)).toMatchObject({ worktree: `/wt/${first.environment_id}`, ref: "base002" });
    const synced = ticketOf(h, "CSV-1");
    expect(synced.pushed_sha).not.toBe(first.pushed_sha);
    expect(ticketOf(h, "CSV-3").state).toBe("approved");

    await queue();
    const third = ticketOf(h, "CSV-3");
    expect(h.host.callsTo("stackBase").at(-1)).toMatchObject({ commits: [synced.pushed_sha], base: { remote: "origin", branch: "main" } });
    expect(third).toMatchObject({ state: "pr_open", pr_base: synced.pr_branch });
    expect(h.host.callsTo("prCreate").at(-1)).toMatchObject({ base: synced.pr_branch });
    expect(outcomes("CSV-3").filter((outcome) => outcome === "held")).toHaveLength(2);
  });
});

describe("a dependency in another repo", () => {
  it("starts on its open pull request without stacking, tells the worker where to read it, and posts its new commits", async () => {
    await seedRepoProject(h, pr((doc) => (doc.ticket[1].depends_on = ["csv-model"])));
    await reachApproved(h, "CSV-1");
    await queue();
    const row = await startWorker(h, "CSV-2");

    expect(h.host.callsTo("stackBase")).toEqual([]);
    expect(lastSpawn().baseBranch).toBe("upstream/trunk");
    expect(stackOf(ticketOf(h, "CSV-2"))).toMatchObject({ deps: {}, base: null, cross: { "CSV-1": "sq1" } });
    expect(lastSpawn().prompt).toContain("Read its files with `git -C /src/web show sq1:<file>`");

    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pushed_sha: "sq5" });
    await noteUpstreamChanges(h.ctx, project(), spec());
    await noteUpstreamChanges(h.ctx, project(), spec());
    const notes = h.store.posts(ticketOf(h, "CSV-2").id).filter((post) => post.kind === "system");
    expect(notes.map((post) => post.body)).toEqual([`CSV-1's pull request ${URL1} has a new commit, sq5. Check that CSV-2's work still fits it.`]);
    expect(h.bb.sent(row.thread_id!).at(-1)).toContain("CSV-1's pull request https://github.com/acme/shop/pull/1 has a new commit, sq5");
    expect(stackOf(ticketOf(h, "CSV-2"))!.cross).toEqual({ "CSV-1": "sq5" });
  });

  it("names the other repo's pull request in the dependent's pull request", async () => {
    await seedRepoProject(h, pr((doc) => (doc.ticket[1].depends_on = ["csv-model"])));
    await reachApproved(h, "CSV-1");
    await queue();
    await reachApproved(h, "CSV-2");
    await queue();
    const created = h.host.callsTo("prCreate").at(-1)!;
    expect(created).toMatchObject({ repo: "/src/api", base: "trunk" });
    expect(created.body).toContain(`Depends on ${URL1} (CSV-1) in the repo "web": merge that one first.`);
  });
});
