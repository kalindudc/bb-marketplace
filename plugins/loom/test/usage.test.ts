import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import type { ThreadUsage } from "../src/ports";
import { ENDED_READS_PER_PASS, SETTLE_MS, SETTLE_RETRY_MS, USAGE_COMMAND_HOLD_MS, foldUsage, foldedUsage, readEndedUsage, refreshUsage, usageCommandsDone } from "../src/usage";
import { makeEngine, seedProject, workerRows } from "./helpers";

let h: ReturnType<typeof makeEngine>;

beforeEach(() => {
  h = makeEngine();
});

const reading = (seq: number, total: number, last: number, session = "pi_a"): ThreadUsage => ({ kind: "reading", session, seq, total, last });
const mark = (sum: number, seq: number, total: number, session = "pi_a") => JSON.stringify({ sum, session, seq, total });
const reads = (threadId: string) => h.bb.callsTo("threadUsage").filter(([id]) => id === threadId).length;
const endRow = (id: number) => h.store.updateThread(id, { state: "ended", ended_at: h.clock.now(), end_reason: "verdict" });
const execs = () => h.host.callsTo("exec");

describe("foldedUsage", () => {
  it("adds what a session used since the event counted last", () => {
    expect(foldedUsage({ tokens: null, usage_json: null }, reading(10, 900, 300), false)).toEqual({ tokens: 900, usage_json: mark(900, 10, 900) });
    expect(foldedUsage({ tokens: 900, usage_json: mark(900, 10, 900) }, reading(20, 1500, 400), false)).toEqual({ tokens: 1500, usage_json: mark(1500, 20, 1500) });
  });

  it("counts all of a total that started again, as when the provider process restarted", () => {
    expect(foldedUsage({ tokens: 1500, usage_json: mark(1500, 20, 1500) }, reading(30, 700, 700), false)).toEqual({ tokens: 2200, usage_json: mark(2200, 30, 700) });
    // Grown past the old total, but by less than its own latest call: a new process too.
    expect(foldedUsage({ tokens: 1500, usage_json: mark(1500, 20, 1500) }, reading(30, 1600, 1600), false)).toEqual({ tokens: 3100, usage_json: mark(3100, 30, 1600) });
    expect(foldedUsage({ tokens: 1500, usage_json: mark(1500, 20, 1500) }, reading(30, 400, 400, "pi_b"), false)).toEqual({ tokens: 1900, usage_json: mark(1900, 30, 400, "pi_b") });
  });

  it("adds nothing for an event it counted, and starts from a figure kept before Loom added events up", () => {
    expect(foldedUsage({ tokens: 1500, usage_json: mark(1500, 20, 1500) }, reading(20, 1500, 400), false)).toEqual({ tokens: 1500, usage_json: mark(1500, 20, 1500) });
    expect(foldedUsage({ tokens: 52_000, usage_json: JSON.stringify({ sum: 52_000 }) }, reading(20, 1500, 400), false)).toEqual({ tokens: 52_000, usage_json: mark(52_000, 20, 1500) });
    expect(foldedUsage({ tokens: 1500, usage_json: mark(1500, 20, 1500) }, null, true)).toEqual({ tokens: 1500, usage_json: mark(1500, 20, 1500) });
  });

  it("never adds bb's events to a larger figure the usage command gave", () => {
    const afterCommand = { tokens: 52_000, usage_json: mark(900, 10, 900) };
    expect(foldedUsage(afterCommand, reading(20, 52_000, 400), false)).toEqual({ tokens: 52_000, usage_json: mark(52_000, 20, 52_000) });
    expect(foldedUsage(afterCommand, reading(20, 1400, 400), false)).toEqual({ tokens: 52_000, usage_json: mark(1400, 20, 1400) });
  });

  it("records 0 for a stopped thread that never started a turn, but not for one that may still start", () => {
    expect(foldedUsage({ tokens: null, usage_json: null }, { kind: "never-ran" }, true)).toEqual({ tokens: 0, usage_json: null });
    expect(foldedUsage({ tokens: null, usage_json: null }, { kind: "never-ran" }, false)).toEqual({ tokens: null, usage_json: null });
    expect(foldedUsage({ tokens: 40, usage_json: null }, { kind: "never-ran" }, true)).toEqual({ tokens: 40, usage_json: null });
  });
});

describe("reading as turns end", () => {
  it("reads bb's event when a turn ends, so each is counted before the next replaces it, and runs no command there", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.engine.ctx.usageCommand = () => "usage-of";
    const row = workerRows(h, "CSV-1")[0]!;
    h.bb.usage.set("thr_w1", reading(10, 900, 300));
    await h.engine.onThreadIdle("thr_w1");
    h.bb.usage.set("thr_w1", reading(30, 700, 700));
    await h.engine.onThreadIdle("thr_w1");
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 1600, usage_json: mark(1600, 30, 700) });
    expect(execs()).toEqual([]);
  });

  it("folds one thread's reads in the order they started, even when the first answer comes last", async () => {
    await seedProject(h);
    await h.engine.tick();
    const row = workerRows(h, "CSV-1")[0]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    h.bb.threadUsage = async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return reading(10, 900, 300, "pi_a");
      }
      return reading(20, 700, 700, "pi_b");
    };
    const first = foldUsage(h.ctx, h.store.thread(row.id)!);
    const second = foldUsage(h.ctx, h.store.thread(row.id)!);
    release();
    await Promise.all([first, second]);
    expect(h.store.thread(row.id)!.tokens).toBe(1600);
  });
});

describe("reading an ended thread", () => {
  it("reads it once more a settle time after it ends", async () => {
    await seedProject(h);
    await h.engine.tick();
    const row = workerRows(h, "CSV-1")[0]!;
    h.bb.usage.set("thr_w1", reading(10, 300, 300));
    h.clock.advance(61_000);
    await h.engine.tick();
    expect(h.store.thread(row.id)!.tokens).toBe(300);
    endRow(row.id);
    const before = reads("thr_w1");
    h.bb.usage.set("thr_w1", reading(40, 5300, 900));
    h.clock.advance(SETTLE_MS - 1);
    await h.engine.tick();
    expect(reads("thr_w1")).toBe(before);
    h.clock.advance(1);
    await h.engine.tick();
    expect(reads("thr_w1")).toBe(before + 1);
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 5300, usage_json: mark(5300, 40, 5300) });
    h.clock.advance(60 * 60_000);
    await h.engine.tick();
    expect(reads("thr_w1")).toBe(before + 1);
  });

  it("reads ended threads of every project, done ones too, a few each pass and newest first", async () => {
    const project = await seedProject(h);
    h.store.setProjectState(project.id, "done", "human");
    const ids = Array.from({ length: ENDED_READS_PER_PASS + 2 }, (_, n) => {
      const row = h.store.addThread({ project_id: project.id, role: "reviewer", state: "active", thread_id: `thr_old${n}` });
      h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.now() + n });
      h.bb.usage.set(`thr_old${n}`, reading(5, 1000 + n, 100));
      return row.id;
    });
    h.clock.advance(SETTLE_MS + 100);
    await h.engine.tick();
    expect(ids.filter((id) => h.store.thread(id)!.tokens !== null)).toEqual(ids.slice(2));
    await h.engine.tick();
    expect(ids.map((id) => h.store.thread(id)!.tokens)).toEqual(ids.map((_, n) => 1000 + n));
  });

  it("records 0 for an ended thread that never started a turn", async () => {
    const project = await seedProject(h);
    const row = h.store.addThread({ project_id: project.id, role: "worker", state: "active", thread_id: "thr_failed" });
    h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.now(), end_reason: "failed" });
    h.bb.usage.set("thr_failed", { kind: "never-ran" });
    h.clock.advance(SETTLE_MS);
    await readEndedUsage(h.ctx);
    expect(h.store.thread(row.id)!.tokens).toBe(0);
  });

  it("reads again after a wait when bb fails, logging once, and keeps what it has after the last wait", async () => {
    const project = await seedProject(h);
    const row = h.store.addThread({ project_id: project.id, role: "reviewer", state: "active", thread_id: "thr_bad" });
    h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.now(), tokens: 700 });
    h.bb.threadUsage = async () => Promise.reject(new Error("HTTP 500: bb is busy"));
    h.clock.advance(SETTLE_MS);
    await readEndedUsage(h.ctx);
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 700, tokens_at: null });
    await readEndedUsage(h.ctx);
    expect(reads("thr_bad")).toBe(0);
    for (const wait of SETTLE_RETRY_MS) {
      h.clock.advance(wait);
      await readEndedUsage(h.ctx);
    }
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 700, tokens_at: h.clock.now() });
    expect(h.bb.callsTo("log").filter(([, text]) => String(text).startsWith("Could not read what thr_bad used"))).toHaveLength(1);
    h.bb.threadUsage = async () => reading(9, 9000, 100);
    h.clock.advance(60 * 60_000);
    await readEndedUsage(h.ctx);
    expect(h.store.thread(row.id)!.tokens).toBe(700);
  });

  it("counts a read bb answers after a failure", async () => {
    const project = await seedProject(h);
    const row = h.store.addThread({ project_id: project.id, role: "reviewer", state: "active", thread_id: "thr_flaky" });
    h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.now() });
    h.bb.threadUsage = async () => Promise.reject(new Error("HTTP 500: bb is busy"));
    h.clock.advance(SETTLE_MS);
    await readEndedUsage(h.ctx);
    h.bb.threadUsage = async () => reading(9, 9000, 100);
    h.clock.advance(SETTLE_RETRY_MS[0]!);
    await readEndedUsage(h.ctx);
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 9000, tokens_at: h.clock.now() });
  });
});

describe("a paused project", () => {
  it("still reads its working threads about once a minute, since they can keep working", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.pause("csv", "human", false);
    h.bb.usage.set("thr_w1", reading(8, 8000, 500));
    h.clock.advance(61_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ state: "active", tokens: 8000 });
  });
});

describe("the usage command", () => {
  const started = async () => {
    const project = await seedProject(h);
    await h.engine.tick();
    h.ctx.usageCommand = () => "usage-of";
    h.clock.advance(61_000);
    return { project, row: workerRows(h, "CSV-1")[0]! };
  };
  // Only the worker is read here: the planner counts as just read.
  const refresh = async (projectId: number) => {
    for (const planner of h.store.threads({ projectId, role: "planner" })) h.store.updateThread(planner.id, { tokens_at: h.clock.now() });
    await refreshUsage(h.ctx, projectId);
    await usageCommandsDone(h.ctx);
  };

  it("runs in the background in the project's checkout with the thread's id, and its larger figure wins", async () => {
    const { project, row } = await started();
    h.bb.usage.set("thr_w1", reading(10, 900, 300));
    h.host.execResults.push({ output: "reading the logs\n52000\nwarning: deprecated flag\n" });
    await refresh(project.id);
    expect(execs()).toEqual([{ cwd: "/repo", command: "usage-of", timeoutMs: 30_000, env: { LOOM_THREAD_ID: "thr_w1", LOOM_PROJECT_SLUG: "csv" } }]);
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 52_000, usage_json: mark(900, 10, 900) });
  });

  it("is never added to bb's events: a later event the command already counted leaves the figure as it is", async () => {
    const { project, row } = await started();
    h.bb.usage.set("thr_w1", reading(10, 900, 300));
    h.host.execResults.push({ output: "52000" });
    await refresh(project.id);
    h.bb.usage.set("thr_w1", reading(20, 52_000, 400));
    h.host.execResults.push({ output: "" });
    h.clock.advance(61_000);
    await refresh(project.id);
    expect(h.store.thread(row.id)!.tokens).toBe(52_000);
  });

  it("waits 10 minutes after the command fails on a machine, and bb's events count meanwhile", async () => {
    const { project, row } = await started();
    h.bb.usage.set("thr_w1", reading(10, 900, 300));
    h.host.execResults.push({ exitCode: 2, output: "no such command" });
    await refresh(project.id);
    expect(h.store.thread(row.id)!.tokens).toBe(900);
    h.clock.advance(61_000);
    await refresh(project.id);
    expect(execs()).toHaveLength(1);
    h.clock.advance(USAGE_COMMAND_HOLD_MS);
    h.host.execResults.push({ output: "not a number" });
    await refresh(project.id);
    expect(execs()).toHaveLength(2);
    expect(h.bb.callsTo("log").map(([, text]) => text)).toContain("The usage command failed for thr_w1, so Loom runs it on host_1 again in 10 minutes: it printed no whole number: not a number");
  });

  it("waits out a failure only on the machine where the command failed", async () => {
    const { project, row } = await started();
    h.host.execResults.push({ exitCode: 1 });
    await refresh(project.id);
    h.db.prepare("UPDATE projects SET host_id = 'host_2' WHERE id = ?").run(row.project_id);
    h.host.execResults.push({ output: "7000" });
    h.clock.advance(61_000);
    await refresh(project.id);
    expect(h.host.calls.filter((call) => call.method === "exec").map((call) => call.hostId)).toEqual(["host_1", "host_2"]);
    expect(h.store.thread(row.id)!.tokens).toBe(7000);
  });

  it("settles an ended thread only once the command answered, reading it again after a failure", async () => {
    const { project } = await started();
    const row = h.store.addThread({ project_id: project.id, role: "reviewer", state: "active", thread_id: "thr_r9" });
    h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.now() });
    h.bb.usage.set("thr_r9", reading(4, 400, 100));
    h.host.execResults.push(new Error("machine did not answer"));
    h.clock.advance(SETTLE_MS);
    await readEndedUsage(h.ctx);
    await usageCommandsDone(h.ctx);
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 400, tokens_at: null });
    h.clock.advance(USAGE_COMMAND_HOLD_MS);
    h.host.execResults.push({ output: "6100" });
    await readEndedUsage(h.ctx);
    await usageCommandsDone(h.ctx);
    expect(h.store.thread(row.id)).toMatchObject({ tokens: 6100, tokens_at: h.clock.now() });
  });

  it("runs nothing when the setting is empty", async () => {
    const { project } = await started();
    h.ctx.usageCommand = () => "";
    await refresh(project.id);
    expect(execs()).toEqual([]);
  });
});

describe("the usage_json migration", () => {
  it("starts each sum from the figure a row had, and has every ended thread read again", () => {
    const db = new Database(":memory:");
    const at = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN usage_json"));
    for (const sql of MIGRATIONS.slice(0, at)) db.exec(sql);
    db.exec("INSERT INTO projects (slug, name, key, bb_project_id, state, created_at, updated_at) VALUES ('lane', 'Lane', 'LANE', 'proj_1', 'paused', 1, 1)");
    const add = db.prepare("INSERT INTO threads (thread_id, project_id, role, state, tokens, tokens_at, started_at, ended_at) VALUES (?, 1, 'worker', ?, ?, ?, 1, ?)");
    add.run("thr_a", "ended", 4000, 50, 40);
    add.run("thr_b", "ended", null, 50, 40);
    add.run("thr_c", "active", 900, 70, null);
    for (const sql of MIGRATIONS.slice(at)) db.exec(sql);
    expect(db.prepare("SELECT thread_id, tokens, tokens_at, usage_json FROM threads ORDER BY thread_id").all()).toEqual([
      { thread_id: "thr_a", tokens: 4000, tokens_at: null, usage_json: '{"sum":4000}' },
      { thread_id: "thr_b", tokens: null, tokens_at: null, usage_json: null },
      { thread_id: "thr_c", tokens: 900, tokens_at: 70, usage_json: '{"sum":900}' },
    ]);
  });
});
