// @vitest-environment node
import { ChildProcess } from "node:child_process";
import { runtimeFixture } from "./member-fixture";
import { putQuestFixture } from "./support";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gitRunner from "../../src/server/exec-git";
import { PRESERVE_MESSAGE } from "../../src/server/member-worktree";
import { registerTools } from "../../src/server/tools";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { linkedWorktree } from "../scope/git-fixture";

const launches = vi.hoisted(() => ({ sync: 0, git: 0 }));
vi.mock(import("node:child_process"), async importOriginal => {
  const actual = await importOriginal();
  function countSync(file?: string, args?: unknown) {
    launches.sync++;
    countGit(file, args);
  }
  return {
    ...actual,
    execFileSync: (...args: [string, ...unknown[]]) => {
      countSync(args[0], args[1]);
      return Reflect.apply(actual.execFileSync, undefined, args);
    },
    spawnSync: (...args: [string, ...unknown[]]) => {
      countSync(args[0], args[1]);
      return Reflect.apply(actual.spawnSync, undefined, args);
    },
    execSync: (...args: unknown[]) => {
      countSync();
      return Reflect.apply(actual.execSync, undefined, args);
    },
  };
});

function countGit(file: string | undefined, args: unknown) {
  if (file === "git" || file === "/usr/bin/sandbox-exec" && Array.isArray(args) && args[0] === "-p" && args[2] === "git") launches.git++;
}

async function countLaunches(run: () => Promise<unknown>) {
  const prototype = ChildProcess.prototype as ChildProcess & { spawn(options: { file: string; args: string[] }): number };
  const spawn = prototype.spawn;
  const spy = vi.spyOn(prototype, "spawn").mockImplementation(function (this: ChildProcess, options) {
    countGit(options.file, options.args.slice(1));
    return spawn.call(this, options);
  });
  launches.sync = launches.git = 0;
  try {
    await run();
    return { ...launches };
  } finally {
    spy.mockRestore();
  }
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch() { const root = mkdtempSync(join(tmpdir(), "tavern-preserve-")); roots.push(root); return root; }

async function fixture(path: string, phase: "done" | "build" = "done") {
  const threads = new Map(["lead", "child"].map(id => [id, makeThreadResponse({ id, environmentId: "env" })]));
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => {
    threads.set(threadId, { ...threads.get(threadId)!, archivedAt: 2_000_000 });
    return { ok: true };
  });
  const f = setup({
    threads: { get: async ({ threadId }: { threadId: string }) => threads.get(threadId)!, archive },
    environments: { get: async () => ({ id: "env", hostId: "host", path, isWorktree: true }) },
  });
  const q = await seedQuest(f.k, "lead", "Private work", "Private work");
  putQuestFixture(f.k.store, q.id, { ...q, phase, endedAt: phase === "done" ? f.time() : null });
  f.k.bind("child", "smith", "bram", "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Private work", displayName: "Bram",
    brief: { outcome: "Draft", mode: "make-it-work", doneWhen: "Tests pass", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null },
  });
  return { ...f, q, threads, archive };
}

describe("member work preservation before cleanup", () => {
  it.each(["clean", "dirty"])("does not block on child processes for a %s member report or cleanup", async state => {
    const { worktree } = linkedWorktree(scratch());
    const report = await fixture(worktree, "build");
    const cleanup = await fixture(worktree);
    registerTools(report.bb, report.runtime);
    if (state === "dirty") writeFileSync(join(worktree, "notes.txt"), "uncommitted member work\n");

    const reportCounts = await countLaunches(async () => {
      const result = await report.harness.behavior.invokeAgentTool("tavern_report",
        { status: "done", outcome: "Did the work.", evidence: [], artifacts: [] }, { threadId: "child" });
      expect(String(result).includes("1 uncommitted file(s)")).toBe(state === "dirty");
    });
    const cleanupCounts = await countLaunches(async () => {
      const result = await cleanup.runtime.archiveBoardQuests([cleanup.q.id], true);
      expect(result.changed).toBe(1);
      expect(result.pendingArchives).toEqual([]);
      expect(cleanup.archive).toHaveBeenCalledWith({ threadId: "child" });
    });
    console.info(`G2 ${state}: ${JSON.stringify({ report: reportCounts, cleanup: cleanupCounts })}`);
    expect(reportCounts.sync).toBe(0);
    expect(cleanupCounts.sync).toBe(0);
    expect(reportCounts.git).toBeGreaterThan(0);
    expect(reportCounts.git).toBeLessThanOrEqual(10);
    expect(cleanupCounts.git).toBeGreaterThan(0);
    expect(cleanupCounts.git).toBeLessThanOrEqual(state === "dirty" ? 44 : 20);
  });

  it.each([false, true])("records a report's warning before overlapping preservation (aliased checkout: %s)", async aliased => {
    const root = scratch(), { worktree } = linkedWorktree(root);
    const cleanupPath = aliased ? join(root, "alias") : worktree;
    if (aliased) symlinkSync(worktree, cleanupPath, "dir");
    const f = await fixture(worktree, "build");
    registerTools(f.bb, f.runtime);
    writeFileSync(join(worktree, "notes.txt"), "uncommitted member work\n");

    let reachedReportRead!: () => void, releaseReport!: () => void, resolvedCleanupPath!: () => void;
    const reportRead = new Promise<void>(resolve => { reachedReportRead = resolve; });
    const reportHeld = new Promise<void>(resolve => { releaseReport = resolve; });
    const cleanupPathResolved = new Promise<void>(resolve => { resolvedCleanupPath = resolve; });
    let reportBlocked = false, cleanupReadStarted = false;
    const execGit = gitRunner.execGit;
    const git = vi.spyOn(gitRunner, "execGit").mockImplementation(async (...args) => {
      if (!reportBlocked && args[1][0] === "symbolic-ref") {
        reportBlocked = true;
        reachedReportRead();
        await reportHeld;
      } else if (reportBlocked && args[1][0] === "status") {
        cleanupReadStarted = true;
      }
      return execGit(...args);
    });
    try {
      const report = f.harness.behavior.invokeAgentTool("tavern_report",
        { status: "done", outcome: "Did the work.", evidence: [], artifacts: [] }, { threadId: "child" });
      await reportRead;
      const environment = await f.bb.sdk.environments.get({ environmentId: "env" });
      const config = await f.bb.sdk.system.config();
      vi.spyOn(f.bb.sdk.environments, "get").mockResolvedValueOnce({ ...environment!, path: cleanupPath });
      vi.spyOn(f.bb.sdk.system, "config").mockImplementationOnce(async () => {
        resolvedCleanupPath();
        return config;
      });

      const cleanup = f.runtime.preserveWorkOrRefuse("child");
      await cleanupPathResolved;
      await setImmediate();
      // If cleanup was not queued behind the held report, let it finish first to expose the inverted history.
      if (cleanupReadStarted) await cleanup;
      releaseReport();
      const [reply, result] = await Promise.all([report, cleanup]);

      expect(String(reply)).toContain("1 uncommitted file(s)");
      expect(result).toBeNull();
      expect(f.k.store.events("lead").map(event => event.type).filter(type => type.startsWith("member.work-")))
        .toEqual(["member.work-uncommitted", "member.work-preserved"]);
    } finally {
      releaseReport();
      git.mockRestore();
    }
  });

  it("commits a member's uncommitted work before its worktree is archived", async () => {
    const root = scratch(), { worktree, git } = linkedWorktree(root);
    const f = await fixture(worktree);
    writeFileSync(join(worktree, "notes.txt"), "uncommitted member work\n");
    const before = git(worktree, "rev-parse", "HEAD").trim();

    const result = await f.runtime.archiveBoardQuests([f.q.id], true);

    expect(result.changed).toBe(1);
    expect(result.pendingArchives).toEqual([]);
    expect(f.archive).toHaveBeenCalledWith({ threadId: "child" });
    expect(git(worktree, "rev-parse", "HEAD").trim()).not.toBe(before);
    expect(git(worktree, "log", "-1", "--format=%s").trim()).toBe(PRESERVE_MESSAGE);
    expect(git(worktree, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("uncommitted member work\n");
    const preserved = f.k.store.events("lead").filter(event => event.type === "member.work-preserved");
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.data).toMatchObject({ memberThreadId: "child", sha: git(worktree, "rev-parse", "HEAD").trim() });
  });

  it("defers cleanup and keeps every file when the member worktree cannot be preserved", async () => {
    const plain = join(scratch(), "not-a-repository");
    mkdirSync(plain);
    writeFileSync(join(plain, "notes.txt"), "uncommitted member work\n");
    const f = await fixture(plain);

    const result = await f.runtime.archiveBoardQuests([f.q.id], true);

    expect(f.archive).not.toHaveBeenCalled();
    expect(result.pendingArchives).toContain("child");
    expect(runtimeFixture(f.runtime.keeper.store, "child").archiveError).toMatch(/worktree/);
    expect(readFileSync(join(plain, "notes.txt"), "utf8")).toBe("uncommitted member work\n");
    expect(f.k.store.events("lead").some(event => event.type === "quest.archive-failed")).toBe(true);
    expect(f.k.store.events("lead").some(event => event.type === "member.work-preserved")).toBe(false);
  });

  it("warns a member that reports with uncommitted files, and stays quiet when the worktree is clean", async () => {
    const root = scratch(), { worktree } = linkedWorktree(root);
    const f = await fixture(worktree, "build"); registerTools(f.bb, f.runtime);
    const report = { status: "done" as const, outcome: "Did the work.", evidence: [], artifacts: [] };

    writeFileSync(join(worktree, "notes.txt"), "still uncommitted\n");
    const dirty = await f.harness.behavior.invokeAgentTool("tavern_report", report, { threadId: "child" });
    expect(String(dirty)).toContain("1 uncommitted file(s)");
    expect(String(dirty)).toContain("commit");
    const warned = f.k.store.events("lead").filter(event => event.type === "member.work-uncommitted");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.data).toMatchObject({ memberThreadId: "child", changed: ["notes.txt"] });

    rmSync(join(worktree, "notes.txt"));
    const clean = await f.harness.behavior.invokeAgentTool("tavern_report", report, { threadId: "child" });
    expect(String(clean)).not.toContain("uncommitted");
    expect(f.k.store.events("lead").filter(event => event.type === "member.work-uncommitted")).toHaveLength(1);
  });
});
