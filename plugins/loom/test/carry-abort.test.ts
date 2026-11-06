// A carry that fails part-way puts the worktree back at the HEAD it had, with nothing uncommitted: LANE-16's worktree was
// left with thousands of modified files, which Loom then refused as work it had not seen.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { utimesSync } from "node:fs";
import { carryAbort, carryDelete, carryFaults, carryFinish, carryStart, carryWrite } from "../src/host/ops";

vi.setConfig({ testTimeout: 30_000 });

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loom-carry-abort-"));
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let counter = 0;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const AUTHOR = { name: "Dev", email: "dev@example.com", date: "1700000000 +0000" };

/** A worker's worktree on the base, with its approved work as one commit: rows.ts added, README.md changed. */
function worker() {
  const root = join(scratch, `case-${counter++}`);
  const origin = join(root, "origin.git");
  const worktree = join(root, "worker");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(worktree);
  sh(worktree, "init", "-q", "-b", "main");
  sh(worktree, "config", "user.email", "dev@example.com");
  sh(worktree, "config", "user.name", "Dev");
  writeFileSync(join(worktree, "README.md"), "hello\n");
  writeFileSync(join(worktree, "notes.md"), "notes\n");
  sh(worktree, "add", "-A");
  sh(worktree, "commit", "-q", "-m", "init");
  sh(worktree, "remote", "add", "origin", origin);
  sh(worktree, "push", "-q", "origin", "main");
  sh(worktree, "fetch", "-q", "origin");
  const base = sh(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "rows.ts"), "export const rows = 1;\n");
  writeFileSync(join(worktree, "README.md"), "hello, rows\n");
  sh(worktree, "add", "-A");
  sh(worktree, "commit", "-q", "-m", "Order rows");
  return { worktree, base, head: sh(worktree, "rev-parse", "HEAD"), tree: sh(worktree, "rev-parse", "HEAD^{tree}") };
}
const read = (worktree: string, path: string) => (existsSync(join(worktree, path)) ? readFileSync(join(worktree, path), "utf8") : null);

describe("a carry that fails", () => {
  it("puts back only what the carry changed, keeping what the worker changed meanwhile", async () => {
    const { worktree, base, head, tree } = worker();
    expect(await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree })).toEqual({ outcome: "ok", present: false, from: head });
    // The carry writes a changed file and a new one, and deletes one, before it fails.
    await carryWrite({ worktree, path: "README.md", mode: "100644", offset: 0, data: b64("<<<<<<< ours\n") });
    await carryWrite({ worktree, path: "merged.ts", mode: "100644", offset: 0, data: b64("merged\n") });
    await carryDelete({ worktree, paths: ["notes.md"] });
    // Meanwhile the worker creates a file of its own and edits one the carry never touched.
    writeFileSync(join(worktree, "mine.ts"), "my work\n");
    mkdirSync(join(worktree, "scratch"));
    writeFileSync(join(worktree, "scratch", "todo.md"), "todo\n");

    const aborted = await carryAbort({ worktree, base, restore: head });
    expect(aborted).toEqual({ clean: false, kept: ["mine.ts", "scratch/todo.md"] });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(head);
    expect([read(worktree, "README.md"), read(worktree, "rows.ts"), read(worktree, "notes.md"), read(worktree, "merged.ts")]).toEqual(["hello, rows\n", "export const rows = 1;\n", "notes\n", null]);
    expect([read(worktree, "mine.ts"), read(worktree, "scratch/todo.md")]).toEqual(["my work\n", "todo\n"]);
    expect(sh(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("?? mine.ts\n?? scratch/todo.md");
  });

  it("keeps a file the carry wrote once the worker changed it, and one the reset changed", async () => {
    const { worktree, base, head, tree } = worker();
    await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree });
    await carryWrite({ worktree, path: "merged.ts", mode: "100644", offset: 0, data: b64("merged\n") });
    writeFileSync(join(worktree, "merged.ts"), "merged, then the worker's edit\n");
    // README.md went back to the base's version in the reset; the worker edits it.
    writeFileSync(join(worktree, "README.md"), "hello, the worker\n");

    const aborted = await carryAbort({ worktree, base, restore: head });
    expect(aborted).toEqual({ clean: false, kept: ["README.md", "merged.ts"] });
    expect([read(worktree, "README.md"), read(worktree, "merged.ts"), read(worktree, "rows.ts")]).toEqual(["hello, the worker\n", "merged, then the worker's edit\n", "export const rows = 1;\n"]);
  });

  it("puts a partly written file back", async () => {
    const { worktree, base, head, tree } = worker();
    await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree });
    await carryWrite({ worktree, path: "README.md", mode: "100644", offset: 0, data: b64("first half ") });
    expect(await carryAbort({ worktree, base, restore: head })).toEqual({ clean: true, kept: [] });
    expect(read(worktree, "README.md")).toBe("hello, rows\n");
  });
});

describe("a carry that finishes", () => {
  it("commits only what it wrote and deleted, leaving what the worker changed meanwhile uncommitted", async () => {
    const { worktree, base, tree } = worker();
    const want = (() => {
      // The carried tree: the base with README.md changed and notes.md deleted.
      const root = join(scratch, `want-${counter++}`);
      execFileSync("git", ["clone", "-q", join(worktree, "..", "origin.git"), root]);
      writeFileSync(join(root, "README.md"), "carried\n");
      rmSync(join(root, "notes.md"));
      execFileSync("git", ["-C", root, "add", "-A"]);
      return execFileSync("git", ["-C", root, "write-tree"], { encoding: "utf8" }).trim();
    })();
    await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: want, replaces: tree });
    await carryWrite({ worktree, path: "README.md", mode: "100644", offset: 0, data: b64("carried\n") });
    await carryDelete({ worktree, paths: ["notes.md"] });
    writeFileSync(join(worktree, "mine.ts"), "my work\n");
    const done = await carryFinish({ worktree, base, message: "Carried", author: AUTHOR, tree: want, paths: ["README.md"] });
    expect(done).toMatchObject({ outcome: "ok", tree: want });
    expect(sh(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("?? mine.ts");
  });
});

describe("a carry that starts again after one was cut short", () => {
  it("refuses, touching nothing, when the worktree has changes the carry did not make", async () => {
    const { worktree, base, head, tree } = worker();
    await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree });
    await carryWrite({ worktree, path: "merged.ts", mode: "100644", offset: 0, data: b64("merged\n") });
    writeFileSync(join(worktree, "mine.ts"), "my work\n");
    const again = await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree });
    expect(again).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("mine.ts") });
    expect([read(worktree, "mine.ts"), read(worktree, "merged.ts")]).toEqual(["my work\n", "merged\n"]);
    // Without the worker's file, it starts again and still knows the HEAD to put back.
    rmSync(join(worktree, "mine.ts"));
    expect(await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree })).toEqual({ outcome: "ok", present: false, from: head });
    expect(read(worktree, "merged.ts")).toBeNull();
  });
});

// Tony's third review: these three left a worker's work committed and deleted, relabeled as the carry's, or stranded.
describe("a carry owns a path by its content, with a write-ahead log", () => {
  const start = async (worktree: string, base: string, tree: string) => carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: "a".repeat(40), replaces: tree });

  it("refuses to finish, committing nothing, when the worker staged a file of its own, and its abort keeps the file", async () => {
    const { worktree, base, head, tree } = worker();
    await start(worktree, base, tree);
    await carryWrite({ worktree, path: "merged.ts", mode: "100644", offset: 0, data: b64("merged\n") });
    writeFileSync(join(worktree, "staged.ts"), "the worker's staged file\n");
    sh(worktree, "add", "staged.ts");
    const done = await carryFinish({ worktree, base, message: "Carried", author: AUTHOR, tree: "a".repeat(40), paths: ["merged.ts"] });
    expect(done).toEqual({ outcome: "foreign", paths: ["staged.ts"] });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(base);
    const aborted = await carryAbort({ worktree, base, restore: head });
    expect(aborted.kept).toContain("staged.ts");
    expect(read(worktree, "staged.ts")).toBe("the worker's staged file\n");
    expect([read(worktree, "merged.ts"), read(worktree, "rows.ts")]).toEqual([null, "export const rows = 1;\n"]);
  });

  it("stops at a range whose file the worker changed, even to the same size and time, and keeps the worker's edit", async () => {
    const { worktree, base, head, tree } = worker();
    await start(worktree, base, tree);
    await carryWrite({ worktree, path: "abc.ts", mode: "100644", offset: 0, data: b64("ABC") });
    const file = join(worktree, "abc.ts");
    const { atime, mtime } = (await import("node:fs")).statSync(file);
    writeFileSync(file, "XYZ");
    utimesSync(file, atime, mtime);
    await expect(carryWrite({ worktree, path: "abc.ts", mode: "100644", offset: 3, data: b64("DEF") })).rejects.toThrow("abc.ts changed in the worktree since the carry wrote it");
    expect(read(worktree, "abc.ts")).toBe("XYZ");
    const aborted = await carryAbort({ worktree, base, restore: head });
    expect(aborted).toEqual({ clean: false, kept: ["abc.ts"] });
    expect(read(worktree, "abc.ts")).toBe("XYZ");
  });

  it("refuses to overwrite or delete a file the worker changed after the carry started", async () => {
    const { worktree, base, head, tree } = worker();
    await start(worktree, base, tree);
    writeFileSync(join(worktree, "README.md"), "the worker's readme\n");
    writeFileSync(join(worktree, "notes.md"), "the worker's notes\n");
    await expect(carryWrite({ worktree, path: "README.md", mode: "100644", offset: 0, data: b64("carried\n") })).rejects.toThrow("README.md changed in the worktree since the carry started");
    await expect(carryDelete({ worktree, paths: ["notes.md"] })).rejects.toThrow("notes.md changed in the worktree since the carry started");
    expect([read(worktree, "README.md"), read(worktree, "notes.md")]).toEqual(["the worker's readme\n", "the worker's notes\n"]);
    expect((await carryAbort({ worktree, base, restore: head })).kept).toEqual(["README.md", "notes.md"]);
  });

  it("recovers a range cut short before or after its file went in, with no manual cleanup", async () => {
    for (const point of ["beforeRename", "afterRename"] as const) {
      const { worktree, base, head, tree } = worker();
      await start(worktree, base, tree);
      await carryWrite({ worktree, path: "half.ts", mode: "100644", offset: 0, data: b64("first ") });
      carryFaults[point] = () => {
        throw new Error(`crashed ${point}`);
      };
      try {
        await expect(carryWrite({ worktree, path: "half.ts", mode: "100644", offset: 6, data: b64("second") })).rejects.toThrow(`crashed ${point}`);
      } finally {
        delete carryFaults[point];
      }
      expect(read(worktree, "half.ts")).toBe(point === "beforeRename" ? "first " : "first second");
      // A restart takes the carry back on its own and starts again; a temporary file it left is gone too.
      expect(await start(worktree, base, tree)).toEqual({ outcome: "ok", present: false, from: head });
      expect(read(worktree, "half.ts")).toBeNull();
      expect(sh(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(await carryAbort({ worktree, base, restore: head })).toEqual({ clean: true, kept: [] });
    }
  });
});
