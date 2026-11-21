// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitRunner, GitRunnerError } from "../src/git-process";

const fakeGit = String.raw`
const { spawn } = require('node:child_process');
const { existsSync, watch, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('-C');
const [root, mode, id] = argv.slice(rootIndex + 1);
function hold() {
  const release = join(root, 'release-' + id);
  const watcher = watch(root, () => {
    if (existsSync(release)) finish();
  });
  const expiry = setTimeout(finish, 2400);
  function finish() {
    clearTimeout(expiry);
    watcher.close();
  }
  writeFileSync(join(root, 'start-' + id), String(process.pid));
}
switch (mode) {
  case 'probe': {
    const keys = ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_ALLOW_PROTOCOL', 'VANTAGE_FAKE_GIT'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const gitKeys = Object.keys(process.env).filter(key => key.startsWith('GIT_')).sort();
    process.stdout.write(JSON.stringify({ env, gitKeys, argv, stdin: require('node:fs').readFileSync(0, 'utf8') }));
    break;
  }
  case 'bytes':
    process.stdout.write(Buffer.from([255, 0, 128, 13, 10]));
    process.stderr.write('ordinary failure');
    process.exitCode = 7;
    break;
  case 'hold':
    hold();
    break;
  case 'stdout':
    process.stdout.write('x'.repeat(65));
    hold();
    break;
  case 'stderr':
    process.stderr.write('x'.repeat(65));
    hold();
    break;
  case 'signal':
    process.kill(process.pid, 'SIGTERM');
    break;
  case 'orphan': {
    const child = spawn(process.execPath, [__filename, '-C', root, 'grandchild', id], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('spawn', () => {
      writeFileSync(join(root, 'wrapper'), String(process.pid));
      child.unref();
    });
    break;
  }
  case 'grandchild':
    setTimeout(() => writeFileSync(join(root, 'survived'), ''), 600);
    writeFileSync(join(root, 'grandchild'), String(process.pid));
    break;
  default:
    process.exitCode = 98;
}
`;

const groupPlatform = process.platform === "darwin" || process.platform === "linux";
const fixtureDeadline = 1800;
let root: string;
let command: { file: string; args: string[] };
let runners: ReturnType<typeof createGitRunner>[];

function runner(options: Parameters<typeof createGitRunner>[0] = {}) {
  const result = createGitRunner({ command, deadlineMs: fixtureDeadline, ...options });
  runners.push(result);
  return result;
}

function present(name: string) {
  return existsSync(join(root, name));
}

async function started(id: string) {
  await vi.waitFor(() => expect(present(`start-${id}`)).toBe(true), { timeout: 1000 });
}

function release(id: string) {
  writeFileSync(join(root, `release-${id}`), "");
}

function pid(name: string) {
  return Number(readFileSync(join(root, name), "utf8"));
}

function expectGone(processId: number) {
  expect(() => process.kill(processId, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vantage-fake-git-"));
  const script = join(root, "fake-git.cjs");
  writeFileSync(script, fakeGit);
  command = { file: process.execPath, args: [script] };
  runners = [];
});

afterEach(async () => {
  try {
    await Promise.all(runners.map((item) => item.dispose()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!groupPlatform)("Git process runner", () => {
  it("passes literal argv and stdin with the read-only Git safeguards", async () => {
    const git = runner();
    const literal = "space ; $(not-a-command)";
    const result = await git.run(root, ["probe", literal], { stdin: "input\n", outputLimit: 2048 });
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual(Buffer.alloc(0));
    const probe: unknown = JSON.parse(result.stdout.toString("utf8"));
    expect(probe).toMatchObject({
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
      argv: expect.arrayContaining([
        "--no-pager",
        "core.fsmonitor=false",
        "core.hooksPath=/dev/null",
        "submodule.recurse=false",
      ]),
      stdin: "input\n",
    });
    expect(probe).toMatchObject({ argv: expect.arrayContaining(["-C", root, "probe", literal]) });
  });

  it("strips inherited Git overrides but preserves ordinary environment variables", async () => {
    try {
      for (const key of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_GLOBAL",
        "GIT_EXEC_PATH",
      ]) {
        vi.stubEnv(key, "inherited");
      }
      vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
      vi.stubEnv("GIT_NO_REPLACE_OBJECTS", "0");
      vi.stubEnv("VANTAGE_FAKE_GIT", "preserved");
      const result = await runner().run(root, ["probe"], { outputLimit: 2048 });
      const probe: unknown = JSON.parse(result.stdout.toString("utf8"));
      expect(probe).toMatchObject({
        env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", VANTAGE_FAKE_GIT: "preserved" },
        gitKeys: [
          "GIT_ALLOW_PROTOCOL",
          "GIT_ASKPASS",
          "GIT_NO_LAZY_FETCH",
          "GIT_NO_REPLACE_OBJECTS",
          "GIT_OPTIONAL_LOCKS",
          "GIT_TERMINAL_PROMPT",
        ],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps ordinary nonzero status and byte-exact stdout and stderr", async () => {
    const git = runner({ stdoutLimit: 4 });
    const result = await git.run(root, ["bytes"], { outputLimit: 5 });
    expect(result).toEqual({
      code: 7,
      stdout: Buffer.from([255, 0, 128, 13, 10]),
      stderr: Buffer.from("ordinary failure"),
    });
  });

  it("starts no more than two workers and rejects a full queue", async () => {
    const git = runner({ maxActive: 2, maxQueued: 1 });
    const a = git.run(root, ["hold", "a"]);
    const b = git.run(root, ["hold", "b"]);
    const queued = git.run(root, ["hold", "c"]);
    await expect(git.run(root, ["hold", "rejected"])).rejects.toMatchObject({ kind: "queue-full" });
    await Promise.all([started("a"), started("b")]);
    expect(present("start-c")).toBe(false);
    release("a");
    await a;
    await started("c");
    expectGone(pid("start-a"));
    expect(present("start-rejected")).toBe(false);
    release("b");
    release("c");
    await Promise.all([b, queued]);
  });

  it("keeps a slot for interactive reads and starts them before queued background work", async () => {
    const git = runner({ maxActive: 2, maxQueued: 1 });
    const a = git.run(root, ["hold", "a"], { lane: "background" });
    const b = git.run(root, ["hold", "b"], { lane: "background" });
    await expect(git.run(root, ["hold", "rejected"], { lane: "background" })).rejects.toMatchObject({
      kind: "queue-full",
    });
    await started("a");
    const i = git.run(root, ["hold", "i"]);
    await started("i");
    expect(present("start-b")).toBe(false);
    const j = git.run(root, ["hold", "j"]);
    release("a");
    await a;
    await started("j");
    expect(present("start-b")).toBe(false);
    release("i");
    release("j");
    await Promise.all([i, j]);
    await started("b");
    release("b");
    await b;
    expect(present("start-rejected")).toBe(false);
  });

  it("removes an aborted waiter without starting it", async () => {
    const git = runner({ maxActive: 1, maxQueued: 1 });
    const signal = new AbortController();
    const active = git.run(root, ["hold", "active"]);
    const aborted = expect(git.run(root, ["hold", "aborted"], { signal: signal.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
    signal.abort(new Error("private reason"));
    await aborted;
    await expect(git.run(root, ["hold", "pre-aborted"], { signal: signal.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
    const next = git.run(root, ["hold", "next"]);
    await started("active");
    release("active");
    await active;
    await started("next");
    expect(present("start-aborted")).toBe(false);
    expect(present("start-pre-aborted")).toBe(false);
    release("next");
    await next;
  });

  it("kills an active child on abort before launching its replacement", async () => {
    const git = runner({ maxActive: 1 });
    const signal = new AbortController();
    const active = expect(git.run(root, ["hold", "active"], { signal: signal.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
    const next = git.run(root, ["hold", "next"]);
    await started("active");
    signal.abort();
    await active;
    await started("next");
    expectGone(pid("start-active"));
    release("next");
    await next;
  });

  it("uses one deadline from admission even when queued", async () => {
    const git = runner({ maxActive: 1, deadlineMs: 700 });
    const active = expect(git.run(root, ["hold", "active"])).rejects.toMatchObject({ kind: "timeout" });
    const queued = expect(git.run(root, ["hold", "queued"])).rejects.toMatchObject({ kind: "timeout" });
    await Promise.all([active, queued]);
    expect(present("start-active")).toBe(true);
    expect(present("start-queued")).toBe(false);
    await expect(git.run(root, ["bytes"])).resolves.toMatchObject({ code: 7 });
    expectGone(pid("start-active"));
  });

  it.each(["stdout", "stderr"])("interrupts %s overflow and releases the slot after close", async (stream) => {
    const git = runner({ stdoutLimit: 64, stderrLimit: 64, maxActive: 1 });
    await expect(git.run(root, [stream, stream])).rejects.toMatchObject({ kind: `${stream}-limit` });
    await expect(git.run(root, ["bytes"])).resolves.toMatchObject({ code: 7 });
  });

  it("treats unexpected signals as transport failures", async () => {
    const git = runner();
    await expect(git.run(root, ["signal"])).rejects.toMatchObject({
      kind: "signal",
      message: expect.stringContaining("SIGTERM"),
    });
  });

  it("reports a sanitized failed start and drains other waiters", async () => {
    const git = runner({ command: { file: join(root, "private-command") }, maxActive: 1 });
    const first = git.run(root, ["private-arg"]).catch((error: unknown) => error);
    const second = git.run(root, ["other-private-arg"]).catch((error: unknown) => error);
    const errors = await Promise.all([first, second]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(GitRunnerError);
      expect(error).toMatchObject({ kind: "start", message: expect.stringContaining("ENOENT") });
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("private-");
    }
    const working = runner({ maxActive: 1 });
    await expect(working.run("\0", ["probe"])).rejects.toMatchObject({ kind: "start" });
    await expect(working.run(root, ["bytes"])).resolves.toMatchObject({ code: 7 });
  });

  it("cancels queued and active jobs on disposal and refuses new work", async () => {
    const git = runner({ maxActive: 1 });
    const active = expect(git.run(root, ["hold", "active"])).rejects.toMatchObject({ kind: "disposed" });
    const queued = expect(git.run(root, ["hold", "queued"])).rejects.toMatchObject({ kind: "disposed" });
    await started("active");
    await git.dispose();
    await Promise.all([active, queued]);
    expectGone(pid("start-active"));
    expect(present("start-queued")).toBe(false);
    await expect(git.run(root, ["bytes"])).rejects.toMatchObject({ kind: "disposed" });
    await git.dispose();
  });

  it("kills a grandchild still holding stdout after the Git wrapper has exited", async () => {
    const git = runner();
    const signal = new AbortController();
    const active = expect(git.run(root, ["orphan"], { signal: signal.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
    try {
      await vi.waitFor(() => expect(present("grandchild")).toBe(true), { timeout: 750 });
      await vi.waitFor(() => expectGone(pid("wrapper")), { timeout: 350 });
      process.kill(pid("grandchild"), 0);
      signal.abort();
      await active;
      await delay(700);
      expect(present("survived")).toBe(false);
    } finally {
      signal.abort();
      await git.dispose();
    }
  });
});

it.skipIf(groupPlatform)("fails closed on hosts without verified process groups", async () => {
  await expect(runner().run(root, ["bytes"])).rejects.toMatchObject({ kind: "unsupported-platform" });
});
