import { beforeEach, describe, expect, it } from "vitest";
import { finishIfComplete, land, runMergeQueue, settleMerges } from "../src/merge";
import { SpawnRefusedError, type SpawnArgs } from "../src/ports";
import { recordPrompt } from "../src/prompts";
import { HOOK_TIMEOUT_MS, NO_HOOK, RECORD_MAX, SUMMARY_TIMEOUT_MS, projectRecord, sendRecords, settleRecords, type DoneSettings } from "../src/record";
import { specOf } from "../src/workers";
import { makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const HOOK = "save-note --stdin";
const FULL: DoneSettings = { doneHook: HOOK, doneRecord: "full" };
const SUMMARY: DoneSettings = { doneHook: HOOK, doneRecord: "summary" };
const project = () => h.store.projectBySlug("csv")!;
const row = () => h.store.record(project().id);
const hookRuns = () => h.host.callsTo("exec").filter((input) => input.command === HOOK);
const eventsOf = (kind: string) => h.store.eventsOfKind(project().id, kind).map((event) => JSON.parse(event.data_json) as Record<string, unknown>);
const send = async (settings: DoneSettings) => {
  sendRecords(h.ctx, settings);
  await settleRecords(h.ctx);
};
const pr = (doc: Doc) => (doc.merge = { strategy: "pr" });

/** A pull request project whose tickets are all cancelled, finished by finishIfComplete. */
async function finishedProject(): Promise<void> {
  await seedProject(h, pr);
  for (const key of ["CSV-1", "CSV-2"]) h.store.setTicketState(ticketOf(h, key).id, "cancelled", "human");
  expect(finishIfComplete(h.ctx, project())).toBe(true);
}

/** An integration project whose CSV-1 merged with a submit, a review and a merge post, and a few posts the record leaves out. */
async function builtProject(): Promise<void> {
  await seedProject(h);
  await reachApproved(h, "CSV-1");
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
  const ticket = ticketOf(h, "CSV-1");
  const post = (author: "human" | "planner" | "worker" | "loom", kind: "note" | "reply" | "block", body: string) =>
    h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: author, author_thread_id: null, kind, body });
  post("worker", "note", "Worker scratch note.");
  post("loom", "reply", "Loom nudge.");
  post("planner", "reply", "Planner: keep the header row.");
  post("human", "reply", "Human: ship it.");
  post("worker", "block", "Blocked on the fixture.");
}

/** Starts the summary agent for a finished project and returns its thread id. */
async function summarizing(): Promise<string> {
  await finishedProject();
  await send(SUMMARY);
  expect(row()).toMatchObject({ state: "summarizing", started_at: h.clock.t });
  return row()!.thread_id!;
}

describe("projectRecord", () => {
  it("has the goal, the outcome, and each ticket's criteria, submits, reviews, merges, blocks and the planner's and human's replies, in order", async () => {
    await builtProject();
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    await land(h.ctx, "csv", { actor: "human", ready: false, direct: true });
    const record = projectRecord(h.store, project());

    expect(record).toContain("# CSV export (csv)");
    expect(record).toContain("## Goal\n\nLet people export their orders as a CSV file from the admin page.");
    expect(record).toContain("Pushed to origin/main at m1");
    expect(record).toContain("### CSV-1 · Order rows (done)");
    expect(record).toContain("1. WHEN an order is mapped THE SYSTEM SHALL return one row");
    expect(record).toContain("### CSV-2 · Export endpoint (cancelled)");
    const order = ["#### submit · worker", "#### review · reviewer", "#### merge · loom", "Planner: keep the header row.", "Human: ship it.", "Blocked on the fixture."].map((text) => record.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const left of ["Worker scratch note.", "Loom nudge.", "#### check", "#### claim"]) expect(record).not.toContain(left);
  });

  it("names a landed pull request, and says a pull request project opened one per ticket", async () => {
    await builtProject();
    await land(h.ctx, "csv", { actor: "human", ready: false });
    expect(projectRecord(h.store, project())).toContain("Landed as https://github.com/acme/shop/pull/1");
    h = makeCtx();
    await finishedProject();
    expect(projectRecord(h.store, project())).toContain("One pull request per ticket");
  });

  it("is clipped to RECORD_MAX characters", async () => {
    await finishedProject();
    const ticket = ticketOf(h, "CSV-1");
    h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "human", author_thread_id: null, kind: "reply", body: "x".repeat(RECORD_MAX) });
    const record = projectRecord(h.store, project());
    expect(record).toHaveLength(RECORD_MAX);
    expect(record.endsWith("…")).toBe(true);
  });
});

describe("queuing", () => {
  it("queues one record when a project lands directly or finishes on the pull request strategy, and none when it is archived unfinished", async () => {
    await builtProject();
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    await land(h.ctx, "csv", { actor: "human", ready: false, direct: true });
    expect(row()).toMatchObject({ state: "pending", thread_id: null });
    expect(h.store.openRecords()).toHaveLength(1);

    h = makeCtx();
    await finishedProject();
    expect(row()?.state).toBe("pending");

    h = makeCtx();
    await seedProject(h);
    h.store.setProjectState(project().id, "archived", "human");
    expect(row()).toBeNull();
  });
});

describe("sendRecords", () => {
  it("skips a record when no hook is set, with no command and no agent", async () => {
    await finishedProject();
    await send(NO_HOOK);
    expect(row()?.state).toBe("skipped");
    expect(hookRuns()).toHaveLength(0);
    expect(h.bb.callsTo("spawnThread")).toHaveLength(0);
  });

  it("sends the full record to the hook in the checkout, with stdin and the LOOM_ variables", async () => {
    await finishedProject();
    await send(FULL);
    expect(hookRuns()).toEqual([
      {
        cwd: "/repo",
        command: HOOK,
        timeoutMs: HOOK_TIMEOUT_MS,
        stdin: projectRecord(h.store, project()),
        env: { LOOM_PROJECT_SLUG: "csv", LOOM_PROJECT_NAME: "CSV export", LOOM_PROJECT_KEY: "CSV", LOOM_PROJECT_URL: "", LOOM_RECORD: "full" },
      },
    ]);
    expect(row()?.state).toBe("sent");
    expect(eventsOf("record.sent")).toEqual([{ kind: "full" }]);
  });

  it("fails on a non-zero exit, a timeout and a host error, with one record.failed event each", async () => {
    const outcomes = [{ exitCode: 3, output: "no such lane" }, { timedOut: true, exitCode: null }, new Error("the machine is offline")];
    const reasons = [/exited with 3.*no such lane/, /timed out/, /the machine is offline/];
    for (const [index, outcome] of outcomes.entries()) {
      h = makeCtx();
      await finishedProject();
      h.host.execResults.push(outcome);
      await send(FULL);
      expect(row()?.state).toBe("failed");
      const failed = eventsOf("record.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ kind: "full", reason: expect.stringMatching(reasons[index]!) });
    }
  });

  it("starts the summary agent on the reviewer's model with the record as agent-only detail", async () => {
    const threadId = await summarizing();
    const args = h.bb.callsTo("spawnThread").at(-1)![0] as SpawnArgs;
    expect(args).toMatchObject({
      title: "CSV · record",
      prompt: recordPrompt(project()),
      detail: projectRecord(h.store, project()),
      metadata: { project: "csv", role: "record" },
      providerId: "codex",
      model: "gpt",
      permissionMode: "full",
    });
    expect(threadId).toMatch(/^thr_w/);
    expect(hookRuns()).toHaveLength(0);
  });

  it("starts the agent with no section when bb refuses the project's section, as a finished project's often is deleted", async () => {
    await finishedProject();
    h.store.updateProject(project().id, { section_id: "sec_gone" });
    h.bb.spawnError = (args) => (args.sectionId === null ? null : new SpawnRefusedError(404, "HTTP 404: Section not found"));
    await send(SUMMARY);
    expect(h.bb.callsTo("spawnThread").map(([args]) => (args as SpawnArgs).sectionId)).toEqual(["sec_gone", null]);
    expect(row()).toMatchObject({ state: "summarizing", thread_id: expect.stringMatching(/^thr_w/) });
  });

  it("waits while the agent works or is idle with no output, then sends its output as the summary and archives it", async () => {
    const threadId = await summarizing();
    await send(SUMMARY);
    h.bb.threads.get(threadId)!.status = "idle";
    await send(SUMMARY);
    expect(row()?.state).toBe("summarizing");
    expect(hookRuns()).toHaveLength(0);

    h.bb.outputs.set(threadId, "## Goal\nExport orders.\n");
    await send(SUMMARY);
    expect(hookRuns()).toHaveLength(1);
    expect(hookRuns()[0]).toMatchObject({ stdin: "## Goal\nExport orders.", env: expect.objectContaining({ LOOM_RECORD: "summary" }) });
    expect(h.bb.callsTo("archive").map(([id]) => id)).toContain(threadId);
    expect(row()?.state).toBe("sent");
    expect(eventsOf("record.sent")).toEqual([{ kind: "summary" }]);
  });

  it("sends the full record when the agent cannot start, is gone, fails or takes 30 minutes, and ends a live agent", async () => {
    const fallbackOf = () => String(eventsOf("record.sent").at(-1)?.fallback);

    await finishedProject();
    h.bb.spawnError = () => new Error("bb refused");
    await send(SUMMARY);
    expect(fallbackOf()).toMatch(/could not start.*bb refused/);

    h = makeCtx();
    let threadId = await summarizing();
    h.bb.threads.get(threadId)!.archivedAt = 1;
    await send(SUMMARY);
    expect(fallbackOf()).toMatch(/gone/);

    h = makeCtx();
    threadId = await summarizing();
    h.bb.threads.delete(threadId);
    await send(SUMMARY);
    expect(fallbackOf()).toMatch(/gone/);

    h = makeCtx();
    threadId = await summarizing();
    h.bb.threads.get(threadId)!.status = "error";
    await send(SUMMARY);
    expect(fallbackOf()).toMatch(/failed/);
    expect(h.bb.callsTo("archive").map(([id]) => id)).toEqual([threadId]);
    expect(h.bb.callsTo("stop")).toHaveLength(0);

    h = makeCtx();
    threadId = await summarizing();
    h.clock.advance(SUMMARY_TIMEOUT_MS + 1);
    await send(SUMMARY);
    expect(fallbackOf()).toMatch(/30 minutes/);
    expect(h.bb.callsTo("stop").map(([id]) => id)).toEqual([threadId]);
    expect(h.bb.callsTo("archive").map(([id]) => id)).toEqual([threadId]);
    expect(hookRuns()[0]).toMatchObject({ stdin: projectRecord(h.store, project()), env: expect.objectContaining({ LOOM_RECORD: "full" }) });
    expect(row()?.state).toBe("sent");
  });

  it("sends the full record when a restart left the summary agent without a thread", async () => {
    await finishedProject();
    h.store.updateRecord(row()!.id, { state: "summarizing", started_at: h.clock.t });
    await send(SUMMARY);
    expect(String(eventsOf("record.sent")[0]?.fallback)).toMatch(/restarted/);
  });

  it("fails a record a restart left sending, without running the hook again", async () => {
    await finishedProject();
    h.store.updateRecord(row()!.id, { state: "sending" });
    await send(FULL);
    expect(row()?.state).toBe("failed");
    expect(hookRuns()).toHaveLength(0);
    expect(String(eventsOf("record.failed")[0]?.reason)).toContain("bb loom report csv --send");
  });

  it("starts one delivery per record however often it is called", async () => {
    await finishedProject();
    sendRecords(h.ctx, FULL);
    sendRecords(h.ctx, FULL);
    await settleRecords(h.ctx);
    expect(hookRuns()).toHaveLength(1);
  });
});
