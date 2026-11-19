// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGit } from "../../src/host/git";
import * as safety from "../../src/shared/git-safety";

const roots: string[] = [];
const mac = process.platform === "darwin";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "tavern-contained-git-"))); roots.push(dir);
  const repo = join(dir, "repo"), dataDir = join(dir, "data"), sentinel = join(dir, "escaped"), script = join(dir, "program");
  fs.mkdirSync(dataDir);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1"); vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  const raw = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args: string[]) => raw(repo, ...args);
  raw(dir, "init", "-qb", "main", repo); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(join(repo, "tracked"), "base\n"); git("add", "-A"); git("commit", "-qm", "base");
  fs.writeFileSync(script, `#!/bin/sh\nprintf ran > '${sentinel}' || { printf 'fixture write refused\n' >&2; exit 1; }\ncase "$#" in 0) cat ;; 1) test ! -f "$1" || cat "$1" ;; esac\n`, { mode: 0o755 });
  const attrs = (text: string, cwd = repo) => fs.writeFileSync(join(cwd, ".git/info/attributes"), text + "\n");
  const dirty = (cwd = repo) => {
    fs.writeFileSync(join(cwd, "tracked"), "edit\n");
    fs.utimesSync(join(cwd, "tracked"), 1000, 1000);
  };
  return { dir, repo, sentinel, script, raw, git, attrs, dirty, run: (args: string[]) => runGit(repo, args, { dataDir }) };
}
function withoutGitGuards() {
  vi.spyOn(safety, "gitEnvironment").mockImplementation(async () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }));
  vi.spyOn(safety, "gitArguments").mockImplementation(args => [...args]);
}
function expectRefused(result: { stderr: string }, sentinel: string) {
  expect(fs.existsSync(sentinel)).toBe(false);
  expect(result.stderr).toMatch(/operation not permitted|permission denied/i);
}

it.skipIf(!mac).each(["filter", "fsmonitor", "hook", "textconv", "ssh"])("contains a checkout's %s even without the Git guards", async vector => {
  const f = fixture(); withoutGitGuards();
  let args: string[];
  switch (vector) {
    case "filter": f.git("config", "filter.fixture.clean", f.script); f.git("config", "filter.fixture.required", "true"); f.attrs("tracked filter=fixture"); f.dirty(); args = ["add", "--", "tracked"]; break;
    case "fsmonitor": f.git("config", "core.fsmonitor", f.script); args = ["status", "--porcelain"]; break;
    case "hook": fs.copyFileSync(f.script, join(f.repo, ".git/hooks/pre-commit")); args = ["commit", "--allow-empty", "-qm", "hook"]; break;
    case "textconv": f.git("config", "diff.fixture.textconv", f.script); f.attrs("tracked diff=fixture"); f.dirty(); args = ["diff", "HEAD"]; break;
    default: f.git("config", "core.sshCommand", f.script); f.git("config", "ssh.variant", "ssh"); args = ["ls-remote", "ssh://127.0.0.1:1/repo"];
  }
  expectRefused(await f.run(args), f.sentinel);
});

it.skipIf(!mac)("contains a credential helper on a network-enabled ls-remote", async () => {
  const f = fixture(); withoutGitGuards();
  const server = createServer((_req, reply) => { reply.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }); reply.end(); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    f.git("config", "credential.helper", "!" + f.script);
    expectRefused(await f.run(["ls-remote", `http://127.0.0.1:${address.port}/repo`]), f.sentinel);
  } finally { server.close(); }
});

it.skipIf(!mac)("contains a program added by a background writer after the actual config read", async () => {
  const f = fixture(), real = safety.gitEnvironment;
  f.attrs("tracked filter=fixture"); f.dirty();
  let inject: (() => void) | undefined, release: (() => void) | undefined, attempts = 0;
  const writer = setInterval(() => { if (!inject) return; inject(); inject = undefined; attempts++; release?.(); }, 5);
  vi.spyOn(safety, "gitEnvironment").mockImplementation(async (...args) => {
    const env = await real(...args);
    await new Promise<void>(done => { release = done; inject = () => f.git("config", "filter.fixture.clean", f.script); });
    return env;
  });
  try {
    for (let i = 0; i < 3; i++) {
      const result = await f.run(["status", "--porcelain"]);
      expectRefused(result, f.sentinel);
      f.git("config", "--unset", "filter.fixture.clean");
    }
    expect(attempts).toBe(3);
  } finally { clearInterval(writer); }
});

it.skipIf(!mac)("contains an unguarded nested Git process started by add -A", async () => {
  const f = fixture(), nested = join(f.repo, "module");
  f.git("clone", "-q", ".", nested);
  f.git("update-index", "--add", "--cacheinfo", "160000," + f.git("rev-parse", "HEAD") + ",module"); f.git("commit", "-qm", "gitlink");
  f.raw(nested, "config", "filter.fixture.clean", f.script); f.attrs("tracked filter=fixture", nested); f.dirty(nested);
  expectRefused(await f.run(["add", "-A"]), f.sentinel);
});

it.skipIf(!mac)("denies loopback connections from a status filter", async () => {
  const f = fixture(); withoutGitGuards();
  let requests = 0;
  const server = createServer((_req, reply) => { requests++; reply.end("unexpected"); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    f.git("config", "filter.fixture.clean", `/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:${address.port}/ >&2; cat`);
    f.attrs("tracked filter=fixture"); f.dirty();
    const status = await f.run(["status", "--porcelain"]);
    expect(status.stdout).toBe(" M tracked\n");
    expect(status.stderr).toMatch(/failed to connect|could not connect|operation not permitted/i);
    expect(requests).toBe(0);
  } finally { server.close(); }
});

it.skipIf(!mac)("fetches a local remote and pushes only to a local remote inside an allowed root", async () => {
  const f = fixture(), sibling = join(f.dir, "peer.git"), allowed = join(f.repo, ".git", "peer.git"), oid = f.git("rev-parse", "HEAD");
  f.git("clone", "--bare", "-q", ".", sibling); f.git("init", "--bare", "-q", allowed);
  expect(await f.run(["fetch", sibling, "refs/heads/main:refs/remotes/peer/main"])).toMatchObject({ code: 0 });
  expect(f.git("rev-parse", "refs/remotes/peer/main")).toBe(oid);
  expect(await f.run(["push", allowed, "HEAD:refs/heads/topic"])).toMatchObject({ code: 0 });
  expect(f.raw(allowed, "rev-parse", "refs/heads/topic")).toBe(oid);
  const refused = await f.run(["push", sibling, "HEAD:refs/heads/topic"]);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toMatch(/unable to (create|start)|permission denied|operation not permitted/i);
});

it.skipIf(!mac)("allows the known_hosts file, not other files in .ssh, for network Git", async () => {
  const f = fixture(), home = join(f.dir, "home"), ssh = join(home, ".ssh");
  fs.mkdirSync(ssh, { recursive: true }); vi.stubEnv("HOME", home);
  const known = join(ssh, "known_hosts"), config = join(ssh, "config");
  fs.writeFileSync(config, "keep\n");
  fs.writeFileSync(f.script, `#!/bin/sh\nprintf fixture > '${known}'\nprintf refused > '${config}'\nexit 1\n`, { mode: 0o755 });
  f.git("config", "core.sshCommand", f.script); f.git("config", "ssh.variant", "ssh");
  withoutGitGuards();
  expect((await f.run(["ls-remote", "ssh://127.0.0.1:1/repo"])).stderr).toMatch(/operation not permitted|permission denied/i);
  expect(fs.readFileSync(known, "utf8")).toBe("fixture");
  expect(fs.readFileSync(config, "utf8")).toBe("keep\n");
});

it.skipIf(!mac)("stages in a linked checkout and grants only the registered private index", async () => {
  const f = fixture(), linked = join(f.dir, "linked"), index = join(f.dir, "private-index");
  f.git("worktree", "add", "-qb", "topic", linked);
  fs.writeFileSync(join(linked, "tracked"), "linked change\n");
  const dataDir = join(f.dir, "data");
  expect(await runGit(linked, ["add", "tracked"], { dataDir })).toMatchObject({ code: 0 });
  expect(f.raw(linked, "show", ":tracked")).toBe("linked change");
  const extra = { GIT_INDEX_FILE: index };
  expect((await runGit(linked, ["read-tree", "HEAD"], { dataDir, env: extra })).code).not.toBe(0);
  expect(fs.existsSync(index)).toBe(false);
  expect(await runGit(linked, ["read-tree", "HEAD"], { dataDir, env: extra, privateIndex: index })).toMatchObject({ code: 0 });
  expect(fs.existsSync(index)).toBe(true);
  expect(fs.existsSync(index + ".lock")).toBe(false);
});

it.skipIf(!mac).each(["gitfile", "commondir"])("does not grant outside writes through a tampered %s", async pointer => {
  const f = fixture(), linked = join(f.dir, "linked"), victim = join(f.dir, "victim"), dataDir = join(f.dir, "data");
  f.git("worktree", "add", "-qb", "topic", linked);
  f.git("clone", "-q", ".", victim);
  const gitDir = f.raw(linked, "rev-parse", "--absolute-git-dir"), commonDir = join(f.repo, ".git");
  const index = join(pointer === "gitfile" ? join(victim, ".git") : gitDir, "index"), before = fs.readFileSync(index);
  if (pointer === "gitfile") fs.writeFileSync(join(linked, ".git"), `gitdir: ${join(victim, ".git")}\n`);
  else fs.writeFileSync(join(gitDir, "commondir"), join(victim, ".git") + "\n");
  fs.writeFileSync(join(linked, "tracked"), "tampered path\n");
  const victimTree = f.raw(victim, "rev-parse", "HEAD^{tree}");
  const recorded = await runGit(linked, ["add", "tracked"], { dataDir, metadata: { gitDir, commonDir } });
  expect(recorded.code).not.toBe(0);
  expect(recorded.stderr).toMatch(/operation not permitted|permission denied/i);
  expect(f.raw(victim, "rev-parse", "HEAD^{tree}")).toBe(victimTree);
  expect(fs.readFileSync(index)).toEqual(before);
  const result = await runGit(linked, ["add", "tracked"], { dataDir });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(/outside Git metadata.*linked worktree/i);
  expect(fs.readFileSync(index)).toEqual(before);
});

it("leaves non-macOS Git uncontained", async () => {
  const f = fixture(); vi.spyOn(os, "platform").mockReturnValue("linux"); withoutGitGuards();
  f.git("config", "filter.fixture.clean", f.script); f.attrs("tracked filter=fixture"); f.dirty();
  expect((await f.run(["add", "--", "tracked"])).code).toBe(0);
  expect(fs.existsSync(f.sentinel)).toBe(true);
});

it("refuses Git on macOS when sandbox-exec is missing", async () => {
  const f = fixture(), exists = fs.existsSync;
  vi.spyOn(os, "platform").mockReturnValue("darwin");
  vi.spyOn(fs, "existsSync").mockImplementation(path => path === "/usr/bin/sandbox-exec" ? false : exists(path));
  await expect(f.run(["status", "--porcelain"])).rejects.toThrow(/macOS.*sandbox-exec.*unavailable/i);
});
