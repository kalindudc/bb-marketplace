// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { PRESERVE_MESSAGE, preserveMemberWork, preserveWorktree, worktreeState } from "../../src/server/member-worktree";
import { linkedWorktree } from "../scope/git-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-member-work-")); roots.push(root);
  const { main, worktree, git } = linkedWorktree(root);
  const read = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
  return { root, main, worktree, git, subject: () => read("log", "-1", "--format=%s"), head: () => read("rev-parse", "HEAD"), porcelain: () => read("status", "--porcelain"), lock: () => resolve(worktree, read("rev-parse", "--git-path", "index.lock")) };
}

function fakeBb(environment: Record<string, unknown> | null) {
  return { sdk: {
    threads: { get: async () => ({ id: "member", environmentId: environment === null ? null : "env" }) },
    environments: { get: async () => environment },
    system: { config: async () => ({ primaryHostId: "host" }) },
  } } as unknown as Pick<BbPluginApi, "sdk">;
}

describe("member worktree preservation", () => {
  it("reports a clean worktree and commits nothing", async () => {
    const f = fixture();
    const before = f.head();
    expect(await worktreeState(f.worktree)).toMatchObject({ dirty: false, changed: [], unfinishedMerge: false });
    expect(await preserveWorktree(f.worktree)).toEqual({ status: "clean", root: f.worktree });
    expect(f.head()).toBe(before);
    expect(f.subject()).toBe("fixture");
  });

  it("commits a tracked edit and a new file with the named message, and keeps their contents", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "tracked.txt"), "changed\n");
    f.git(f.worktree, "add", "tracked.txt"); f.git(f.worktree, "commit", "-qm", "seed the tracked file");
    writeFileSync(join(f.worktree, "tracked.txt"), "changed again\n");
    writeFileSync(join(f.worktree, "notes.txt"), "uncommitted member work\n");

    const state = await worktreeState(f.worktree);
    expect(state.dirty).toBe(true);
    expect(state.changed.sort()).toEqual(["notes.txt", "tracked.txt"]);

    const preserved = await preserveWorktree(f.worktree);
    expect(preserved).toMatchObject({ status: "committed", changed: expect.arrayContaining(["notes.txt", "tracked.txt"]) });
    expect(preserved.status === "committed" && preserved.sha).toBe(f.head());
    expect(f.subject()).toBe(PRESERVE_MESSAGE);
    expect(f.porcelain()).toBe("");
    expect(readFileSync(join(f.worktree, "notes.txt"), "utf8")).toBe("uncommitted member work\n");
    expect(readFileSync(join(f.worktree, "tracked.txt"), "utf8")).toBe("changed again\n");
  });

  it("defers an unfinished merge instead of committing its conflict markers", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "shared.txt"), "base\n"); f.git(f.worktree, "add", "shared.txt"); f.git(f.worktree, "commit", "-qm", "base");
    f.git(f.worktree, "branch", "other");
    writeFileSync(join(f.worktree, "shared.txt"), "topic\n"); f.git(f.worktree, "add", "shared.txt"); f.git(f.worktree, "commit", "-qm", "topic side");
    f.git(f.worktree, "checkout", "-q", "other"); writeFileSync(join(f.worktree, "shared.txt"), "other\n"); f.git(f.worktree, "add", "shared.txt"); f.git(f.worktree, "commit", "-qm", "other side");
    f.git(f.worktree, "checkout", "-q", "topic"); expect(() => f.git(f.worktree, "merge", "other")).toThrow();
    expect((await worktreeState(f.worktree)).unfinishedMerge).toBe(true);

    const preserved = await preserveWorktree(f.worktree);
    expect(preserved).toMatchObject({ status: "deferred", error: expect.stringContaining("unfinished merge") });
    expect(readFileSync(join(f.worktree, "shared.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("defers and keeps every file when the commit cannot be made", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "notes.txt"), "uncommitted member work\n");
    writeFileSync(f.lock(), "");

    const preserved = await preserveWorktree(f.worktree);
    expect(preserved).toMatchObject({ status: "deferred", error: expect.stringContaining("cannot commit") });
    expect(f.porcelain()).toContain("notes.txt");
    expect(readFileSync(join(f.worktree, "notes.txt"), "utf8")).toBe("uncommitted member work\n");
    expect(f.subject()).toBe("fixture");
  });

  it("defers rather than discarding work when a populated checkout cannot be read", async () => {
    const f = fixture();
    const plain = join(f.root, "not-a-repository");
    mkdirSync(plain); writeFileSync(join(plain, "notes.txt"), "work Tavern cannot classify\n");
    expect(await preserveWorktree(plain)).toMatchObject({ status: "deferred", error: expect.stringContaining("cannot read the member worktree") });
    expect(readFileSync(join(plain, "notes.txt"), "utf8")).toBe("work Tavern cannot classify\n");
  });

  it("treats a missing or empty checkout as nothing to preserve", async () => {
    const f = fixture();
    const empty = join(f.root, "empty");
    mkdirSync(empty);
    expect(await preserveWorktree(empty)).toEqual({ status: "none" });
    expect(await preserveWorktree(join(f.root, "gone"))).toEqual({ status: "none" });
  });

  it("serializes preservation of the same worktree across overlapping cleanups", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "notes.txt"), "uncommitted member work\n");

    const [first, second] = await Promise.all([preserveWorktree(f.worktree), preserveWorktree(f.worktree)]);

    expect(first).toMatchObject({ status: "committed", sha: f.head(), changed: ["notes.txt"] });
    expect(second).toEqual({ status: "clean", root: f.worktree });
    expect(f.porcelain()).toBe("");
  });

  it("preserves a member on this server and skips one whose worktree is elsewhere", async () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "notes.txt"), "uncommitted member work\n");

    expect(await preserveMemberWork(fakeBb(null), "member")).toEqual({ status: "none" });
    expect(await preserveMemberWork(fakeBb({ id: "env", hostId: "elsewhere", path: f.worktree, isWorktree: true }), "member")).toEqual({ status: "none" });
    expect(await preserveMemberWork(fakeBb({ id: "env", hostId: "host", path: f.worktree, isWorktree: false }), "member")).toEqual({ status: "none" });

    const preserved = await preserveMemberWork(fakeBb({ id: "env", hostId: "host", path: f.worktree, isWorktree: true }), "member");
    expect(preserved).toMatchObject({ status: "committed" });
    expect(f.subject()).toBe(PRESERVE_MESSAGE);
  });
});
