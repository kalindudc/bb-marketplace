// @vitest-environment node
import { gitEnvironmentSync } from "../../src/shared/git-safety";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostContract, type Authority } from "../../src/host-contract";
import * as gitHost from "../../src/host/git";
import * as processModule from "../../src/host/process";
import { hostCallTimeoutMs } from "../../src/host/client";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "source-base-"))); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo); mkdirSync(join(root, "data"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "worker", "--object-format=" + format); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "tracked"), "base"); git("add", "tracked"); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "tracked"), "head"); git("commit", "-qam", "head"); const head = git("rev-parse", "HEAD");
  const registry = new HostRegistry(join(root, "data")), authority: Authority = { placementId: "source-placement", generation: 1, endpointId: "source", operationId: "inspect-source" };
  registry.registerEndpoint({ placementId: authority.placementId, generation: 1, endpointId: authority.endpointId, endpoint: { hostId: "source-host", environmentId: "source-environment", root: repo }, git: "full", access: "source-read", workspaceKind: null, ownerThreadId: null, objectFormat: format, allowedRefs: [] });
  const remote = (url = "https://code.example/team/repo.git", name = "origin") => { git("remote", "add", name, url); return name; };
  const upstream = (url?: string) => {
    remote(url); git("update-ref", "refs/remotes/origin/main", base); git("config", "branch.worker.remote", "origin"); git("config", "branch.worker.merge", "refs/heads/main");
  };
  return { root, repo, git, base, head, registry, authority, remote, upstream, inspect: () => inspectHost(registry, authority) };
}
function sourceState(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else result[relative(root, path)] = stat.mode + ":" + (stat.isSymbolicLink() ? readlinkSync(path) : createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(root); return result;
}
it.each(["sha1", "sha256"] as const)("pins the actual upstream merge base and fetch provenance without mutating a %s source", async format => {
  const f = fixture(format); f.upstream(); f.remote("https://other.example/repo.git", "other");
  f.git("checkout", "-qb", "remote-line", f.base); writeFileSync(join(f.repo, "remote-only"), "remote"); f.git("add", "remote-only"); f.git("commit", "-qm", "remote-line");
  f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD")); f.git("checkout", "-q", "worker");
  writeFileSync(join(f.repo, "tracked"), "dirty user edit"); writeFileSync(join(f.repo, "untracked"), "keep this too"); const before = sourceState(f.repo);
  const result = await f.inspect(); expect(result.sourceBase).toEqual({ outcome: "ok", via: "upstream", base: f.base, remoteName: "origin", remoteUrl: "https://code.example/team/repo.git", trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" });
  expect(result.head).toBe(f.head); expect(sourceState(f.repo)).toEqual(before);
});
it("falls back only to the sole remote symbolic HEAD and inverts its actual nonstandard fetch refspec", async () => {
  const f = fixture(); f.remote(); f.git("config", "remote.origin.fetch", "+refs/heads/release-*:refs/remotes/origin/tracked-*");
  f.git("update-ref", "refs/remotes/origin/tracked-stable", f.base); f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/tracked-stable");
  expect((await f.inspect()).sourceBase).toEqual({ outcome: "ok", via: "remote-head", base: f.base, remoteName: "origin", remoteUrl: "https://code.example/team/repo.git", trackingRef: "refs/remotes/origin/tracked-stable", fetchRef: "refs/heads/release-stable" });
});
it.each(["none", "several", "missing-head", "dangling-upstream", "unrelated"])("returns an explicit blocker for %s rather than guessing or changing refs", async kind => {
  const f = fixture();
  if (kind === "several") { f.remote(); f.remote("https://other.example/repo.git", "other"); }
  if (kind === "missing-head") { f.remote(); f.git("update-ref", "refs/remotes/origin/main", f.base); }
  if (kind === "dangling-upstream") { f.upstream(); f.git("update-ref", "-d", "refs/remotes/origin/main"); f.git("update-ref", "refs/remotes/origin/fallback", f.base); f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/fallback"); }
  if (kind === "unrelated") { f.upstream(); const unrelated = f.git("commit-tree", f.git("rev-parse", "HEAD^{tree}"), "-m", "unrelated"); f.git("update-ref", "refs/remotes/origin/main", unrelated); }
  const before = sourceState(f.repo), result = await f.inspect(); expect(result.sourceBase).toMatchObject({ outcome: "unavailable", code: expect.stringContaining("source-base"), message: expect.stringMatching(/upstream|remote|ref|ancestor/i), retryable: false }); expect(sourceState(f.repo)).toEqual(before);
});
it("uses Git's exact configured tracking ref rather than assuming the remote branch's local spelling", async () => {
  const f = fixture(); f.upstream(); f.git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/not-main"); f.git("update-ref", "refs/remotes/origin/not-main", f.base);
  expect((await f.inspect()).sourceBase).toMatchObject({ outcome: "ok", trackingRef: "refs/remotes/origin/not-main", fetchRef: "refs/heads/main", base: f.base });
});
it("does not lazily fetch a missing promised commit or change the source even under hostile ambient fetch settings", async () => {
  const f = fixture(); f.upstream(join(f.root, "unavailable-origin.git")); f.git("config", "core.repositoryformatversion", "1"); f.git("config", "extensions.partialclone", "origin"); f.git("config", "remote.origin.promisor", "true");
  rmSync(join(f.repo, ".git/objects", f.base.slice(0, 2), f.base.slice(2))); const before = sourceState(f.repo), trace = join(f.repo, ".git", "git-trace.jsonl");
  vi.stubEnv("GIT_NO_LAZY_FETCH", "0"); vi.stubEnv("GIT_TRACE2_EVENT", trace);
  expect((await f.inspect()).sourceBase).toMatchObject({ outcome: "unavailable" });
  const { [".git/git-trace.jsonl"]: _trace, ...after } = sourceState(f.repo);
  expect(after).toEqual(before);
  const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(event => event.event === "start")).toBe(true);
  expect(events.filter(event => event.event === "child_start" && event.argv?.includes("fetch"))).toEqual([]);
});
it("accepts stale local tracking facts without fetching or contacting the configured remote", async () => {
  const f = fixture(); f.upstream("https://unreachable.invalid/repo.git"); const original = gitHost.runGit;
  const spy = vi.spyOn(gitHost, "runGit").mockImplementation((root, args, options) => {
    expect(args[0]).not.toMatch(/^(fetch|push|update-ref|commit|add|checkout|switch|reset|merge|rebase)$/); return original(root, args, options);
  });
  const result = await f.inspect(); expect(result.sourceBase).toMatchObject({ outcome: "ok", base: f.base }); expect(spy.mock.calls.some(([, args]) => args[0] === "merge-base")).toBe(true);
});
it.each([
  ["git@ssh.example:team/repo.git?token=secret#fragment", "git@ssh.example:team/repo.git"],
  ["ssh://git:password-secret@ssh.example:2222/team/repo.git?token=secret#fragment", "ssh://git@ssh.example:2222/team/repo.git"],
  ["https://token-secret@code.example/team/repo.git?token=secret#fragment", "https://code.example/team/repo.git"],
  ["https://alice:password-secret@code.example/team/repo.git?token=secret#fragment", "https://code.example/team/repo.git"],
  ["/tmp/source-base-upstream.git", "/tmp/source-base-upstream.git"],
  ["file:///tmp/source-base-upstream.git", "file:///tmp/source-base-upstream.git"],
])("preserves transport while removing credentials from %s", async (url, expected) => {
  const f = fixture(); f.upstream(url); const result = await f.inspect(); expect(result.sourceBase).toMatchObject({ outcome: "ok", remoteUrl: expected }); expect(JSON.stringify(result)).not.toMatch(/password-secret|token-secret|token=secret|alice/);
});
it("uses the fetch URL after Git rewrites, never the unrelated push URL", async () => {
  const f = fixture(); f.upstream("short:repo.git"); f.git("config", "url.ssh://git@fetch.example/team/.insteadOf", "short:"); f.git("remote", "set-url", "--push", "origin", "https://push.example/unrelated/repo.git");
  expect((await f.inspect()).sourceBase).toMatchObject({ outcome: "ok", remoteUrl: "ssh://git@fetch.example/team/repo.git" });
});
it("blocks ambiguous inverse refspecs rather than inventing the actual remote branch", async () => {
  const f = fixture(); f.remote(); f.git("config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/remotes/origin/*");
  f.git("update-ref", "refs/remotes/origin/main", f.base); f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  expect((await f.inspect()).sourceBase).toMatchObject({ outcome: "unavailable", retryable: false });
});
it("does not execute unsafe remote helpers or leak their command in a blocker", async () => {
  const f = fixture(); f.upstream("ext::sh -c secret-command"); const result = await f.inspect(); expect(result.sourceBase).toMatchObject({ outcome: "unavailable", retryable: false }); expect(JSON.stringify(result)).not.toContain("secret-command");
});
it("propagates generation revocation rather than downgrading it to unavailable metadata", async () => {
  const f = fixture(); f.upstream(); const original = gitHost.runGit;
  vi.spyOn(gitHost, "runGit").mockImplementation((root, args, options) => {
    if (args[0] === "merge-base") f.registry.revokePlacement({ placementId: f.authority.placementId, generation: 1, reason: "cancel inspection" });
    return original(root, args, options);
  });
  await expect(f.inspect()).rejects.toThrow(/placement-revoked/);
});
it("bounds strict base provenance and ties the base object format to inspection while supporting old workers", async () => {
  const f = fixture(); f.upstream(); const result = await f.inspect(); expect(result.sourceBase?.outcome).toBe("ok");
  const { sourceBase, ...oldWorker } = result; expect(hostContract.inspect.output.safeParse(oldWorker).success).toBe(true);
  expect(hostContract.inspect.output.safeParse({ ...result, sourceBase: { ...sourceBase, extra: true } }).success).toBe(false);
  expect(hostContract.inspect.output.safeParse({ ...result, sourceBase: { ...sourceBase, remoteUrl: "x".repeat(1025) } }).success).toBe(false);
  expect(hostContract.inspect.output.safeParse({ ...result, sourceBase: { ...sourceBase, base: "a".repeat(64) } }).success).toBe(false);
});

it("keeps merge-base timeouts distinct and names the step", async () => {
  const f = fixture(); f.upstream(); const original = gitHost.runGit;
  vi.spyOn(gitHost, "runGit").mockImplementation((root,args,options) => {
    if (args[0] === "merge-base") {
      expect(options.timeoutMs).toBeGreaterThanOrEqual(30_000);
      return Promise.reject(Object.assign(new Error("Git merge-base exceeded its deadline."), { code: "git-timeout", retryable: true }));
    }
    return original(root,args,options);
  });
  await expect(f.inspect()).rejects.toMatchObject({ code: "git-timeout", message: expect.stringContaining("merge-base") });
});

it("caps cumulative Git work and names the slowest step before the host deadline", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "budget-"));
  mkdirSync(join(dataDir, "empty-hooks"));
  let clock = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const process = vi.spyOn(processModule, "runProcess").mockImplementation(async (_program, args, options) => {
    if (args.includes("status")) clock += 270_000;
    else if (args.includes("add")) { expect(options.timeoutMs).toBeLessThanOrEqual(30_000); clock += 31_000; }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  });
  try {
    const budget = (gitHost as typeof gitHost & { withGitDeadline: (work: () => Promise<void>) => Promise<void> }).withGitDeadline;
    expect(budget).toBeTypeOf("function");
    await expect(budget(async () => {
      await gitHost.git(dataDir, ["status"], { dataDir, timeoutMs: 300_000 });
      await gitHost.git(dataDir, ["add", "-A"], { dataDir, timeoutMs: 300_000 });
    })).rejects.toMatchObject({ code: "git-timeout", message: expect.stringContaining("status") });
    expect(process).toHaveBeenCalledTimes(2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

it("aborts the shared Git deadline even while waiting for the checkout lock", async () => {
  vi.useFakeTimers();
  try {
    const work = (gitHost.withGitDeadline as (work: (signal?: AbortSignal) => Promise<void>) => Promise<void>)(signal => new Promise((_resolve,reject) => {
      if (!signal) return reject(new Error("No operation deadline signal"));
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    const result = expect(work).rejects.toMatchObject({ code: "git-timeout", message: expect.stringContaining("metadata") });
    await vi.advanceTimersByTimeAsync(300_000);
    await result;
  } finally { vi.useRealTimers(); }
});

it.each(["member-write","home-import"] as const)("keeps %s inspect usable after source metadata times out",async access=>{
  const f=fixture();f.upstream();
  f.registry.registerEndpoint({placementId:"other",generation:1,endpointId:"other",endpoint:{hostId:"other-host",environmentId:"other-env",root:f.repo},ownerThreadId:access==="member-write"?"member":null,git:"full",access,workspaceKind:access==="member-write"?"dedicated-machine":null,objectFormat:"sha1",allowedRefs:access==="member-write"?["refs/heads/worker"]:[]});
  const original=gitHost.runGit;
  vi.spyOn(gitHost,"runGit").mockImplementation((root,args,options)=>args[0]==="remote"?Promise.reject(Object.assign(new Error("Git remote exceeded its deadline."),{code:"git-timeout",retryable:true})):original(root,args,options));
  expect(await inspectHost(f.registry,{placementId:"other",generation:1,endpointId:"other",operationId:"inspect"})).toMatchObject({sourceBase:{outcome:"unavailable",code:"git-timeout"}});
});
it("suppresses ambient raw-diff ellipses",()=>{
  const f=fixture();vi.stubEnv("GIT_PRINT_SHA1_ELLIPSIS","yes");
  expect(gitEnvironmentSync(f.repo).GIT_PRINT_SHA1_ELLIPSIS).toBe("no");
});

it.each([["carryStart",200_000],["importCommit",900_000],["carryDelete",undefined],["carryFinish",undefined]] as const)("expires %s inside its own host budget",async(method,networkTimeoutMs)=>{
  vi.useFakeTimers();
  try {
    const timeoutMs=hostCallTimeoutMs(method,{networkTimeoutMs})-10_000;
    let bounded!:AbortSignal;
    const outcome=gitHost.withGitDeadline(signal=>new Promise<void>((_resolve,reject)=>{
      bounded=signal;signal.addEventListener("abort",()=>reject(new Error("operation aborted")),{once:true});
    }),undefined,timeoutMs).catch(error=>error);
    const first=Math.min(300_000,timeoutMs-1);
    await vi.advanceTimersByTimeAsync(first);expect(bounded.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(timeoutMs-first);
    expect(await outcome).toMatchObject({code:"git-timeout"});
  } finally {vi.useRealTimers();}
});
