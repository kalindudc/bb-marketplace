// A carry never takes a worker's work: one that fails leaves the worktree as it is and names what it wrote; it commits
// only its own paths, through an index of its own; it stops when a path it would change is not as it left it; and a carry
// cut short is recognized and taken over when it starts again. Each case below lost a worker's edit in a review.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { chmodSync, lstatSync, readdirSync, renameSync, symlinkSync, utimesSync } from "node:fs";
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

const start = (w: ReturnType<typeof worker>, tree = "a".repeat(40)) => carryStart({ worktree: w.worktree, remote: "origin", baseBranch: "main", base: w.base, tree, replaces: w.tree });
const put = (w: ReturnType<typeof worker>, path: string, data: string, offset = 0, mode: "100644" | "100755" | "120000" = "100644") => carryWrite({ worktree: w.worktree, path, mode, offset, data: b64(data) });
const abort = (w: ReturnType<typeof worker>) => carryAbort({ worktree: w.worktree, base: w.base, restore: w.head });
const finish = (w: ReturnType<typeof worker>, tree: string, paths: string[]) => carryFinish({ worktree: w.worktree, base: w.base, message: "Carried", author: AUTHOR, tree, paths });
const indexOf = (w: ReturnType<typeof worker>, path: string) => {
  try {
    return sh(w.worktree, "show", `:${path}`);
  } catch {
    return null;
  }
};
/** The tree the base has with `files` written over it, as a carry of them would leave it. */
function treeWith(w: ReturnType<typeof worker>, files: Record<string, string | null>, exec: string[] = []): string {
  const index = join(scratch, `want-index-${counter++}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["-C", w.worktree, "read-tree", w.base], { env });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) execFileSync("git", ["-C", w.worktree, "rm", "-q", "--cached", "--", path], { env });
    else {
      const blob = execFileSync("git", ["-C", w.worktree, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
      execFileSync("git", ["-C", w.worktree, "update-index", "--add", "--cacheinfo", `${exec.includes(path) ? "100755" : "100644"},${blob},${path}`], { env });
    }
  }
  return execFileSync("git", ["-C", w.worktree, "write-tree"], { env, encoding: "utf8" }).trim();
}

describe("a carry that fails", () => {
  it("leaves the worktree as it is, the carry's files and the worker's, and names what each path the carry wrote holds", async () => {
    const w = worker();
    expect(await start(w)).toEqual({ outcome: "ok", present: false, from: w.head });
    await put(w, "README.md", "<<<<<<< ours\n");
    await put(w, "merged.ts", "merged\n");
    await carryDelete({ worktree: w.worktree, paths: ["notes.md"] });
    writeFileSync(join(w.worktree, "mine.ts"), "my work\n");
    writeFileSync(join(w.worktree, "merged.ts"), "the worker's edit\n");
    const before = sh(w.worktree, "status", "--porcelain", "--untracked-files=all");

    const aborted = await abort(w);
    expect(aborted.carried).toEqual([
      { path: "README.md", holds: "carry" },
      { path: "merged.ts", holds: "changed" },
      { path: "notes.md", holds: "absent" },
    ]);
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.base);
    expect([read(w.worktree, "README.md"), read(w.worktree, "merged.ts"), read(w.worktree, "mine.ts")]).toEqual(["<<<<<<< ours\n", "the worker's edit\n", "my work\n"]);
  });

  it("keeps its temporary files out of the worktree, and removes only those still holding what it wrote", async () => {
    const w = worker();
    await start(w);
    carryFaults.beforeRename = () => {
      throw new Error("cut short");
    };
    await expect(put(w, "half.ts", "carry\n")).rejects.toThrow("cut short");
    delete carryFaults.beforeRename;
    expect(readdirSync(w.worktree).filter((name) => name.startsWith(".loom-carry"))).toEqual([]);
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect((await abort(w)).carried).toEqual([{ path: "half.ts", holds: "absent" }]);
  });
});

describe("a carry's writes and deletes", () => {
  it("stops at a range whose file the worker changed, even to the same size and time, and keeps the worker's edit", async () => {
    const w = worker();
    await start(w);
    await put(w, "abc.ts", "ABC");
    const file = join(w.worktree, "abc.ts");
    const { atime, mtime } = lstatSync(file);
    writeFileSync(file, "XYZ");
    utimesSync(file, atime, mtime);
    await expect(put(w, "abc.ts", "DEF", 3)).rejects.toThrow("abc.ts is not as the carry left it");
    expect(read(w.worktree, "abc.ts")).toBe("XYZ");
  });

  it("stops at a file the worker made executable, and at one it edited after the carry started", async () => {
    const w = worker();
    await start(w);
    await put(w, "run.sh", "echo\n");
    chmodSync(join(w.worktree, "run.sh"), 0o755);
    await expect(put(w, "run.sh", "echo 2\n")).rejects.toThrow("run.sh is not as the carry left it");
    chmodSync(join(w.worktree, "README.md"), 0o755);
    await expect(put(w, "README.md", "carried\n")).rejects.toThrow("README.md is not as the carry started it");
    writeFileSync(join(w.worktree, "notes.md"), "the worker's notes\n");
    await expect(carryDelete({ worktree: w.worktree, paths: ["notes.md"] })).rejects.toThrow("notes.md is not as the carry started it");
    expect(read(w.worktree, "notes.md")).toBe("the worker's notes\n");
    expect(lstatSync(join(w.worktree, "README.md")).mode & 0o777).toBe(0o755);
  });

  it("does not overwrite a file the worker wrote while the carry's temporary file was going in", async () => {
    const w = worker();
    await start(w);
    carryFaults.beforeRename = () => writeFileSync(join(w.worktree, "README.md"), "worker during rename\n");
    try {
      await expect(put(w, "README.md", "carry\n")).rejects.toThrow("README.md is not as the carry started it");
    } finally {
      delete carryFaults.beforeRename;
    }
    expect(read(w.worktree, "README.md")).toBe("worker during rename\n");
  });

  it("never writes, deletes or judges through a parent directory that is a symlink now", async () => {
    const w = worker();
    await start(w);
    await put(w, "dir/carried.ts", "carry\n");
    const outside = join(scratch, `outside-${counter++}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "carried.ts"), "carry\n");
    renameSync(join(w.worktree, "dir"), join(w.worktree, "worker-saved-dir"));
    symlinkSync(outside, join(w.worktree, "dir"));
    await expect(put(w, "dir/carried.ts", "more", 6)).rejects.toThrow(/dir\/carried\.ts (is reached through a symlink|leads out of the worktree)/u);
    await expect(carryDelete({ worktree: w.worktree, paths: ["dir/carried.ts"] })).rejects.toThrow(/is reached through a symlink|leads out of the worktree/u);
    // A symlink that stays inside the worktree is refused by the carry's own check.
    const inside = join(w.worktree, "inside");
    mkdirSync(inside);
    writeFileSync(join(inside, "carried.ts"), "carry\n");
    rmSync(join(w.worktree, "dir"));
    symlinkSync(inside, join(w.worktree, "dir"));
    await expect(put(w, "dir/carried.ts", "more", 6)).rejects.toThrow("dir/carried.ts is reached through a symlink");
    expect((await abort(w)).carried).toEqual([{ path: "dir/carried.ts", holds: "changed" }]);
    expect([read(outside, "carried.ts"), read(inside, "carried.ts")]).toEqual(["carry\n", "carry\n"]);
    expect(read(w.worktree, "worker-saved-dir/carried.ts")).toBe("carry\n");
  });
});

describe("a carry that finishes", () => {
  it("commits its own paths through an index of its own, leaving the worker's staged and unstaged versions as they were", async () => {
    const w = worker();
    await start(w);
    await put(w, "README.md", "carried\n");
    await carryDelete({ worktree: w.worktree, paths: ["notes.md"] });
    writeFileSync(join(w.worktree, "mine.ts"), "staged unique\n");
    sh(w.worktree, "add", "mine.ts");
    writeFileSync(join(w.worktree, "mine.ts"), "working newer\n");
    const want = treeWith(w, { "README.md": "carried\n", "notes.md": null });
    const done = await finish(w, want, ["README.md"]);
    expect(done).toMatchObject({ outcome: "ok", tree: want });
    expect(sh(w.worktree, "rev-parse", "HEAD^{tree}")).toBe(want);
    expect([indexOf(w, "mine.ts"), read(w.worktree, "mine.ts")]).toEqual(["staged unique", "working newer\n"]);
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("AM mine.ts");
  });

  it("refuses, touching no index, when the worker staged a version of a carry path, or recreated one it deleted", async () => {
    const w = worker();
    await start(w);
    await put(w, "carry.ts", "carry\n");
    writeFileSync(join(w.worktree, "carry.ts"), "worker staged unique\n");
    sh(w.worktree, "add", "carry.ts");
    writeFileSync(join(w.worktree, "carry.ts"), "worker unstaged newer\n");
    expect(await finish(w, treeWith(w, { "carry.ts": "carry\n" }), ["carry.ts"])).toEqual({ outcome: "foreign", paths: ["carry.ts"] });
    expect([indexOf(w, "carry.ts"), read(w.worktree, "carry.ts"), sh(w.worktree, "rev-parse", "HEAD")]).toEqual(["worker staged unique", "worker unstaged newer\n", w.base]);
    await abort(w);
    expect(indexOf(w, "carry.ts")).toBe("worker staged unique");

    const v = worker();
    await start(v);
    await carryDelete({ worktree: v.worktree, paths: ["notes.md"] });
    writeFileSync(join(v.worktree, "notes.md"), "worker recreated\n");
    sh(v.worktree, "add", "notes.md");
    expect(await finish(v, treeWith(v, { "notes.md": null }), [])).toEqual({ outcome: "foreign", paths: ["notes.md"] });
    expect(indexOf(v, "notes.md")).toBe("worker recreated");
  });

  it("refuses a file the worker made executable, and returns a mismatch with nothing committed", async () => {
    const w = worker();
    await start(w);
    await put(w, "run.sh", "echo\n");
    chmodSync(join(w.worktree, "run.sh"), 0o755);
    expect(await finish(w, treeWith(w, { "run.sh": "echo\n" }), ["run.sh"])).toEqual({ outcome: "foreign", paths: ["run.sh"] });
    chmodSync(join(w.worktree, "run.sh"), 0o644);
    expect(await finish(w, "b".repeat(40), ["run.sh"])).toMatchObject({ outcome: "mismatch" });
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.base);
    expect(indexOf(w, "run.sh")).toBeNull();
  });

  it("never commits a file the worker stages while the commit is being made", async () => {
    const w = worker();
    await start(w);
    await put(w, "carry.ts", "carry\n");
    const want = treeWith(w, { "carry.ts": "carry\n" });
    carryFaults.beforeCommit = () => {
      writeFileSync(join(w.worktree, "late.ts"), "worker late staged\n");
      sh(w.worktree, "add", "late.ts");
    };
    try {
      expect(await finish(w, want, ["carry.ts"])).toMatchObject({ outcome: "ok", tree: want });
    } finally {
      delete carryFaults.beforeCommit;
    }
    expect(sh(w.worktree, "ls-tree", "--name-only", "HEAD")).not.toContain("late.ts");
    expect(indexOf(w, "late.ts")).toBe("worker late staged");
  });
});

describe("a carry that starts again after one was cut short", () => {
  it("refuses, touching nothing, when the worktree has changes the carry did not make", async () => {
    const w = worker();
    await start(w);
    await put(w, "merged.ts", "merged\n");
    writeFileSync(join(w.worktree, "mine.ts"), "my work\n");
    expect(await start(w)).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("mine.ts") });
    expect([read(w.worktree, "mine.ts"), read(w.worktree, "merged.ts")]).toEqual(["my work\n", "merged\n"]);
  });

  it("takes over a carry cut short before or after its file went in, or after a failed carry left its files", async () => {
    for (const point of ["beforeRename", "afterRename", "abort"] as const) {
      const w = worker();
      await start(w);
      await put(w, "half.ts", "first ");
      if (point === "abort") await abort(w);
      else {
        carryFaults[point] = () => {
          throw new Error(`crashed ${point}`);
        };
        try {
          await expect(put(w, "half.ts", "second", 6)).rejects.toThrow(`crashed ${point}`);
        } finally {
          delete carryFaults[point];
        }
      }
      expect(await start(w)).toEqual({ outcome: "ok", present: false, from: w.head });
      expect(read(w.worktree, "half.ts")).toBeNull();
      expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }
  });

  it("recognizes the carry's own commit when it was cut short right after the commit, the first of a stacked carry too", async () => {
    const w = worker();
    await start(w);
    await put(w, "carry.ts", "first step\n");
    const first = treeWith(w, { "carry.ts": "first step\n" });
    carryFaults.afterCommit = () => {
      throw new Error("crashed after the commit");
    };
    try {
      await expect(finish(w, first, ["carry.ts"])).rejects.toThrow("crashed after the commit");
    } finally {
      delete carryFaults.afterCommit;
    }
    expect(sh(w.worktree, "rev-parse", "HEAD^{tree}")).toBe(first);
    expect(await start(w)).toEqual({ outcome: "ok", present: false, from: w.head });
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.base);
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});
