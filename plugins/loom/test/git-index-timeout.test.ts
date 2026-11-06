// The index and tree steps on the project's checkout (ls-tree, mktree, commit-tree, merge-tree) get
// the repo's git index time limit, not the 30 seconds quick git calls get. A monorepo's read-tree into a temporary index
// took 41.5 s under load, past 30 s, so every submit failed; importCommit now lists and writes only the trees on the way
// to a changed path, and those steps keep the limit. The process runner is wrapped so that a step "takes" a set time: it
// is reported as a timeout when its limit is shorter, and runs for real otherwise, so no test waits.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hostCallTransient } from "../src/forge-waits";

const slow = vi.hoisted(() => ({ ms: new Map<string, number>(), limits: new Map<string, number[]>() }));

vi.mock("../src/host/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host/process")>();
  const subcommand = (argv: readonly string[]) => {
    let at = argv[0] === "-C" ? 2 : 0;
    while (argv[at] === "-c") at += 2;
    return argv[at] ?? "";
  };
  const runProcess = ((file: string, argv: readonly string[], options: { timeoutMs: number }) => {
    const name = subcommand(argv);
    const takes = file === "git" ? slow.ms.get(name) : undefined;
    if (file === "git") slow.limits.set(name, [...(slow.limits.get(name) ?? []), options.timeoutMs]);
    if (takes !== undefined && options.timeoutMs < takes) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true });
    return actual.runProcess(file, argv, options as never);
  }) as typeof actual.runProcess;
  return { ...actual, runProcess };
});

const { importCommit, mergeOnto, stackBase } = await import("../src/host/ops");

vi.setConfig({ testTimeout: 30_000 });

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const AUTHOR = { name: "Dev", email: "dev@example.com", date: "1700000000 +0000" };

let scratch: string;
let counter = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loom-index-timeout-"));
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
  slow.ms.clear();
  slow.limits.clear();
});

/** A checkout with an origin, its main at one commit, and two branches off it that merge cleanly. */
function checkout() {
  const dir = join(scratch, `repo-${counter++}`);
  const origin = `${dir}-origin.git`;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "dev@example.com");
  sh(dir, "config", "user.name", "Dev");
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  sh(dir, "remote", "add", "origin", origin);
  sh(dir, "push", "-q", "origin", "main");
  const base = sh(dir, "rev-parse", "HEAD");
  const branch = (name: string) => {
    sh(dir, "checkout", "-q", "-b", name, base);
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", name);
    const sha = sh(dir, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "main");
    return sha;
  };
  return { dir, base, tree: sh(dir, "rev-parse", "HEAD^{tree}"), a: branch("a"), b: branch("b"), dataDir: join(dir, "..", `data-${counter}`) };
}

const importInput = (repo: ReturnType<typeof checkout>, extra: { indexTimeoutMs?: number } = {}) => ({
  repo: repo.dir,
  remote: "origin",
  baseBranch: "main",
  base: repo.base,
  tree: repo.tree,
  message: "Mapped orders to rows\n",
  author: AUTHOR,
  entries: [],
  refs: ["refs/heads/loom/csv/csv-1-home"],
  ...extra,
});

describe("the git index time limit on the project's checkout", () => {
  it("brings a commit home when listing the base's tree takes 41.5 s, past the 30 s quick git calls get", async () => {
    const repo = checkout();
    slow.ms.set("ls-tree", 41_500);
    const made = await importCommit(importInput(repo), repo.dataDir);
    expect(made).toMatchObject({ outcome: "ok" });
    expect(slow.limits.get("ls-tree")![0]).toBeGreaterThan(290_000);
    expect(slow.limits.get("mktree")![0]).toBeGreaterThan(290_000);
    expect(slow.limits.has("read-tree")).toBe(false);
    // Quick calls keep their 30 seconds.
    expect(new Set(slow.limits.get("rev-parse"))).toEqual(new Set([30_000]));
  });

  it("gives the steps the repo's own limit, shared across the call", async () => {
    const repo = checkout();
    const made = await importCommit(importInput(repo, { indexTimeoutMs: 600_000 }), repo.dataDir);
    expect(made).toMatchObject({ outcome: "ok" });
    const [listed] = slow.limits.get("ls-tree")!;
    expect(listed).toBeGreaterThan(590_000);
    expect(listed).toBeLessThanOrEqual(600_000);
    expect(slow.limits.get("mktree")![0]).toBeLessThanOrEqual(listed!);
  });

  it("names the setting to raise when the steps run past the limit, in a message the server waits out", async () => {
    const repo = checkout();
    slow.ms.set("ls-tree", 41_500);
    const error = await importCommit(importInput(repo, { indexTimeoutMs: 30_000 }), repo.dataDir).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toMatch(/^git ls-tree took too long: .*ran past 30 seconds\. Raise git_index_timeout_seconds/u);
    expect(hostCallTransient(error)).toEqual({ transient: "server" });
  });

  it("gives mergeOnto's merge-tree the limit too, past the 120 s it had", async () => {
    const repo = checkout();
    slow.ms.set("merge-tree", 150_000);
    const merged = await mergeOnto({ repo: repo.dir, head: repo.a, ref: repo.b, message: "Merge b into a (Loom)", refs: [] });
    expect(merged).toMatchObject({ outcome: "merged", already: false });
    expect(slow.limits.get("merge-tree")![0]).toBeGreaterThan(290_000);
  });

  it("records an ours merge with the head's tree and both parents, running no merge-tree", async () => {
    const repo = checkout();
    const merged = await mergeOnto({ repo: repo.dir, head: repo.a, ref: repo.b, message: "Merge b into a", refs: [], ours: true });
    expect(merged).toMatchObject({ outcome: "merged", already: false, tree: sh(repo.dir, "rev-parse", `${repo.a}^{tree}`) });
    expect(sh(repo.dir, "rev-parse", `${(merged as { sha: string }).sha}^@`).split("\n")).toEqual([repo.a, repo.b]);
    expect(slow.limits.get("merge-tree")).toBeUndefined();
  });

  it("gives stackBase's merge-tree the limit too", async () => {
    const repo = checkout();
    slow.ms.set("merge-tree", 150_000);
    const built = await stackBase({ repo: repo.dir, branch: "loom/csv/base", commits: [repo.a, repo.b], message: "Loom: stack base" });
    expect(built).toMatchObject({ outcome: "ok" });
    expect(slow.limits.get("merge-tree")![0]).toBeGreaterThan(290_000);
  });
});
