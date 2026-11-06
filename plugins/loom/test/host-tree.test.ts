// importCommit builds the worker's commit by rewriting only the trees on the way to a changed path. The oracle is the
// algorithm it replaced, kept here: read the base into a temporary index, apply the entries with update-index, write-tree.
// Each case checks that the new commit's root tree is the oracle's, sha for sha.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importChunk, importCommit } from "../src/host/ops";
import { rewriteTree, type TreeEntry } from "../src/host/tree";

vi.setConfig({ testTimeout: 30_000 });

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
const AUTHOR = { name: "Dev", email: "dev@example.com", date: "1700000000 +0000" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

type Entry = { path: string; mode: "100644" | "100755" | "120000"; content: string } | { path: string; delete: true };

interface Fixture {
  repo: string;
  base: string;
}

let scratch: string;
let counter = 0;
let main: Fixture;
let tiny: Fixture;
let submodule: string;

/** A repository with `files` committed (and the submodule entry `gitlinks` names), pushed to its own bare origin. */
function fixture(name: string, files: Record<string, string>, gitlinks: Record<string, string> = {}): Fixture {
  const repo = join(scratch, name);
  const origin = join(scratch, `${name}-origin.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "dev@example.com");
  sh(repo, "config", "user.name", "Dev");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  sh(repo, "add", "-A");
  for (const [path, sha] of Object.entries(gitlinks)) sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sha},${path}`);
  sh(repo, "commit", "-q", "-m", "seed", "--allow-empty");
  sh(repo, "remote", "add", "origin", origin);
  sh(repo, "push", "-q", "origin", "main");
  return { repo, base: sh(repo, "rev-parse", "HEAD") };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loom-tree-"));
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  submodule = "1".repeat(40);
  main = fixture(
    "repo",
    { "top.txt": "top\n", "script.sh": "#!/bin/sh\necho hi\n", "dir/a.txt": "a\n", "dir/b.txt": "b\n", "only/one.txt": "one\n", "nested/deep/x.txt": "x\n", "vendor/readme": "vendor\n", "with space/in name.txt": "s\n", "ünï/çödé/файл.txt": "u\n" },
    { "vendor/mod": submodule },
  );
  tiny = fixture("tiny", { "only.txt": "only\n" });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The tree the old algorithm writes: the base in a temporary index, the entries through update-index --index-info. */
function oracle(entries: readonly Entry[], { repo, base } = main): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, `oracle-index-${counter++}`) };
  const git = (args: string[], input?: string) => execFileSync("git", ["-C", repo, ...args], { env, input, encoding: "utf8" }).trim();
  git(["read-tree", base]);
  const records = entries.map((entry) => ("delete" in entry ? `0 ${"0".repeat(40)}\t${entry.path}` : `${entry.mode} ${git(["hash-object", "-w", "--no-filters", "--stdin"], entry.content)}\t${entry.path}`));
  if (records.length > 0) git(["update-index", "-z", "--index-info"], `${records.join("\0")}\0`);
  return git(["write-tree"]);
}

async function rewritten(entries: readonly Entry[], tree?: string, fx = main) {
  const expected = tree ?? oracle(entries, fx);
  const dataDir = join(scratch, `data-${counter++}`);
  const sent: Parameters<typeof importCommit>[0]["entries"] = [];
  for (const entry of entries) {
    if ("delete" in entry) sent.push({ path: entry.path, delete: true });
    else {
      const upload = `up-${counter++}`;
      await importChunk({ upload, offset: 0, data: Buffer.from(entry.content).toString("base64") }, dataDir);
      sent.push({ path: entry.path, mode: entry.mode, upload });
    }
  }
  const made = await importCommit({ repo: fx.repo, remote: "origin", baseBranch: "main", base: fx.base, tree: expected, message: "CSV-1: change\n", author: AUTHOR, entries: sent, refs: [`refs/heads/loom/csv/case-${counter++}`] }, dataDir);
  return { made, tree: expected };
}

async function expectSameTree(entries: readonly Entry[], fx = main) {
  const { made, tree } = await rewritten(entries, undefined, fx);
  expect(made).toMatchObject({ outcome: "ok" });
  const sha = (made as { sha: string }).sha;
  expect(sh(fx.repo, "rev-parse", `${sha}^{tree}`)).toBe(tree);
  expect(sh(fx.repo, "rev-parse", `${sha}^`)).toBe(fx.base);
  return tree;
}

describe("importCommit's tree rewrite equals read-tree, update-index and write-tree", () => {
  it("modifies a file", async () => {
    await expectSameTree([{ path: "dir/a.txt", mode: "100644", content: "changed\n" }]);
  });

  it("adds a file in a new nested directory", async () => {
    await expectSameTree([{ path: "new/deeper/still/f.txt", mode: "100644", content: "f\n" }]);
  });

  it("deletes the only file of a directory, which drops the directory", async () => {
    const tree = await expectSameTree([{ path: "only/one.txt", delete: true }]);
    expect(sh(main.repo, "ls-tree", "--name-only", tree)).not.toContain("only");
  });

  it("drops every directory that a deletion empties, up to the root's other entries", async () => {
    const tree = await expectSameTree([{ path: "nested/deep/x.txt", delete: true }]);
    expect(sh(main.repo, "ls-tree", "--name-only", tree)).not.toContain("nested");
  });

  it("changes a file's mode from 100644 to 100755", async () => {
    const tree = await expectSameTree([{ path: "top.txt", mode: "100755", content: "top\n" }]);
    expect(sh(main.repo, "ls-tree", tree, "top.txt")).toMatch(/^100755 blob /u);
  });

  it("writes a symlink", async () => {
    const tree = await expectSameTree([{ path: "dir/link", mode: "120000", content: "a.txt" }]);
    expect(sh(main.repo, "ls-tree", tree, "dir/link")).toMatch(/^120000 blob /u);
  });

  it("leaves a submodule entry untouched, in the directory that changes too", async () => {
    const tree = await expectSameTree([{ path: "vendor/readme", mode: "100644", content: "changed\n" }]);
    expect(sh(main.repo, "ls-tree", tree, "vendor/mod")).toBe(`160000 commit ${submodule}\tvendor/mod`);
  });

  it("changes several paths in one directory at once", async () => {
    await expectSameTree([
      { path: "dir/a.txt", mode: "100644", content: "a changed\n" },
      { path: "dir/c.txt", mode: "100644", content: "c\n" },
      { path: "dir/b.txt", delete: true },
    ]);
  });

  it("changes paths in several directories at different depths", async () => {
    await expectSameTree([
      { path: "top.txt", mode: "100644", content: "t\n" },
      { path: "nested/deep/y.txt", mode: "100644", content: "y\n" },
      { path: "nested/z.txt", mode: "100644", content: "z\n" },
      { path: "only/one.txt", delete: true },
    ]);
  });

  it("replaces a file with a directory and a directory's file with a file", async () => {
    await expectSameTree([
      { path: "top.txt", delete: true },
      { path: "top.txt/inner", mode: "100644", content: "inner\n" },
    ]);
    await expectSameTree([{ path: "only", mode: "100644", content: "now a file\n" }]);
  });

  it("ignores a deletion of a path that is not there and of a directory, as update-index does", async () => {
    await expectSameTree([
      { path: "missing/file", delete: true },
      { path: "dir", delete: true },
      { path: "top.txt/below", delete: true },
    ]);
  });

  it("takes the last entry for a path named twice", async () => {
    await expectSameTree([
      { path: "dir/a.txt", mode: "100644", content: "first\n" },
      { path: "dir/a.txt", mode: "100755", content: "second\n" },
    ]);
  });

  it("deletes every file, which leaves only the submodule", async () => {
    const all = sh(main.repo, "ls-tree", "-r", "--name-only", "-z", main.base).split("\0").filter((path) => path !== "" && path !== "vendor/mod");
    const tree = await expectSameTree([...all.map((path) => ({ path, delete: true as const })), { path: "vendor/mod/none", delete: true }]);
    expect(tree).not.toBe(sh(main.repo, "rev-parse", `${main.base}^{tree}`));
  });

  it("handles paths with spaces and non-ASCII names, in new and existing directories", async () => {
    await expectSameTree([
      { path: "with space/in name.txt", mode: "100644", content: "changed\n" },
      { path: "with space/another file.txt", mode: "100644", content: "new\n" },
      { path: "ünï/çödé/файл.txt", delete: true },
      { path: "ünï/çödé/ファイル 2.txt", mode: "100755", content: "u2\n" },
      { path: "日本語/ディレクトリ/ファイル.txt", mode: "100644", content: "jp\n" },
    ]);
  });

  it("writes the empty tree when every file of the base is deleted", async () => {
    const tree = await expectSameTree([{ path: "only.txt", delete: true }], tiny);
    expect(tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("applies edits in order when one path is an ancestor of another", async () => {
    const file = (path: string, content: string): Entry => ({ path, mode: "100644", content });
    // A file where a directory was, then a file below it again: the directory starts empty.
    await expectSameTree([file("dir", "now a file\n"), file("dir/new.txt", "below\n")]);
    // A file below a directory, then a file at the directory's own path: the file wins.
    await expectSameTree([file("dir/new.txt", "below\n"), file("dir", "now a file\n")]);
    await expectSameTree([file("nested/deep/y.txt", "y\n"), { path: "nested", delete: true }]);
    await expectSameTree([{ path: "top.txt", delete: true }, file("top.txt/inner", "inner\n"), { path: "top.txt/inner", delete: true }]);
    await expectSameTree([file("top.txt/inner", "inner\n"), { path: "top.txt/inner", delete: true }]);
    await expectSameTree([file("vendor/mod/x", "over the submodule\n")]);
    await expectSameTree([file("vendor/mod", "a file for the submodule\n"), { path: "vendor/mod", delete: true }]);
    await expectSameTree([{ path: "vendor/mod", delete: true }, { path: "vendor/mod/x", delete: true }]);
  });

  // The oracle on random edit sequences over a small set of names, so ancestors, replacements and removals meet often.
  it("equals the oracle on random edit sequences", async () => {
    let seed = 20_261_106;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % limit;
    };
    const names = ["dir", "a.txt", "b.txt", "only", "one.txt", "nested", "deep", "x.txt", "top.txt", "vendor", "readme", "mod", "new", "with space", "é"];
    const modes = ["100644", "100755", "120000"] as const;
    let compared = 0;
    for (let round = 0; round < 40 && compared < 25; round += 1) {
      const entries: Entry[] = [];
      for (let count = 1 + next(5); count > 0; count -= 1) {
        const path = Array.from({ length: 1 + next(3) }, () => names[next(names.length)]!).join("/");
        entries.push(next(2) === 0 ? { path, delete: true } : { path, mode: modes[next(modes.length)]!, content: `${round}-${count}\n` });
      }
      let expected: string;
      try {
        expected = oracle(entries);
      } catch {
        // update-index refused the sequence, which no worker's tree can produce.
        continue;
      }
      const { made } = await rewritten(entries, expected);
      expect(made, JSON.stringify(entries)).toMatchObject({ outcome: "ok" });
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(15);
  }, 180_000);

  it("changes nothing for no entries", async () => {
    const tree = await expectSameTree([]);
    expect(tree).toBe(sh(main.repo, "rev-parse", `${main.base}^{tree}`));
  });

  it("reports a mismatch with the tree it wrote when the worker's tree differs", async () => {
    const entries: Entry[] = [{ path: "dir/a.txt", mode: "100644", content: "changed\n" }];
    const { made, tree } = await rewritten(entries, sh(main.repo, "rev-parse", `${main.base}^{tree}`));
    expect(made).toEqual({ outcome: "mismatch", tree: oracle(entries) });
    expect(tree).not.toBe((made as { tree: string }).tree);
  });

  it("reads and writes only the trees on the way to a changed path", async () => {
    const calls: string[] = [];
    const trees = new Map<string, Map<string, TreeEntry>>([
      ["root", new Map([["a", { mode: "040000", type: "tree", sha: "ta" }], ["b", { mode: "040000", type: "tree", sha: "tb" }], ["f", { mode: "100644", type: "blob", sha: "bf" }]])],
      ["ta", new Map([["x", { mode: "100644", type: "blob", sha: "bx" }]])],
    ]);
    const root = await rewriteTree(
      {
        list: async (tree) => {
          calls.push(`list ${tree}`);
          return new Map(trees.get(tree)!);
        },
        write: async (entries) => {
          calls.push(`write ${[...entries.keys()].join(",")}`);
          return `new-${calls.length}`;
        },
      },
      "root",
      [["a/x", { mode: "100644", sha: "bx2" }]],
    );
    expect(calls).toEqual(["list root", "list ta", "write x", "write a,b,f"]);
    expect(root).toBe("new-4");
  });
});
