// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createTavernHostEntry } from "../../src/host/entry";
import * as snapshotModule from "../../src/host/snapshot";
import * as processModule from "../../src/host/process";
import { BLOB_MAX_BYTES, type Authority } from "../../src/host-contract";
import { inspectHost } from "../../src/host/inspect";
import { HostError, HostRegistry } from "../../src/host/registry";
import { snapshotWorktree } from "../../src/host/snapshot";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync(join(tmpdir(), "snapshot-")); roots.push(root);
  const repo = join(root, "repo"), data = join(root, "data"); mkdirSync(repo); mkdirSync(data);
  git(repo, "init", "-q", "-b", "main", "--object-format=" + format);
  git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "tracked"), "base\n"); writeFileSync(join(repo, ".gitignore"), "ignored\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const registry = new HostRegistry(data), authority: Authority = { placementId: "source", generation: 1, endpointId: "source", operationId: "snapshot" };
  registry.registerEndpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint: { hostId: "source-host", environmentId: "source-env", root: repo }, ownerThreadId: "keeper", access: "source-read", git: "full", workspaceKind: null, objectFormat: format, allowedRefs: [] });
  await inspectHost(registry, authority);
  return { repo, registry, authority, base: git(repo, "rev-parse", "HEAD") };
}
function before(repo: string) {
  return { index: readFileSync(join(repo, ".git/index")), head: readFileSync(join(repo, ".git/HEAD")), refs: git(repo, "show-ref"), stash: git(repo, "stash", "list"), stashRef: existsSync(join(repo, ".git/refs/stash")) ? readFileSync(join(repo, ".git/refs/stash")) : null,
    files: ["tracked", "untracked", "ignored"].map(path => existsSync(join(repo, path)) ? readFileSync(join(repo, path)) : null) };
}
it.each(["sha1", "sha256"] as const)("captures exact %s dirty content deterministically without changing user state", async format => {
  const f = await fixture(format);
  writeFileSync(join(f.repo, "tracked"), "stash\n"); git(f.repo, "stash", "push", "-qm", "existing stash");
  writeFileSync(join(f.repo, "tracked"), "staged\n"); git(f.repo, "add", "tracked");
  writeFileSync(join(f.repo, "tracked"), "working\n"); writeFileSync(join(f.repo, "untracked"), "new\n"); writeFileSync(join(f.repo, "ignored"), "private\n");
  const original = before(f.repo);
  const first = await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  expect(first).toMatchObject({ head: f.base, includesUncommitted: true, modifiedPaths: 1, untrackedPaths: 1 });
  expect(git(f.repo, "show", first.commit + ":tracked")).toBe("working");
  expect(git(f.repo, "show", first.commit + ":untracked")).toBe("new");
  expect(git(f.repo, "ls-tree", "--name-only", first.commit)).not.toContain("ignored\n");
  expect(git(f.repo, "rev-parse", first.commit + "^{tree}")).toBe(first.tree);
  expect(before(f.repo)).toEqual(original);
  expect(await snapshotWorktree(f.registry, { ...f.authority, base: f.base })).toEqual(first);
  expect(before(f.repo)).toEqual(original);
});
it("never refreshes the user's index or takes index.lock for touched unchanged content", async () => {
  const f = await fixture(), index = join(f.repo, ".git/index");
  const touched = new Date(Date.now() - 10_000); utimesSync(join(f.repo, "tracked"), touched, touched);
  const original = readFileSync(index), events: string[] = [];
  const watcher = watch(join(f.repo, ".git"), (_event, file) => { if (file) events.push(file.toString()); });
  try {
    expect(await snapshotWorktree(f.registry, { ...f.authority, base: f.base })).toMatchObject({ commit: f.base, includesUncommitted: false });
    expect(readFileSync(index)).toEqual(original);
    expect(events).not.toContain("index.lock");
  } finally { watcher.close(); }
});
it("captures a same-second same-size rewrite instead of trusting copied stale index stats", async () => {
  const f = await fixture(), file = join(f.repo, "tracked"), index = join(f.repo, ".git/index");
  git(f.repo, "config", "core.trustctime", "false"); git(f.repo, "config", "core.checkStat", "minimal");
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  writeFileSync(file, "bbbb"); utimesSync(file, stamp, stamp); git(f.repo, "add", "tracked");
  utimesSync(index, stamp, stamp);
  writeFileSync(file, "cccc"); utimesSync(file, stamp, stamp);
  const original = readFileSync(index);
  expect(statSync(file).mtimeMs).toBe(statSync(index).mtimeMs);
  const result = await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  expect(git(f.repo, "show", result.commit + ":tracked")).toBe("cccc");
  expect(readFileSync(index)).toEqual(original);
});
it("returns HEAD for a clean checkout", async () => {
  const f = await fixture();
  expect(await snapshotWorktree(f.registry, { ...f.authority, base: f.base })).toMatchObject({ commit: f.base, head: f.base, includesUncommitted: false, modifiedPaths: 0, untrackedPaths: 0 });
});
function guardWholeIndex(args: readonly string[]) {
  if (args.includes("ls-files") && (args.includes("--stage") || args.includes("-s") || !args.includes("--others") && !args.includes("--unmerged")) || args.includes("ls-tree") && args.includes("-r"))
    throw new Error("Whole-index listings are not allowed by this test.");
}
it("never lists the whole index while capturing a dirty checkout", async () => {
  const f = await fixture(), run = processModule.runProcess;
  const process = vi.spyOn(processModule, "runProcess").mockImplementation((program, args, options) => {
    if (program === "git") guardWholeIndex(args);
    return run(program, args, options);
  });
  writeFileSync(join(f.repo, "tracked"), "working\n");
  const original = before(f.repo);
  expect(await snapshotWorktree(f.registry, { ...f.authority, base: f.base })).toMatchObject({ includesUncommitted: true, modifiedPaths: 1 });
  expect(process.mock.calls.some(([, args]) => args.includes("ls-files") && args.includes("--unmerged"))).toBe(true);
  expect(before(f.repo)).toEqual(original);
});
it("gives inspection and temporary-index scans World-sized Git deadlines without slowing metadata", async () => {
  const process = vi.spyOn(processModule, "runProcess"), f = await fixture();
  writeFileSync(join(f.repo, "untracked"), "new\n");
  await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  const scans = process.mock.calls.filter(([program, args]) => program === "git" &&
    (args.includes("status") || args.includes("add") || args.includes("ls-files") && args.includes("--others")));
  expect(scans.length).toBeGreaterThanOrEqual(4);
  for (const [, , options] of scans) { expect(options.timeoutMs).toBeGreaterThanOrEqual(150_000); expect(options.timeoutMs).toBeLessThanOrEqual(300_000); }
  const metadata = process.mock.calls.filter(([, args]) => args.includes("rev-parse") || args.includes("symbolic-ref") || args.includes("config"));
  expect(metadata.length).toBeGreaterThan(0);
  for (const [, , options] of metadata) expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
});
it("preserves an unchanged committed gitlink without transporting it", async () => {
  const f = await fixture();
  git(f.repo, "clone", "-q", "--no-hardlinks", ".", "module");
  git(f.repo, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module");
  git(f.repo, "commit", "-qm", "gitlink base");
  const base = git(f.repo, "rev-parse", "HEAD");
  writeFileSync(join(f.repo, "tracked"), "working\n");
  const original = before(f.repo);
  const result = await snapshotWorktree(f.registry, { ...f.authority, base });
  expect(result).toMatchObject({ includesUncommitted: true, modifiedPaths: 1 });
  expect(git(f.repo, "ls-tree", result.commit, "module")).toBe(git(f.repo, "ls-tree", base, "module"));
  expect(git(f.repo, "show", result.commit + ":tracked")).toBe("working");
  expect(before(f.repo)).toEqual(original);
});
it("refuses unmerged index entries without a merge marker", async () => {
  const f = await fixture(), blob = git(f.repo, "rev-parse", "HEAD:tracked");
  execFileSync("git", ["-C", f.repo, "update-index", "--index-info"], { input: `0 ${"0".repeat(40)}\ttracked\n100644 ${blob} 1\ttracked\n100644 ${blob} 2\ttracked\n` });
  const original = before(f.repo);
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toMatchObject({ code: "unfinished-merge" });
  expect(before(f.repo)).toEqual(original);
});
it("does not write shared index files when the user's index is split", async () => {
  const f = await fixture(); git(f.repo, "update-index", "--split-index");
  const shared = () => readdirSync(join(f.repo, ".git")).filter(name => name.startsWith("sharedindex.")).map(name => [name, readFileSync(join(f.repo, ".git", name))]);
  const previous = shared(), index = readFileSync(join(f.repo, ".git/index"));
  writeFileSync(join(f.repo, "untracked"), "new\n");
  await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  expect(shared()).toEqual(previous); expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});
it("refuses an untracked nested repository with the submodule code", async () => {
  const f = await fixture(), nested = join(f.repo, "nested"); mkdirSync(nested);
  git(nested, "init", "-q"); git(nested, "config", "user.name", "Fixture"); git(nested, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(nested, "file"), "nested"); git(nested, "add", "file"); git(nested, "commit", "-qm", "nested");
  expect(git(f.repo, "ls-files", "--others", "--exclude-standard")).toBe("nested/");
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toMatchObject({ code: "submodule-unsupported" });
});
it("includes untracked paths outside the sparse cone without changing the user's index", async () => {
  const f = await fixture();
  for (const dir of ["kept", "outside"]) { mkdirSync(join(f.repo, dir)); writeFileSync(join(f.repo, dir, "tracked"), dir); }
  git(f.repo, "add", "-A"); git(f.repo, "commit", "-qm", "sparse base");
  git(f.repo, "sparse-checkout", "init", "--cone"); git(f.repo, "sparse-checkout", "set", "kept");
  mkdirSync(join(f.repo, "outside"), { recursive: true }); writeFileSync(join(f.repo, "outside/new"), "outside cone");
  const original = before(f.repo);
  const result = await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  expect(git(f.repo, "show", result.commit + ":outside/new")).toBe("outside cone");
  expect(git(f.repo, "show", result.commit + ":outside/tracked")).toBe("outside");
  expect(result).toMatchObject({ modifiedPaths: 0, untrackedPaths: 1 });
  expect(before(f.repo)).toEqual(original);
});
it("captures tracked deletions and symlinks without modifying either", async () => {
  const f = await fixture(); rmSync(join(f.repo, "tracked")); symlinkSync("target", join(f.repo, "link"));
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  expect(git(f.repo, "ls-tree", result.commit, "tracked")).toBe("");
  expect(git(f.repo, "ls-tree", result.commit, "link")).toMatch(/^120000 blob/);
  expect(git(f.repo, "show", result.commit + ":link")).toBe("target");
  expect(result).toMatchObject({ modifiedPaths: 1, untrackedPaths: 1 });
  expect(existsSync(join(f.repo, "tracked"))).toBe(false);
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});
it("refuses a newly added working-tree gitlink with an exact code", async () => {
  const f = await fixture();
  git(f.repo, "clone", "-q", "--no-hardlinks", ".", "module");
  git(f.repo, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module");
  const original = before(f.repo);
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toMatchObject({ code: "submodule-unsupported" });
  expect(before(f.repo)).toEqual(original);
});
it("refuses an over-bound file before hashing it", async () => {
  const f = await fixture(); writeFileSync(join(f.repo, "large"), ""); truncateSync(join(f.repo, "large"), BLOB_MAX_BYTES + 1);
  const index = readFileSync(join(f.repo, ".git/index"));
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toMatchObject({ code: "file-too-large" });
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});
it.each([false, true])("round-trips snapshot refusal codes and retryable=%s through the host entry", async retryable => {
  const f = await fixture(), entry = createTavernHostEntry({ artifactPath: join(f.registry.dataDir, "unused-guard.js") });
  const harness = experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir: f.registry.dataDir, tempDir: f.registry.dataDir } });
  const code = retryable ? "source-changed" : "unfinished-merge";
  if (retryable) vi.spyOn(snapshotModule, "snapshotWorktree").mockRejectedValueOnce(new HostError(code, "Source changed; retry", true));
  else writeFileSync(join(f.repo, ".git/MERGE_HEAD"), f.base + "\n");
  try {
    await expect(harness.experimental_call("snapshotWorktree", { ...f.authority, base: f.base })).resolves.toMatchObject({ outcome: "unavailable", code, retryable });
  } finally { await harness.experimental_dispose(); }
});
it("refuses an unfinished merge", async () => {
  const f = await fixture(); writeFileSync(join(f.repo, ".git/MERGE_HEAD"), f.base + "\n");
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toMatchObject({ code: "unfinished-merge" });
});

it.each(["removed", "replaced", "file-to-module", "staged-missing", "dirty"])("refuses the %s gitlink snapshot without changing the real index", async kind => {
  const f = await fixture();
  if (kind === "file-to-module") {
    writeFileSync(join(f.repo, "module"), "plain"); git(f.repo, "add", "module"); git(f.repo, "commit", "-qm", "file base");
  } else {
    git(f.repo, "clone", "-q", "--no-hardlinks", ".", "module");
    git(f.repo, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module");
    if (kind !== "staged-missing") {
      writeFileSync(join(f.repo, ".gitmodules"), '[submodule "module"]\n\tpath = module\n\turl = .\n');
      git(f.repo, "add", ".gitmodules"); git(f.repo, "commit", "-qm", "module base");
    }
  }
  const base = git(f.repo, "rev-parse", "HEAD");
  const sentinel = join(f.registry.dataDir, "submodule-filter");
  if (kind === "dirty") {
    const module = join(f.repo, "module");
    git(module, "config", "filter.fixture.clean", `touch "${sentinel}"; cat`);
    writeFileSync(join(module, ".git/info/attributes"), "tracked filter=fixture\n");
    writeFileSync(join(module, "tracked"), "dirty");
  } else {
    rmSync(join(f.repo, "module"), { recursive: true, force: true });
    if (kind === "replaced") writeFileSync(join(f.repo, "module"), "plain");
    if (kind === "file-to-module") { git(f.repo, "clone", "-q", "--no-hardlinks", ".", "module"); git(f.repo, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module"); }
  }
  const original = before(f.repo);
  await expect(snapshotWorktree(f.registry, { ...f.authority, base })).rejects.toMatchObject({ code: "submodule-unsupported" });
  expect(existsSync(sentinel)).toBe(false);
  expect(before(f.repo)).toEqual(original);
});
it("names the untracked listing when its output overflows", async () => {
  const f = await fixture(), original = processModule.runProcess;
  vi.spyOn(processModule, "runProcess").mockImplementation((program, args, options) => {
    if (args.includes("--others")) return Promise.reject(new Error("git: maxBuffer length exceeded"));
    return original(program, args, options);
  });
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toMatchObject({ code: "too-many-paths", message: expect.stringMatching(/untracked.*listing/i) });
});
it("names old Git versions before staging a snapshot", async () => {
  const f = await fixture(), original = processModule.runProcess;
  vi.spyOn(processModule, "runProcess").mockImplementation((program, args, options) => args.includes("--version")
    ? Promise.resolve({ code: 0, stdout: "git version 2.34.9\n", stderr: "", timedOut: false }) : original(program, args, options));
  await expect(snapshotWorktree(f.registry, { ...f.authority, base: f.base })).rejects.toThrow(/2\.34\.9/);
});

it.each([[["ls-files", "--stage", "-z", "--"]], [["ls-files", "-s", "-z"]], [["ls-tree", "-r", "HEAD"]]])("rejects every whole-index spelling %j in the guard", async injected => {
  const f = await fixture(), original = processModule.runProcess;
  expect(() => guardWholeIndex(injected)).toThrow(/Whole-index/);
  vi.spyOn(processModule, "runProcess").mockImplementation((program,args,options) => { if (program === "git") guardWholeIndex(args); return original(program,args,options); });
  writeFileSync(join(f.repo, "tracked"), "dirty");
  expect(await snapshotWorktree(f.registry, { ...f.authority, base: f.base })).toMatchObject({ includesUncommitted: true });
});

it("does not run repository filters when staging a private snapshot", async () => {
  const f = await fixture(), sentinel = join(f.registry.dataDir, "ran");
  git(f.repo, "config", "filter.fixture.clean", `touch "${sentinel}"; cat`);
  writeFileSync(join(f.repo, ".git/info/attributes"), "tracked filter=fixture\n");
  writeFileSync(join(f.repo, "tracked"), "changed snapshot\n");
  const snapshot = await snapshotWorktree(f.registry, { ...f.authority, base: f.base });
  expect(snapshot).toMatchObject({ includesUncommitted: true, modifiedPaths: 1 });
  expect(git(f.repo, "show", snapshot.commit + ":tracked")).toBe("changed snapshot");
  expect(existsSync(sentinel)).toBe(false);
});