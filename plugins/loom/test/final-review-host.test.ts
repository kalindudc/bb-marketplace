import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkoutPrint, finalScratch, finalScratchRoot } from "../src/host/ops";

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-final-host-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function makeRepo(): string {
  const repo = join(scratch, `repo-${counter++}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const sh = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=dev@example.com", "-c", "user.name=Dev", ...args]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "two\n");
  sh("add", ".");
  sh("commit", "-q", "-m", "start");
  return repo;
}
const print = async (repo: string) => {
  const answer = await checkoutPrint({ repo });
  if (answer.outcome !== "ok") throw new Error(answer.message);
  return answer;
};

// Each case runs several git commands, which a loaded full run can slow past vitest's 5 seconds.
describe("checkoutPrint", { timeout: 20_000 }, () => {
  it("is the same for the same checkout, and reading it changes nothing", async () => {
    const repo = makeRepo();
    const first = await print(repo);
    expect(first).toMatchObject({ dirty: false, head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect((await print(repo)).print).toBe(first.print);
  });

  it("changes with an edit, a staged change, an untracked file, a new commit and a branch switch", async () => {
    const repo = makeRepo();
    const sh = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=dev@example.com", "-c", "user.name=Dev", ...args]);
    const seen = new Set([(await print(repo)).print]);
    const step = async (change: () => void) => {
      change();
      const next = (await print(repo)).print;
      expect(seen.has(next)).toBe(false);
      seen.add(next);
    };
    await step(() => writeFileSync(join(repo, "a.txt"), "one, edited\n"));
    await step(() => sh("add", "a.txt"));
    await step(() => writeFileSync(join(repo, "new.txt"), "new\n"));
    await step(() => sh("commit", "-q", "-m", "more"));
    await step(() => sh("switch", "-q", "-c", "other"));
  });

  it("fingerprints a dirty checkout's changes: a second edit to an already-changed file, or to an untracked one, shows", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "the person's edit\n");
    writeFileSync(join(repo, "notes.txt"), "the person's notes\n");
    const before = await print(repo);
    expect(before.dirty).toBe(true);
    writeFileSync(join(repo, "a.txt"), "the person's edit, changed again\n");
    const tracked = await print(repo);
    expect(tracked.print).not.toBe(before.print);
    writeFileSync(join(repo, "notes.txt"), "the person's notes, changed\n");
    expect((await print(repo)).print).not.toBe(tracked.print);
  });

  it("is unavailable where there is no repository", async () => {
    expect(await checkoutPrint({ repo: join(scratch, "nothing-here") })).toMatchObject({ outcome: "unavailable" });
  });
});

describe("finalScratch", () => {
  const dataDir = () => join(scratch, "bb", "plugins", "loom", "host-data");
  const root = () => join(scratch, "cache", "final-review");

  it("makes an empty directory, lists it, and removes it", () => {
    const made = finalScratch({ key: "loom-abc", action: "create" }, dataDir(), root());
    expect(made).toEqual({ path: join(root(), "loom-abc"), entries: [] });
    writeFileSync(join(made.path, "left.txt"), "x");
    expect(finalScratch({ key: "loom-abc", action: "inspect" }, dataDir(), root()).entries).toEqual(["left.txt"]);
    expect(finalScratch({ key: "loom-abc", action: "create" }, dataDir(), root()).entries).toEqual([]);
    finalScratch({ key: "loom-abc", action: "remove" }, dataDir(), root());
    expect(existsSync(made.path)).toBe(false);
  });

  it("removes a run's directory that an earlier Loom made in its data directory", () => {
    const old = join(dataDir(), "final-review", "loom-old");
    mkdirSync(old, { recursive: true });
    finalScratch({ key: "loom-old", action: "remove" }, dataDir(), root());
    expect(existsSync(old)).toBe(false);
  });
});

describe("finalScratchRoot", () => {
  const inside = (dir: string, path: string) => !relative(dir, path).startsWith("..");

  it("is outside bb's data directory, which bb refuses as a workspace no project owns", () => {
    const path = finalScratchRoot("/Users/dev/.bb/plugins/loom/host-data", {}, "/Users/dev");
    expect(inside("/Users/dev/.bb", path)).toBe(false);
    expect(inside("/Users/dev/.cache", path)).toBe(true);
  });

  it("follows XDG_CACHE_HOME when it is absolute, and keeps two bb installs apart", () => {
    expect(inside("/var/cache/dev", finalScratchRoot("/Users/dev/.bb/plugins/loom/host-data", { XDG_CACHE_HOME: "/var/cache/dev" }, "/Users/dev"))).toBe(true);
    expect(inside("/Users/dev/.cache", finalScratchRoot("/Users/dev/.bb/plugins/loom/host-data", { XDG_CACHE_HOME: "cache" }, "/Users/dev"))).toBe(true);
    expect(finalScratchRoot("/Users/dev/.bb/plugins/loom/host-data", {}, "/Users/dev")).not.toBe(finalScratchRoot("/Users/dev/.bb-dev/plugins/loom/host-data", {}, "/Users/dev"));
  });
});

describe("the re-review's fingerprint gaps", () => {
  const sh = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=dev@example.com", "-c", "user.name=Dev", ...args]);

  it("sees a tracked file marked assume-unchanged and then edited", async () => {
    const repo = makeRepo();
    const before = await print(repo);
    sh(repo, "update-index", "--assume-unchanged", "a.txt");
    writeFileSync(join(repo, "a.txt"), "edited behind git's back\n");
    expect((await print(repo)).print).not.toBe(before.print);
  });

  it("sees an edit to an untracked file in a checkout that is a subdirectory of its repo", async () => {
    const repo = makeRepo();
    const sub = join(repo, "services", "orders");
    execFileSync("mkdir", ["-p", sub]);
    writeFileSync(join(sub, "app.ts"), "tracked\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "a service");
    writeFileSync(join(sub, "notes.txt"), "first\n");
    const before = await print(sub);
    writeFileSync(join(sub, "notes.txt"), "second, and longer\n");
    expect((await print(sub)).print).not.toBe(before.print);
  });

  it("is unavailable, not a fingerprint with gaps, past its path cap", async () => {
    const repo = makeRepo();
    for (let index = 0; index < 301; index += 1) writeFileSync(join(repo, `untracked-${index}.txt`), "x");
    expect(await checkoutPrint({ repo })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("more than 300") });
  });

  it("reads no file contents: a same-size edit with the same modification time is not its business", async () => {
    const source = readFileSync(new URL("../src/host/ops.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export async function checkoutPrint"), source.indexOf("export function finalScratch"));
    expect(body).not.toMatch(/readFileSync|readFile\(|createReadStream/);
  });
});

describe("finalScratch's sweep", () => {
  it("removes Loom's scratch directories that no run owns, at most 20 at a time, and keeps the rest", () => {
    const dataDir = join(scratch, "sweep", "host-data");
    const root = join(scratch, "sweep", "cache");
    for (const key of ["loom-owned", ...Array.from({ length: 22 }, (_, index) => `loom-orphan-${index}`)]) finalScratch({ key, action: "create" }, dataDir, root);
    const swept = finalScratch({ key: "loom-sweep", action: "sweep", keep: ["loom-owned"] }, dataDir, root);
    expect(swept.entries).toHaveLength(20);
    expect(existsSync(join(root, "loom-owned"))).toBe(true);
    finalScratch({ key: "loom-sweep", action: "sweep", keep: ["loom-owned"] }, dataDir, root);
    expect(readdirSync(root)).toEqual(["loom-owned"]);
  });

  it("sweeps the orphans an earlier Loom left in its data directory too", () => {
    const dataDir = join(scratch, "sweep-old", "host-data");
    const root = join(scratch, "sweep-old", "cache");
    for (const key of ["loom-owned", "loom-orphan"]) mkdirSync(join(dataDir, "final-review", key), { recursive: true });
    const swept = finalScratch({ key: "loom-sweep", action: "sweep", keep: ["loom-owned"] }, dataDir, root);
    expect(swept.entries).toEqual(["loom-orphan"]);
    expect(readdirSync(join(dataDir, "final-review"))).toEqual(["loom-owned"]);
  });
});
