import { beforeEach, describe, expect, it } from "vitest";
import { createCli, formatMetrics } from "../src/cli";
import { formatDuration, readyToLand } from "../src/format";
import type { ProjectMetrics } from "../src/metrics";
import { TICKET_STATES } from "../src/states";
import { START_FAILED } from "../src/workers";
import { FakePort, makeHost, specToml, type Doc } from "./helpers";

let host: ReturnType<typeof makeHost>;
let fake: FakePort;

beforeEach(() => {
  fake = new FakePort();
  host = makeHost({ port: fake });
  host.bb.cli.register(createCli(host.projects, host.engine, host.store, Date.now));
});

const run = (argv: string[], threadId?: string) => host.harness.runCli(argv, threadId === undefined ? undefined : { threadId });
const propose = (edit?: (doc: Doc) => void) => host.projects.propose({ toml: specToml(edit), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
const errorOf = (stdout: string) => (JSON.parse(stdout) as { ok: false; error: { code: string; message: string; hint?: string } }).error;
const humanEvents = () => host.store.events(host.store.projectBySlug("csv")!.id).filter((event) => event.kind === "human.action").map((event) => JSON.parse(event.data_json) as Record<string, unknown>);

async function approved() {
  await propose();
  await host.projects.approve("csv", "human");
}

describe("read commands", () => {
  it("list says so when there are no projects, and lists projects otherwise", async () => {
    expect((await run(["list"])).stdout).toContain("No Loom projects yet");
    expect(JSON.parse((await run(["list", "--json"])).stdout)).toEqual([]);
    await propose();
    const listed = await run(["list"]);
    expect(listed).toMatchObject({ exitCode: 0 });
    expect(listed.stdout).toContain("csv");
    expect(listed.stdout).toContain("draft");
    expect(listed.stdout).toContain("CSV export");
    expect(JSON.parse((await run(["list", "--json"])).stdout)).toMatchObject([{ slug: "csv", state: "draft", ticketCount: 0 }]);
    expect(listed.stdout).toContain("  0 tickets  CSV export");
    await propose((doc) => doc.ticket.pop());
    await run(["approve", "csv"]);
    expect((await run(["list"])).stdout).toContain("  1 ticket   CSV export");
  });

  it("show prints the state, the goal, the merge setup and the next step", async () => {
    await propose();
    const draft = (await run(["show", "csv"])).stdout;
    expect(draft).toContain("CSV export (csv) · draft");
    expect(draft).toContain("Let people export their orders");
    expect(draft).toContain("integration branch loom/csv");
    expect(draft).toContain("bb loom approve csv");
    await host.projects.approve("csv", "human");
    expect((await run(["show", "csv"])).stdout).toContain("bb loom start csv");
    expect(JSON.parse((await run(["show", "csv", "--json"])).stdout)).toMatchObject({ slug: "csv", state: "ready", ticketCount: 2, ticketCounts: { queued: 2 } });
  });

  it("spec prints the TOML as a version comment and the file, and takes --version", async () => {
    await propose();
    const out = (await run(["spec", "csv"])).stdout;
    expect(out.startsWith("# csv · spec v1 (draft)")).toBe(true);
    expect(out).toContain('slug = "csv"');
    await host.projects.approve("csv", "human");
    await propose((doc) => (doc.project.name = "Orders CSV"));
    expect((await run(["spec", "csv"])).stdout).toContain("spec v1 (approved)");
    const pending = (await run(["spec", "csv", "--version", "2"])).stdout;
    expect(pending).toContain("spec v2 (pending)");
    expect(pending).toContain("Orders CSV");
    expect(JSON.parse((await run(["spec", "csv", "--version", "2", "--json"])).stdout)).toMatchObject({ version: 2, status: "pending" });
    const missing = await run(["spec", "csv", "--version", "9", "--json"]);
    expect(missing.exitCode).toBe(1);
    expect(errorOf(missing.stdout).code).toBe("loom_not_found");
  });

  it("tickets lists keys, states and dependencies, with a state filter", async () => {
    await approved();
    host.projects.block("CSV-2", "waiting", "human");
    const all = (await run(["tickets", "csv"])).stdout;
    expect(all).toContain("CSV-1  queued");
    expect(all).toContain("Order rows");
    expect(all).toContain("CSV-2  blocked");
    expect(all).toContain("after CSV-1");
    const blockedOnly = (await run(["tickets", "csv", "--state", "blocked"])).stdout;
    expect(blockedOnly).toContain("CSV-2  blocked");
    expect(blockedOnly).not.toContain("Order rows");
    expect(JSON.parse((await run(["tickets", "csv", "--state", "queued,blocked", "--json"])).stdout)).toHaveLength(2);
    expect((await run(["tickets", "csv", "--state", "flying", "--json"])).exitCode).toBe(1);
  });

  it("ticket prints its posts indented by reply depth", async () => {
    await approved();
    const brief = host.store.posts(host.store.ticketByKey("CSV-1")!.id)[0]!;
    const reply = host.projects.post("CSV-1", { body: "Keep the header row.", parentId: brief.id, author: "human" });
    host.projects.post("CSV-1", { body: "Agreed.\nSecond line.", parentId: reply.id, author: "human" });
    const out = (await run(["ticket", "CSV-1"])).stdout;
    const lines = out.split("\n");
    expect(lines[0]).toBe("CSV-1 · queued · Order rows");
    expect(lines).toContain(`#${brief.id} planner brief ${new Date(brief.at).toISOString().slice(0, 16)}Z`);
    expect(lines).toContain("Build the row mapper.");
    expect(lines.find((line) => line.includes(`#${reply.id} human reply`))?.startsWith("  #")).toBe(true);
    expect(lines).toContain("  Keep the header row.");
    expect(lines.find((line) => line.includes("human reply") && line.startsWith("    #"))).toBeDefined();
    expect(lines).toContain("    Second line.");
    const json = JSON.parse((await run(["ticket", "CSV-1", "--json"])).stdout) as { posts: Array<{ depth: number }> };
    expect(json.posts.map((post) => post.depth)).toEqual([0, 1, 2]);
    expect(errorOf((await run(["ticket", "CSV-9", "--json"])).stdout).code).toBe("loom_not_found");
  });
});

describe("human commands", () => {
  it("approve creates the tickets and says what comes next", async () => {
    await propose();
    const out = await run(["approve", "csv"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("CSV-1, CSV-2");
    expect(out.stdout).toContain("bb loom start csv");
    expect(errorOf((await run(["approve", "csv", "--json"])).stdout).code).toBe("loom_invalid_state");
  });

  it("approve applies a pending version, and refuses another version", async () => {
    await approved();
    await propose((doc) => (doc.project.name = "Orders CSV"));
    expect(errorOf((await run(["approve", "csv", "--version", "5", "--json"])).stdout).code).toBe("loom_invalid_state");
    const out = await run(["approve", "csv", "--version", "2"]);
    expect(out.stdout).toContain("Applied spec v2");
    expect(humanEvents().at(-1)).toMatchObject({ action: "approve", slug: "csv", pending: true });
  });

  it("approve of a pending version says which tickets it queued again", async () => {
    await approved();
    const id = host.store.ticketByKey("CSV-1")!.id;
    host.store.setTicketState(id, "working", "loom");
    host.store.setTicketState(id, "blocked", "loom", { reason: START_FAILED });
    const reviewed = host.store.ticketByKey("CSV-2")!.id;
    for (const state of ["working", "checking", "review", "blocked"] as const) host.store.setTicketState(reviewed, state, "loom");
    host.store.updateTicket(reviewed, { head_sha: "abc1234", review_round: 1, blocked_reason: "bb refused to start a reviewer: HTTP 400: Unsupported provider claude" });
    await propose((doc) => (doc.project.name = "Orders CSV"));
    const out = await run(["approve", "csv", "--version", "2"]);
    expect(out.stdout).toContain("Queued again, because bb never started its worker: CSV-1.");
    expect(out.stdout).toContain("Back in review, because bb refused to start its reviewer: CSV-2.");
    expect(host.store.ticketByKey("CSV-1")!.state).toBe("queued");
    expect(host.store.ticketByKey("CSV-2")!.state).toBe("review");
  });

  it("start, pause, resume and archive move the project", async () => {
    await approved();
    const started = (await run(["start", "csv"])).stdout;
    expect(started).toContain("csv is running");
    expect(started).not.toContain("does not run workers");
    expect((await run(["pause", "csv"])).stdout).toContain("csv is paused");
    const resumed = (await run(["resume", "csv"])).stdout;
    expect(resumed).toContain("csv is running");
    expect(resumed).not.toContain("does not run workers");
    expect((await run(["pause", "csv", "--now"])).stdout).toContain("csv is paused");
    expect(host.store.projectBySlug("csv")?.system_reason).toBe("pause --now");
    expect((await run(["archive", "csv"])).stdout).toContain("csv is archived");
    expect(host.store.projectBySlug("csv")?.state).toBe("archived");
  });

  it("refuses an invalid move with the current state and a hint", async () => {
    await propose();
    const out = await run(["start", "csv", "--json"]);
    expect(out.exitCode).toBe(1);
    const error = errorOf(out.stdout);
    expect(error.code).toBe("loom_invalid_state");
    expect(error.message).toContain("draft");
    expect(error.hint).toContain("bb loom approve csv");
    expect(humanEvents()).toEqual([]);
  });

  it("an unknown project is a loom_not_found error", async () => {
    const out = await run(["approve", "nope", "--json"]);
    expect(out.exitCode).toBe(1);
    expect(errorOf(out.stdout)).toMatchObject({ code: "loom_not_found" });
  });

  it("post adds a human reply and block blocks a ticket", async () => {
    await approved();
    const brief = host.store.posts(host.store.ticketByKey("CSV-1")!.id)[0]!;
    const posted = await run(["post", "CSV-1", "Please", "keep", "the", "header", "--reply-to", String(brief.id)]);
    expect(posted.stdout).toContain("Posted #");
    expect(host.store.posts(host.store.ticketByKey("CSV-1")!.id).at(-1)).toMatchObject({ body: "Please keep the header", parent_id: brief.id, author_kind: "human", kind: "reply" });
    const other = host.store.posts(host.store.ticketByKey("CSV-2")!.id)[0]!;
    expect(errorOf((await run(["post", "CSV-1", "hi", "--reply-to", String(other.id), "--json"])).stdout).code).toBe("loom_not_found");

    const blocked = await run(["block", "CSV-1", "Waiting on data"]);
    expect(blocked.stdout).toContain("CSV-1 is blocked: Waiting on data");
    expect(host.store.ticketByKey("CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "Waiting on data" });
    expect(errorOf((await run(["block", "CSV-1", "again", "--json"])).stdout).code).toBe("loom_invalid_state");
  });

  it("requeue puts a blocked ticket back in the queue with the note as a reply, and refuses a ticket that is not blocked", async () => {
    await approved();
    expect(errorOf((await run(["requeue", "CSV-1", "--json"])).stdout)).toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("only a blocked ticket") });
    await run(["block", "CSV-1", "Waiting on data"]);
    const out = await run(["requeue", "CSV-1", "--note", "Data is ready"]);
    expect(out.stdout).toContain("CSV-1 is queued again");
    expect(host.store.ticketByKey("CSV-1")).toMatchObject({ state: "queued", blocked_reason: null });
    expect(host.store.posts(host.store.ticketByKey("CSV-1")!.id).at(-1)).toMatchObject({ kind: "reply", author_kind: "human", body: "Data is ready" });
    expect(errorOf((await run(["requeue", "CSV-9", "--json"])).stdout).code).toBe("loom_not_found");
    await run(["block", "CSV-1", "again"]);
    expect((await run(["requeue", "CSV-1"])).exitCode).toBe(0);
    expect(host.store.posts(host.store.ticketByKey("CSV-1")!.id).at(-1)).toMatchObject({ kind: "block" });
  });

  it("cancel cancels a ticket with a reason and refuses a ticket that cannot move", async () => {
    await approved();
    const out = await run(["cancel", "CSV-2", "Not", "needed", "any", "more"]);
    expect(out.stdout).toContain("CSV-2 is cancelled: Not needed any more");
    expect(host.store.ticketByKey("CSV-2")?.state).toBe("cancelled");
    expect(host.store.posts(host.store.ticketByKey("CSV-2")!.id).at(-1)!.body).toBe("Cancelled: Not needed any more");
    expect(errorOf((await run(["cancel", "CSV-2", "again", "--json"])).stdout).code).toBe("loom_invalid_state");
  });

  it("block, cancel and post reach the live worker through the engine", async () => {
    await approved();
    await run(["start", "csv"]);
    await host.engine.tick();
    expect(fake.callsTo("spawnThread")).toHaveLength(1);
    await run(["post", "CSV-1", "Use", "the", "v2", "API"]);
    expect(fake.callsTo("send")).toEqual([["thr_w1", { summary: "[loom] Reply on CSV-1 from the human", detail: "Use the v2 API" }]]);
    await run(["pause", "csv", "--now"]);
    expect(fake.callsTo("stop")).toEqual([["thr_w1"]]);
    await run(["block", "CSV-1", "Wrong", "approach"]);
    expect(host.store.ticketByKey("CSV-1")).toMatchObject({ state: "blocked", branch: "wt-thr_w1" });
    expect(fake.callsTo("archive")).toEqual([["thr_w1"]]);
    expect(host.store.threadByThreadId("thr_w1")?.state).toBe("ended");
  });

  it("start is refused with loom_no_checkout when the bb project has no checkout", async () => {
    await approved();
    fake.checkout = null;
    const out = await run(["start", "csv", "--json"]);
    expect(out.exitCode).toBe(1);
    expect(errorOf(out.stdout)).toMatchObject({ code: "loom_no_checkout" });
    expect(host.store.projectBySlug("csv")?.state).toBe("ready");
    expect(humanEvents()).toEqual([]);
  });

  it("writes one human.action event per human command and none for a failed one", async () => {
    await propose();
    await run(["approve", "csv"]);
    await run(["start", "csv"]);
    await run(["post", "CSV-1", "hello"]);
    await run(["block", "CSV-2", "later"]);
    await run(["requeue", "CSV-2"]);
    await run(["cancel", "CSV-2", "dropped"]);
    await run(["pause", "csv", "--now"]);
    await run(["resume", "csv"]);
    await run(["start", "csv"]);
    await run(["archive", "csv"]);
    expect(humanEvents()).toEqual([
      { action: "approve", slug: "csv", pending: false },
      { action: "start", slug: "csv" },
      { action: "post", slug: "csv", key: "CSV-1" },
      { action: "block", slug: "csv", key: "CSV-2" },
      { action: "requeue", slug: "csv", key: "CSV-2" },
      { action: "cancel", slug: "csv", key: "CSV-2" },
      { action: "pause", slug: "csv", now: true },
      { action: "resume", slug: "csv" },
      { action: "archive", slug: "csv" },
    ]);
  });
});

describe("land", () => {
  const doneTicket = (key: string) => {
    for (const state of ["working", "checking", "review", "approved", "merging", "done"] as const) host.store.setTicketState(host.store.ticketByKey(key)!.id, state, "loom");
  };

  async function running() {
    await approved();
    await run(["start", "csv"]);
  }

  it("prints the pull request url, and --json prints { url, done }", async () => {
    await running();
    doneTicket("CSV-1");
    const text = await run(["land", "csv"]);
    expect(text).toMatchObject({ exitCode: 0 });
    expect(text.stdout).toContain("https://github.com/acme/shop/pull/1");
    expect(text.stdout).toContain("csv");

    const json = await run(["land", "csv", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ url: "https://github.com/acme/shop/pull/1", done: false });
    expect(host.hostPort.callsTo("prCreate")).toHaveLength(1);
    expect(host.hostPort.callsTo("push")).toHaveLength(2);
  });

  it("passes --title and --ready on, and says when the project is done", async () => {
    await running();
    doneTicket("CSV-1");
    host.projects.block("CSV-2", "x", "human");
    host.store.setTicketState(host.store.ticketByKey("CSV-2")!.id, "cancelled", "human");
    const out = await run(["land", "csv", "--title", "Export orders", "--ready", "--json"]);
    expect(JSON.parse(out.stdout)).toEqual({ url: "https://github.com/acme/shop/pull/1", done: true });
    expect(host.hostPort.callsTo("prCreate")[0]).toMatchObject({ title: "Export orders", draft: false });
    expect(host.store.projectBySlug("csv")?.state).toBe("done");
    expect((await run(["land", "csv"])).stdout).toContain("done");
  });

  it("--direct pushes to the base branch with no pull request, and --json prints where and at which commit", async () => {
    await running();
    doneTicket("CSV-1");
    const text = await run(["land", "csv", "--direct"]);
    expect(text).toMatchObject({ exitCode: 0 });
    expect(text.stdout).toContain("Landed csv on origin/main at ");
    expect(text.stdout).toContain("bb loom land --direct");
    const json = await run(["land", "csv", "--direct", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ url: null, pushed: "origin/main", done: false });
    expect(host.hostPort.callsTo("prCreate")).toEqual([]);
    expect(host.hostPort.callsTo("push").map((push) => push.branch)).toEqual(["main", "main"]);
    expect(humanEvents().filter((event) => event.action === "land")).toEqual([
      { action: "land", slug: "csv", direct: true },
      { action: "land", slug: "csv", direct: true },
    ]);
  });

  it("refuses --title and --ready with --direct, and writes no event", async () => {
    await running();
    doneTicket("CSV-1");
    for (const extra of [["--ready"], ["--title", "Export orders"]]) {
      const out = await run(["land", "csv", "--direct", ...extra, "--json"]);
      expect(out.exitCode).toBe(1);
      expect(errorOf(out.stdout)).toMatchObject({ code: "loom_invalid_input", message: expect.stringContaining("do not go with --direct") });
    }
    expect(humanEvents().filter((event) => event.action === "land")).toEqual([]);
    expect(host.hostPort.callsTo("push")).toEqual([]);
  });

  it("writes one human.action event, and none for a refusal", async () => {
    await running();
    const refused = await run(["land", "csv", "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(humanEvents().filter((event) => event.action === "land")).toEqual([]);
    doneTicket("CSV-1");
    await run(["land", "csv"]);
    expect(humanEvents().filter((event) => event.action === "land")).toEqual([{ action: "land", slug: "csv" }]);
  });

  it("is refused with loom_invalid_state while a ticket is merging or when no ticket is done, and loom_unavailable with the host's message", async () => {
    await running();
    expect(errorOf((await run(["land", "csv", "--json"])).stdout)).toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("no ticket is done yet") });
    doneTicket("CSV-1");
    for (const state of ["working", "checking", "review", "approved", "merging"] as const) host.store.setTicketState(host.store.ticketByKey("CSV-2")!.id, state, "loom");
    expect(errorOf((await run(["land", "csv", "--json"])).stdout)).toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("a ticket is merging") });
    host.store.setTicketState(host.store.ticketByKey("CSV-2")!.id, "done", "loom");

    host.hostPort.scripted.push = [{ outcome: "unavailable", message: "git push to origin failed: rejected" }];
    const out = await run(["land", "csv", "--json"]);
    expect(out.exitCode).toBe(1);
    expect(errorOf(out.stdout)).toMatchObject({ code: "loom_unavailable", message: "git push to origin failed: rejected" });
  });

  it("show says to land once every ticket is finished, while the project is running or paused", async () => {
    const land = "Next: Every ticket is finished. Land it with `bb loom land csv`, which pushes the integration branch and opens one pull request.";
    await running();
    doneTicket("CSV-1");
    expect((await run(["show", "csv"])).stdout).toContain("Next: Pause it with `bb loom pause csv`.");
    host.store.setTicketState(host.store.ticketByKey("CSV-2")!.id, "cancelled", "human");
    expect((await run(["show", "csv"])).stdout).toContain(land);
    await run(["pause", "csv"]);
    expect((await run(["show", "csv"])).stdout).toContain(land);
  });

  it("is refused on the pull request strategy", async () => {
    await propose((doc) => (doc.merge = { strategy: "pr" }));
    await host.projects.approve("csv", "human");
    await run(["start", "csv"]);
    expect(errorOf((await run(["land", "csv", "--json"])).stdout)).toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("pull request per ticket") });
  });
});

describe("readyToLand", () => {
  const project = (over: Partial<Parameters<typeof readyToLand>[0]> = {}) => ({ state: "running", strategy: "integration", ticketCounts: { done: 2, cancelled: 1 }, ...over });

  it("is true for a running or paused integration project whose tickets are all done or cancelled, with one done", () => {
    expect(readyToLand(project())).toBe(true);
    expect(readyToLand(project({ state: "paused", ticketCounts: { done: 1 } }))).toBe(true);
  });

  it("is false for the pull request strategy, another state, no done ticket or an unfinished ticket", () => {
    expect(readyToLand(project({ strategy: "pr" }))).toBe(false);
    for (const state of ["draft", "ready", "done", "archived"]) expect(readyToLand(project({ state })), state).toBe(false);
    expect(readyToLand(project({ ticketCounts: { cancelled: 2 } }))).toBe(false);
    expect(readyToLand(project({ ticketCounts: {} }))).toBe(false);
    for (const state of ["queued", "working", "review", "merging", "blocked"]) expect(readyToLand(project({ ticketCounts: { done: 1, [state]: 1 } })), state).toBe(false);
  });
});

describe("loom_human_only", () => {
  async function setup() {
    await approved();
    const project = host.store.projectBySlug("csv")!;
    host.store.addThread({ thread_id: "thr_worker", project_id: project.id, role: "worker", state: "active" });
    host.store.addThread({ thread_id: "thr_review", project_id: project.id, role: "reviewer", state: "active" });
  }

  const humanCommands = [
    ["approve", "csv"],
    ["start", "csv"],
    ["pause", "csv"],
    ["resume", "csv"],
    ["archive", "csv"],
    ["post", "CSV-1", "hello"],
    ["block", "CSV-1", "why"],
    ["requeue", "CSV-1"],
    ["cancel", "CSV-1", "why"],
    ["land", "csv"],
  ];

  it("refuses every state-changing command from a planner, worker or reviewer thread", async () => {
    await setup();
    const before = host.store.events(host.store.projectBySlug("csv")!.id).length;
    for (const threadId of ["thr_plan", "thr_worker", "thr_review"]) {
      for (const argv of humanCommands) {
        const out = await run([...argv, "--json"], threadId);
        expect(out.exitCode, `${threadId} ${argv.join(" ")}`).toBe(1);
        expect(errorOf(out.stdout).code, `${threadId} ${argv.join(" ")}`).toBe("loom_human_only");
      }
    }
    expect(host.store.projectBySlug("csv")?.state).toBe("ready");
    expect(host.store.events(host.store.projectBySlug("csv")!.id)).toHaveLength(before);
  });

  it("lets read commands through for a Loom thread, and human commands through for an ordinary thread", async () => {
    await setup();
    expect((await run(["list"], "thr_worker")).exitCode).toBe(0);
    expect((await run(["show", "csv"], "thr_plan")).exitCode).toBe(0);
    expect((await run(["tickets", "csv"], "thr_review")).exitCode).toBe(0);
    expect((await run(["ticket", "CSV-1"], "thr_plan")).exitCode).toBe(0);
    expect((await run(["spec", "csv"], "thr_plan")).exitCode).toBe(0);
    expect((await run(["start", "csv"], "thr_ordinary")).exitCode).toBe(0);
  });
});

describe("--json", () => {
  it("every command prints machine-readable output", async () => {
    await propose();
    const commands = [
      ["list"],
      ["show", "csv"],
      ["spec", "csv"],
      ["tickets", "csv"],
      ["approve", "csv"],
      ["tickets", "csv"],
      ["ticket", "CSV-1"],
      ["post", "CSV-1", "hello"],
      ["block", "CSV-2", "later"],
      ["requeue", "CSV-2", "--note", "now"],
      ["cancel", "CSV-2", "dropped"],
      ["start", "csv"],
      ["pause", "csv"],
      ["resume", "csv"],
      ["archive", "csv"],
    ];
    for (const argv of commands) {
      const out = await run([...argv, "--json"]);
      expect(out.exitCode, argv.join(" ")).toBe(0);
      expect(() => JSON.parse(out.stdout), argv.join(" ")).not.toThrow();
    }
  });
});

describe("metrics and feed", () => {
  const HOUR = 3_600_000;
  const sample = (over: Partial<ProjectMetrics> = {}): ProjectMetrics => ({
    counts: { ...Object.fromEntries(TICKET_STATES.map((state) => [state, 0])), queued: 2, working: 1, done: 4 } as ProjectMetrics["counts"],
    wip: 3,
    throughput: [
      { day: "2026-01-01", done: 1 },
      { day: "2026-01-02", done: 3 },
    ],
    cycleTime: { p50: 3 * HOUR + 12 * 60_000, p85: 5 * HOUR, n: 4 },
    leadTime: { p50: 26 * HOUR, p85: 50 * HOUR, n: 4 },
    wipAge: [{ key: "CSV-3", state: "review", ageMs: 26 * HOUR }],
    firstPassApproval: { rate: 0.5, n: 4 },
    reviewRounds: { mean: 1.5, n: 4 },
    checks: { total: 6, failed: 2 },
    blocks: 1,
    humanInterventions: 2,
    tokens: { total: 7000, perDoneTicket: 1750, byRole: { planner: 1000, worker: 4000, reviewer: 2000 }, unreported: 0 },
    cumulativeFlow: [],
    activeMs: 7 * HOUR,
    timeInState: { ms: { ...Object.fromEntries(TICKET_STATES.map((state) => [state, 0])), queued: 2 * HOUR, working: 4 * HOUR, checking: HOUR, review: 3 * HOUR } as ProjectMetrics["counts"], flowEfficiency: 0.4, n: 3 },
    checksByCommand: [
      { command: "npm test", runs: 31, failed: 7, p50Ms: 100_000 },
      { command: "npm run lint", runs: 1, failed: 0, p50Ms: 12_000 },
    ],
    scopeFlags: { outside: 3, protectedHits: 0 },
    findings: { total: 17, blocking: 5, shouldFix: 12, rounds: 12, changesRequested: 4 },
    tokensByTicket: [
      { key: "CSV-9", tokens: 310_000 },
      { key: "CSV-4", tokens: 240_000 },
    ],
    reliability: { failedAttempts: 3, rateLimitRetries: 4, timeouts: 2, mergesSentBack: 1 },
    ...over,
  });

  it("formats durations in two units at most", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12 * 60_000 + 30_000)).toBe("12m 30s");
    expect(formatDuration(3 * HOUR + 12 * 60_000)).toBe("3h 12m");
    expect(formatDuration(3 * HOUR)).toBe("3h");
    expect(formatDuration(26 * HOUR)).toBe("1d 2h");
    expect(formatDuration(48 * HOUR)).toBe("2d");
  });

  it("prints one line per metric, with units", () => {
    const lines = formatMetrics(sample()).trimEnd().split("\n");
    expect(lines).toEqual([
      "tickets queued 2, working 1, done 4",
      "work in progress 3",
      "throughput 4 done in the last 2 days, 2.0 per day",
      "cycle time p50 3h 12m, p85 5h (4 tickets)",
      "lead time p50 1d 2h, p85 2d 2h (4 tickets)",
      "work item age oldest CSV-3 (review) 1d 2h, 3 in flight",
      "first-pass approval 50% (2 of 4 tickets with a verdict)",
      "review rounds 1.5 per done ticket (4 done)",
      "checks 6 run, 2 failed (33%)",
      "blocks 1",
      "human interventions 2",
      "tokens (sampled) 7000 in all, 1750 per done ticket; planner 1000, worker 4000, reviewer 2000",
      "active time 7h",
      "time in state (3 done tickets) queued 20%, working 40%, checking 10%, review 30%; flow efficiency 40%",
      "checks by command npm test 31 runs, 7 failed, p50 1m 40s; npm run lint 1 run, 0 failed, p50 12s",
      "scope flags 3 outside scope, 0 on protected paths",
      "review findings 17 in 12 rounds (5 blocking, 12 should-fix), changes requested in 4",
      "tokens by ticket CSV-9 310000, CSV-4 240000",
      "reliability 3 failed attempts, 4 rate-limit retries, 2 timeouts, 1 merge sent back",
    ]);
    const one = formatMetrics(sample({ reliability: { failedAttempts: 1, rateLimitRetries: 1, timeouts: 1, mergesSentBack: 2 } }));
    expect(one).toContain("reliability 1 failed attempt, 1 rate-limit retry, 1 timeout, 2 merges sent back\n");
  });

  it("says how many threads report no token usage, when any", () => {
    const tokens = (unreported: number) => formatMetrics(sample({ tokens: { ...sample().tokens, unreported } }));
    expect(tokens(1)).toContain("tokens (sampled) 7000 in all, 1750 per done ticket; planner 1000, worker 4000, reviewer 2000; 1 thread reports no token usage\n");
    expect(tokens(2)).toContain("reviewer 2000; 2 threads report no token usage\n");
    expect(tokens(0)).toContain("reviewer 2000\n");
  });

  it("says so when there is nothing to measure yet", () => {
    const empty = sample({
      counts: Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as ProjectMetrics["counts"],
      wip: 0,
      throughput: [],
      cycleTime: { p50: null, p85: null, n: 0 },
      leadTime: { p50: null, p85: null, n: 0 },
      wipAge: [],
      firstPassApproval: { rate: null, n: 0 },
      reviewRounds: { mean: null, n: 0 },
      checks: { total: 0, failed: 0 },
      tokens: { total: 0, perDoneTicket: null, byRole: { planner: 0, worker: 0, reviewer: 0 }, unreported: 0 },
      activeMs: 0,
      timeInState: { ms: Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as ProjectMetrics["counts"], flowEfficiency: null, n: 0 },
      checksByCommand: [],
      scopeFlags: { outside: 0, protectedHits: 0 },
      findings: { total: 0, blocking: 0, shouldFix: 0, rounds: 0, changesRequested: 0 },
      tokensByTicket: [],
      reliability: { failedAttempts: 0, rateLimitRetries: 0, timeouts: 0, mergesSentBack: 0 },
    });
    const text = formatMetrics(empty);
    expect(text).toContain("time in state none yet\n");
    expect(text).toContain("checks by command none yet\n");
    expect(text).toContain("scope flags 0 outside scope, 0 on protected paths\n");
    expect(text).toContain("review findings none yet\n");
    expect(text).toContain("tokens by ticket none yet\n");
    expect(text).toContain("reliability 0 failed attempts, 0 rate-limit retries, 0 timeouts, 0 merges sent back\n");
    expect(text).toContain("tickets none");
    expect(text).toContain("cycle time none yet");
    expect(text).toContain("work item age none in flight");
    expect(text).toContain("first-pass approval none yet");
    expect(text).toContain("review rounds none yet");
    expect(text).toContain("checks none run");
    expect(text).toContain("tokens (sampled) 0 in all");
    expect(text).not.toContain("NaN");
  });

  it("metrics prints the project's numbers, and --json prints ProjectMetrics", async () => {
    await approved();
    const text = (await run(["metrics", "csv"])).stdout;
    expect(text).toContain("tickets queued 2\n");
    expect(text).toContain("work in progress 0\n");
    expect(text).toContain("cycle time none yet\n");
    const metrics = JSON.parse((await run(["metrics", "csv", "--json"])).stdout) as ProjectMetrics;
    expect(metrics.counts.queued).toBe(2);
    expect(metrics.wip).toBe(0);
    expect(metrics.throughput).toHaveLength(14);
    expect(Object.keys(metrics).sort()).toEqual([
      "activeMs",
      "blocks",
      "checks",
      "checksByCommand",
      "counts",
      "cumulativeFlow",
      "cycleTime",
      "findings",
      "firstPassApproval",
      "humanInterventions",
      "leadTime",
      "reliability",
      "reviewRounds",
      "scopeFlags",
      "throughput",
      "timeInState",
      "tokens",
      "tokensByTicket",
      "wip",
      "wipAge",
    ]);
    expect(Object.keys(metrics.tokens).sort()).toEqual(["byRole", "perDoneTicket", "total", "unreported"]);
    expect((await run(["metrics", "csv"])).stdout).not.toMatch(/human interventions [1-9]/);
  });

  it("metrics --days sets the throughput and cumulative flow window, and prints the new sections", async () => {
    await approved();
    const lines = (await run(["metrics", "csv", "--days", "7"])).stdout.trimEnd().split("\n");
    expect(lines).toContain("throughput 0 done in the last 7 days, 0.0 per day");
    for (const label of ["time in state", "checks by command", "scope flags", "review findings", "tokens by ticket", "reliability"]) expect(lines.some((line) => line.startsWith(`${label} `)), label).toBe(true);
    const metrics = JSON.parse((await run(["metrics", "csv", "--days", "30", "--json"])).stdout) as ProjectMetrics;
    expect(metrics.throughput).toHaveLength(30);
    expect(metrics.cumulativeFlow).toHaveLength(30);
    expect(metrics.timeInState).toMatchObject({ flowEfficiency: null, n: 0 });
    expect((await run(["metrics", "csv", "--days", "0"])).exitCode).not.toBe(0);
    expect((await run(["metrics", "csv", "--days", "91"])).exitCode).not.toBe(0);
  });

  it("metrics counts the human's commands as interventions", async () => {
    await approved();
    await run(["start", "csv"]);
    await run(["pause", "csv"]);
    await run(["post", "CSV-1", "hi"]);
    expect(JSON.parse((await run(["metrics", "csv", "--json"])).stdout)).toMatchObject({ humanInterventions: 2 });
  });

  it("metrics refuses an unknown project", async () => {
    const out = await run(["metrics", "nope", "--json"]);
    expect(out.exitCode).toBe(1);
    expect(errorOf(out.stdout).code).toBe("loom_not_found");
  });

  it("feed prints one dated sentence per event, oldest first, and --after prints only newer ones", async () => {
    await approved();
    const lines = (await run(["feed", "csv"])).stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\dZ {2}The project was created\.$/);
    expect(lines).toContain(lines.find((line) => line.endsWith("CSV-1 was created."))!);
    const all = JSON.parse((await run(["feed", "csv", "--json"])).stdout) as { rows: Array<{ id: number; text: string }>; lastId: number };
    expect(all.rows.map((row) => row.text)).toEqual(lines.map((line) => line.slice(19)));
    expect(all.lastId).toBe(all.rows.at(-1)!.id);

    await run(["start", "csv"]);
    const later = (await run(["feed", "csv", "--after", String(all.lastId)])).stdout.trimEnd().split("\n");
    expect(later.map((line) => line.slice(19))).toEqual(["The project moved from ready to running.", "The human ran start."]);
    expect((await run(["feed", "csv", "--after", "999999"])).stdout).toBe("No events.\n");
    expect(JSON.parse((await run(["feed", "csv", "--after", "999999", "--json"])).stdout)).toEqual({ rows: [], lastId: 999999 });
  });

  it("feed refuses an unknown project", async () => {
    expect(errorOf((await run(["feed", "nope", "--json"])).stdout).code).toBe("loom_not_found");
  });
});
