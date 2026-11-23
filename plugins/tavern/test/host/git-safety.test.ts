// @vitest-environment node
import { ChildProcess, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGit } from "../../src/host/git";
import { preserveWorktree } from "../../src/server/member-worktree";
import { draftPush, openDraft } from "../../src/host/forge";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import * as safety from "../../src/shared/git-safety";
import { serveGit } from "./git-daemon";
import { countGitLaunches, settleGitConfigClock } from "../git-launch-count";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tavern-git-safety-"))); roots.push(dir);
  const root = join(dir, "repo"), dataDir = join(dir, "data"); mkdirSync(root); mkdirSync(dataDir);
  const sentinel = join(dir, "ran"), global = join(dir, "git-global");
  const program = join(dir, "program");
  writeFileSync(program, `#!/bin/sh\ntouch ${shell(sentinel)}\nif [ "$#" -eq 0 ]; then cat; fi\n`, { mode: 0o755 });
  writeFileSync(global, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", global);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const raw = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args: string[]) => raw(root, ...args);
  git("init", "-qb", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "tracked"), "base\n"); git("add", "-A"); git("commit", "-qm", "base");
  return { dir, root, dataDir, sentinel, global, program, git, raw, run: (args: string[], cwd = root) => runGit(cwd, args, { dataDir }) };
}

it("uses the configured Git program for sync and async launches without removing the sandbox", async () => {
  const f = fixture(), configured = join(f.dir, "real-git");
  writeFileSync(configured, '#!/bin/sh\nexec git "$@"\n', { mode: 0o755 });
  const child = ChildProcess.prototype as unknown as { spawn(options: { args: string[] }): unknown };
  const launches = vi.spyOn(child, "spawn");
  let selected = configured;
  const dispose = safety.installServerGitProgram(() => selected);
  try {
    const env = await safety.gitEnvironment(f.root);
    selected = "";
    const invocation = await safety.gitInvocation(f.root, ["-C", f.root, "rev-parse", "HEAD"], env);
    if (process.platform === "darwin") {
      expect(invocation.file).toBe("/usr/bin/sandbox-exec");
      expect(invocation.args[2]).toBe(configured);
      expect(invocation.args[1]).toContain("(deny file-write*)");
    } else expect(invocation.file).toBe(configured);
    selected = configured;
    expect((await f.run(["rev-parse", "HEAD"])).stdout.trim()).toBe(f.git("rev-parse", "HEAD"));
    expect(safety.execGitSync(f.root, ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 }).trim()).toBe(f.git("rev-parse", "HEAD"));
  } finally { dispose(); }
  expect(launches.mock.calls.length).toBeGreaterThan(0);
  expect(launches.mock.calls.every(([call]) => call.args.includes(configured))).toBe(true);
});

it.each([false, true])("names the Git program setting and path instead of falling back (exists: %s)", async exists => {
  const f = fixture(), path = join(f.dir, "unavailable-git");
  if (exists) writeFileSync(path, "", { mode: 0o644 });
  await safety.withGitProgram(path, async () => {
    const expected = new RegExp("Git program.*" + path);
    await expect(f.run(["rev-parse", "HEAD"])).rejects.toThrow(expected);
    expect(() => safety.execGitSync(f.root, ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 })).toThrow(expected);
  });
});

function configValue(env: NodeJS.ProcessEnv, key: string) {
  let value: string | undefined;
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++)
    if (env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === key) value = env[`GIT_CONFIG_VALUE_${i}`];
  return value;
}

it("does not cache a config whose unchanged stat may describe multiple writes in one clock tick", async () => {
  const f = fixture(), config = join(f.root, ".git/config"), key = "filter.fixture.clean";
  const original = fs.statSync, file = original(config, { bigint: true });
  const checkedAt = Date.now() + 1000, stamp = BigInt(checkedAt - 50) * 1_000_000n;
  const clock = vi.spyOn(Date, "now").mockReturnValue(checkedAt);
  vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof original>) => {
    const stat = Reflect.apply(original, fs, args);
    return args[0] === config && args[1]?.bigint && stat ? Object.assign(stat, { mtimeNs: stamp, ctimeNs: stamp, size: file.size }) : stat;
  }) as typeof original);
  expect(configValue(await safety.gitEnvironment(f.root), key)).toBeUndefined();
  expect.soft(safety.gitConfigRevision(f.root)).toBeUndefined();
  f.git("config", key, "cat");
  expect.soft(configValue(await safety.gitEnvironment(f.root), key)).toBe("");
  clock.mockReturnValue(checkedAt + 200);
  expect(configValue(await safety.gitEnvironment(f.root), key)).toBe("");
  expect(safety.gitConfigRevision(f.root)).toBeDefined();
});

it("lists configuration only once across eight sequential Git calls", async () => {
  const f = fixture(), count = countGitLaunches();
  settleGitConfigClock();
  for (let i = 0; i < 8; i++) expect(await f.run(["rev-parse", "--verify", "HEAD"])).toMatchObject({ code: 0 });
  count("eight calls on one repository", 9, 1);
});

it.each(["local", "worktree", "include", "existing nested include", "conditional include"])("applies protections on the next call after %s config changes", async kind => {
  const f = fixture();
  settleGitConfigClock();
  let root = f.root;
  const key = "filter.fixture.clean", included = join(f.dir, "included");
  if (kind === "worktree") {
    root = join(f.dir, "linked");
    f.git("worktree", "add", "-qb", "linked", root);
    f.git("config", "extensions.worktreeConfig", "true");
  } else if (kind === "include") f.git("config", "include.path", included);
  else if (kind === "existing nested include") {
    const parent = join(f.dir, "parent");
    f.git("config", "include.path", parent);
    f.git("config", "--file", parent, "include.path", "included");
    f.git("config", "--file", included, "fixture.before", "value");
  } else if (kind === "conditional include") {
    f.git("branch", "include-enabled");
    f.git("config", "includeIf.onbranch:include-enabled.path", included);
    writeFileSync(included, "[filter \"fixture\"]\n\tclean = cat\n");
  }
  expect(configValue(await safety.gitEnvironment(root), key)).toBeUndefined();
  if (kind !== "conditional include") expect(safety.gitConfigRevision(root)).toBeDefined();
  if (kind === "local") f.git("config", key, "cat");
  else if (kind === "worktree") f.raw(root, "config", "--worktree", key, "cat");
  else if (kind === "include" || kind === "existing nested include") writeFileSync(included, "[filter \"fixture\"]\n\tclean = cat\n");
  else f.git("checkout", "-q", "include-enabled");
  expect(configValue(await safety.gitEnvironment(root), key)).toBe("");
});

it.each(["home", "xdg", "system", "environment"])("refreshes the trusted filter override when %s configuration changes", async kind => {
  const f = fixture(), key = "filter.fixture.clean";
  settleGitConfigClock();
  const home = join(f.dir, "home"), xdg = join(f.dir, "xdg"), system = join(f.dir, "git-system");
  mkdirSync(home); mkdirSync(join(xdg, "git"), { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("XDG_CONFIG_HOME", xdg);
  vi.stubEnv("GIT_CONFIG_GLOBAL", undefined);
  if (kind === "system") { vi.stubEnv("GIT_CONFIG_SYSTEM", system); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "0"); }
  f.git("config", key, "cat");
  expect(configValue(await safety.gitEnvironment(f.root), key)).toBe("");
  expect(safety.gitConfigRevision(f.root)).toBeDefined();
  const file = kind === "home" ? join(home, ".gitconfig") : kind === "xdg" ? join(xdg, "git/config") : kind === "system" ? system : f.global;
  writeFileSync(file, "[filter \"fixture\"]\n\tclean = trusted-fixture\n");
  if (kind === "environment") vi.stubEnv("GIT_CONFIG_GLOBAL", file);
  expect(configValue(safety.gitEnvironmentSync(f.root), key)).toBe("trusted-fixture");
});

it.each(["clean", "smudge", "process"])("disables an optional local %s filter", async kind => {
  const f = fixture();
  const info = kind === "process";
  writeFileSync(join(f.root, info ? ".git/info/attributes" : ".gitattributes"), "tracked filter=x\n");
  f.git("config", "filter.x." + kind, f.program);
  if (kind === "smudge") {
    expect((await f.run(["checkout-index", "-f", "tracked"])).code).toBe(0);
  } else {
    writeFileSync(join(f.root, "tracked"), "working bytes\n");
    expect(await f.run(["status", "--porcelain", "--untracked-files=no"])).toMatchObject({ code: 0, stdout: " M tracked\n" });
    expect((await f.run(["add", "--", "tracked"])).code).toBe(0);
    expect(f.git("show", ":tracked")).toBe("working bytes");
  }
  expect(existsSync(f.sentinel)).toBe(false);
});

it.each(["include", "worktree"])("disables a filter from %s config", async kind => {
  const f = fixture(), root = join(f.dir, "linked");
  f.git("worktree", "add", "-qb", "linked", root);
  if (kind === "include") {
    const include = join(f.dir, "included");
    f.git("config", "--file", include, "filter.x.clean", f.program);
    f.git("config", "include.path", include);
  } else {
    f.git("config", "extensions.worktreeConfig", "true");
    f.raw(root, "config", "--worktree", "filter.x.clean", f.program);
  }
  writeFileSync(join(f.root, ".git/info/attributes"), "tracked filter=x\n");
  writeFileSync(join(root, "tracked"), "different length\n");
  expect(await f.run(["status", "--porcelain"], root)).toMatchObject({ code: 0, stdout: " M tracked\n" });
  expect((await f.run(["add", "--", "tracked"], root)).code).toBe(0);
  expect(f.raw(root, "show", ":tracked")).toBe("different length");
  expect(existsSync(f.sentinel)).toBe(false);
});

it("fails closed rather than staging data from a required noncanonical local filter", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".git/info/attributes"), "tracked filter=git-crypt\n");
  f.git("config", "filter.git-crypt.clean", f.program);
  f.git("config", "filter.git-crypt.smudge", "git-crypt smudge");
  f.git("config", "filter.git-crypt.required", "true");
  writeFileSync(join(f.root, "tracked"), "sensitive plaintext\n");
  const add = await f.run(["add", "--", "tracked"]);
  expect(add.code).not.toBe(0);
  expect(add.stderr).toMatch(/clean filter.*failed/);
  expect(f.git("show", ":tracked")).toBe("base");
  expect(existsSync(f.sentinel)).toBe(false);
});

it.skipIf(spawnSync("git-lfs", ["version"], { stdio: "ignore" }).status !== 0)("keeps canonical local-only Git LFS pointers during stage and preservation", async () => {
  const f = fixture(), bin = join(f.dir, "trusted-bin"); mkdirSync(bin);
  symlinkSync(execFileSync("which", ["git-lfs"], { encoding: "utf8" }).trim(), join(bin, "git-lfs"));
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  f.git("lfs", "install", "--local");
  writeFileSync(join(f.root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(f.root, "asset.bin"), "preserved asset\n");
  expect(await preserveWorktree(f.root)).toMatchObject({ status: "committed" });
  expect(f.git("show", "HEAD:asset.bin")).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:/);
  writeFileSync(join(f.root, "asset.bin"), "staged asset\n");
  expect((await f.run(["add", "--", "asset.bin"])).code).toBe(0);
  expect(f.git("show", ":asset.bin")).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:/);
  if (process.platform === "darwin") {
    const outside = join(f.dir, "forbidden-lfs-storage");
    f.git("config", "lfs.storage", outside);
    writeFileSync(join(f.root, "asset.bin"), "new object with outside storage\n");
    expect((await f.run(["add", "--", "asset.bin"])).code).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
  }
});

it("retains the user's own filter settings despite a local override", async () => {
  const f = fixture();
  f.git("config", "--file", f.global, "filter.lfs.clean", "sed s/dirty/normalized/");
  f.git("config", "filter.lfs.clean", f.program);
  f.git("config", "filter.lfs.required", "true");
  writeFileSync(join(f.root, ".git/info/attributes"), "tracked filter=lfs\n");
  writeFileSync(join(f.root, "tracked"), "dirty\n");
  expect((await f.run(["add", "--", "tracked"])).code).toBe(0);
  expect(f.git("show", ":tracked")).toBe("normalized");
  expect(existsSync(f.sentinel)).toBe(false);
});

it.each(["external", "x.command", "x.textconv"])("does not execute diff.%s", async key => {
  const f = fixture();
  writeFileSync(join(f.root, ".git/info/attributes"), "tracked diff=x\n");
  writeFileSync(join(f.root, "tracked"), "updated content\n");
  f.git("add", "-A"); f.git("commit", "-qm", "update");
  f.git("config", "diff." + key, f.program);
  for (const args of [["diff", "HEAD~", "HEAD"], ["show", "HEAD"], ["log", "-1", "-p"]])
    expect(await f.run(args)).toMatchObject({ code: 0, stdout: expect.stringContaining("+updated content") });
  expect(existsSync(f.sentinel)).toBe(false);
});

it("does not sign commits or verify log signatures using repository programs", async () => {
  const f = fixture();
  f.git("config", "commit.gpgSign", "true"); f.git("config", "gpg.program", f.program);
  const commit = await f.run(["commit", "--allow-empty", "-qm", "unsigned"]);
  expect(existsSync(f.sentinel)).toBe(false);
  expect(commit.code).toBe(0);
  const text = f.git("cat-file", "commit", "HEAD");
  const signed = text.replace("\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n test-only\n -----END PGP SIGNATURE-----\n\n");
  const oid = execFileSync("git", ["-C", f.root, "hash-object", "-t", "commit", "-w", "--stdin"], { input: signed, encoding: "utf8" }).trim();
  f.git("config", "log.showSignature", "true");
  expect(await f.run(["log", "-1", "--format=%s", oid])).toMatchObject({ code: 0, stdout: "unsigned\n" });
  expect(existsSync(f.sentinel)).toBe(false);
});

it("reports preflight failures and preserves retryable Git timeouts", async () => {
  const f = fixture();
  await expect(f.run(["status"], join(f.dir, "missing"))).rejects.toMatchObject({ code: "git-preflight" });
  vi.spyOn(safety, "gitEnvironment").mockRejectedValueOnce(Object.assign(new Error("slower than the test budget"), { killed: true, signal: "SIGTERM" }));
  await expect(f.run(["status"])).rejects.toMatchObject({ code: "git-timeout", retryable: true });
});

it("does not export GIT_WORK_TREE for an explicit Git directory", () => {
  const f = fixture(), gitDir = join(f.root, ".git");
  f.git("config", "core.worktree", f.dir);
  expect(safety.gitEnvironmentSync(gitDir, { gitDir })).not.toHaveProperty("GIT_WORK_TREE");
});

it("ignores an outside core.worktree", async () => {
  const f = fixture(), outside = join(f.dir, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "unrelated"), "external\n");
  f.git("config", "core.worktree", outside);
  expect(await f.run(["rev-parse", "--show-toplevel"])).toMatchObject({ code: 0, stdout: f.root + "\n" });
  expect(await f.run(["status", "--porcelain"])).toMatchObject({ code: 0, stdout: "" });
});

it.each(["GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF"])("refuses a caller's %s extra", async key => {
  const f = fixture();
  await expect(runGit(f.root, ["status"], { dataDir: f.dataDir, env: { [key]: "0" } })).rejects.toThrow(new RegExp(key));
});

it("preserves inherited config entries and appends guards after them", async () => {
  const f = fixture();
  vi.stubEnv("GIT_CONFIG_COUNT", "2");
  vi.stubEnv("GIT_CONFIG_KEY_0", "example.feature"); vi.stubEnv("GIT_CONFIG_VALUE_0", "preserved");
  vi.stubEnv("GIT_CONFIG_KEY_1", "core.pager"); vi.stubEnv("GIT_CONFIG_VALUE_1", f.program);
  expect(await f.run(["config", "--get", "example.feature"])).toMatchObject({ code: 0, stdout: "preserved\n" });
  expect(await f.run(["config", "--get", "core.pager"])).toMatchObject({ code: 0, stdout: "cat\n" });
});

it("does not enter a dirty submodule's filter from status or worktree diff", async () => {
  const f = fixture(), submodule = join(f.root, "module"), head = f.git("rev-parse", "HEAD");
  f.git("clone", "-q", ".", submodule);
  f.git("update-index", "--add", "--cacheinfo", "160000," + head + ",module"); f.git("commit", "-qm", "gitlink");
  f.raw(submodule, "config", "filter.x.clean", f.program);
  writeFileSync(join(submodule, ".git/info/attributes"), "tracked filter=x\n");
  writeFileSync(join(submodule, "tracked"), "dirty submodule\n");
  for (const args of [["status", "--porcelain"], ["diff"]])
    expect(await f.run(args)).toMatchObject({ code: 0, stdout: "" });
  expect(existsSync(f.sentinel)).toBe(false);
});

it.each(["credential.helper", "credential.url.helper"])("does not call a local %s", async key => {
  const f = fixture(), server = createServer((_req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address()!, url = "http://127.0.0.1:" + (typeof address === "string" ? address : address.port) + "/repo";
    f.git("config", key === "credential.helper" ? key : "credential." + url + ".helper", "!" + f.program);
    const result = await f.run(["ls-remote", "--", url]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/terminal prompts disabled|could not read Username/);
    expect(existsSync(f.sentinel)).toBe(false);
  } finally { server.close(); }
});

it("does not run a configured SSH command or ext transport", async () => {
  const f = fixture(), bin = join(f.dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  f.git("config", "core.sshCommand", f.program);
  expect((await f.run(["ls-remote", "--", "ssh://fixture.invalid/repository"])).code).not.toBe(0);
  expect(existsSync(f.sentinel)).toBe(false);
  f.git("config", "protocol.ext.allow", "always");
  f.git("remote", "add", "ext", "ext::" + f.program);
  for (const args of [["ls-remote", "ext"], ["fetch", "ext", "main"], ["push", "ext", "HEAD:refs/heads/topic"]])
    expect(await f.run(args)).toMatchObject({ code: expect.any(Number), stderr: expect.stringMatching(/transport 'ext' not allowed/) });
  expect(existsSync(f.sentinel)).toBe(false);
});

it("uses the default upload and receive programs on Tavern's fetch and draft push", async () => {
  const f = fixture(), remote = join(f.root, ".git", "remote.git"), bare = join(f.dir, "bare.git"), base = f.git("rev-parse", "HEAD");
  f.git("clone", "-q", "--bare", ".", remote);
  f.git("init", "-q", "--bare", bare);
  f.raw(bare, "remote", "add", "origin", remote);
  f.raw(bare, "config", "remote.origin.uploadpack", f.program);
  const fetched = await f.run(["fetch", "origin", "main"], bare);
  expect(fetched.code, fetched.stderr).toBe(0);
  expect(f.raw(bare, "rev-parse", "FETCH_HEAD")).toBe(base);
  f.git("remote", "add", "origin", remote);
  f.git("config", "remote.origin.uploadpack", f.program);
  f.git("config", "remote.origin.receivepack", f.program);
  writeFileSync(join(f.root, ".git/hooks/pre-push"), `#!/bin/sh\nexec "${f.program}" pre-push\n`, { mode: 0o755 });
  const pushed = await f.run(["push", "origin", "HEAD:refs/heads/pack-guard"]);
  expect(pushed.code, pushed.stderr).toBe(0);
  expect(f.raw(remote, "rev-parse", "refs/heads/pack-guard")).toBe(base);
  const registry = new HostRegistry(f.dataDir), authority = { placementId: "draft", generation: 1, endpointId: "home", operationId: "push" };
  const server = await serveGit(remote);
  try {
    registry.registerEndpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint: { hostId: "host", environmentId: "env", root: f.root }, ownerThreadId: null, access: "home-import", git: "full", workspaceKind: null, objectFormat: "sha1", allowedRefs: [], draft: { remote: server.url, branch: "topic", base: "main", sourceBase: "main" } });
    await inspectHost(registry, authority);
    const result = await draftPush(registry, { ...authority, sha: base, tree: f.git("rev-parse", "HEAD^{tree}"), previous: null }, new AbortController().signal);
    expect(result).toMatchObject({ pushed: true });
    expect(f.raw(remote, "rev-parse", "refs/heads/topic")).toBe(base);
    expect(existsSync(f.sentinel)).toBe(false);
  } finally { await server.close(); }
});

it.each(["insteadOf", "pushInsteadOf", "pushurl"])("refuses a draft whose effective URL changes through %s", async kind => {
  const f = fixture(), remote = join(f.root, ".git", "test-remote.git"), redirected = join(f.root, ".git", "redirected.git");
  f.git("clone", "-q", "--bare", ".", remote); f.git("clone", "-q", "--bare", ".", redirected);
  const server = await serveGit(remote);
  try {
    if (kind === "pushurl") {
      f.git("config", `remote.${server.url}.url`, server.url);
      f.git("config", `remote.${server.url}.pushurl`, redirected);
    } else f.git("config", `url.${redirected}.${kind}`, server.url);
    const registry = new HostRegistry(f.dataDir), authority = { placementId: "draft", generation: 1, endpointId: "home", operationId: "push" };
    registry.registerEndpoint({ placementId: authority.placementId, generation: 1, endpointId: authority.endpointId, endpoint: { hostId: "host", environmentId: "env", root: f.root }, ownerThreadId: null, access: "home-import", git: "full", workspaceKind: null, objectFormat: "sha1", allowedRefs: [], draft: { remote: server.url, branch: "topic", base: "main", sourceBase: "main" } });
    await inspectHost(registry, authority);
    await expect(draftPush(registry, { ...authority, sha: f.git("rev-parse", "HEAD"), tree: f.git("rev-parse", "HEAD^{tree}"), previous: null }, new AbortController().signal)).rejects.toThrow(/remote.*(?:changed|registered|rewrite)/i);
    expect(f.raw(redirected, "for-each-ref", "refs/heads/topic")).toBe("");
  } finally { await server.close(); }
});

it.each([["uploadpack", "git-upload-pack", ["ls-remote", "origin"]], ["receivepack", "git-receive-pack", ["push", "origin", "HEAD:refs/heads/topic"]]] as const)("honours the user's own %s command", async (key, program, args) => {
  const f = fixture(), remote = join(f.root, ".git", "test-remote.git"), marker = join(f.root, ".git", "trusted-ran"), wrapper = join(f.dir, "trusted-pack");
  f.git("clone", "-q", "--bare", ".", remote); f.git("remote", "add", "origin", remote);
  writeFileSync(wrapper, `#!/bin/sh\nprintf trusted > '${marker}'\nexec ${program} "$@"\n`, { mode: 0o755 });
  f.git("config", "--file", f.global, "remote.origin." + key, wrapper);
  f.git("config", "remote.origin." + key, f.program);
  expect(await f.run([...args])).toMatchObject({ code: 0 });
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(f.sentinel)).toBe(false);
});

it("does not use a repository's Git protocol proxy even though the first match normally wins", async () => {
  const f = fixture();
  f.git("config", "core.gitProxy", f.program);
  const result = await f.run(["ls-remote", "--", "git://127.0.0.1:0/repo"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).not.toMatch(/cannot (?:run|start proxy) none/);
  expect(existsSync(f.sentinel)).toBe(false);
});

it("does not run config-defined hooks on Git versions that support them", async () => {
  const f = fixture();
  f.git("config", "hook.fixture.command", f.program + " hook");
  f.git("config", "hook.fixture.event", "post-commit");
  expect((await f.run(["commit", "--allow-empty", "-qm", "no hooks"])).code).toBe(0);
  expect(f.git("log", "-1", "--format=%s")).toBe("no hooks");
  expect(existsSync(f.sentinel)).toBe(false);
});

it("disables a user-global config-defined hook even when it can write inside the checkout", async () => {
  const f = fixture(), hook = join(f.dir, "global-hook"), marker = join(f.root, "global-hook-ran");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  f.git("config", "--file", f.global, "hook.fixture-global.command", hook);
  f.git("config", "--file", f.global, "hook.fixture-global.event", "post-commit");
  expect((await f.run(["commit", "--allow-empty", "-qm", "no global hooks"])).code).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

it("passes Git pins to a forge command without changing its locale or exporting GIT_WORK_TREE", async () => {
  const f = fixture();
  vi.stubEnv("LC_ALL", "en_US.UTF-8");
  f.git("config", "core.fsmonitor", f.program);
  f.git("config", "core.worktree", f.dir);
  expect(await openDraft(f.root, { kind: "command", id: "fixture", name: "Fixture", enabled: true, open: "test \"$LC_ALL\" = en_US.UTF-8 && test -z \"${GIT_WORK_TREE+x}\" && git status --porcelain && printf 'https://example.invalid/pull/1\\n'" }, { remote: "example.invalid/owner/repo", base: "main", head: "topic", title: "Title", body: "Body" })).toMatchObject({ ok: true, url: "https://example.invalid/pull/1" });
  expect(existsSync(f.sentinel)).toBe(false);
});
