import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { ORDINARY_TOOLS, PLANNER_TOOLS, REVIEWER_TOOLS, SKILLS, WORKER_TOOLS, registerTools } from "../src/tools";
import { readFileSync } from "node:fs";
import { Clock, FakePort, checkOutHead, makeHost, seedProject, specToml, type Doc, type EngineHarness } from "./helpers";

let host: ReturnType<typeof makeHost>;

beforeEach(() => {
  host = makeHost();
  registerTools(host.bb, host.projects, host.engine);
});

const text = (result: PluginAgentToolResult) => (typeof result === "string" ? result : result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
const isError = (result: PluginAgentToolResult) => typeof result !== "string" && result.isError === true;

const propose = (edit?: (doc: Doc) => void, threadId = "thr_plan") => host.harness.callAgentTool("loom_propose", { spec_toml: specToml(edit) }, { threadId, projectId: "proj_1" });

const configure = (threadId: string, over: Parameters<typeof makePluginAgentConfigurationContext>[0] = {}) =>
  host.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ ...over, thread: { id: threadId, ...over.thread } }));

describe("agent configuration", () => {
  it("gives a side-chat fork nothing", async () => {
    const config = await configure("thr_side", { origin: { kind: "fork", pluginId: "side-chat" } });
    expect(config.tools).toEqual([]);
    expect(config.skills).toEqual([]);
  });

  it("gives an ordinary thread loom_propose and both skills", async () => {
    const config = await configure("thr_new");
    expect(config.tools.map((tool) => tool.name)).toEqual([...ORDINARY_TOOLS]);
    expect(config.skills).toEqual([SKILLS.plan, SKILLS.usage]);
    expect(config.instructions).toBeNull();
  });

  it("ignores a role claimed in metadata when no row exists", async () => {
    const config = await configure("thr_forged", { pluginMetadata: { role: "worker", project: "csv", spawnToken: "forged" } });
    expect(config.tools.map((tool) => tool.name)).toEqual([...ORDINARY_TOOLS]);
    expect(config.skills).toEqual([SKILLS.plan, SKILLS.usage]);
  });

  it("gives a planner its tools, both skills and instructions that name its project", async () => {
    await propose();
    const config = await configure("thr_plan", { pluginMetadata: { project: "somebody-else" } });
    expect(config.tools.map((tool) => tool.name)).toEqual([...PLANNER_TOOLS]);
    expect(config.skills).toEqual([SKILLS.plan, SKILLS.usage]);
    expect(config.instructions).toContain('"csv"');
    expect(config.instructions).not.toContain("somebody-else");
    expect(config.instructions).toContain("you never start, pause or approve the project");
  });

  it("gives a worker row exactly the worker tools and the usage skill, and a reviewer row exactly the reviewer tools, the usage skill and the one-verdict instruction", async () => {
    await propose();
    const project = host.store.projectBySlug("csv")!;
    host.store.addThread({ thread_id: "thr_worker", project_id: project.id, role: "worker", state: "active" });
    host.store.addThread({ spawn_token: "tok_1", project_id: project.id, role: "reviewer", state: "spawning" });
    const worker = await configure("thr_worker");
    expect(worker.tools.map((tool) => tool.name)).toEqual([...WORKER_TOOLS]);
    expect(worker.skills).toEqual([SKILLS.usage]);
    expect(worker.instructions).toBe("You are a Loom worker on a ticket; follow the brief in your first message.");
    const reviewer = await configure("thr_reviewer", { pluginMetadata: { spawnToken: "tok_1" } });
    expect(reviewer.tools.map((tool) => tool.name)).toEqual([...REVIEWER_TOOLS]);
    expect(REVIEWER_TOOLS).toEqual(["loom_note", "loom_approve", "loom_request_changes"]);
    expect(reviewer.skills).toEqual([SKILLS.usage]);
    expect(reviewer.instructions).toBe("You are a Loom reviewer for a ticket, round 0; change nothing; follow the brief and call one verdict tool.");
    expect(host.store.threadBySpawnToken("tok_1")?.thread_id).toBe("thr_reviewer");
  });
});

describe("loom_propose", () => {
  it("creates a draft from an ordinary thread, makes it the planner and moves it into the new section", async () => {
    const result = await propose();
    expect(isError(result)).toBe(false);
    const output = text(result);
    expect(output).toContain("Draft ready: `csv` · spec v1.");
    expect(output).toContain("bb loom spec csv");
    expect(output).toContain("bb loom approve csv");
    expect(output).toContain("bb loom start csv");

    expect(host.store.projectBySlug("csv")).toMatchObject({ state: "draft", host_id: "host_env", bb_project_id: "proj_1", planner_thread_id: "thr_plan", section_id: "sec_1" });
    expect(host.harness.sdk.callsTo("threadSections.create")).toEqual([[{ name: "Loom · CSV export (csv)" }]]);
    expect(host.harness.sdk.callsTo("threads.update")).toEqual([[{ threadId: "thr_plan", sectionId: "sec_1" }]]);
    expect(host.harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([[{ threadId: "thr_plan", set: { project: "csv", role: "planner" }, pluginId: "loom" }]]);
  });

  it("uses the server's primary host when the thread has no environment", async () => {
    host.state.environmentId = null;
    await propose();
    expect(host.store.projectBySlug("csv")?.host_id).toBe("host_primary");
  });

  it("lists the warnings", async () => {
    const output = text(await propose((doc) => (doc.agents.reviewer = { ...doc.agents.worker })));
    expect(output).toContain("Warnings:");
    expect(output).toContain("agents.reviewer: the reviewer uses the same provider and model as the worker");
  });

  it("refuses an invalid spec with numbered errors and creates nothing", async () => {
    const result = await propose((doc) => {
      doc.project.key = "csv";
      doc.ticket[0].scope = [];
    });
    expect(isError(result)).toBe(true);
    const output = text(result);
    expect(output).toContain("Spec not saved.");
    expect(output).toContain("1. project.key:");
    expect(output).toContain("2. ticket[0].scope:");
    expect(host.store.projects()).toEqual([]);
    expect(host.harness.sdk.callsTo("threadSections.create")).toEqual([]);
  });

  it("refuses a spec shorter than the tool's minimum before running", async () => {
    await expect(host.harness.callAgentTool("loom_propose", { spec_toml: "x" }, { threadId: "thr_plan", projectId: "proj_1" })).rejects.toThrow();
  });

  it("revises the draft from the planner thread and reports the change", async () => {
    await propose();
    const revised = text(await propose((doc) => (doc.project.goal = "Export orders and customers as CSV files from the admin page.")));
    expect(revised).toContain("Draft `csv` revised · spec v2.");
    expect(text(await propose((doc) => (doc.project.goal = "Export orders and customers as CSV files from the admin page.")))).toContain("No change");
  });

  it("describes a pending version after approval", async () => {
    await propose();
    await host.projects.approve("csv", "human");
    const output = text(await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter the person can choose.")));
    expect(output).toContain("Spec v2 of `csv` is pending");
    expect(output).toContain("bb loom approve csv --version 2");
    expect(output).toContain("Ticket changes after approval go through the planner's board tools.");
  });

  it("refuses a worker row", async () => {
    await propose();
    const project = host.store.projectBySlug("csv")!;
    host.store.addThread({ thread_id: "thr_worker", project_id: project.id, role: "worker", state: "active" });
    const result = await propose((doc) => (doc.project.slug = "other"), "thr_worker");
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("Workers and reviewers cannot propose projects.");
  });

  it("refuses another thread proposing an existing slug", async () => {
    await propose();
    const result = await propose(undefined, "thr_other");
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("this thread is not its planner");
  });

  it("reports a taken section name and creates nothing", async () => {
    host.state.takenNames.add("Loom · CSV export (csv)");
    const result = await propose();
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('A sidebar section named "Loom · CSV export (csv)" already exists.');
    expect(host.store.projects()).toEqual([]);
  });
});

describe("worker and planner tools", () => {
  let fake: FakePort;
  let harness: Awaited<ReturnType<typeof setup>>;
  let hh: EngineHarness;

  async function setup() {
    fake = new FakePort();
    fake.addThread("thr_plan", "idle");
    host = makeHost({ port: fake });
    registerTools(host.bb, host.projects, host.engine);
    hh = { ctx: host.engine.ctx, store: host.store, bb: fake, host: host.hostPort, projects: host.projects, clock: new Clock(), kicks: { count: 0 } };
    const project = await seedProject(hh, (doc: Doc) => {
      doc.ticket[1].depends_on = [];
    });
    return { project };
  }

  const ticketNamed = (key: string) => host.store.ticketByKey(key)!;
  const call = (name: string, input: unknown, threadId: string) => host.harness.callAgentTool(name, input, { threadId, projectId: "proj_1" });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const startWorkerFor = async (key: string) => {
    const { spawnWorker, specOf } = await import("../src/workers");
    const project = host.store.projectBySlug("csv")!;
    await spawnWorker(host.engine.ctx, project, specOf(host.store, project), ticketNamed(key));
    return host.store.ticketByKey(key)!.worker_thread_id!;
  };

  beforeEach(async () => {
    harness = await setup();
  });

  it("gives a planner its tools, the worker tools stay away from it, and a worker cannot use the planner tools", async () => {
    const planner = await configure("thr_plan");
    expect(planner.tools.map((tool) => tool.name)).toEqual([...PLANNER_TOOLS]);
    expect(PLANNER_TOOLS).toEqual(["loom_propose", "loom_board", "loom_ticket", "loom_requeue", "loom_add_tickets", "loom_edit_ticket", "loom_cancel_ticket", "loom_post"]);
    const workerId = await startWorkerFor("CSV-1");
    const worker = await configure(workerId);
    expect(worker.tools.map((tool) => tool.name)).toEqual([...WORKER_TOOLS]);
    expect(worker.instructions).toBe("You are a Loom worker on CSV-1; follow the brief in your first message.");
    for (const [name, input] of [
      ["loom_board", {}],
      ["loom_ticket", { key: "CSV-1" }],
      ["loom_requeue", { key: "CSV-1", note: "x" }],
      ["loom_cancel_ticket", { key: "CSV-1", reason: "x" }],
      ["loom_post", { key: "CSV-1", text: "x" }],
    ] as const) {
      const result = await call(name, input, workerId);
      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("planner");
    }
    expect(harness.project.state).toBe("running");
  });

  it("loom_note adds a note under the worker's name, and a reply when asked, for the worker of a working ticket only", async () => {
    const workerId = await startWorkerFor("CSV-1");
    expect(text(await call("loom_note", { text: "Mapper done" }, workerId))).toContain("Noted");
    const note = host.store.posts(ticketNamed("CSV-1").id).at(-1)!;
    expect(note).toMatchObject({ kind: "note", author_kind: "worker", author_thread_id: workerId, body: "Mapper done" });
    await call("loom_note", { text: "Edge cases too", reply_to: note.id }, workerId);
    expect(host.store.posts(ticketNamed("CSV-1").id).at(-1)).toMatchObject({ kind: "note", parent_id: note.id });
    expect(isError(await call("loom_note", { text: "x", reply_to: 9999 }, workerId))).toBe(true);
    expect(isError(await call("loom_note", { text: "x" }, "thr_plan"))).toBe(true);

    host.store.setTicketState(ticketNamed("CSV-1").id, "checking", "loom");
    const late = await call("loom_note", { text: "late" }, workerId);
    expect(isError(late)).toBe(true);
    expect(text(late)).toContain("working");
  });

  it("loom_submit hands the work in, and is refused from a thread that is not the live worker of a working ticket", async () => {
    const workerId = await startWorkerFor("CSV-1");
    const other = await startWorkerFor("CSV-2");
    host.hostPort.worktree("/wt/env_1").dirty = true;
    const refused = await call("loom_submit", { summary: "done" }, "thr_plan");
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain("Loom worker");
    expect(isError(await call("loom_submit", { summary: "done" }, "thr_unknown"))).toBe(true);
    expect(isError(await call("loom_submit", { summary: "   " }, workerId))).toBe(true);

    const result = await call("loom_submit", { summary: "Mapped every order" }, workerId);
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("Submitted CSV-1");
    expect(ticketNamed("CSV-1").state).toBe("checking");
    expect(ticketNamed("CSV-2").state).toBe("working");
    expect(isError(await call("loom_submit", { summary: "again" }, workerId))).toBe(true);
    expect(other).not.toBe(workerId);
    const { settleChecks } = await import("../src/checks");
    await settleChecks(host.engine.ctx);
    expect(ticketNamed("CSV-1").state).toBe("review");
  });

  it("loom_block records the reason and the needs, and the ticket blocks once the thread stopped", async () => {
    const workerId = await startWorkerFor("CSV-1");
    const result = await call("loom_block", { reason: "No API key", needs: "A key in the CI settings" }, workerId);
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain("end your turn");
    await settle();
    expect(ticketNamed("CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "No API key. Needs: A key in the CI settings" });
    expect(isError(await call("loom_block", { reason: "again", needs: "x" }, workerId))).toBe(true);
    expect(isError(await call("loom_block", { reason: "x", needs: "y" }, "thr_plan"))).toBe(true);
  });

  it("loom_board and loom_ticket show the planner its board and a ticket's thread", async () => {
    const board = text(await call("loom_board", {}, "thr_plan"));
    expect(board).toContain("Board for csv: 2 tickets");
    expect(board).toContain("CSV-1  queued");
    expect(text(await call("loom_board", { state: "blocked" }, "thr_plan"))).toContain("No tickets in blocked");
    const ticket = text(await call("loom_ticket", { key: "CSV-2" }, "thr_plan"));
    expect(ticket).toContain("CSV-2 · queued · Export endpoint");
    expect(ticket).toContain("planner brief");
    expect(isError(await call("loom_ticket", { key: "CSV-77" }, "thr_plan"))).toBe(true);
  });

  it("loom_requeue sends a blocked ticket back with a reply, and loom_post answers on a ticket", async () => {
    await host.engine.block("CSV-1", "stuck", "human");
    expect(text(await call("loom_post", { key: "CSV-1", text: "Use the v2 API" }, "thr_plan"))).toContain("Posted");
    const posted = host.store.posts(ticketNamed("CSV-1").id).at(-1)!;
    expect(posted).toMatchObject({ kind: "reply", author_kind: "planner", author_thread_id: "thr_plan" });
    await call("loom_post", { key: "CSV-1", text: "Details", reply_to: posted.id }, "thr_plan");
    expect(host.store.posts(ticketNamed("CSV-1").id).at(-1)!.parent_id).toBe(posted.id);

    expect(text(await call("loom_requeue", { key: "CSV-1", note: "Answered above" }, "thr_plan"))).toContain("CSV-1 is queued again");
    expect(ticketNamed("CSV-1").state).toBe("queued");
    const again = await call("loom_requeue", { key: "CSV-1", note: "x" }, "thr_plan");
    expect(isError(again)).toBe(true);
    expect(text(again)).toContain("only a blocked ticket");
  });

  it("loom_add_tickets adds a batch with dependencies and refuses a cycle", async () => {
    const tickets = [
      { ref: "docs", title: "Docs", body: "Write them.", acceptance: ["WHEN built THE SYSTEM SHALL list it"], scope: ["docs/**"], depends_on: ["CSV-1"] },
      { ref: "more", title: "More docs", body: "Write more.", acceptance: ["WHEN built THE SYSTEM SHALL list more"], scope: ["docs/more/**"], depends_on: ["docs"] },
    ];
    expect(text(await call("loom_add_tickets", { tickets }, "thr_plan"))).toContain("Added CSV-3, CSV-4");
    expect(host.store.ticketByKey("CSV-4")?.deps_json).toBe('["CSV-3"]');

    const cyclic = [
      { ...tickets[0], ref: "x", depends_on: ["y"] },
      { ...tickets[1], ref: "y", depends_on: ["x"] },
    ];
    const refused = await call("loom_add_tickets", { tickets: cyclic }, "thr_plan");
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain("dependency cycle");
    expect(host.store.tickets(harness.project.id)).toHaveLength(4);
  });

  it("loom_edit_ticket changes only the patched fields, and refuses a working ticket", async () => {
    const before = ticketNamed("CSV-2");
    expect(text(await call("loom_edit_ticket", { key: "CSV-2", patch: { title: "Export v2" } }, "thr_plan"))).toContain("CSV-2 changed: title");
    expect(ticketNamed("CSV-2")).toMatchObject({ title: "Export v2", verify_json: before.verify_json, deps_json: before.deps_json, priority: before.priority });

    await startWorkerFor("CSV-1");
    const refused = await call("loom_edit_ticket", { key: "CSV-1", patch: { title: "x" } }, "thr_plan");
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain("only a queued or blocked");
    await expect(call("loom_edit_ticket", { key: "CSV-2", patch: { ref: "new" } }, "thr_plan")).rejects.toThrow();
    await expect(call("loom_edit_ticket", { key: "CSV-2", patch: { priority: 9 } }, "thr_plan")).rejects.toThrow();
  });

  it("loom_cancel_ticket cancels, ending a live worker", async () => {
    const workerId = await startWorkerFor("CSV-1");
    expect(text(await call("loom_cancel_ticket", { key: "CSV-1", reason: "No longer needed" }, "thr_plan"))).toContain("CSV-1 is cancelled");
    expect(ticketNamed("CSV-1").state).toBe("cancelled");
    expect(host.store.threadByThreadId(workerId)?.state).toBe("ended");
  });

  it("refuses a planner that does not belong to the ticket's project", async () => {
    await host.projects.propose({ toml: specToml((doc) => ((doc.project.slug = "other"), (doc.project.key = "OTH"))), threadId: "thr_plan2", bbProjectId: "proj_1", hostId: "host_1" });
    for (const [name, input] of [
      ["loom_ticket", { key: "CSV-1" }],
      ["loom_requeue", { key: "CSV-1", note: "x" }],
      ["loom_edit_ticket", { key: "CSV-1", patch: { title: "x" } }],
      ["loom_cancel_ticket", { key: "CSV-1", reason: "x" }],
      ["loom_post", { key: "CSV-1", text: "x" }],
    ] as const) {
      const result = await call(name, input, "thr_plan2");
      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("another project");
    }
    expect(ticketNamed("CSV-1").title).toBe("Order rows");
  });

  describe("reviewer tools", () => {
    const findings = [{ severity: "blocking", title: "Off by one", detail: "The loop skips the last order.", file: "src/model/a.ts", line: 12 }];

    async function reviewing() {
      const workerId = await startWorkerFor("CSV-1");
      await reachReviewFrom(workerId);
      const { spawnReviewers, settleReviews } = await import("../src/review");
      const { specOf } = await import("../src/workers");
      const project = host.store.projectBySlug("csv")!;
      await spawnReviewers(host.engine.ctx, project, specOf(host.store, project));
      const row = host.store.threads({ ticketId: ticketNamed("CSV-1").id, role: "reviewer" })[0]!;
      checkOutHead(hh, row);
      return { workerId, reviewerId: row.thread_id!, settleReviews };
    }

    async function reachReviewFrom(workerId: string) {
      host.hostPort.worktree(`/wt/${host.store.threadByThreadId(workerId)!.environment_id}`).dirty = true;
      await call("loom_submit", { summary: "Done" }, workerId);
      const { settleChecks } = await import("../src/checks");
      await settleChecks(host.engine.ctx);
      expect(ticketNamed("CSV-1").state).toBe("review");
    }

    it("loom_approve approves for the reviewer row, and a worker, a planner and an unknown thread are refused", async () => {
      const { workerId, reviewerId, settleReviews } = await reviewing();
      for (const threadId of [workerId, "thr_plan", "thr_unknown"]) {
        const refused = await call("loom_approve", { summary: "Looks good" }, threadId);
        expect(isError(refused)).toBe(true);
        expect(text(refused)).toContain("Loom reviewer");
        const asked = await call("loom_request_changes", { summary: "No", findings }, threadId);
        expect(isError(asked)).toBe(true);
      }
      expect(ticketNamed("CSV-1").state).toBe("review");
      const result = await call("loom_approve", { summary: "Every criterion holds" }, reviewerId);
      expect(isError(result)).toBe(false);
      expect(text(result)).toContain("approval of CSV-1");
      await settleReviews(host.engine.ctx);
      expect(ticketNamed("CSV-1").state).toBe("approved");
    });

    it("loom_request_changes sends the findings to the worker, and its parameters are validated", async () => {
      const { workerId, reviewerId, settleReviews } = await reviewing();
      for (const bad of [
        { summary: "x", findings: [] },
        { summary: "", findings },
        { summary: "x", findings: [{ ...findings[0], severity: "nit" }] },
        { summary: "x", findings: [{ ...findings[0], line: 1.5 }] },
        { summary: "x", findings: [{ ...findings[0], title: "" }] },
        { summary: "x", findings: Array.from({ length: 21 }, () => findings[0]) },
      ]) {
        await expect(call("loom_request_changes", bad, reviewerId)).rejects.toThrow();
      }
      const result = await call("loom_request_changes", { summary: "Two problems", findings: [findings[0], { severity: "should-fix", title: "Naming", detail: "Rename m." }] }, reviewerId);
      expect(isError(result)).toBe(false);
      await settleReviews(host.engine.ctx);
      expect(ticketNamed("CSV-1").state).toBe("working");
      expect(fake.sent(workerId).at(-1)).toContain("1. [blocking] Off by one (src/model/a.ts:12)");
    });

    it("refuses a verdict while the worktree is not on head_sha", async () => {
      const { reviewerId } = await reviewing();
      host.hostPort.worktree(`/wt/${host.store.threadByThreadId(reviewerId)!.environment_id}`).head = "other";
      const result = await call("loom_approve", { summary: "ok" }, reviewerId);
      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("Check out c1 first, then review again.");
    });

    it("loom_note accepts a note from the live worker of a working ticket or from a reviewer of a ticket in review, and from nobody else", async () => {
      const { workerId, reviewerId } = await reviewing();
      const note = await call("loom_note", { text: "Checked the mapper against the criteria" }, reviewerId);
      expect(isError(note)).toBe(false);
      expect(host.store.posts(ticketNamed("CSV-1").id).at(-1)).toMatchObject({ kind: "note", author_kind: "reviewer", author_thread_id: reviewerId, body: "Checked the mapper against the criteria" });
      const refused = await call("loom_note", { text: "late" }, workerId);
      expect(isError(refused)).toBe(true);
      expect(text(refused)).toContain("working");
      expect(isError(await call("loom_note", { text: "x" }, "thr_plan"))).toBe(true);
    });
  });

  it("clips a long result to 12000 characters", async () => {
    const long = Array.from({ length: 200 }, (_, i) => ({ ref: `t${i}`, title: "T".repeat(100), body: "b", acceptance: ["WHEN a THE SYSTEM SHALL b"], scope: [`d${i}/**`] }));
    await call("loom_add_tickets", { tickets: long.slice(0, 50) }, "thr_plan");
    await call("loom_add_tickets", { tickets: long.slice(50, 100).map((t, i) => ({ ...t, ref: `u${i}` })) }, "thr_plan");
    expect(text(await call("loom_board", {}, "thr_plan")).length).toBeLessThanOrEqual(12_000);
  });
});

describe("the loom skill", () => {
  it("names every planner, worker and reviewer tool and every human command", () => {
    const skill = readFileSync(new URL("../skills/loom/SKILL.md", import.meta.url), "utf8");
    for (const tool of [...PLANNER_TOOLS, ...WORKER_TOOLS, ...REVIEWER_TOOLS]) expect(skill, tool).toContain(tool);
    for (const command of ["post", "block", "requeue", "cancel", "approve", "start", "pause", "resume", "archive", "land"]) expect(skill, command).toContain(`bb loom ${command}`);
    for (const heading of ["## Reviewers", "## Merging", "## Landing"]) expect(skill, heading).toContain(heading);
    expect(skill).not.toContain("later release");
    expect(skill).not.toContain("runs no workers");
  });
});
