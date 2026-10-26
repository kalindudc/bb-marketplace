// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changedFiles, diff, exec, filePatch, ghStatus, git, prCreate, prState, push, stackBase, worktreeState } from "../src/host/ops";

interface Admitted {
  command: string;
  args: string[];
  priority: string | undefined;
  signal: AbortSignal | undefined;
}

const seen = vi.hoisted(() => ({ inside: 0, admitted: [] as Admitted[], children: [] as Array<{ file: string; args: string[]; admitted: boolean }> }));

// The real scheduler still admits every call; the wrapper notes what it was asked and whether a child starts inside its turn.
vi.mock("@get-bb/plugin-sdk/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/host")>();
  const runVcs = actual.experimental_runVcsProcess;
  return {
    ...actual,
    experimental_runVcsProcess: ((command, args, operation, options) => {
      seen.admitted.push({ command, args: [...args], priority: options?.priority, signal: options?.signal });
      return runVcs(
        command,
        args,
        () => {
          seen.inside += 1;
          return operation().finally(() => (seen.inside -= 1));
        },
        options,
      );
    }) as typeof runVcs,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const noted =
    <F extends (...args: never[]) => unknown>(original: F) =>
    (file: string, args: readonly string[], ...rest: unknown[]) => {
      seen.children.push({ file, args: [...args], admitted: seen.inside > 0 });
      return (original as unknown as (...all: unknown[]) => unknown)(file, args, ...rest);
    };
  return { ...actual, execFile: noted(actual.execFile), spawn: noted(actual.spawn) };
});

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let scratch: string;
let counter = 0;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo(): string {
  const dir = join(scratch, `repo-${counter++}`);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "dev@example.com");
  sh(dir, "config", "user.name", "Dev");
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

function commitOn(repo: string, branch: string, file: string): string {
  sh(repo, "switch", "-q", "-c", branch, "main");
  writeFileSync(join(repo, file), `${file}\n`);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", file);
  sh(repo, "switch", "-q", "main");
  return sh(repo, "rev-parse", branch);
}

const forget = () => {
  seen.admitted.length = 0;
  seen.children.length = 0;
};

/** Every call went through the scheduler at this priority with this signal, and each child started inside its own turn with the same argv. */
function expectAdmitted(priority: string, signal: AbortSignal) {
  expect(seen.admitted.length).toBeGreaterThan(0);
  for (const call of seen.admitted) {
    expect(call.priority, call.args.join(" ")).toBe(priority);
    expect(call.signal, call.args.join(" ")).toBe(signal);
  }
  expect(seen.children).toEqual(seen.admitted.map(({ command, args }) => ({ file: command, args, admitted: true })));
}

const gitSubcommands = (repo: string) =>
  seen.admitted.map(({ command, args }) => {
    expect([command, args[0], args[1]]).toEqual(["git", "-C", repo]);
    return args.slice(2).find((arg) => !arg.startsWith("-"));
  });

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-host-vcs-")));
  for (const key of Object.keys(ENV)) saved[key] = process.env[key];
  Object.assign(process.env, ENV);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(forget);

describe("git through bb's VCS scheduler", () => {
  it("runs Loom's engine reads at background priority with git's whole argv, -C first, and the call's signal", async () => {
    const repo = makeRepo();
    const { signal } = new AbortController();
    forget();
    await worktreeState({ worktree: repo, base: "main" }, signal);
    expect(gitSubcommands(repo)).toEqual(["rev-parse", "symbolic-ref", "status", "merge-base", "diff", "ls-files"]);
    expectAdmitted("background", signal);
  });

  it("gives a push its argv as git gets it, so the scheduler can tell it uses the network", async () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    const { signal } = new AbortController();
    forget();
    expect(await push({ repo, remote: "origin", src: "main", branch: "loom/x" }, signal)).toEqual({ outcome: "ok" });
    expect(seen.admitted.map(({ args }) => args)).toEqual([["-C", repo, "push", "origin", "main:refs/heads/loom/x"]]);
    expectAdmitted("background", signal);
  });

  it("runs the Changes tab's reads, which a person waits on, at interactive priority", async () => {
    const repo = makeRepo();
    const feature = commitOn(repo, "feature", "a.txt");
    const base = sh(repo, "rev-parse", "main");
    const { signal } = new AbortController();
    forget();
    expect(await diff({ repo, base: "main", head: feature, maxBytes: 10_000 }, signal)).toMatchObject({ truncated: false });
    expect(await filePatch({ repo, base, head: feature, path: "a.txt", maxBytes: 10_000 }, signal)).toMatchObject({ outcome: "ok" });
    expect(gitSubcommands(repo)).toEqual(["diff", "diff", "rev-parse", "rev-parse", "diff"]);
    expectAdmitted("interactive", signal);

    sh(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    forget();
    expect(await changedFiles({ repo, base: "main", head: feature, mergeBase: true, landed: true, maxFiles: 10 }, signal)).toMatchObject({ outcome: "ok", base, files: [{ path: "a.txt" }] });
    expect(gitSubcommands(repo)).toEqual(["rev-parse", "rev-parse", "merge-base", "rev-list", "rev-parse", "merge-base", "diff", "diff"]);
    expectAdmitted("interactive", signal);
  });

  it("starts commit-tree's spawn, which takes the message on stdin, inside its turn too", async () => {
    const repo = makeRepo();
    const a = commitOn(repo, "a", "a.txt");
    const b = commitOn(repo, "b", "b.txt");
    const { signal } = new AbortController();
    forget();
    const stacked = await stackBase({ repo, branch: "loom/stack", commits: [a, b], message: "Stack a and b" }, signal);
    expect(stacked).toMatchObject({ outcome: "ok", tip: null });
    const tree = seen.admitted.find(({ args }) => args.includes("commit-tree"));
    expect(tree?.args).toEqual(["-C", repo, "commit-tree", expect.stringMatching(/^[0-9a-f]{40}$/u), "-p", a, "-p", b, "-F", "-"]);
    expectAdmitted("background", signal);
  });

  it("spawns nothing for a call aborted before its turn", async () => {
    const repo = makeRepo();
    const controller = new AbortController();
    controller.abort();
    forget();
    await expect(git(repo, ["status"], { signal: controller.signal })).rejects.toThrow(/aborted/u);
    expect(seen.admitted).toHaveLength(1);
    expect(seen.children).toEqual([]);
  });
});

describe("gh through bb's VCS scheduler", () => {
  let savedPath: string | undefined;
  beforeAll(() => {
    savedPath = process.env.PATH;
  });
  beforeEach(() => {
    const bin = join(scratch, `bin-${counter++}`);
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat > /dev/null\ncase "$1" in\n  pr) [ "$2" = create ] && echo "https://github.com/acme/shop/pull/7" || echo '{"state":"MERGED"}' ;;\nesac\n`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("runs each gh call at background priority with its argv and the call's signal", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    const url = "https://github.com/acme/shop/pull/7";
    const { signal } = new AbortController();
    forget();
    expect(await prState({ repo, url, forge: { kind: "gh" } }, signal)).toEqual({ outcome: "ok", state: "MERGED" });
    expect(await ghStatus({ repo, pushUrl: "git@github.com:acme/shop.git" }, signal)).toEqual({ status: "ready", host: "github.com" });
    expect(await prCreate({ repo, remote: "origin", base: "main", head: "loom/x", title: "t", body: "b", draft: false, forge: { kind: "gh" } }, signal)).toEqual({ outcome: "ok", url });
    expect(seen.admitted.map(({ command, args }) => [command, ...args])).toEqual([
      ["gh", "pr", "view", url, "--json", "state"],
      ["gh", "auth", "status", "--hostname", "github.com"],
      ["git", "-C", repo, "remote", "get-url", "--push", "--all", "origin"],
      ["gh", "pr", "create", "--repo", "github.com/acme/shop", "--base", "main", "--head", "loom/x", "--title", "t", "--body-file", "-"],
    ]);
    expectAdmitted("background", signal);
  });
});

describe("check and forge commands", () => {
  it("run outside the scheduler: a shell command is not a git or gh process, even when it runs git", async () => {
    const repo = makeRepo();
    const { signal } = new AbortController();
    forget();
    expect(await exec({ cwd: repo, command: "git rev-parse HEAD", timeoutMs: 5000 }, signal)).toMatchObject({ exitCode: 0 });
    expect(await prState({ repo, url: "https://review.example.com/r/1", forge: { kind: "command", state: "echo open" } }, signal)).toEqual({ outcome: "ok", state: "OPEN" });
    expect(seen.admitted).toEqual([]);
    expect(seen.children).toEqual([
      { file: "/bin/sh", args: ["-c", "git rev-parse HEAD"], admitted: false },
      { file: "/bin/sh", args: ["-c", "echo open"], admitted: false },
    ]);
  });
});
