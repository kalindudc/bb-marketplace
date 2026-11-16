// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESERVE_MESSAGE } from "../../src/server/member-worktree";
import { registerTools } from "../../src/server/tools";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { linkedWorktree } from "../scope/git-fixture";

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
  f.k.store.put("quests", q.id, { ...q, phase, endedAt: phase === "done" ? f.time() : null });
  f.k.bind("child", "smith", "bram", "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Private work", displayName: "Bram",
    brief: { outcome: "Draft", mode: "make-it-work", doneWhen: "Tests pass", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null },
  });
  return { ...f, q, threads, archive };
}

describe("member work preservation before cleanup", () => {
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
    expect(f.runtime.keeper.store.runtime("child").archiveError).toMatch(/worktree/);
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
