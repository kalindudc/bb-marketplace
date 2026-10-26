import { beforeEach, describe, expect, it } from "vitest";
import { finishIfComplete, land, pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { SpawnRefusedError, type SpawnArgs } from "../src/ports";
import { recordPrompt } from "../src/prompts";
import { HOOK_TIMEOUT_MS, NO_HOOK, RECORD_MAX, SETTINGS, SUMMARY_TIMEOUT_MS, projectRecord, sendRecords, settleRecords, type DoneSettings } from "../src/record";
import { specOf } from "../src/workers";
import { makeCtx, reachApproved, seedProject, seedRepoProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

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
const pr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 });
const PR = (n: number) => `https://github.com/acme/shop/pull/${n}`;
const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")}Z`;
const recordSpawns = () => h.bb.callsTo("spawnThread").map(([args]) => args as SpawnArgs).filter((args) => args.metadata.role === "record");

/** Approves one ticket and runs the merge queue: it merges into its repo's integration branch, or opens its pull request on the pr strategy. */
async function queueOne(key: string): Promise<void> {
  await reachApproved(h, key);
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
}

async function mergeOne(key: string): Promise<void> {
  await queueOne(key);
  expect(ticketOf(h, key).state).toBe("done");
}

/** seedRepoProject's project, CSV-1 merged in web and CSV-2 in api, and docs with no work. */
async function mergedRepoProject(edit?: (doc: Doc) => void): Promise<void> {
  await seedRepoProject(h, edit);
  await mergeOne("CSV-1");
  await mergeOne("CSV-2");
}

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

describe("Loom's settings", () => {
  it("signs pull request comments with Posted by Loom unless the user sets another line, or none", () => {
    const signature = SETTINGS.commentSignature;
    expect(signature.default).toBe("Posted by Loom");
    expect(signature.experimental_schema.safeParse("<sub>Sent by Loom for Kai</sub>").success).toBe(true);
    expect(signature.experimental_schema.safeParse("").success).toBe(true);
    expect(signature.experimental_schema.safeParse("two\nlines").success).toBe(false);
    expect(signature.experimental_schema.safeParse("x".repeat(201)).success).toBe(false);
  });
});

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

  it("has no Repos section and no Repo line on a single-repo project", async () => {
    await builtProject();
    const record = projectRecord(h.store, project());
    expect(record).toContain("Loom project CSV, running, base branch main. 2 tickets: 1 done, 1 queued.");
    expect(record).toContain("## Outcome\n\nNot landed yet: the work is on the integration branch loom/csv.\n");
    expect(record).toContain("### CSV-1 · Order rows (done)\n\nBuild the row mapper.");
    for (const left of ["## Repos", "Repo: "]) expect(record).not.toContain(left);
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
        env: { LOOM_PROJECT_SLUG: "csv", LOOM_PROJECT_NAME: "CSV export", LOOM_PROJECT_KEY: "CSV", LOOM_PROJECT_URL: "", LOOM_PROJECT_URLS: "", LOOM_RECORD: "full" },
      },
    ]);
    expect(row()?.state).toBe("sent");
    expect(eventsOf("record.sent")).toEqual([{ kind: "full" }]);
  });

  it("gives a single-repo project's landed pull request as both LOOM_PROJECT_URL and LOOM_PROJECT_URLS", async () => {
    await builtProject();
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    await land(h.ctx, "csv", { actor: "human", ready: false });
    expect(project()).toMatchObject({ state: "done", pr_url: PR(1) });
    await send(FULL);
    expect(hookRuns()).toHaveLength(1);
    expect(hookRuns()[0]).toMatchObject({ cwd: "/repo", env: { LOOM_PROJECT_SLUG: "csv", LOOM_PROJECT_NAME: "CSV export", LOOM_PROJECT_KEY: "CSV", LOOM_PROJECT_URL: PR(1), LOOM_PROJECT_URLS: PR(1), LOOM_RECORD: "full" } });
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
      bbProjectId: "proj_1",
      hostId: "host_1",
      baseBranch: "origin/main",
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

  it("tries the agent again while it cannot start or get an environment, then sends the full record once the 30 minutes are up", async () => {
    await finishedProject();
    h.bb.spawnError = () => new Error("No free slot.");
    await send(SUMMARY);
    expect(row()).toMatchObject({ state: "pending", thread_id: null, retry_at: h.clock.t + 2 * 60_000 });
    await send(SUMMARY);
    expect(h.bb.callsTo("spawnThread")).toHaveLength(1);

    // A thread whose environment bb could not provision is tried again too.
    h.bb.spawnError = null;
    h.clock.advance(2 * 60_000);
    await send(SUMMARY);
    const threadId = row()!.thread_id!;
    h.bb.threads.get(threadId)!.status = "error";
    h.bb.systemErrors.set(threadId, { code: "thread_provisioning_failed", message: "Provisioning thread failed", detail: "No free slot." });
    await send(SUMMARY);
    expect(row()).toMatchObject({ state: "pending", thread_id: null });
    expect(h.bb.callsTo("archive").map(([id]) => id)).toContain(threadId);

    h.bb.spawnError = () => new Error("No free slot.");
    for (let n = 0; n < 20 && row()?.state === "pending"; n++) {
      h.clock.advance(2 * 60_000);
      await send(SUMMARY);
    }
    expect(row()?.state).toBe("sent");
    expect(String(eventsOf("record.sent").at(-1)?.fallback)).toBe("the summary agent could not start: No free slot.");
    expect(hookRuns()).toHaveLength(1);
  });

  it("sends the full record when the agent cannot start, is gone, fails or takes 30 minutes, and ends a live agent", async () => {
    const fallbackOf = () => String(eventsOf("record.sent").at(-1)?.fallback);

    await finishedProject();
    h.bb.spawnError = () => new SpawnRefusedError(400, "HTTP 400: bb refused");
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

describe("a multi-repo project", () => {
  const human = { actor: "human", ready: false };

  it("lists the repos after the goal, gives each repo's outcome, and names each ticket's repo", async () => {
    await mergedRepoProject();
    let record = projectRecord(h.store, project());
    expect(record).toContain("Loom project CSV, running, in 3 repos. 2 tickets: 2 done.");
    expect(record).toContain(
      [
        "## Goal\n\nLet people export their orders as a CSV file from the admin page.\n",
        "## Repos\n",
        "- web: bb project proj_web, base main, integration branch loom/csv.",
        "- api: bb project proj_api, base trunk, integration branch loom/csv.",
        "- docs: bb project proj_docs, base main, integration branch loom/csv.\n",
        "## Outcome\n",
        "- web: not landed yet; its merged work is on the integration branch loom/csv.",
        "- api: not landed yet; its merged work is on the integration branch loom/csv.",
        "- docs: no merged work.\n",
        "## Tickets\n",
      ].join("\n"),
    );
    expect(record).toContain("### CSV-1 · Order rows (done)\n\nRepo: web\n\nBuild the row mapper.\n");
    expect(record).toContain("### CSV-2 · Export endpoint (done)\n\nRepo: api\n\nServe the file.\n");

    await land(h.ctx, "csv", { ...human, repo: "web" });
    const webAt = h.clock.t;
    h.clock.advance(5 * 60_000);
    await land(h.ctx, "csv", { ...human, repo: "api", direct: true });
    expect(project().state).toBe("done");
    record = projectRecord(h.store, project());
    expect(record).toContain("Loom project CSV, done, in 3 repos.");
    expect(record).toContain(
      ["## Outcome\n", `- web: landed as ${PR(1)}, ${minute(webAt)}.`, `- api: pushed to upstream/trunk at m2, ${minute(h.clock.t)}.`, "- docs: no merged work.\n"].join("\n"),
    );
  });

  it("says a repo's newer merged work is not landed yet, and names its earlier land", async () => {
    await seedRepoProject(h, (doc) => doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"], repo: "web" }));
    await mergeOne("CSV-1");
    await land(h.ctx, "csv", human);
    const landedAt = h.clock.t;
    h.clock.advance(60_000);
    await mergeOne("CSV-3");
    expect(projectRecord(h.store, project())).toContain(
      ["## Outcome\n", `- web: not landed yet; its merged work is on the integration branch loom/csv (before that, landed as ${PR(1)}, ${minute(landedAt)}).`, "- api: no merged work.", "- docs: no merged work.\n"].join("\n"),
    );
  });

  it("on the pull request strategy lists each repo's bb project and base, and gives each repo its tickets' merged and open pull requests, or no merged work", async () => {
    await seedRepoProject(h, (doc) => {
      pr(doc);
      doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"], repo: "web" });
    });
    const outcomeOf = () => {
      const record = projectRecord(h.store, project());
      return record.slice(record.indexOf("## Outcome"), record.indexOf("## Tickets"));
    };
    expect(outcomeOf()).toBe("## Outcome\n\n- web: no merged work.\n- api: no merged work.\n- docs: no merged work.\n\n");

    await queueOne("CSV-2");
    await queueOne("CSV-1");
    await queueOne("CSV-3");
    expect(["CSV-2", "CSV-1", "CSV-3"].map((key) => [ticketOf(h, key).state, ticketOf(h, key).pr_url])).toEqual([
      ["pr_open", PR(1)],
      ["pr_open", PR(2)],
      ["pr_open", PR(3)],
    ]);
    expect(outcomeOf()).toBe(`## Outcome\n\n- web: no merged work; ${PR(2)} (CSV-1) and ${PR(3)} (CSV-3) are still open.\n- api: no merged work; ${PR(1)} (CSV-2) is still open.\n- docs: no merged work.\n\n`);

    h.host.prStates.set(PR(1), "MERGED");
    h.host.prStates.set(PR(2), "MERGED");
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    const at = minute(h.clock.t);
    const record = projectRecord(h.store, project());
    expect(record).toContain("## Repos\n\n- web: bb project proj_web, base main.\n- api: bb project proj_api, base trunk.\n- docs: bb project proj_docs, base main.\n\n## Outcome");
    expect(outcomeOf()).toBe(`## Outcome\n\n- web: merged as ${PR(2)} (CSV-1, ${at}); ${PR(3)} (CSV-3) is still open.\n- api: merged as ${PR(1)} (CSV-2, ${at}).\n- docs: no merged work.\n\n`);
    expect(record).not.toContain("One pull request per ticket");
    expect(record).toContain(`### CSV-2 · Export endpoint (done)\n\nRepo: api\n\nServe the file.\n\nPull request: ${PR(1)}\n`);
  });

  it("starts the summary agent in the first repo's bb project from that repo's fresh base", async () => {
    await mergedRepoProject();
    await land(h.ctx, "csv", human);
    await send(SUMMARY);
    expect(recordSpawns()).toHaveLength(1);
    expect(recordSpawns()[0]).toMatchObject({ bbProjectId: "proj_web", hostId: "host_1", baseBranch: "loom/csv", title: "CSV · record", detail: projectRecord(h.store, project()) });
    expect(row()?.state).toBe("summarizing");

    // On the pull request strategy the fresh base is the repo's remote base branch, so api's first place shows.
    h = makeCtx();
    await seedRepoProject(h, (doc) => {
      pr(doc);
      doc.repo = [doc.repo[1], doc.repo[0], doc.repo[2]];
    });
    for (const key of ["CSV-1", "CSV-2"]) h.store.setTicketState(ticketOf(h, key).id, "cancelled", "human");
    expect(finishIfComplete(h.ctx, project())).toBe(true);
    await send(SUMMARY);
    expect(recordSpawns()[0]).toMatchObject({ bbProjectId: "proj_api", baseBranch: "upstream/trunk" });
  });

  it("gives the hook the first repo's pull request in [[repo]] order and every repo's, one per line, in the Loom project's checkout", async () => {
    await mergedRepoProject();
    await land(h.ctx, "csv", { ...human, repo: "api" });
    await land(h.ctx, "csv", { ...human, repo: "web" });
    expect(h.store.projectRepos(project().id).map((repo) => [repo.name, repo.pr_url])).toEqual([
      ["api", PR(1)],
      ["web", PR(2)],
    ]);
    await send(FULL);
    expect(hookRuns()).toEqual([
      {
        cwd: "/repo",
        command: HOOK,
        timeoutMs: HOOK_TIMEOUT_MS,
        stdin: projectRecord(h.store, project()),
        env: { LOOM_PROJECT_SLUG: "csv", LOOM_PROJECT_NAME: "CSV export", LOOM_PROJECT_KEY: "CSV", LOOM_PROJECT_URL: PR(2), LOOM_PROJECT_URLS: `${PR(2)}\n${PR(1)}`, LOOM_RECORD: "full" },
      },
    ]);
    expect(row()?.state).toBe("sent");
  });

  it("skips a repo with no pull request, such as one landed directly, and leaves both variables empty when none has one", async () => {
    await mergedRepoProject();
    await land(h.ctx, "csv", { ...human, repo: "api" });
    await land(h.ctx, "csv", { ...human, repo: "web", direct: true });
    await send(FULL);
    expect(hookRuns()[0]?.env).toMatchObject({ LOOM_PROJECT_URL: PR(1), LOOM_PROJECT_URLS: PR(1) });

    h = makeCtx();
    await mergedRepoProject();
    await land(h.ctx, "csv", { ...human, direct: true });
    await send(FULL);
    expect(hookRuns()[0]?.env).toMatchObject({ LOOM_PROJECT_URL: "", LOOM_PROJECT_URLS: "" });
  });
});
