// A carry never takes a worker's work: it starts only on a clean worktree with nothing ignored where it writes; one that
// fails leaves the worktree as it is and names what it wrote; it commits with git add and git commit only when the index
// still matches HEAD; it stops when a path it would change is not as it left it; and a carry cut short is recognized and
// taken over when it starts again. Each case below lost a worker's edit in a review. The worker's git here serves only
// what World's emulated git serves: a shim on PATH refuses its index and object plumbing, so none of it comes back.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { chmodSync, lstatSync, readdirSync, realpathSync, renameSync, symlinkSync, utimesSync } from "node:fs";
import { carryAbort, carryDelete, carryFaults, carryFinish, carryStart, carryWrite } from "../src/host/ops";

vi.setConfig({ testTimeout: 30_000 });

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
// The fixtures use the real git; Loom's host calls find the shim first on PATH.
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const sh = (cwd: string, ...args: string[]) => execFileSync(GIT, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let scratch: string;
let refusedLog: string;

/** World's emulated git: no index or object plumbing, no private index, update-ref only on refs/, no config writes. */
function porcelainOnlyGit(dir: string, log: string): void {
  mkdirSync(dir);
  const shim = `#!/bin/bash
sub=""; rest=()
args=("$@"); i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace) i=$((i+2));;
    -*) i=$((i+1));;
    *) sub="$a"; rest=("\${args[@]:$((i+1))}"); break;;
  esac
done
refuse() { echo "$*" >> ${JSON.stringify(log)}; echo "wt git: $sub is not served" >&2; exit 128; }
case "$sub" in
  read-tree|commit-tree|update-index|mktree|write-tree|hash-object) refuse "$sub";;
  update-ref) skip=0; for r in "\${rest[@]}"; do if [ $skip = 1 ]; then skip=0; continue; fi; case "$r" in -m) skip=1;; -*) ;; refs/*) break;; *) refuse "update-ref $r";; esac; done;;
  config) case "\${rest[0]}" in --get|--list|-l) ;; *) refuse "config \${rest[*]}";; esac;;
esac
if [ -n "$GIT_INDEX_FILE" ]; then refuse "GIT_INDEX_FILE $sub"; fi
exec ${JSON.stringify(GIT)} "$@"
`;
  writeFileSync(join(dir, "git"), shim);
  chmodSync(join(dir, "git"), 0o755);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loom-carry-abort-"));
  refusedLog = join(scratch, "refused.log");
  porcelainOnlyGit(join(scratch, "bin"), refusedLog);
  saved.PATH = process.env.PATH;
  process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH ?? ""}`;
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterEach(() => {
  const refused = existsSync(refusedLog) ? readFileSync(refusedLog, "utf8") : "";
  rmSync(refusedLog, { force: true });
  expect(refused, "the carry ran git that World's emulated git does not serve").toBe("");
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
  execFileSync(GIT, ["init", "-q", "--bare", "-b", "main", origin]);
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

const start = (w: ReturnType<typeof worker>, tree = "a".repeat(40), paths?: string[]) =>
  carryStart({ worktree: w.worktree, remote: "origin", baseBranch: "main", base: w.base, tree, replaces: w.tree, ...(paths === undefined ? {} : { paths }) });
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
  execFileSync(GIT, ["-C", w.worktree, "read-tree", w.base], { env });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) execFileSync(GIT, ["-C", w.worktree, "rm", "-q", "--cached", "--", path], { env });
    else {
      const blob = execFileSync(GIT, ["-C", w.worktree, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
      execFileSync(GIT, ["-C", w.worktree, "update-index", "--add", "--cacheinfo", `${exec.includes(path) ? "100755" : "100644"},${blob},${path}`], { env });
    }
  }
  return execFileSync(GIT, ["-C", w.worktree, "write-tree"], { env, encoding: "utf8" }).trim();
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

  it("refuses a rename across filesystems instead of writing in place, never following a leaf symlink", async () => {
    const w = worker();
    const outside = join(scratch, `outside-${counter++}`);
    writeFileSync(outside, "worker external unique\n");
    symlinkSync(outside, join(w.worktree, "link"));
    sh(w.worktree, "add", "link");
    sh(w.worktree, "commit", "-q", "-m", "link");
    const v = { ...w, head: sh(w.worktree, "rev-parse", "HEAD"), tree: sh(w.worktree, "rev-parse", "HEAD^{tree}") };
    const base = { ...v, base: v.head };
    await start(base);
    carryFaults.rename = () => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    };
    try {
      await expect(put(base, "link", "carry regular file\n")).rejects.toThrow("another filesystem");
    } finally {
      delete carryFaults.rename;
    }
    expect([readFileSync(outside, "utf8"), lstatSync(join(base.worktree, "link")).isSymbolicLink()]).toEqual(["worker external unique\n", true]);
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
  it("commits its paths with git add and git commit when the index still matches HEAD", async () => {
    const w = worker();
    await start(w);
    await put(w, "README.md", "carried\n");
    await put(w, "run.sh", "echo\n", 0, "100755");
    await carryDelete({ worktree: w.worktree, paths: ["notes.md"] });
    const want = treeWith(w, { "README.md": "carried\n", "run.sh": "echo\n", "notes.md": null }, ["run.sh"]);
    expect(await finish(w, want, ["README.md", "run.sh"])).toMatchObject({ outcome: "ok", tree: want });
    expect(sh(w.worktree, "rev-parse", "HEAD^{tree}")).toBe(want);
    expect(sh(w.worktree, "rev-parse", "HEAD^")).toBe(w.base);
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("refuses before it stages anything when the worker staged another path, keeping its staged and unstaged versions", async () => {
    const w = worker();
    await start(w);
    await put(w, "README.md", "carried\n");
    writeFileSync(join(w.worktree, "mine.ts"), "staged unique\n");
    sh(w.worktree, "add", "mine.ts");
    writeFileSync(join(w.worktree, "mine.ts"), "working newer\n");
    expect(await finish(w, treeWith(w, { "README.md": "carried\n" }), ["README.md"])).toEqual({ outcome: "foreign", paths: ["mine.ts"] });
    expect([indexOf(w, "mine.ts"), read(w.worktree, "mine.ts"), indexOf(w, "README.md"), sh(w.worktree, "rev-parse", "HEAD")]).toEqual(["staged unique", "working newer\n", "hello", w.base]);
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

  it("refuses a file the worker made executable; a tree that is not the one sent is a mismatch the next carry takes over", async () => {
    const w = worker();
    await start(w);
    await put(w, "run.sh", "echo\n");
    chmodSync(join(w.worktree, "run.sh"), 0o755);
    expect(await finish(w, treeWith(w, { "run.sh": "echo\n" }), ["run.sh"])).toEqual({ outcome: "foreign", paths: ["run.sh"] });
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.base);
    chmodSync(join(w.worktree, "run.sh"), 0o644);
    expect(await finish(w, "b".repeat(40), ["run.sh"])).toMatchObject({ outcome: "mismatch", tree: treeWith(w, { "run.sh": "echo\n" }) });
    expect(await start(w)).toEqual({ outcome: "ok", present: false, from: w.head });
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.base);
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("commits a file the worker stages during the commit with it, keeping it, and answers mismatch", async () => {
    const w = worker();
    await start(w);
    await put(w, "carry.ts", "carry\n");
    const want = treeWith(w, { "carry.ts": "carry\n" });
    carryFaults.beforeCommit = () => {
      writeFileSync(join(w.worktree, "late.ts"), "worker late staged\n");
      sh(w.worktree, "add", "late.ts");
    };
    try {
      expect(await finish(w, want, ["carry.ts"])).toMatchObject({ outcome: "mismatch" });
    } finally {
      delete carryFaults.beforeCommit;
    }
    expect([sh(w.worktree, "show", "HEAD:late.ts"), read(w.worktree, "late.ts")]).toEqual(["worker late staged", "worker late staged\n"]);
  });
});

describe("a carry that starts", () => {
  it("refuses, touching nothing, an ignored file where the carry will write", async () => {
    const w = worker();
    writeFileSync(join(w.worktree, ".gitignore"), "build.out\n");
    sh(w.worktree, "add", ".gitignore");
    sh(w.worktree, "commit", "-q", "-m", "ignore");
    const v = { ...w, head: sh(w.worktree, "rev-parse", "HEAD"), tree: sh(w.worktree, "rev-parse", "HEAD^{tree}") };
    writeFileSync(join(v.worktree, "build.out"), "worker ignored unique\n");
    const started = await start(v, "a".repeat(40), ["build.out", "src/new.ts"]);
    expect(started).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("build.out") });
    expect([read(v.worktree, "build.out"), sh(v.worktree, "rev-parse", "HEAD")]).toEqual(["worker ignored unique\n", v.head]);
  });

  it("refuses, touching nothing, an ignored file where the reset to the base would write", async () => {
    const w = worker();
    sh(w.worktree, "rm", "-q", "notes.md");
    writeFileSync(join(w.worktree, ".gitignore"), "/notes.md\n");
    sh(w.worktree, "add", ".gitignore");
    sh(w.worktree, "commit", "-q", "-m", "drop notes");
    const v = { ...w, head: sh(w.worktree, "rev-parse", "HEAD"), tree: sh(w.worktree, "rev-parse", "HEAD^{tree}") };
    writeFileSync(join(v.worktree, "notes.md"), "worker ignored unique\n");
    expect(sh(v.worktree, "status", "--porcelain")).toBe("");
    expect(await start(v, "a".repeat(40), ["src/new.ts"])).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("notes.md") });
    expect([read(v.worktree, "notes.md"), sh(v.worktree, "rev-parse", "HEAD")]).toEqual(["worker ignored unique\n", v.head]);
  });


  it("refuses up front when no private directory outside the worktree is on its filesystem", async () => {
    const w = worker();
    const own = realpathSync(w.worktree);
    carryFaults.deviceOf = (path) => (realpathSync(path) === own ? 1 : 2);
    try {
      expect(await start(w)).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("filesystem") });
    } finally {
      delete carryFaults.deviceOf;
    }
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.head);
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

  it("keeps the last whole mark when it is cut short while publishing the next one, so a restart still takes the carry over", async () => {
    const w = worker();
    await start(w);
    await put(w, "half.ts", "carry\n");
    carryFaults.beforeMarkRename = () => {
      throw new Error("crashed while publishing the mark");
    };
    try {
      await expect(finish(w, treeWith(w, { "half.ts": "carry\n" }), ["half.ts"])).rejects.toThrow("crashed while publishing the mark");
    } finally {
      delete carryFaults.beforeMarkRename;
    }
    expect(sh(w.worktree, "rev-parse", "HEAD")).toBe(w.base);
    expect(await start(w)).toEqual({ outcome: "ok", present: false, from: w.head });
    expect(read(w.worktree, "half.ts")).toBeNull();
    expect(sh(w.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("takes over a carry cut short after it journaled its commit but before HEAD moved, on a root base", async () => {
    const root = join(scratch, `root-${counter++}`);
    mkdirSync(root);
    sh(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.ts"), "a\n");
    sh(root, "add", "-A");
    sh(root, "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "-q", "-m", "root");
    sh(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const w = { worktree: root, base: sh(root, "rev-parse", "HEAD"), head: sh(root, "rev-parse", "HEAD"), tree: sh(root, "rev-parse", "HEAD^{tree}") };
    await start(w);
    await put(w, "half.ts", "carry\n");
    carryFaults.beforeCommit = () => {
      throw new Error("crashed before the commit");
    };
    try {
      await expect(finish(w, treeWith(w, { "half.ts": "carry\n" }), ["half.ts"])).rejects.toThrow("crashed before the commit");
    } finally {
      delete carryFaults.beforeCommit;
    }
    expect(await start(w)).toEqual({ outcome: "ok", present: false, from: w.head });
    expect([read(root, "half.ts"), sh(root, "status", "--porcelain", "--untracked-files=all")]).toEqual([null, ""]);
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
