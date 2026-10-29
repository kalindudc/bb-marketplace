import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import { Store } from "../src/db/store";
import { feedText } from "../src/feed-text";
import { finishIfComplete, runMergeQueue, settleMerges } from "../src/merge";
import { planningKickoff, specReviewerBrief, standingInstructionsLines, workerBrief } from "../src/prompts";
import { parseSpec } from "../src/spec";
import { blockTicket, requeueTicket, specOf } from "../src/workers";
import { followHooks, HOOK_RUN_LEASE_MS, HOOK_RUN_TIMEOUT_MS, HOOK_TELL_TRIES, settleHooks } from "../src/hooks";
import { makeCtx, makeEngine, reachApproved, seedProject, seedRepoProject, specToml, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const toPlanner = () => h.bb.sent("thr_plan");
const eventsOf = (kind: string) => h.store.eventsOfKind(project().id, kind).map((event) => JSON.parse(event.data_json) as Record<string, unknown>);
const hookRuns = (command: string) => h.host.callsTo("exec").filter((input) => input.command === command);
const follow = async () => {
  await followHooks(h.ctx);
  await settleHooks(h.ctx);
};
const withHooks = (hooks: Array<Record<string, unknown>>, more?: (doc: Doc) => void) => (doc: Doc) => {
  doc.hook = hooks;
  more?.(doc);
};
const pr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 });
const BOARD = "Add this pull request to the project's Shuttle board, and create the board first if it does not exist.";

describe("[[hook]] in the spec", () => {
  const errorsOf = (hooks: unknown[], more?: (doc: Doc) => void) => parseSpec(specToml(withHooks(hooks as Array<Record<string, unknown>>, more))).errors;

  it("takes hooks on every event, with tell, run or both, and leaves a spec without them as it was", () => {
    const hooks = [
      { on: "spec.approved", tell: "Say hello." },
      { on: "project.started", tell: "Create the board.", run: "board-cli create" },
      { on: "ticket.started", tell: "Name the key in commits.", to: "worker" },
      { on: "pr.opened", tell: BOARD, to: "planner" },
      { on: "ticket.blocked", run: "notify-cli blocked" },
      { on: "ticket.done", tell: "Note it." },
      { on: "project.done", tell: "Archive the board." },
    ];
    const result = parseSpec(specToml(withHooks(hooks)));
    expect(result.errors).toEqual([]);
    expect(result.spec!.hook).toHaveLength(7);
    expect(parseSpec(specToml()).spec!.hook).toBeUndefined();
  });

  it("refuses a hook that does nothing, a to without a tell, a worker hook on any event but ticket.started, and an unknown event", () => {
    expect(errorsOf([{ on: "pr.opened" }])).toEqual([expect.stringMatching(/^hook\[0\]: does nothing\. Set tell .* or run/)]);
    expect(errorsOf([{ on: "pr.opened", to: "planner", run: "x" }])).toEqual([expect.stringMatching(/^hook\[0\]\.to: only says who reads tell/)]);
    expect(errorsOf([{ on: "pr.opened", to: "worker", tell: "Add it to the board." }])).toEqual([expect.stringMatching(/^hook\[0\]\.to: a worker reads a hook only when it starts on a ticket.*on = "ticket.started"/)]);
    expect(errorsOf([{ on: "ticket.merged", tell: "x" }])[0]).toMatch(/^hook\[0\]\.on: .*Use one of the listed values/);
    expect(errorsOf([{ on: "pr.opened", tell: "x", when: "always" }])[0]).toMatch(/^hook\[0\]: unknown key "when"/);
  });
});

describe("telling the planner", () => {
  it("tells the idle planner once when the project starts, with what happened and what to do, and records it in the feed", async () => {
    await seedProject(h, withHooks([{ on: "project.started", tell: "Create a Shuttle board named after the project." }]));
    await follow();
    expect(toPlanner()).toHaveLength(1);
    const [message] = toPlanner();
    expect(message).toContain("[loom] A hook of csv fired on project.started. Carry it out, then end your turn.");
    expect(message).toContain("1. hook[0], on project.started: The human started the project.\n   Do: Create a Shuttle board named after the project.");
    expect(eventsOf("hook.told")).toEqual([{ hooks: [{ hook: 0, on: "project.started" }] }]);
    await follow();
    expect(toPlanner()).toHaveLength(1);
    const told = h.store.eventsOfKind(project().id, "hook.told")[0]!;
    expect(feedText(told, new Map())).toBe("Loom told the planner to carry out a hook on project.started.");
  });

  it("waits while the planner is busy, then sends everything that fired in one message, oldest first", async () => {
    await seedProject(h, withHooks([{ on: "project.started", tell: "Create the board." }, { on: "ticket.started", tell: "Post the ticket on the board." }]));
    h.bb.threads.get("thr_plan")!.status = "active";
    await follow();
    await startWorker(h, "CSV-1");
    await follow();
    expect(toPlanner()).toEqual([]);
    h.bb.threads.get("thr_plan")!.status = "idle";
    await follow();
    expect(toPlanner()).toHaveLength(1);
    expect(toPlanner()[0]).toContain("2 hooks of csv fired on project.started, ticket.started.");
    const text = toPlanner()[0]!;
    expect(text.indexOf("Do: Create the board.")).toBeLessThan(text.indexOf('2. hook[1], on ticket.started: A worker started on CSV-1 "Order rows".'));
  });

  it("fires ticket.started at a ticket's first start only, and ticket.blocked each time it blocks", async () => {
    await seedProject(h, withHooks([{ on: "ticket.started", tell: "Start." }, { on: "ticket.blocked", tell: "Look at it." }]));
    await follow();
    const row = await startWorker(h, "CSV-1");
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "The fixture is missing", needs: "A fixture", actor: row.thread_id! });
    await follow();
    await requeueTicket(h.ctx, "CSV-1", { note: "Try again", actor: "human", author: "human" });
    const again = await startWorker(h, "CSV-1");
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "Still missing", needs: "A fixture", actor: again.thread_id! });
    await follow();
    const all = toPlanner().join("\n");
    expect(all.match(/A worker started on CSV-1/g)).toHaveLength(1);
    expect(all.match(/CSV-1 "Order rows" is blocked/g)).toHaveLength(2);
    expect(all).toContain("Still missing");
  });

  it("fires pr.opened once per pull request Loom opens, not on fix rounds, and ticket.done when it merges", async () => {
    await seedProject(h, withHooks([{ on: "pr.opened", tell: BOARD }, { on: "ticket.done", tell: "Mark it done on the board." }], pr));
    await follow();
    await reachApproved(h, "CSV-1");
    await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
    await settleMerges(h.ctx);
    const ticket = ticketOf(h, "CSV-1");
    expect(ticket.state).toBe("pr_open");
    await follow();
    expect(toPlanner()).toHaveLength(1);
    expect(toPlanner()[0]).toContain(`hook[0], on pr.opened: Loom opened the pull request ${ticket.pr_url} for CSV-1 "Order rows".\n   Do: ${BOARD}`);
    // A fix round takes it back through review to the same pull request.
    for (const to of ["working", "checking", "review", "approved", "merging"] as const) h.store.setTicketState(ticket.id, to, "loom");
    h.store.setTicketState(ticket.id, "pr_open", "loom", { url: ticket.pr_url, fixRound: 1 });
    await follow();
    expect(toPlanner()).toHaveLength(1);
    h.store.setTicketState(ticket.id, "done", "loom");
    await follow();
    expect(toPlanner()).toHaveLength(2);
    expect(toPlanner()[1]).toContain(`CSV-1 "Order rows" is done: its pull request ${ticket.pr_url} merged.`);
  });

  it("fires spec.approved for a pending version, with the version, and project.done when the last ticket ends", async () => {
    await seedProject(h, pr);
    await follow();
    await h.projects.propose({ toml: specToml(withHooks([{ on: "spec.approved", tell: "Tell the channel." }, { on: "project.done", tell: "Archive the board." }], pr)), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await h.projects.approve("csv", "human");
    await follow();
    expect(toPlanner().join("\n")).toContain("hook[0], on spec.approved: The human approved spec version 2, a change to the approved project.");
    for (const key of ["CSV-1", "CSV-2"]) h.store.setTicketState(ticketOf(h, key).id, "cancelled", "human");
    expect(finishIfComplete(h.ctx, project())).toBe(true);
    await follow();
    expect(toPlanner().join("\n")).toContain("hook[1], on project.done: Every ticket is done or cancelled, so the project is done.");
  });

  it("does not fire for events from before the version that added the hook", async () => {
    await seedProject(h, pr);
    await startWorker(h, "CSV-1");
    await follow();
    await h.projects.propose({ toml: specToml(withHooks([{ on: "ticket.started", tell: "Start." }], pr)), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await h.projects.approve("csv", "human");
    await follow();
    expect(toPlanner().join("\n")).not.toContain("A worker started");
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "working", "loom", { attempt: 1 });
    await follow();
    expect(toPlanner().join("\n")).toContain('A worker started on CSV-2 "Export endpoint".');
  });

  it("follows each event with the hooks of the version in force when it happened, even when both wait for the same pass", async () => {
    await seedProject(h, pr);
    await follow();
    await startWorker(h, "CSV-1");
    await h.projects.propose({ toml: specToml(withHooks([{ on: "ticket.started", tell: "Start." }, { on: "spec.approved", tell: "Tell the channel." }], pr)), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await h.projects.approve("csv", "human");
    await follow();
    const all = toPlanner().join("\n");
    expect(all).not.toContain("A worker started on CSV-1");
    expect(all).toContain("The human approved spec version 2");
  });

  it("keeps why a ticket blocked when it is requeued before Loom reads the block", async () => {
    await seedProject(h, withHooks([{ on: "ticket.blocked", tell: "Look at it." }]));
    await follow();
    const row = await startWorker(h, "CSV-1");
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "The real fixture is missing", needs: "A fixture", actor: row.thread_id! });
    await requeueTicket(h.ctx, "CSV-1", { note: "Try again", actor: "human", author: "human" });
    await follow();
    expect(toPlanner()[0]).toContain('CSV-1 "Order rows" is blocked: The real fixture is missing. Needs: A fixture');
  });

  it("tries a refused send again on the next pass, then fails it after the last try", async () => {
    await seedProject(h, withHooks([{ on: "project.started", tell: "Create the board." }]));
    h.bb.sendError = new Error("HTTP 503: busy");
    for (let pass = 0; pass < HOOK_TELL_TRIES; pass++) await follow();
    expect(h.bb.callsTo("send")).toHaveLength(HOOK_TELL_TRIES);
    expect(eventsOf("hook.failed")).toEqual([{ hook: 0, on: "project.started", kind: "tell", reason: `bb refused ${HOOK_TELL_TRIES} sends to the planner: HTTP 503: busy` }]);
    h.bb.sendError = null;
    await follow();
    expect(h.bb.callsTo("send")).toHaveLength(HOOK_TELL_TRIES);
  });

  it("fails a tell an earlier process was sending when it stopped, instead of sending it again", async () => {
    await seedProject(h, withHooks([{ on: "project.started", tell: "Create the board." }]));
    h.bb.threads.get("thr_plan")!.status = "active";
    await follow();
    const [row] = h.store.hookFirings(project().id, ["pending"]);
    h.store.moveHookFiring(row!.id, "pending", { state: "running" });
    h.bb.threads.get("thr_plan")!.status = "idle";
    await follow();
    expect(toPlanner()).toEqual([]);
    expect(eventsOf("hook.failed")).toEqual([{ hook: 0, on: "project.started", kind: "tell", reason: "Loom restarted while it told the planner, so it does not tell it again" }]);
  });

  it("leaves a worker hook to the briefs, and fails a tell when the project has no planner thread", async () => {
    await seedProject(h, withHooks([{ on: "ticket.started", tell: "Name the key in commits.", to: "worker" }, { on: "project.started", tell: "Create the board." }]));
    const planner = h.store.threads({ projectId: project().id, role: "planner" })[0]!;
    h.store.updateThread(planner.id, { state: "ended" });
    await startWorker(h, "CSV-1");
    await follow();
    expect(toPlanner()).toEqual([]);
    expect(eventsOf("hook.failed")).toEqual([{ hook: 1, on: "project.started", kind: "tell", reason: "the project has no planner thread to tell" }]);
    expect(h.store.hookFirings(project().id, ["pending", "running", "done", "failed", "skipped"]).map((row) => row.hook)).toEqual([1]);
  });

  it("skips what an archived project still had queued", async () => {
    await seedProject(h, withHooks([{ on: "project.started", tell: "Create the board." }]));
    h.bb.threads.get("thr_plan")!.status = "active";
    await follow();
    h.store.setProjectState(project().id, "archived", "human");
    await follow();
    expect(toPlanner()).toEqual([]);
    expect(h.store.hookFirings(project().id, ["skipped"])).toHaveLength(1);
  });
});

describe("the engine", () => {
  it("follows the hooks on every pass", async () => {
    const e = makeEngine();
    h = e;
    await seedProject(e, withHooks([{ on: "project.started", tell: "Create the board." }]));
    await e.engine.tick();
    expect(e.bb.sent("thr_plan").join("\n")).toContain("Do: Create the board.");
  });
});

describe("running a hook's command", () => {
  const BOARD_ADD = 'board-cli add "$LOOM_URL"';

  it("runs the command once in the project's checkout, with the event's variables, and records it", async () => {
    await seedProject(h, withHooks([{ on: "pr.opened", run: BOARD_ADD }], pr));
    await reachApproved(h, "CSV-1");
    await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
    await settleMerges(h.ctx);
    await follow();
    await follow();
    const runs = hookRuns(BOARD_ADD);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      cwd: "/repo",
      timeoutMs: HOOK_RUN_TIMEOUT_MS,
      env: { LOOM_EVENT: "pr.opened", LOOM_PROJECT_SLUG: "csv", LOOM_PROJECT_NAME: "CSV export", LOOM_PROJECT_KEY: "CSV", LOOM_TICKET_KEY: "CSV-1", LOOM_TICKET_TITLE: "Order rows", LOOM_URL: ticketOf(h, "CSV-1").pr_url },
    });
    expect(eventsOf("hook.ran")).toEqual([{ hook: 0, on: "pr.opened", kind: "run", key: "CSV-1" }]);
    expect(toPlanner()).toEqual([]);
  });

  it("records a failed command in the feed, blocks nothing and never runs it again", async () => {
    await seedProject(h, withHooks([{ on: "ticket.started", run: "notify-cli started" }]));
    h.host.execResults.push({ exitCode: 3, output: "no such channel\n" });
    await startWorker(h, "CSV-1");
    await follow();
    await follow();
    expect(hookRuns("notify-cli started")).toHaveLength(1);
    expect(eventsOf("hook.failed")).toEqual([{ hook: 0, on: "ticket.started", kind: "run", key: "CSV-1", reason: "it exited with 3: no such channel" }]);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    const failed = h.store.eventsOfKind(project().id, "hook.failed")[0]!;
    expect(feedText(failed, new Map())).toBe("The command of hook[0] on ticket.started for CSV-1 failed: it exited with 3: no such channel.");
  });

  it("fails a command left running by an earlier process instead of running it again, and starts no other until it cannot still run", async () => {
    await seedProject(h, withHooks([{ on: "project.started", run: "board-cli create" }, { on: "ticket.started", run: "board-cli note" }]));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started: string[] = [];
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: { command?: string }) => {
      if (method === "exec") started.push(input.command!);
      if (method === "exec" && input.command === "board-cli create") await held;
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;
    await followHooks(h.ctx);
    await startWorker(h, "CSV-1");
    // A reload: a new store over the same database, with the first command still running in the old process.
    const store = new Store((h as EngineHarness & { db: Database.Database }).db, h.clock.now);
    const ctx = { ...h.ctx, store };
    await followHooks(ctx);
    await settleHooks(ctx);
    expect(started).toEqual(["board-cli create"]);
    expect(store.hookFirings(project().id, ["running"]).map((row) => row.text)).toEqual(["board-cli create"]);
    h.clock.advance(HOOK_RUN_LEASE_MS);
    await followHooks(ctx);
    await settleHooks(ctx);
    expect(store.hookFirings(project().id, ["failed"]).map((row) => row.reason)).toEqual(["Loom restarted while the command ran, so it does not run it again"]);
    expect(started).toEqual(["board-cli create", "board-cli note"]);
    // The old process's command ends after the row failed; its result changes nothing.
    release();
    await settleHooks(h.ctx);
    expect(store.hookFirings(project().id, ["failed"])).toHaveLength(1);
    expect(eventsOf("hook.ran").map((data) => data.on)).toEqual(["ticket.started"]);
  });

  it("runs a project event's command in the project's own checkout on a multi-repo project", async () => {
    await seedRepoProject(h, withHooks([{ on: "project.started", run: "board-cli create" }, { on: "ticket.started", run: "board-cli note" }]));
    await startWorker(h, "CSV-1");
    await follow();
    await follow();
    expect(hookRuns("board-cli create").map((input) => input.cwd)).toEqual(["/repo"]);
    expect(hookRuns("board-cli note").map((input) => [input.cwd, input.env?.LOOM_REPO])).toEqual([["/src/web", "web"]]);
    expect(eventsOf("hook.failed")).toEqual([]);
  });

  it("runs one project's commands one at a time, in the order their events happened", async () => {
    await seedProject(h, withHooks([{ on: "ticket.started", run: 'echo "$LOOM_TICKET_KEY"' }]));
    await startWorker(h, "CSV-1");
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "working", "loom", { attempt: 1 });
    await followHooks(h.ctx);
    expect(h.store.hookFirings(project().id, ["running", "pending"]).map((row) => row.state)).toEqual(["running", "pending"]);
    await settleHooks(h.ctx);
    await follow();
    expect(hookRuns('echo "$LOOM_TICKET_KEY"').map((input) => input.env?.LOOM_TICKET_KEY)).toEqual(["CSV-1", "CSV-2"]);
  });
});

describe("the migration", () => {
  it("starts every project that exists before hooks after its newest event, so a later hook never fires for an old one", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
    const store = new Store(db, () => 1);
    const made = store.createProject({ slug: "old", name: "Old", key: "OLD", bb_project_id: "proj_1" }, "human");
    store.event(made.id, null, "spec.approved", "human", { version: 1 });
    db.exec(MIGRATIONS.at(-1)!);
    const newest = (db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number }).id;
    expect(store.project(made.id)!.hook_event_id).toBe(newest);
    expect(store.createProject({ slug: "new", name: "New", key: "NEW", bb_project_id: "proj_1" }, "human").hook_event_id).toBe(0);
  });
});

describe("the standing planner instructions", () => {
  const INSTRUCTIONS = "Use Shuttle: create a PR board for every project and link each pull request to it.";

  it("go after the human's goal in the Loom page's kickoff, with how a spec carries them out, and are left out when empty", () => {
    const kickoff = planningKickoff({ merge: "ask", reviewer: "", instructions: `\n${INSTRUCTIONS}\n` });
    expect(kickoff).toContain("## The human's standing instructions");
    expect(kickoff).toContain(`"""\n${INSTRUCTIONS}\n"""`);
    expect(kickoff).toMatch(/write a \[\[hook\]\] table for it/);
    expect(planningKickoff({ merge: "ask", reviewer: "", instructions: "  " })).not.toContain("standing instructions");
    expect(standingInstructionsLines("")).toEqual([]);
  });

  it("reach a planner started from the Loom page", async () => {
    let instructions = INSTRUCTIONS;
    const projects = new (h.projects.constructor as typeof import("../src/projects").Projects)({ ...h.ctx, plannerInstructions: () => instructions });
    await projects.startPlanning({ request: { projectId: "proj_1", input: [{ type: "text", text: "Export orders as CSV", mentions: [] }] } as never, merge: "ask", reviewer: "" });
    const spawn = h.bb.callsTo("spawnPlanner").at(-1)![0] as { kickoff: string };
    expect(spawn.kickoff).toContain(INSTRUCTIONS);
    instructions = "";
    expect(projects.plannerInstructions()).toBe("");
  });

  it("go to the spec reviewer with a rubric line that checks them", async () => {
    await seedProject(h);
    const p = project();
    const spec = specOf(h.store, p);
    const brief = specReviewerBrief({ project: p, spec, toml: "", version: 1, round: 1, earlier: [], instructions: INSTRUCTIONS });
    expect(brief).toContain(`## The human's standing instructions`);
    expect(brief).toContain(INSTRUCTIONS);
    expect(brief).toMatch(/Hooks: every \[\[hook\]\] carries out something the human asked for/);
    expect(specReviewerBrief({ project: p, spec, toml: "", version: 1, round: 1, earlier: [] })).not.toContain("## The human's standing instructions");
  });
});

describe("a worker's brief", () => {
  it("carries every ticket.started hook for workers, and nothing for the planner's hooks", async () => {
    await seedProject(h, withHooks([{ on: "ticket.started", to: "worker", tell: "Name the ticket key in every commit message." }, { on: "ticket.started", tell: "Post the ticket on the board." }]));
    const p = project();
    const brief = workerBrief({ project: p, spec: specOf(h.store, p), ticket: ticketOf(h, "CSV-1"), posts: [], resume: false });
    expect(brief).toContain("## The spec's instructions for every worker");
    expect(brief).toContain("- Name the ticket key in every commit message.");
    expect(brief).not.toContain("Post the ticket on the board.");
    await seedProject((h = makeCtx()));
    expect(workerBrief({ project: project(), spec: specOf(h.store, project()), ticket: ticketOf(h, "CSV-1"), posts: [], resume: false })).not.toContain("instructions for every worker");
  });
});
