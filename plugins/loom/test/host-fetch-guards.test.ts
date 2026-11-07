// A plain fetch accepts the repo's fetch.uriprotocols and fetch.trustpackfileuriindexes, so it can take its git host's
// prebuilt packs (one base fetch wrote 51 packs and 67 GB). Every fetch Loom runs says no to packfile URIs and bundle URIs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ argv: [] as string[][] }));

vi.mock("../src/host/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host/process")>();
  const runProcess = ((file: string, argv: readonly string[], options: never) => {
    if (file === "git") seen.argv.push([...argv]);
    return actual.runProcess(file, argv, options);
  }) as typeof actual.runProcess;
  return { ...actual, runProcess };
});

const { behindBase, carryStart, fetchBranch, fetchTip, importCommit, landedOn, prCommit, stackBase } = await import("../src/host/ops");

vi.setConfig({ testTimeout: 30_000 });

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const AUTHOR = { name: "Dev", email: "dev@example.com", date: "1700000000 +0000" };
const GUARDS = ["-c", "fetch.uriprotocols=", "-c", "transfer.bundleURI=false"];

let scratch: string;
let counter = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loom-fetch-guards-"));
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

beforeEach(() => {
  seen.argv.length = 0;
});

const subcommand = (argv: readonly string[]) => {
  let at = argv[0] === "-C" ? 2 : 0;
  while (argv[at] === "-c") at += 2;
  return argv[at];
};
const fetches = () => seen.argv.filter((argv) => subcommand(argv) === "fetch");

/** An origin with main at one commit, a clone of it, and a second commit that only the origin has. */
function world() {
  const origin = join(scratch, `origin-${counter}.git`);
  const clone = (name: string) => {
    const dir = join(scratch, `${name}-${counter}`);
    execFileSync("git", ["clone", "-q", origin, dir], { stdio: "pipe" });
    sh(dir, "config", "user.email", "dev@example.com");
    sh(dir, "config", "user.name", "Dev");
    return dir;
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(scratch, `seed-${counter}`);
  mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  sh(seed, "config", "user.email", "dev@example.com");
  sh(seed, "config", "user.name", "Dev");
  writeFileSync(join(seed, "a.txt"), "a\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "one");
  sh(seed, "push", "-q", origin, "main");
  const first = sh(seed, "rev-parse", "HEAD");
  const local = clone("local");
  writeFileSync(join(seed, "b.txt"), "b\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "two");
  sh(seed, "push", "-q", origin, "main");
  sh(seed, "switch", "-q", "-c", "feature");
  writeFileSync(join(seed, "f.txt"), "f\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "feature");
  sh(seed, "push", "-q", origin, "feature");
  counter += 1;
  return { origin, local, first, second: sh(seed, "rev-parse", "main"), feature: sh(seed, "rev-parse", "feature") };
}

function expectGuarded(minimum = 1) {
  expect(fetches().length).toBeGreaterThanOrEqual(minimum);
  for (const argv of fetches()) {
    expect(argv.slice(0, 2)).toEqual(["-C", expect.any(String)]);
    expect(argv.slice(2, 2 + GUARDS.length)).toEqual(GUARDS);
  }
}

describe("every git fetch Loom runs", () => {
  it("fetchBranch", async () => {
    const w = world();
    expect(await fetchBranch({ worktree: w.local, remote: "origin", branch: "feature" })).toMatchObject({ outcome: "ok", sha: w.feature });
    expectGuarded();
  });

  it("behindBase", async () => {
    const w = world();
    expect(await behindBase({ repo: w.local, remote: "origin", base: "main", fetch: true, shas: [w.first] })).toMatchObject({ outcome: "ok", tip: w.second });
    expectGuarded();
  });

  it("stackBase", async () => {
    const w = world();
    expect(await stackBase({ repo: w.local, branch: "loom/csv/base", commits: [w.first], message: "stack", base: { remote: "origin", branch: "main" } })).toMatchObject({ outcome: "ok", sha: w.second });
    expectGuarded();
  });

  it("fetchTip", async () => {
    const w = world();
    expect(await fetchTip({ repo: w.local, remote: "origin", branch: "feature", base: "main", ref: "refs/loom/tip" })).toMatchObject({ outcome: "ok", sha: w.feature });
    expectGuarded(2);
  });

  it("landedOn", async () => {
    const w = world();
    expect(await landedOn({ repo: w.local, remote: "origin", base: "main", sha: w.first })).toEqual({ outcome: "ok", landed: true });
    expectGuarded();
  });

  it("prCommit, when the branch's tip is not here yet", async () => {
    const w = world();
    const result = await prCommit({ repo: w.local, remote: "origin", branch: "feature", base: "main", head: w.first, message: "pr" });
    expect(result).toMatchObject({ outcome: "diverged" });
    expectGuarded();
  });

  it("importCommit, when the base is not here yet", async () => {
    const w = world();
    const made = await importCommit({ repo: w.local, remote: "origin", baseBranch: "main", base: w.second, tree: sh(w.local, "rev-parse", `${w.first}^{tree}`), message: "m\n", author: AUTHOR, entries: [{ path: "b.txt", delete: true }], refs: [] }, join(scratch, "data"));
    expect(made).toMatchObject({ outcome: "ok" });
    expectGuarded();
  });

  it("carryStart, when the base is not on the machine", async () => {
    const w = world();
    await carryStart({ worktree: w.local, remote: "origin", baseBranch: "main", base: w.second, tree: "2".repeat(40) });
    expectGuarded();
  });

  it("leaves ls-remote and push as they were", async () => {
    const w = world();
    await landedOn({ repo: w.local, remote: "origin", base: "main", sha: w.first });
    const listed = seen.argv.find((argv) => subcommand(argv) === "ls-remote")!;
    expect(listed).toEqual(["-C", w.local, "ls-remote", "origin", "refs/heads/main"]);
  });
});
