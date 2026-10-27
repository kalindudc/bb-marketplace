import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { PostRow } from "../src/db/store";
import { renderThread, workerBrief } from "../src/prompts";
import { SpawnRefusedError, SpawnUnavailableError, type SpawnArgs } from "../src/ports";
import { waitOf } from "../src/starts";
import { parseSpec } from "../src/spec";
import {
  blockTicket,
  blockedAtStart,
  endThread,
  onThreadGone,
  onTurnFailed,
  onWorkerIdle,
  recordBranch,
  requeueTicket,
  resolveEnvironment,
  resumeEnding,
  resumeWork,
  spawnWorker,
  specOf,
  startedFine,
  ticketMoveFor,
  toWorking,
} from "../src/workers";
import { BOXES, makeCtx, seedMachineProject, seedProject, specToml, startLateWorker, startWorker, ticketOf, workerRows, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const spawnArgs = (n = 0) => h.bb.callsTo("spawnThread")[n]![0] as SpawnArgs;
const callNames = () => h.bb.calls.map((call) => call.method);
const kinds = (key: string) => h.store.posts(ticketOf(h, key).id).map((post) => post.kind);
const project = () => h.store.projectBySlug("csv")!;
const rateLimited = (over: Partial<Parameters<typeof makeTurnFailedEvent>[0]> = {}) =>
  makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1", errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null }, ...over });

async function startBoth() {
  await seedProject(h);
  return startWorker(h);
}

describe("spawnWorker", () => {
  it("reserves the row and claims the ticket before it calls bb, then activates the row", async () => {
    await seedProject(h);
    let during: unknown;
    h.bb.spawnError = (args) => {
      const row = h.store.threadBySpawnToken(args.metadata.spawnToken!);
      during = { state: row?.state, thread: row?.thread_id, ticket: ticketOf(h, "CSV-1").state };
      return null;
    };
    const row = await startWorker(h);
    expect(during).toEqual({ state: "spawning", thread: null, ticket: "working" });
    expect(spawnArgs()).toMatchObject({
      bbProjectId: "proj_1",
      hostId: "host_1",
      baseBranch: "loom/csv",
      title: "CSV-1 · Order rows",
      sectionId: "sec_1",
      providerId: "claude",
      model: "sonnet",
      permissionMode: "full",
      metadata: { project: "csv", role: "worker", ticket: "CSV-1", spawnToken: row.spawn_token },
    });
    expect(row).toMatchObject({ state: "active", thread_id: "thr_w1", environment_id: "env_1", clock_at: h.clock.t, idle_count: 0 });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", attempt: 1, worker_thread_id: "thr_w1", environment_id: "env_1" });
    expect(kinds("CSV-1")).toEqual(["brief", "claim"]);
  });

  it("gives the worker a brief with the criteria, the scope, the protected paths and the checks", async () => {
    await seedProject(h, (doc) => {
      doc.scope = { protected: ["db/migrations/**"] };
      doc.ticket[0].verify = ["npm run lint"];
    });
    await startWorker(h);
    const prompt = spawnArgs().prompt;
    expect(prompt).toContain("You are a Loom worker on CSV-1");
    expect(prompt).toContain('1. WHEN an order is mapped THE SYSTEM SHALL return one row');
    expect(prompt).toContain('"src/model/**"');
    expect(prompt).toContain('"db/migrations/**"');
    expect(prompt).toContain('- "npm run lint"\n- "npm test"');
    expect(prompt).toContain("loom_submit");
    expect(prompt).not.toContain("Earlier work");
  });

  it("gives a single-repo worker the spawn arguments and brief it always had, without looking up any checkout", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    expect(spawnArgs()).toEqual({
      bbProjectId: "proj_1",
      hostId: "host_1",
      baseBranch: "loom/csv",
      title: "CSV-1 \u00b7 Order rows",
      prompt: [
        'You are a Loom worker on CSV-1 in the project "CSV export" (csv). Loom is a plugin that runs this project with agents: you do this one ticket in this worktree, and the plugin decides when it is done.',
        "",
        "## Ticket",
        'CSV-1 \u00b7 "Order rows"',
        "Build the row mapper.",
        "",
        "## Acceptance criteria",
        "1. WHEN an order is mapped THE SYSTEM SHALL return one row",
        "",
        "## Scope",
        "You may change files matching:",
        '- "src/model/**"',
        "Protected paths you must never edit:",
        "- none",
        "A change outside your scope does not stop your submit, but it is flagged to the reviewer, so keep to the scope.",
        "",
        "## Checks the plugin runs when you submit",
        '- "npm test"',
        "They run in this worktree, in this order, and stop at the first failure. They must not write tracked files, and you must not edit files while they run.",
        "",
        "## Rules",
        "- Work only in this worktree. Never push, merge, or edit a protected path.",
        "- Call loom_note({ text }) once for each milestone, so the human can follow along on the ticket.",
        "- Call loom_submit({ summary }) when every acceptance criterion holds, then end your turn. The plugin commits your work and runs the checks; you get the result as a message.",
        "- Call loom_block({ reason, needs }) when you cannot continue without something from the human or the planner: say what is wrong and exactly what you need. Then end your turn.",
        "- Do not commit yourself; the plugin does it. Do not run bb loom commands.",
      ].join("\n"),
      sectionId: "sec_1",
      metadata: { project: "csv", role: "worker", ticket: "CSV-1", spawnToken: row.spawn_token },
      providerId: "claude",
      model: "sonnet",
      permissionMode: "full",
    });
    expect(h.bb.callsTo("projectCheckout")).toEqual([]);
  });

  it("keeps a thread id that the configure hook bound through the spawn token", async () => {
    await seedProject(h);
    h.bb.afterSpawn = (threadId, args) => void h.projects.roleOf(threadId, { spawnToken: args.metadata.spawnToken });
    const row = await startWorker(h);
    expect(row).toMatchObject({ state: "active", thread_id: "thr_w1" });
  });

  it("rolls back without counting a failure when the project stopped running", async () => {
    await seedProject(h);
    const running = project();
    h.store.setProjectState(running.id, "paused", "human");
    await spawnWorker(h.ctx, running, specOf(h.store, running), ticketOf(h, "CSV-1"));
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", attempt: 0, failures: 0, worker_thread_id: null });
    expect(workerRows(h, "CSV-1")).toMatchObject([{ state: "ended" }]);
  });

  it("starts a fresh ticket from the remote base on the pr strategy, and falls back to the base on a ref error", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    h.bb.spawnError = (args) => (args.baseBranch === "origin/main" ? new Error("fatal: invalid reference: origin/main") : null);
    await startWorker(h);
    expect(h.bb.callsTo("spawnThread").map(([args]) => (args as SpawnArgs).baseBranch)).toEqual(["origin/main", "main"]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", failures: 0 });
  });

  it("resumes from the ticket's branch with the reply thread in the brief", async () => {
    await seedProject(h);
    const first = await startWorker(h);
    h.bb.environments.get("env_1")!.branchName = "wt-first";
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "The API key is missing", needs: "A test key in the CI settings", actor: first.thread_id! });
    h.store.addPost({ project_id: project().id, ticket_id: ticketOf(h, "CSV-1").id, parent_id: null, author_kind: "human", author_thread_id: null, kind: "reply", body: "Use the key in vault/test" });
    await requeueTicket(h.ctx, "CSV-1", { note: "Key is in vault now", actor: "human", author: "human" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", branch: "wt-first", failures: 0, blocked_reason: null });

    await startWorker(h);
    expect(spawnArgs(1).baseBranch).toBe("wt-first");
    expect(spawnArgs(1).prompt).toContain("Earlier work");
    expect(spawnArgs(1).prompt).toContain('"wt-first"');
    expect(spawnArgs(1).prompt).toContain("The API key is missing");
    expect(spawnArgs(1).prompt).toContain("Use the key in vault/test");
    expect(spawnArgs(1).prompt).toContain("Key is in vault now");
    expect(ticketOf(h, "CSV-1").attempt).toBe(2);
  });

  it("waits after a failed spawn, with the same row and claim, and counts failures only after three in a row", async () => {
    await seedProject(h);
    h.bb.spawnError = () => new Error("host is unreachable");
    await startWorker(h).catch(() => undefined);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0, attempt: 1, worker_thread_id: null });
    expect(workerRows(h, "CSV-1")).toMatchObject([{ state: "ended", end_reason: "failed" }]);
    expect(waitOf(ticketOf(h, "CSV-1"))).toMatchObject({ role: "worker", tries: 1, kind: "failed", reason: "host is unreachable", until: h.clock.t + 60_000, counted: false });
    const post = h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!;
    expect(post).toMatchObject({ kind: "system", author_kind: "loom" });
    expect(post.body).toBe("Could not start a worker: host is unreachable. Loom tries again in 1m; a start that fails 4 times in a row counts as a failed attempt.");

    // Before its retry time the ticket does not start.
    await startWorker(h).catch(() => undefined);
    expect(h.bb.callsTo("spawnThread")).toHaveLength(1);

    const failures: number[] = [];
    for (let n = 0; n < 5; n++) {
      h.clock.advance(waitOf(ticketOf(h, "CSV-1"))!.until - h.clock.t);
      await startWorker(h).catch(() => undefined);
      failures.push(ticketOf(h, "CSV-1").failures);
    }
    expect(failures).toEqual([0, 0, 1, 2, 3]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", attempt: 1, start_wait_json: null, blocked_reason: "could not start a worker 3 times; the last time: host is unreachable" });
    // One row and one claim for the whole attempt; the posts say what changed, not every retry.
    expect(workerRows(h, "CSV-1")).toHaveLength(1);
    expect(kinds("CSV-1").filter((kind) => kind === "claim")).toHaveLength(1);
    expect(h.store.posts(ticketOf(h, "CSV-1").id).filter((p) => p.kind === "system").map((p) => p.body.slice(0, 60))).toHaveLength(3);
    expect(project().triage_pending).toBe(1);
    expect(blockedAtStart(h.store, ticketOf(h, "CSV-1"))).toBe(true);

    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human" });
    expect(blockedAtStart(h.store, ticketOf(h, "CSV-1"))).toBe(false);
  });

  it("waits without counting while the environment provider is unavailable, and starts the same attempt when it is back", async () => {
    await seedProject(h, (doc) => (doc.budget = { max_attempts: 1 }));
    h.bb.spawnError = () => new SpawnUnavailableError("HTTP 409: No room on this machine.");
    await startWorker(h);
    for (let n = 0; n < 6; n++) {
      h.clock.advance(waitOf(ticketOf(h, "CSV-1"))!.until - h.clock.t);
      await startWorker(h);
    }
    const wait = waitOf(ticketOf(h, "CSV-1"))!;
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0, attempt: 1 });
    expect(wait).toMatchObject({ kind: "unavailable", tries: 7, counted: false, expired: false, since: h.clock.t - [1, 2, 4, 8, 15, 15].reduce((a, b) => a + b, 0) * 60_000 });
    expect(wait.until - h.clock.t).toBe(15 * 60_000);
    expect(h.store.posts(ticketOf(h, "CSV-1").id).filter((post) => post.kind === "system").map((post) => post.body)).toEqual([
      "Could not start a worker: HTTP 409: No room on this machine. Loom tries again in 1m; waiting for its provider counts no attempt, and the ticket blocks if it stays unavailable for 1h.",
    ]);

    h.bb.spawnError = null;
    h.clock.advance(wait.until - h.clock.t);
    const row = await startWorker(h);
    expect(workerRows(h, "CSV-1")).toHaveLength(1);
    expect(row).toMatchObject({ state: "active", attempt: 1, thread_id: "thr_w1" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", attempt: 1, worker_thread_id: "thr_w1" });
    expect(spawnArgs(7).prompt).not.toContain("## Earlier work");
    startedFine(h.ctx, row);
    expect(ticketOf(h, "CSV-1").start_wait_json).toBeNull();
  });

  it("does not count a queued ticket or one blocked for another reason as blocked at start", async () => {
    await seedProject(h);
    expect(blockedAtStart(h.store, ticketOf(h, "CSV-1"))).toBe(false);
    await blockTicket(h.ctx, ticketOf(h, "CSV-2"), { reason: "Waiting on legal", needs: "", actor: "human" });
    expect(ticketOf(h, "CSV-2").state).toBe("blocked");
    expect(blockedAtStart(h.store, ticketOf(h, "CSV-2"))).toBe(false);
  });

  it("blocks at once with bb's message when bb refuses the spawn", async () => {
    await seedProject(h);
    h.bb.spawnError = () => new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.");
    await startWorker(h);
    expect(ticketOf(h, "CSV-1")).toMatchObject({
      state: "blocked",
      failures: 1,
      worker_thread_id: null,
      blocked_reason: "bb refused to start a worker: HTTP 400: Provider pi only supports full permission mode.",
    });
    expect(h.bb.callsTo("spawnThread")).toHaveLength(1);
    expect(project().triage_pending).toBe(1);
    expect(blockedAtStart(h.store, ticketOf(h, "CSV-1"))).toBe(true);
  });

  it("clears the branch and counts no failure when a resumed spawn fails", async () => {
    await seedProject(h);
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { branch: "wt-old", attempt: 1 });
    h.bb.spawnError = () => new Error("fatal: couldn't find remote ref wt-old");
    await startWorker(h).catch(() => undefined);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", branch: null, failures: 0 });
    h.bb.spawnError = null;
    await startWorker(h);
    expect(spawnArgs(1).baseBranch).toBe("loom/csv");
  });
});

describe("spawnWorker eligibility", () => {
  const refuses = async (key: string) => {
    const running = project();
    const before = h.bb.callsTo("spawnThread").length;
    await spawnWorker(h.ctx, running, specOf(h.store, running), ticketOf(h, key));
    expect(h.bb.callsTo("spawnThread")).toHaveLength(before);
    expect(workerRows(h, key)).toEqual([]);
    expect(ticketOf(h, key)).toMatchObject({ state: "queued", attempt: 0, worker_thread_id: null });
    expect(kinds(key)).not.toContain("claim");
  };

  it("claims nothing for a ticket whose dependencies are not done any more", async () => {
    await seedProject(h);
    await refuses("CSV-2");
  });

  it("claims nothing when another ticket in flight now holds an overlapping scope", async () => {
    await seedProject(h, (doc) => (doc.ticket[1].depends_on = []));
    await startWorker(h, "CSV-1");
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { scope_json: JSON.stringify(["src/model/**"]) });
    await refuses("CSV-2");
  });

  it("claims nothing when max_workers are already working or checking", async () => {
    await seedProject(h, (doc) => {
      doc.ticket[1].depends_on = [];
      doc.agents = { ...doc.agents, max_workers: 1 };
    });
    await startWorker(h, "CSV-1");
    await refuses("CSV-2");
  });
});

describe("spawnWorker on a multi-repo project", () => {
  const seedRepos = (edit?: (doc: Doc) => void) => {
    h.bb.addBbProject("proj_web", { host_1: "/src/web" });
    h.bb.addBbProject("proj_api", { host_1: "/src/api" });
    h.bb.addBbProject("proj_docs", { host_1: "/src/docs" });
    return seedProject(h, (doc) => {
      doc.scope = { protected: ["db/**"] };
      doc.repo = [
        { name: "web", project: "proj_web", checks: ["npm run web-test"], protected: ["web.lock"] },
        { name: "api", project: "proj_api", base: "trunk", remote: "upstream" },
        { name: "docs", project: "proj_docs" },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[0].verify = ["npm run lint"];
      doc.ticket[1].repo = "api";
      doc.ticket[1].depends_on = [];
      edit?.(doc);
    });
  };
  const otherRepos = (...lines: string[]) => ["## Other repositories (read only)", "This project also works in these repos. You may read them for context, but never edit them: changes there belong to their own tickets.", ...lines].join("\n");

  it("spawns the worker in its repo's bb project on the project's machine, from the integration branch", async () => {
    await seedRepos();
    await startWorker(h, "CSV-2");
    expect(spawnArgs()).toMatchObject({ bbProjectId: "proj_api", hostId: "host_1", baseBranch: "loom/csv" });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", worker_thread_id: "thr_w1" });
  });

  it("starts from the repo's remote base on the pr strategy, and falls back to the repo's base on a ref error", async () => {
    await seedRepos((doc) => (doc.merge = { strategy: "pr" }));
    h.bb.spawnError = (args) => (args.baseBranch === "upstream/trunk" ? new Error("fatal: invalid reference: upstream/trunk") : null);
    await startWorker(h, "CSV-2");
    expect(h.bb.callsTo("spawnThread").map(([args]) => [(args as SpawnArgs).bbProjectId, (args as SpawnArgs).baseBranch])).toEqual([
      ["proj_api", "upstream/trunk"],
      ["proj_api", "trunk"],
    ]);
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", failures: 0 });
  });

  it("names the repo in the brief with its checks and protected paths, and lists the other repos read only with their checkout paths", async () => {
    await seedRepos();
    await startWorker(h);
    const prompt = spawnArgs().prompt;
    expect(prompt).toContain(
      "## Repository\nThis ticket is in the repo \"web\", the bb project proj_web, and this worktree is a checkout of it. The scope globs and protected paths below are relative to this repo's root.\n\n## Scope",
    );
    expect(prompt).toContain('Protected paths you must never edit:\n- "db/**"\n- "web.lock"\n');
    expect(prompt).toContain('## Checks the plugin runs when you submit\n- "npm run lint"\n- "npm run web-test"\nThey run');
    expect(prompt).not.toContain('"npm test"');
    expect(prompt).toContain(
      otherRepos(
        '- "api" (bb project proj_api): /src/api',
        '- "docs" (bb project proj_docs): /src/docs',
        'This project\'s merged work in them is on the branch "loom/csv". Read a file from it with `git -C <path> show loom/csv:<file>`.',
        "",
        "## Rules",
      ),
    );
    expect(h.bb.callsTo("projectCheckout")).toEqual([
      ["proj_api", "host_1"],
      ["proj_docs", "host_1"],
    ]);
  });

  it("uses the top-level checks and protected paths for a repo that sets none, and names no integration branch on the pr strategy", async () => {
    await seedRepos((doc) => (doc.merge = { strategy: "pr" }));
    await startWorker(h, "CSV-2");
    const prompt = spawnArgs().prompt;
    expect(prompt).toContain('This ticket is in the repo "api", the bb project proj_api,');
    expect(prompt).toContain('Protected paths you must never edit:\n- "db/**"\nA change');
    expect(prompt).toContain('## Checks the plugin runs when you submit\n- "npm test"\nThey run');
    expect(prompt).toContain(otherRepos('- "web" (bb project proj_web): /src/web', '- "docs" (bb project proj_docs): /src/docs', "", "## The pull request"));
    expect(prompt).toContain("Loom asks you to write the pull request with loom_pr");
    expect(prompt).not.toContain("merged work");
  });

  it("still starts the worker when another repo's checkout cannot be found, and lists that repo without a path", async () => {
    await seedRepos();
    h.bb.checkouts.set("proj_docs", {});
    await startWorker(h);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", worker_thread_id: "thr_w1", failures: 0 });
    expect(spawnArgs().prompt).toContain('- "api" (bb project proj_api): /src/api\n- "docs" (bb project proj_docs): no checkout was found on this machine\n');
    expect(h.bb.callsTo("log")).toContainEqual(["warn", expect.stringContaining(`CSV-1's brief lists the repo "docs" without a checkout path: Repo "docs" (bb project proj_docs) has no checkout on the machine host_1`)]);
  });

  it("still starts the worker when bb cannot look up the checkouts", async () => {
    await seedRepos();
    vi.spyOn(h.bb, "projectCheckout").mockRejectedValue(new Error("bb is restarting"));
    await startWorker(h);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", worker_thread_id: "thr_w1" });
    expect(spawnArgs().prompt).toContain('- "api" (bb project proj_api): no checkout was found on this machine\n- "docs" (bb project proj_docs): no checkout was found on this machine\n');
  });

  it("counts a failed start when the ticket names a repo the spec does not list", async () => {
    await seedRepos();
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { repo: "gone" });
    await startWorker(h);
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1, worker_thread_id: null });
    expect(h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!.body).toContain('This spec has no repo "gone"');
  });

  it("starts two tickets with overlapping scopes in different repos side by side", async () => {
    await seedRepos((doc) => (doc.ticket[1].scope = ["src/model/**"]));
    await startWorker(h, "CSV-1");
    await startWorker(h, "CSV-2");
    expect([ticketOf(h, "CSV-1").state, ticketOf(h, "CSV-2").state]).toEqual(["working", "working"]);
    expect(h.bb.callsTo("spawnThread").map(([args]) => (args as SpawnArgs).bbProjectId)).toEqual(["proj_web", "proj_api"]);
  });

  it("starts only one of two tickets with overlapping scopes in the same repo", async () => {
    await seedRepos((doc) => {
      doc.ticket[1].repo = "web";
      doc.ticket[1].scope = ["src/model/**"];
    });
    await startWorker(h, "CSV-1");
    await spawnWorker(h.ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-2"));
    expect([ticketOf(h, "CSV-1").state, ticketOf(h, "CSV-2").state]).toEqual(["working", "queued"]);
    expect(h.bb.callsTo("spawnThread")).toHaveLength(1);
  });
});

describe("idle policy", () => {
  it("nudges the first idle and abandons the second with a WIP commit, requeueing with one failure", async () => {
    const row = await startBoth();
    h.host.worktree("/wt/env_1").dirty = true;
    h.host.worktree("/wt/env_1").changed = ["src/model/a.ts"];

    await onWorkerIdle(h.ctx, row);
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
    expect(h.bb.sent("thr_w1")[0]).toMatch(/^\[loom\] CSV-1: .*loom_submit.*loom_block/s);
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", idle_count: 1 });
    expect(h.host.callsTo("commitAll")).toEqual([]);

    await onWorkerIdle(h.ctx, row);
    expect(h.host.callsTo("commitAll")).toEqual([{ worktree: "/wt/env_1", message: "WIP CSV-1 (attempt 1)" }]);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "abandoned" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1, branch: "wt-thr_w1", worker_thread_id: null });
    expect(callNames().filter((name) => name === "stop" || name === "archive")).toEqual(["stop", "archive"]);
  });

  it("blocks the ticket once max_attempts workers failed, and flags the project for triage", async () => {
    await seedProject(h, (doc) => (doc.budget = { max_attempts: 2 }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await startWorker(h);
      await onWorkerIdle(h.ctx, row);
      await onWorkerIdle(h.ctx, row);
    }
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", failures: 2 });
    expect(ticketOf(h, "CSV-1").blocked_reason).toContain("failed 2 times");
    expect(project().triage_pending).toBe(1);
  });

  it("does nothing for an idle that arrives after the row ended, while the project is paused, or while the ticket is checking", async () => {
    const row = await startBoth();
    h.store.setProjectState(project().id, "paused", "human");
    await onWorkerIdle(h.ctx, row);
    expect(h.bb.sent("thr_w1")).toEqual([]);
    h.store.setProjectState(project().id, "running", "human");

    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    await onWorkerIdle(h.ctx, row);
    expect(h.bb.sent("thr_w1")).toEqual([]);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");

    await endThread(h.ctx, row, "gone", { commit: false });
    h.bb.calls.length = 0;
    await onWorkerIdle(h.ctx, row);
    await onWorkerIdle(h.ctx, row);
    expect(h.bb.calls).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
  });
});

describe("endThread", () => {
  it("ends a row once when two paths race, and the second caller learns it lost", async () => {
    const row = await startBoth();
    const results = await Promise.all([endThread(h.ctx, row, "abandoned", { commit: true }), endThread(h.ctx, row, "timeout", { commit: true })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.bb.callsTo("stop")).toHaveLength(1);
    expect(h.bb.callsTo("archive")).toHaveLength(1);
    expect(ticketOf(h, "CSV-1").failures).toBe(1);
  });

  it("releases the ticket only after the thread was stopped and archived", async () => {
    const row = await startBoth();
    h.bb.stopConfirms = false;
    expect(await endThread(h.ctx, row, "abandoned", { commit: false })).toBe(true);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ending", end_reason: "abandoned" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", worker_thread_id: "thr_w1" });
    expect(h.bb.callsTo("archive")).toEqual([]);

    h.bb.stopConfirms = true;
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1 });
    const order = callNames().filter((name) => ["stop", "archive"].includes(name));
    expect(order.indexOf("archive")).toBeGreaterThan(order.lastIndexOf("stop"));
  });

  it("archives anyway after ten minutes in ending, and records the final token count", async () => {
    const row = await startBoth();
    h.bb.stopConfirms = false;
    h.bb.tokens.set("thr_w1", 4321);
    await endThread(h.ctx, row, "timeout", { commit: false });
    h.clock.advance(9 * 60_000);
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)?.state).toBe("ending");
    expect(h.bb.callsTo("archive")).toEqual([]);

    h.clock.advance(2 * 60_000);
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", tokens: 4321 });
    expect(ticketOf(h, "CSV-1").state).toBe("queued");
    expect(h.bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("did not stop"))).toBe(true);
  });

  it("leaves the ticket alone when the caller passes move null, and treats a thread that is already gone as stopped", async () => {
    const row = await startBoth();
    h.bb.threads.delete("thr_w1");
    await endThread(h.ctx, row, "cancelled", { commit: false, move: null });
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(h.bb.callsTo("archive")).toEqual([]);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
  });

  it("records the worker's branch before it archives, and skips the commit when there is no path", async () => {
    const row = await startBoth();
    h.bb.environments.get("env_1")!.path = null;
    await endThread(h.ctx, row, "blocked", { commit: true });
    expect(ticketOf(h, "CSV-1").branch).toBe("wt-thr_w1");
    expect(h.host.callsTo("commitAll")).toEqual([]);
    expect(callNames().indexOf("getEnvironment")).toBeLessThan(callNames().indexOf("archive"));
  });

  it("reads the branch through the thread when the row has no environment yet", async () => {
    await seedProject(h);
    h.bb.provisionEnvironment = false;
    const row = await startWorker(h);
    expect(row.environment_id).toBeNull();
    h.bb.environments.set("env_late", { path: "/wt/late", branchName: "wt-late", hostId: "host_1" });
    h.bb.threads.get("thr_w1")!.environmentId = "env_late";
    await recordBranch(h.ctx, row);
    expect(ticketOf(h, "CSV-1").branch).toBe("wt-late");
    expect(h.store.thread(row.id)?.environment_id).toBe("env_late");
  });
});

describe("ending a worker on a machine of its own", () => {
  it("brings its WIP commit home on the home branch, leaving the reviewed ref alone, before the machine goes", async () => {
    await seedMachineProject(h);
    const row = await startWorker(h);
    h.host.worktree(`/wt/${row.environment_id}`).dirty = true;
    h.host.calls = [];
    await endThread(h.ctx, row, "blocked", { commit: true });
    expect(h.host.calls.map((call) => `${call.method}@${call.hostId}`)).toEqual(["commitAll@host_box1", "exportChanges@host_box1", "importCommit@host_1"]);
    expect(h.host.refs.get("refs/heads/loom/csv/csv-1-home")).toBe("home1");
    expect(h.host.refs.has("refs/loom/csv/csv-1/reviewed")).toBe(false);
    expect(h.bb.callsTo("archive")).toHaveLength(1);
  });

  it("keeps the thread, stopped but not archived, while its work cannot be brought home, and ends it once the work comes home", async () => {
    await seedMachineProject(h);
    const row = await startWorker(h);
    h.host.worktree(`/wt/${row.environment_id}`).dirty = true;
    h.host.scripted.importCommit = [new Error("the project's machine is offline")];
    await endThread(h.ctx, row, "blocked", { commit: true });
    expect(h.store.thread(row.id)).toMatchObject({ state: "ending", end_reason: "blocked" });
    expect(h.bb.callsTo("stop")).toEqual([[row.thread_id]]);
    expect(h.bb.callsTo("archive")).toEqual([]);
    expect(h.bb.callsTo("log").map(([, text]) => text)).toContain("Could not bring CSV-1's work home before ending its thread, so Loom keeps the thread and its machine and tries again: the project's machine is offline");

    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(h.host.refs.get("refs/heads/loom/csv/csv-1-home")).toBe("home1");
    expect(h.bb.callsTo("archive")).toEqual([[row.thread_id]]);
  });

  it("ends the thread after ten minutes of failed bring-homes, and says on the ticket that the work did not come home", async () => {
    await seedMachineProject(h);
    const row = await startWorker(h);
    h.host.errors.importCommit = new Error("the project's machine is offline");
    await endThread(h.ctx, row, "blocked", { commit: true });
    h.clock.advance(9 * 60_000);
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)?.state).toBe("ending");
    expect(h.bb.callsTo("archive")).toEqual([]);

    h.clock.advance(2 * 60_000);
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(h.bb.callsTo("archive")).toEqual([[row.thread_id]]);
    const note = h.store.posts(ticketOf(h, "CSV-1").id).find((post) => post.kind === "system" && post.body.startsWith("Loom could not bring"));
    expect(note?.body).toBe("Loom could not bring the worker's work home from its machine, so the next worker starts without the changes it made since it last submitted or saved: the project's machine is offline. Loom tried for 10 minutes before it ended the thread.");
  });

  it("still ends the thread when its WIP commit fails, and says why in the log", async () => {
    await seedMachineProject(h);
    const row = await startWorker(h);
    h.host.errors.commitAll = new Error("the disk is full");
    await endThread(h.ctx, row, "blocked", { commit: true });
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(h.bb.callsTo("log").map(([, text]) => text)).toContain("Could not save CSV-1's work before ending its thread: the disk is full");
  });
});

describe("resolveEnvironment", () => {
  it("returns the environment the row already has, without asking bb for the thread", async () => {
    const row = await startBoth();
    const environment = await resolveEnvironment(h.ctx, row);
    expect(environment).toEqual({ path: "/wt/env_1", branchName: "wt-thr_w1", hostId: "host_1" });
    expect(h.bb.callsTo("getThread")).toEqual([]);
  });

  it("finds a late-provisioned environment through the thread and keeps it on the row and the ticket", async () => {
    await seedProject(h);
    const row = await startLateWorker(h);
    expect(row.environment_id).toBeNull();
    expect(await resolveEnvironment(h.ctx, row)).toEqual({ path: "/wt/late", branchName: "late-branch", hostId: "host_1" });
    expect(h.store.thread(row.id)!.environment_id).toBe("env_late");
    expect(ticketOf(h, "CSV-1").environment_id).toBe("env_late");
  });

  it("works from a stale snapshot: it reads the row again, and a second call does not ask the thread twice", async () => {
    await seedProject(h);
    const stale = await startLateWorker(h);
    await resolveEnvironment(h.ctx, stale);
    h.bb.calls = [];
    expect(await resolveEnvironment(h.ctx, stale)).toMatchObject({ path: "/wt/late" });
    expect(h.bb.callsTo("getThread")).toEqual([]);
  });

  it("is null when bb has no environment for the thread yet, or does not know the thread", async () => {
    await seedProject(h);
    h.bb.provisionEnvironment = false;
    const row = await startWorker(h);
    expect(await resolveEnvironment(h.ctx, row)).toBeNull();
    expect(h.store.thread(row.id)!.environment_id).toBeNull();
    h.bb.threads.delete("thr_w1");
    expect(await resolveEnvironment(h.ctx, row)).toBeNull();
  });
});

describe("a worker whose environment arrived after spawn", () => {
  it("is ended with its WIP committed in the late worktree and its branch recorded", async () => {
    await seedProject(h);
    const row = await startLateWorker(h);
    await endThread(h.ctx, row, "blocked", { commit: true });
    expect(h.host.callsTo("commitAll")).toEqual([{ worktree: "/wt/late", message: "WIP CSV-1 (attempt 1)" }]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", branch: "late-branch" });
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", environment_id: "env_late" });
  });

  it("saves its work through blockTicket as well", async () => {
    await seedProject(h);
    const row = await startLateWorker(h);
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "help", needs: "input", actor: row.thread_id! });
    expect(h.host.callsTo("commitAll")).toHaveLength(1);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", branch: "late-branch" });
  });
});

describe("ticketMoveFor", () => {
  it("maps each end reason to a ticket move", async () => {
    await seedProject(h);
    const ticket = ticketOf(h, "CSV-1");
    const spec = specOf(h.store, project());
    const working = { ...ticket, state: "working" as const, failures: 0 };
    expect(ticketMoveFor("abandoned", working, spec)).toMatchObject({ to: "queued", patch: { failures: 1, worker_thread_id: null, environment_id: null } });
    expect(ticketMoveFor("timeout", { ...working, failures: 1 }, spec)).toMatchObject({ to: "queued", patch: { failures: 2 } });
    expect(ticketMoveFor("failed", { ...working, failures: 2 }, spec)).toMatchObject({ to: "blocked", patch: { failures: 3 } });
    expect(ticketMoveFor("gone", { ...working, state: "checking", failures: 2 }, spec)).toMatchObject({ to: "queued", patch: { worker_thread_id: null } });
    expect(ticketMoveFor("gone", working, spec)?.patch.failures).toBeUndefined();
    expect(ticketMoveFor("blocked", { ...working, blocked_reason: "why" }, spec)).toMatchObject({ to: "blocked", patch: { blocked_reason: "why" } });
    expect(ticketMoveFor("cancelled", working, spec)).toMatchObject({ to: "cancelled" });
  });

  it("returns nothing once the ticket has left working or checking, except for block and cancel", async () => {
    await seedProject(h);
    const spec = specOf(h.store, project());
    const review = { ...ticketOf(h, "CSV-1"), state: "review" as const };
    for (const reason of ["abandoned", "timeout", "failed", "gone"] as const) expect(ticketMoveFor(reason, review, spec)).toBeNull();
    expect(ticketMoveFor("blocked", review, spec)?.to).toBe("blocked");
    expect(ticketMoveFor("cancelled", review, spec)?.to).toBe("cancelled");
    const done = { ...review, state: "done" as const };
    expect(ticketMoveFor("blocked", done, spec)).toBeNull();
    expect(ticketMoveFor("cancelled", { ...review, state: "cancelled" as const }, spec)).toBeNull();
  });
});

describe("blocking and requeueing", () => {
  it("stores the branch when a worker blocks before it ever submitted, and the requeued worker starts from it", async () => {
    const row = await startBoth();
    h.host.worktree("/wt/env_1").dirty = true;
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "No API key", needs: "A key", actor: row.thread_id! });
    const ticket = ticketOf(h, "CSV-1");
    expect(ticket).toMatchObject({ state: "blocked", branch: "wt-thr_w1", worker_thread_id: null });
    expect(ticket.blocked_reason).toBe("No API key. Needs: A key");
    expect(project().triage_pending).toBe(1);
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(h.host.callsTo("commitAll")).toHaveLength(1);
    const block = h.store.posts(ticket.id).at(-1)!;
    expect(block).toMatchObject({ kind: "block", author_kind: "worker", author_thread_id: "thr_w1" });
    expect(JSON.parse(block.data_json)).toEqual({ reason: "No API key", needs: "A key" });

    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human" });
    await startWorker(h);
    expect(spawnArgs(1).baseBranch).toBe("wt-thr_w1");
  });

  it("requeues a blocked ticket with the note as a reply, resets the counters and kicks the engine, and refuses any other state", async () => {
    await seedProject(h);
    const ticket = ticketOf(h, "CSV-1");
    h.store.updateTicket(ticket.id, { failures: 3, check_failures: 4, blocked_reason: "stuck" });
    h.store.setTicketState(ticket.id, "blocked", "human");
    const kicks = h.kicks.count;
    const requeued = await requeueTicket(h.ctx, "CSV-1", { note: "Try the other API", actor: "thr_plan", author: "planner", threadId: "thr_plan" });
    expect(requeued).toMatchObject({ state: "queued", failures: 0, check_failures: 0, blocked_reason: null });
    expect(h.store.posts(ticket.id).at(-1)).toMatchObject({ kind: "reply", author_kind: "planner", author_thread_id: "thr_plan", body: "Try the other API" });
    expect(h.kicks.count).toBe(kicks + 1);

    await expect(requeueTicket(h.ctx, "CSV-1", { note: "again", actor: "human", author: "human" })).rejects.toMatchObject({ code: "loom_invalid_state" });
    await expect(requeueTicket(h.ctx, "CSV-9", { note: "x", actor: "human", author: "human" })).rejects.toMatchObject({ code: "loom_not_found" });
  });

  it("blocks a ticket that is in review: the live worker ends and the ticket moves", async () => {
    const row = await startBoth();
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "Not what we want", needs: "", actor: "human" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "Not what we want" });
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(h.store.posts(ticketOf(h, "CSV-1").id).at(-1)).toMatchObject({ kind: "block", author_kind: "human" });
  });

  it("blocks a ticket with no live worker directly", async () => {
    await seedProject(h);
    await blockTicket(h.ctx, ticketOf(h, "CSV-2"), { reason: "Waiting on legal", needs: "", actor: "human" });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "blocked", blocked_reason: "Waiting on legal" });
    expect(project().triage_pending).toBe(1);
  });
});

describe("toWorking", () => {
  it("moves the ticket to working and restarts the worker's clock and idle count", async () => {
    const row = await startBoth();
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.updateThread(row.id, { idle_count: 1 });
    h.clock.advance(90 * 60_000);
    toWorking(h.ctx, ticketOf(h, "CSV-1"), h.store.thread(row.id)!, { why: "test" });
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(h.store.thread(row.id)).toMatchObject({ clock_at: h.clock.t, idle_count: 0 });
    const event = h.store.events(project().id).filter((e) => e.kind === "ticket.state").at(-1)!;
    expect(JSON.parse(event.data_json)).toMatchObject({ from: "checking", to: "working", why: "test" });
  });
});

describe("failed turns", () => {
  it("retries a rate-limited turn at the window's reset plus 15 seconds, holds new spawns, and does not end the worker", async () => {
    const row = await startBoth();
    const reset = h.clock.t + 10 * 60_000;
    await onTurnFailed(
      h.ctx,
      rateLimited({
        rateLimits: { kind: "subscription-window", overageReason: null, overageStatus: null, providerId: "claude", reachedReason: null, status: "blocked", windows: [{ label: "5h", providerKey: null, resetsAtMs: reset, status: "blocked" }] },
      }),
    );
    expect(h.bb.callsTo("retryTurn")).toEqual([["thr_w1", "req_1", reset + 15_000]]);
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", rate_limit_retries: 1 });
    expect(project().hold_until).toBe(reset + 15_000);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });

  it("falls back to a growing delay without a reset time, and stops retrying after three tries", async () => {
    const row = await startBoth();
    await onTurnFailed(h.ctx, rateLimited({ attemptNumber: 2 }));
    expect(h.bb.callsTo("retryTurn")[0]![2]).toBe(h.clock.t + 120_000);
    h.store.updateThread(row.id, { rate_limit_retries: 3 });
    await onTurnFailed(h.ctx, rateLimited({ attemptNumber: 3 }));
    expect(h.bb.callsTo("retryTurn")).toHaveLength(1);
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
  });

  it("does not retry a worker's rate limit while the project is paused", async () => {
    await startBoth();
    h.store.setProjectState(project().id, "paused", "human");
    await onTurnFailed(h.ctx, rateLimited());
    expect(h.bb.callsTo("retryTurn")).toEqual([]);
  });

  it("counts any other failed turn like an idle: nudge first, then end the worker as failed", async () => {
    const row = await startBoth();
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1" }));
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_2" }));
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "failed" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1 });
  });

  it("blocks a ticket whose environment provider stays unavailable for an hour, counting no attempt, and approval requeues it", async () => {
    await seedProject(h);
    h.bb.spawnError = () => new SpawnUnavailableError("No room on this machine.");
    await startWorker(h);
    while (ticketOf(h, "CSV-1").state === "queued") {
      h.clock.advance(waitOf(ticketOf(h, "CSV-1"))!.until - h.clock.t);
      await startWorker(h);
    }
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", failures: 0, start_wait_json: null, blocked_reason: "no worker could start: the environment provider was unavailable for 1h: No room on this machine." });
    expect(h.bb.callsTo("spawnThread")).toHaveLength(8);
    expect(project().triage_pending).toBe(1);
    expect(blockedAtStart(h.store, ticketOf(h, "CSV-1"))).toBe(true);
  });

  it("handles a provisioning failure once, as a failed start that waits, even though bb reports it twice", async () => {
    await seedProject(h);
    h.bb.provisionEnvironment = false;
    const row = await startWorker(h);
    h.bb.systemErrors.set("thr_w1", { code: "thread_provisioning_failed", message: "Provisioning thread failed", detail: "The worktree could not be created." });
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1" }));
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1" }));
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "failed" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
    expect(waitOf(ticketOf(h, "CSV-1"))).toMatchObject({ tries: 1, kind: "failed", row: row.id });
    expect(h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!.body).toContain("Could not start a worker: The worktree could not be created.");
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
    expect(h.bb.sent("thr_w1")).toEqual([]);

    // The retry starts the same row on a new thread, and asks for the same branch.
    h.clock.advance(60_000);
    h.bb.provisionEnvironment = true;
    await startWorker(h);
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", thread_id: "thr_w2", attempt: 1 });
  });

  it("keeps the branch of a ticket whose pull request is open when its new worker cannot start", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { branch: "wt-old", attempt: 1, pushed_sha: "abc", pr_branch: "wt-old" });
    h.bb.provisionEnvironment = false;
    await startWorker(h);
    h.bb.systemErrors.set("thr_w1", { code: "thread_provisioning_failed", message: "Provisioning thread failed", detail: "fatal: bad ref" });
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1" }));
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", branch: "wt-old", failures: 0 });
  });

  it("clears the branch of a resumed ticket whose thread failed before it had an environment", async () => {
    await seedProject(h);
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { branch: "wt-old", attempt: 1 });
    h.bb.provisionEnvironment = false;
    await startWorker(h);
    h.bb.systemErrors.set("thr_w1", { code: "thread_provisioning_failed", message: "Provisioning thread failed", detail: "fatal: bad ref" });
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1" }));
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", branch: null, failures: 0, start_wait_json: null });
  });

  it("ignores turns of threads it does not know", async () => {
    await onTurnFailed(h.ctx, rateLimited({ threadId: "thr_other" }));
    expect(h.bb.callsTo("retryTurn")).toEqual([]);
  });
});

describe("threads that disappear", () => {
  it("requeues a ticket without a failure when the human archives its worker", async () => {
    const row = await startBoth();
    h.host.worktree("/wt/env_1").dirty = true;
    await onThreadGone(h.ctx, "thr_w1");
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0, branch: "wt-thr_w1" });
    expect(h.host.callsTo("commitAll")).toHaveLength(1);
  });

  it("does the same for a worker deleted while the project is paused", async () => {
    await startBoth();
    h.store.setProjectState(project().id, "paused", "human");
    await onThreadGone(h.ctx, "thr_w1");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
  });

  it("ignores the archive event for a row the plugin is already ending, and for unknown threads", async () => {
    const row = await startBoth();
    await endThread(h.ctx, row, "abandoned", { commit: false });
    await onThreadGone(h.ctx, "thr_w1");
    await onThreadGone(h.ctx, "thr_unknown");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1 });
  });

  it("numbers each worker row with the ticket's attempt", async () => {
    const first = await startBoth();
    expect(first.attempt).toBe(1);
    await onThreadGone(h.ctx, "thr_w1");
    expect(h.store.thread(first.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    const second = await startWorker(h);
    expect(second.id).not.toBe(first.id);
    expect(second.attempt).toBe(2);
  });
});

describe("prompts", () => {
  const post = (id: number, kind: PostRow["kind"], body: string, parent: number | null = null): PostRow => ({
    id,
    project_id: 1,
    ticket_id: 1,
    parent_id: parent,
    author_kind: kind === "block" ? "worker" : "planner",
    author_thread_id: null,
    kind,
    body,
    data_json: "{}",
    at: 1_800_000_000_000,
  });

  it("renders replies indented under their parent", () => {
    const text = renderThread([post(1, "brief", "Do it"), post(2, "reply", "Question?"), post(3, "reply", "Answer.", 2)], 10_000);
    expect(text).toBe(
      ["#1 planner brief 2027-01-15T08:00Z", "Do it", "", "#2 planner reply 2027-01-15T08:00Z", "Question?", "", "  #3 planner reply 2027-01-15T08:00Z", "  Answer."].join("\n"),
    );
  });

  it("drops the oldest posts first and always keeps the brief and the last block post", () => {
    const posts = [post(1, "brief", "BRIEF"), post(2, "block", "OLD BLOCK"), ...Array.from({ length: 20 }, (_, i) => post(3 + i, "note", `note ${i} ${"x".repeat(200)}`)), post(23, "block", "LAST BLOCK"), post(24, "reply", "NEWEST")];
    const text = renderThread(posts, 1500);
    expect(text).toContain("BRIEF");
    expect(text).toContain("LAST BLOCK");
    expect(text).toContain("NEWEST");
    expect(text).not.toContain("OLD BLOCK");
    expect(text).not.toContain("note 0 ");
    expect(text).toMatch(/\[\d+ earlier posts left out/);
    expect(text.length).toBeLessThan(2500);
  });

  it("puts the block reason, the branch and the thread into a resumed brief only", async () => {
    await seedProject(h);
    const spec = parseSpec(specToml()).spec!;
    const ticket = { ...ticketOf(h, "CSV-1"), branch: "wt-old" };
    const posts = [post(1, "brief", "Do it"), post(2, "block", "The key is missing")];
    const fresh = workerBrief({ project: project(), spec, ticket, posts, resume: false });
    const resumed = workerBrief({ project: project(), spec, ticket, posts, resume: true });
    expect(fresh).not.toContain("The key is missing");
    expect(resumed).toContain("The key is missing");
    expect(resumed).toContain('"wt-old"');
    const reject = parseSpec(specToml((doc: Doc) => (doc.scope = { enforce: "reject" }))).spec!;
    expect(workerBrief({ project: project(), spec: reject, ticket, posts, resume: false })).toContain("makes loom_submit fail");
  });

  it("tells a pull request worker how to sign its comments, also when it resumes on an open pull request", async () => {
    await seedProject(h);
    const spec = parseSpec(specToml((doc: Doc) => (doc.merge = { strategy: "pr" }))).spec!;
    const ticket = ticketOf(h, "CSV-1");
    const sign = "End every comment and reply you post on the pull request with a blank line and then this line, exactly as written:\n  Posted by Loom";
    expect(workerBrief({ project: project(), spec, ticket, posts: [], resume: true, signature: "Posted by Loom" })).toContain(sign);
    expect(workerBrief({ project: project(), spec, ticket, posts: [], resume: true, signature: "" })).not.toContain("End every comment");
    const integration = parseSpec(specToml()).spec!;
    expect(workerBrief({ project: project(), spec: integration, ticket, posts: [], resume: false, signature: "Posted by Loom" })).not.toContain("End every comment");
  });
});

describe("loom_resume on a machine of its own", () => {
  async function pending() {
    await seedMachineProject(h);
    const row = await startWorker(h);
    h.host.trees.set("home1", "t1");
    h.store.updateThread(row.id, { resume_json: JSON.stringify({ sha: "home1", tree: "t1" }) });
    h.host.calls = [];
    return h.store.thread(row.id)!;
  }

  it("carries the work brought home into the worker's worktree and clears the resume, and loom_submit waits for it", async () => {
    const row = await pending();
    expect(() => submit(h.ctx, row.thread_id!, "Done")).toThrow(/Call loom_resume first/u);
    const reply = await resumeWork(h.ctx, row.thread_id!);
    expect(reply).toContain("Loom put CSV-1's earlier work in your worktree");
    expect(h.store.thread(row.id)!.resume_json).toBeNull();
    expect(h.host.calls.map((call) => `${call.method}@${call.hostId}`)).toEqual(["exportChanges@host_1", "carryStart@host_box1", "carryFinish@host_box1"]);
    expect(h.host.callsTo("exportChanges")).toEqual([{ worktree: "/repo", base: "origin/main", head: "home1" }]);
    const worktree = h.host.worktree(`/wt/${row.environment_id}`);
    expect(h.host.trees.get(worktree.head)).toBe("t1");
    expect(submit(h.ctx, row.thread_id!, "Done")).toContain("Submitted CSV-1");
    await settleChecks(h.ctx);
  });

  it("says there is nothing to resume without pending work, and keeps the resume when the carry fails", async () => {
    const row = await pending();
    h.host.scripted.carryStart = [{ outcome: "unavailable", message: "The base commit base000 is not on this machine" }];
    await expect(resumeWork(h.ctx, row.thread_id!)).rejects.toThrow("Loom could not put the earlier work in your worktree: The base commit base000 is not on this machine. Call loom_resume again, or loom_block if it keeps failing.");
    expect(h.store.thread(row.id)!.resume_json).not.toBeNull();
    await resumeWork(h.ctx, row.thread_id!);
    expect(await resumeWork(h.ctx, row.thread_id!)).toContain("Nothing to resume");
    await expect(resumeWork(h.ctx, "thr_plan")).rejects.toThrow(/loom_resume is for a Loom worker thread/u);
  });
});

describe("a worker on a machine of its own after an earlier one", () => {
  it("starts at the fresh base with the work brought home pending for loom_resume", async () => {
    await seedMachineProject(h);
    const first = await startWorker(h);
    h.host.worktree(`/wt/${first.environment_id}`).dirty = true;
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "Need the schema", needs: "the schema", actor: "human" });
    expect(h.host.refs.get("refs/heads/loom/csv/csv-1-home")).toBe("home1");
    await requeueTicket(h.ctx, "CSV-1", { note: "Here it is", actor: "human", author: "human" });
    const second = await startWorker(h);
    expect(second.id).not.toBe(first.id);
    expect(spawnArgs(1)).toMatchObject({ baseBranch: "origin/main", environment: { providerId: "git-worktree", machine: { providerId: "boxes" } } });
    expect(h.host.callsTo("refTip")).toContainEqual({ repo: "/repo", ref: "refs/heads/loom/csv/csv-1-home" });
    expect(JSON.parse(h.store.thread(second.id)!.resume_json!)).toEqual({ sha: "home1", tree: "c1" });
  });

  it("keeps the work brought home when a worker ends before loom_resume, so the next worker resumes from it", async () => {
    await seedMachineProject(h);
    const first = await startWorker(h);
    h.host.worktree(`/wt/${first.environment_id}`).dirty = true;
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "Need the schema", needs: "the schema", actor: "human" });
    await requeueTicket(h.ctx, "CSV-1", { note: "Here it is", actor: "human", author: "human" });
    const second = await startWorker(h);
    expect(JSON.parse(h.store.thread(second.id)!.resume_json!)).toEqual({ sha: "home1", tree: "c1" });

    h.host.worktree(`/wt/${second.environment_id}`).dirty = true;
    h.host.calls = [];
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "Still stuck", needs: "help", actor: "human" });
    expect(h.host.calls.map((call) => `${call.method}@${call.hostId}`)).toEqual(["commitAll@host_box2"]);
    expect(h.host.refs.get("refs/heads/loom/csv/csv-1-home")).toBe("home1");
    expect(h.bb.callsTo("log").map(([, text]) => text)).toContain("CSV-1's worker ended before loom_resume, so Loom kept the work brought home as it was; the worker's own changes stay committed on its machine.");

    await requeueTicket(h.ctx, "CSV-1", { note: "Try again", actor: "human", author: "human" });
    const third = await startWorker(h);
    expect(JSON.parse(h.store.thread(third.id)!.resume_json!)).toEqual({ sha: "home1", tree: "c1" });
  });

  it("starts with nothing pending when no work was brought home", async () => {
    await seedMachineProject(h);
    const row = await startWorker(h);
    expect(spawnArgs(0).baseBranch).toBe("origin/main");
    expect(h.store.thread(row.id)!.resume_json).toBeNull();
  });

  it("waits, counting nothing at first, when Loom cannot read the work brought home", async () => {
    await seedMachineProject(h);
    h.host.scripted.refTip = [new Error("the host is restarting")];
    await spawnWorker(h.ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"));
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
    expect(waitOf(ticketOf(h, "CSV-1"), "worker")).toMatchObject({ kind: "failed", reason: "Loom could not read the work brought home for CSV-1: the host is restarting" });
  });
});

describe("a placement change between a ticket's workers", () => {
  async function placement(machine: boolean) {
    h.bb.machineProviderList = [BOXES];
    await h.projects.propose({
      toml: specToml((doc) => {
        doc.merge = { strategy: "pr", stack: false };
        if (machine) doc.environment = { provider: "git-worktree", machine: { provider: "boxes" } };
        else delete doc.environment;
      }),
      threadId: "thr_plan",
      bbProjectId: "proj_1",
      hostId: "host_1",
    });
    await h.projects.approve("csv", "human");
  }
  const block = (reason: string) => blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason, needs: "help", actor: "human" });
  const requeue = () => requeueTicket(h.ctx, "CSV-1", { note: "Go on", actor: "human", author: "human" });

  it("resumes a worker on a new machine from the branch a worker on the project's machine left, also after a worker that never resumed", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", stack: false }));
    const first = await startWorker(h);
    h.bb.environments.get(first.environment_id!)!.branchName = "loom/csv/csv-1-1";
    h.host.worktree(`/wt/${first.environment_id}`).dirty = true;
    await block("Need the schema");
    h.host.refs.set("refs/heads/loom/csv/csv-1-1", "c1");
    await placement(true);
    await requeue();
    const second = await startWorker(h);
    expect(spawnArgs(1)).toMatchObject({ baseBranch: "origin/main", environment: { machine: { providerId: "boxes" } } });
    expect(JSON.parse(h.store.thread(second.id)!.resume_json!)).toEqual({ sha: "c1", tree: "c1" });

    h.host.worktree(`/wt/${second.environment_id}`).dirty = true;
    await block("Still stuck");
    expect(ticketOf(h, "CSV-1").branch).toBe("loom/csv/csv-1-1");
    await requeue();
    const third = await startWorker(h);
    expect(JSON.parse(h.store.thread(third.id)!.resume_json!)).toEqual({ sha: "c1", tree: "c1" });
  });

  it("starts a worker on the project's machine from the work brought home when the last branch was on another machine, and from its own branch after that", async () => {
    await seedMachineProject(h);
    const first = await startWorker(h);
    h.host.worktree(`/wt/${first.environment_id}`).dirty = true;
    await block("Need the schema");
    expect(h.host.refs.get("refs/heads/loom/csv/csv-1-home")).toBe("home1");
    await placement(false);
    await requeue();
    const second = await startWorker(h);
    expect(spawnArgs(1).baseBranch).toBe("loom/csv/csv-1-home");
    expect(spawnArgs(1).environment?.machine).toBeUndefined();
    expect(h.store.thread(second.id)!.resume_json).toBeNull();

    h.bb.environments.get(second.environment_id!)!.branchName = "loom/csv/csv-1-2";
    h.host.worktree(`/wt/${second.environment_id}`).dirty = true;
    await block("Still stuck");
    h.host.refs.set("refs/heads/loom/csv/csv-1-2", "c2");
    h.host.ancestry.add("home1..c2");
    await requeue();
    await startWorker(h);
    expect(spawnArgs(2).baseBranch).toBe("loom/csv/csv-1-2");
  });

  it("resumes from the work brought home, not from a copy of the last worker's branch that its provider synced to the checkout", async () => {
    await seedMachineProject(h);
    const first = await startWorker(h);
    h.host.worktree(`/wt/${first.environment_id}`).dirty = true;
    await block("Need the schema");
    h.host.refs.set("refs/heads/wt-thr_w1", "synced1");
    await requeue();
    h.host.calls = [];
    const second = await startWorker(h);
    expect(JSON.parse(h.store.thread(second.id)!.resume_json!)).toEqual({ sha: "home1", tree: "c1" });
    expect(h.host.callsTo("refTip")).toEqual([
      { repo: "/repo", ref: "refs/heads/loom/csv/csv-1-home" },
      { repo: "/repo", ref: "refs/heads/wt-thr_w1", contains: "home1" },
    ]);
  });
});

describe("idles a move of the thread's machine caused", () => {
  const moved = (threadId: string, seq: number) => h.bb.systemErrors.set(threadId, { code: "machine_maintenance", message: "Machine preservation is interrupting this turn.", seq, at: 0 });

  it("does not count the idle after a move, consumes the event, counts the next idle, and ignores a later move again", async () => {
    await seedMachineProject(h);
    const row = await startWorker(h);
    moved(row.thread_id!, 7);
    await onWorkerIdle(h.ctx, row);
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", idle_count: 0, maintenance_seq: 7 });
    expect(h.bb.sent(row.thread_id!)).toEqual([]);

    await onWorkerIdle(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)).toMatchObject({ idle_count: 1 });
    expect(h.bb.sent(row.thread_id!)).toHaveLength(1);

    moved(row.thread_id!, 12);
    await onWorkerIdle(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", idle_count: 1, maintenance_seq: 12 });
  });

  it("counts the same idle as before on the project's machine, and asks bb nothing", async () => {
    const row = await startBoth();
    moved(row.thread_id!, 7);
    await onWorkerIdle(h.ctx, row);
    expect(h.store.thread(row.id)).toMatchObject({ idle_count: 1, maintenance_seq: 0 });
    expect(h.bb.callsTo("latestSystemError")).toEqual([]);
  });
});

describe("the brief of a worker on a machine of its own", () => {
  const spec = (edit?: (doc: Doc) => void) =>
    parseSpec(
      specToml((doc) => {
        doc.merge = { strategy: "pr", stack: false };
        doc.environment = { provider: "git-worktree", machine: { provider: "boxes" } };
        doc.repo = [{ name: "web", project: "proj_web" }, { name: "api", project: "proj_api" }];
        doc.ticket[0].repo = "web";
        doc.ticket[1].repo = "web";
        edit?.(doc);
      }),
    ).spec!;

  it("starts with loom_resume when earlier work is pending, and says where the earlier work comes from", async () => {
    await seedProject(h);
    const ticket = { ...ticketOf(h, "CSV-2"), repo: "web", branch: "loom/csv/csv-2-1" };
    const brief = workerBrief({ project: project(), spec: spec(), ticket, posts: [], resume: true, remote: true, resumePending: true });
    expect(brief.split("\n").slice(2, 4)).toEqual(["## First step", "Call loom_resume before anything else. It puts the work earlier workers left on this ticket in this worktree, as one commit on the base, carried from the project's machine; loom_submit is refused until you have."]);
    expect(brief).toContain("An earlier worker already worked on this ticket, on another machine. loom_resume, your first step, brings its work here, so continue from it instead of starting again.");
    expect(brief).not.toContain("loom/csv/csv-2-1");
    const none = workerBrief({ project: project(), spec: spec(), ticket, posts: [], resume: true, remote: true, resumePending: false });
    expect(none).not.toContain("## First step");
    expect(none).toContain("none of its work was kept, so this worktree starts from the base");
  });

  it("names no path on the project's machine, and points an open dependency at its branch on the remote", async () => {
    await seedProject(h);
    const dep = { ...ticketOf(h, "CSV-1"), repo: "web", state: "pr_open" as const, pushed_sha: "abc1234567890", pr_branch: "loom/csv/csv-1-1", pr_url: "https://github.com/acme/web/pull/1" };
    const ticket = { ...ticketOf(h, "CSV-2"), repo: "web" };
    const checkouts = new Map([["api", "/src/api"]]);
    const brief = workerBrief({ project: project(), spec: spec(), ticket, posts: [], resume: false, tickets: [dep, ticket], checkouts, remote: true });
    expect(brief).not.toContain("/src/api");
    expect(brief).toContain('- "api" (bb project proj_api): it is not on this machine');
    expect(brief).toContain("Its branch is origin/loom/csv/csv-1-1: read its files with `git fetch origin loom/csv/csv-1-1` and then `git show FETCH_HEAD:<file>`.");
    const local = workerBrief({ project: project(), spec: spec(), ticket, posts: [], resume: false, tickets: [dep, ticket], checkouts });
    expect(local).toContain("/src/api");
    expect(local).not.toContain("git fetch origin");
  });
});
