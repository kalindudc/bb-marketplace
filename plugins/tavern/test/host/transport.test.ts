// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emulatedGit, realGit } from "./emulated-git";
import { gitFixtureTemplate } from "../git-fixture-template";
import { parseTreeEntries, treeObjectBytes } from "../../src/host/porcelain";
import * as processModule from "../../src/host/process";
import { BLOB_MAX_BYTES, CHUNK_BYTES, type Authority, type EndpointRegistration, type HostOutput, type TransferAuthority, type TransferRegistration } from "../../src/host-contract";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { snapshotWorktree } from "../../src/host/snapshot";
import { createTransport, carryFaults } from "../../src/host/transport";

function expectNoAutoMaintenance({ env }: processModule.ProcessOptions) {
  const config = new Map(Array.from({ length: Number(env?.GIT_CONFIG_COUNT) }, (_, i) => [env?.[`GIT_CONFIG_KEY_${i}`]?.toLowerCase(), env?.[`GIT_CONFIG_VALUE_${i}`]]));
  expect(config.get("gc.auto")).toBe("0");
  expect(config.get("maintenance.auto")).toBe("false");
}

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const key of Object.keys(carryFaults)) delete carryFaults[key as keyof typeof carryFaults]; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const seedRepos = gitFixtureTemplate((root, format: "sha1" | "sha256") => {
  const home = join(root, "home"); mkdirSync(home);
  git(home, "init", "-q", "-b", "main", "--object-format=" + format); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); writeFileSync(join(home, "gone"), "remove me\n"); writeFileSync(join(home, ".gitignore"), "ignored/\n");
  git(home, "add", "-A"); git(home, "commit", "-qm", "baseline"); const base = git(home, "rev-parse", "HEAD");
  for (const branch of ["maker", "checker"]) {
    const path = join(root, branch);
    git(home, "clone", "-q", "--no-hardlinks", home, path); git(path, "checkout", "-qb", branch);
    git(path, "config", "user.name", "Fixture"); git(path, "config", "user.email", "fixture@example.invalid");
  }
  return base;
});
describe.each([false, true])("member emulation: %s", emulate => {
afterEach(() => vi.unstubAllEnvs());
async function fixture<K extends "source" | "target" | "checked">(endpoints: readonly K[], format: "sha1" | "sha256" = "sha1", full = false) {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "transport-")); roots.push(root);
  const base = seedRepos(root, format);
  const home = join(root, "home"), maker = join(root, "maker"), checker = join(root, "checker");
  for (const path of [maker, checker]) git(path, "remote", "set-url", "origin", home);
  if (emulate) vi.stubEnv("PATH", emulatedGit(root) + ":" + process.env.PATH);
  const endpoint = async (id: string, path: string, access: EndpointRegistration["access"], placementId: string, refs: string[]) => {
    const data = join(root, id + "-data"); mkdirSync(data);
    const registry = new HostRegistry(data), port = createTransport(registry);
    const registration: EndpointRegistration = { placementId, generation: 1, endpointId: id, endpoint: { hostId: id + "-host", environmentId: id + "-environment", root: path }, ownerThreadId: access === "member-write" ? id + "-thread" : null, access, git: full || path === home ? "full" : "porcelain", workspaceKind: access === "member-write" ? "dedicated-machine" : null, objectFormat: format, allowedRefs: refs };
    const authority: Authority = { placementId, generation: 1, endpointId: id, operationId: "operation-a" };
    registry.registerEndpoint(registration); await inspectHost(registry, authority);
    return { registry, port, authority, data, path };
  };
  type Endpoint = Awaited<ReturnType<typeof endpoint>>;
  const bindEndpoints = {
    source: () => endpoint("maker", maker, "member-write", "placement-a", ["refs/heads/maker"]),
    target: () => endpoint("home", home, "home-import", "placement-a", ["refs/tavern/keeper/snapshot-a"]),
    checked: () => endpoint("checker", checker, "member-write", "placement-c", ["refs/heads/checker"]),
  };
  const bound = {} as Record<K, Endpoint>;
  for (const name of endpoints) bound[name] = await bindEndpoints[name]();
  const bind = (side: Endpoint, values: Partial<TransferRegistration> = {}): TransferAuthority => {
    const { head = git(maker, "rev-parse", "HEAD"), tree = git(maker, "rev-parse", "HEAD^{tree}"), ...overrides } = values;
    const registration: TransferRegistration = { ...side.authority, transferId: "transfer-a", snapshotId: "snapshot-a", direction: "bring-home", objectFormat: format, base, head, tree, fromEndpointId: "maker", toEndpointId: "home", allowedRefs: [], uploads: [], artifacts: [], ...overrides };
    side.registry.registerTransfer(registration);
    return { ...side.authority, transferId: registration.transferId };
  };
  return { root, home, maker, checker, base, format, endpoint, bind, ...bound };
}
async function exported(f: Pick<Awaited<ReturnType<typeof fixture>>, "source" | "bind">) {
  const authority = f.bind(f.source);
  return { authority, value: await f.source.port.exportChanges(authority) };
}
async function upload(f: Pick<Awaited<ReturnType<typeof fixture>>, "source" | "target" | "bind">, value: HostOutput<"exportChanges">) {
  const files = value.changes.filter(change => change.status !== "D"), uploads = files.map((_, at) => "upload-" + at);
  const authority = f.bind(f.target, { uploads, head: value.head, tree: value.tree, allowedRefs: ["refs/tavern/keeper/snapshot-a"] });
  for (const [at, file] of files.entries()) {
    for (let offset = 0; offset < file.size! || offset === 0; offset += CHUNK_BYTES) {
      const chunk = await f.source.port.readBlob({ ...f.source.authority, transferId: "transfer-a", sha: file.blob!, offset, length: Math.min(CHUNK_BYTES, file.size! - offset) });
      const input = { ...authority, upload: uploads[at]!, offset, data: chunk.data };
      await f.target.port.importChunk(input); await f.target.port.importChunk(input);
    }
  }
  const entries = value.changes.map(change => change.status === "D" ? { path: change.path, delete: true as const } : { path: change.path, mode: change.mode!, upload: uploads[files.indexOf(change)]! });
  return { authority, entries };
}
it.each(["sha1", "sha256"] as const)("brings a %s maker home without touching the user's checkout/index and carries its exact tree to an independent checker", async format => {
  const f = await fixture(["source", "target", "checked"], format), bytes = Buffer.alloc(CHUNK_BYTES + 19, 0xa7);
  writeFileSync(join(f.maker, "tracked"), "maker\n"); unlinkSync(join(f.maker, "gone")); writeFileSync(join(f.maker, "binary"), bytes); symlinkSync("tracked", join(f.maker, "link"));
  git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "maker snapshot");
  writeFileSync(join(f.home, "tracked"), "user's staged work\n"); git(f.home, "add", "tracked");
  // Git status can refresh the copied index before the import begins.
  const status = git(f.home, "status", "--porcelain"), index = readFileSync(join(f.home, ".git/index"));
  const { value } = await exported(f), sent = await upload(f, value);
  const input = { ...sent.authority, remote: "origin", baseBranch: "main", author: value.author, message: value.message, entries: sent.entries, refs: ["refs/tavern/keeper/snapshot-a"], networkTimeoutMs: 1000 };
  const made = await f.target.port.importCommit(input);
  expect(made.outcome).toBe("ok"); if (made.outcome !== "ok") throw new Error("expected import");
  expect(await f.target.port.importCommit(input)).toEqual(made);
  expect(git(f.home, "rev-parse", made.sha + "^{tree}")).toBe(value.tree);
  expect(readFileSync(join(f.home, ".git/index"))).toEqual(index); expect(git(f.home, "status", "--porcelain")).toBe(status);
  expect(readFileSync(join(f.home, "tracked"), "utf8")).toBe("user's staged work\n");
  const carriedSource = await f.endpoint("home-copy", f.home, "source-read", "placement-c", []);
  const transfer = { direction: "carry-out" as const, base: f.base, head: made.sha, tree: value.tree, fromEndpointId: "home-copy", toEndpointId: "checker" };
  const from = f.bind(carriedSource, transfer), to = f.bind(f.checked, transfer);
  const snapshot = await carriedSource.port.exportChanges(from), paths = snapshot.changes.map(change => change.path);
  expect(await f.checked.port.carryStart({ ...to, remote: "origin", baseBranch: "main", paths, networkTimeoutMs: 1000 })).toMatchObject({ outcome: "ok", present: false });
  await f.checked.port.carryDelete({ ...to, paths: snapshot.changes.filter(change => change.status === "D").map(change => change.path) });
  const written: string[] = [];
  for (const file of snapshot.changes.filter(change => change.status !== "D")) {
    written.push(file.path);
    for (let offset = 0; offset < file.size! || offset === 0; offset += CHUNK_BYTES) {
      const chunk = await carriedSource.port.readBlob({ ...from, sha: file.blob!, offset, length: Math.min(CHUNK_BYTES, file.size! - offset) });
      await f.checked.port.carryWrite({ ...to, path: file.path, mode: file.mode!, offset, data: chunk.data });
    }
  }
  const finished = await f.checked.port.carryFinish({ ...to, message: snapshot.message, author: snapshot.author, paths: written });
  expect(finished).toMatchObject({ outcome: "ok", tree: value.tree }); expect(git(f.checker, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(f.checker, "binary")).equals(bytes)).toBe(true); expect(existsSync(join(f.checker, "gone"))).toBe(false);
  expect(await f.checked.port.worktreeState({ ...f.checked.authority, base: f.base, baseTree: value.tree, trackedOnly: true })).toMatchObject({ dirty: false, changed: [] });
}, 60_000);
it.each(["sha1", "sha256"] as const)("rebuilds a read-only %s uncommitted snapshot at home with canonical names and modes", async format => {
  const f = await fixture(["source", "target"], format);
  for (const dir of ["a", "nested/deeper", "empty"]) mkdirSync(join(f.maker, dir), { recursive: true });
  writeFileSync(join(f.maker, "a/file"), "old nested file"); git(f.maker, "add", "a/file"); git(f.maker, "commit", "-qm", "nested baseline");
  for (const path of ["a.b", "a/file", "nested/deeper/-name", ".dot", "é", "tracked"]) writeFileSync(join(f.maker, path), "bytes: " + path);
  chmodSync(join(f.maker, "a.b"), 0o755); symlinkSync("missing", join(f.maker, "link")); unlinkSync(join(f.maker, "gone"));
  const index = readFileSync(join(f.maker, ".git/index")), head = git(f.maker, "rev-parse", "HEAD");
  const captured = await snapshotWorktree(f.source.registry, { ...f.source.authority, base: f.base });
  expect(captured.includesUncommitted).toBe(true);
  expect(readFileSync(join(f.maker, ".git/index"))).toEqual(index); expect(git(f.maker, "rev-parse", "HEAD")).toBe(head);
  const read = { ...f.source, authority: { ...f.source.authority, endpointId: "member-read" } };
  f.source.registry.registerEndpoint({ ...f.source.registry.endpoint(f.source.authority).registration, endpointId: "member-read", access: "source-read", allowedRefs: [], ownerThreadId: null, workspaceKind: null });
  await inspectHost(read.registry, read.authority);
  const from = f.bind(read, { head: captured.commit, tree: captured.tree, fromEndpointId: "member-read" });
  const value = await read.port.exportChanges(from);
  const sourceFrom = f.bind(f.source, { head: captured.commit, tree: captured.tree });
  await f.source.port.exportChanges(sourceFrom);
  const sent = await upload(f, value);
  expect(await f.target.port.importCommit({ ...sent.authority, remote: "origin", baseBranch: "main", author: value.author, message: value.message, entries: sent.entries, refs: ["refs/tavern/keeper/snapshot-a"], networkTimeoutMs: 1000 })).toMatchObject({ outcome: "ok" });
  expect(git(f.home, "rev-parse", "refs/tavern/keeper/snapshot-a^{tree}")).toBe(captured.tree);
  git(f.maker, "add", "-A"); expect(git(f.maker, "write-tree")).toBe(captured.tree);
}, 60_000);
it.each(["file-to-directory", "directory-to-file"] as const)("snapshots an uncommitted %s replacement like real Git", async kind => {
  const f = await fixture(["source"]);
  if (kind === "directory-to-file") {
    mkdirSync(join(f.maker, "swap")); writeFileSync(join(f.maker, "swap/child"), "before");
    git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "directory baseline");
    rmSync(join(f.maker, "swap"), { recursive: true }); writeFileSync(join(f.maker, "swap"), "after");
  } else {
    unlinkSync(join(f.maker, "tracked")); mkdirSync(join(f.maker, "tracked")); writeFileSync(join(f.maker, "tracked/child"), "after");
  }
  const captured = await snapshotWorktree(f.source.registry, { ...f.source.authority, base: f.base });
  git(f.maker, "add", "-A"); expect(captured.tree).toBe(git(f.maker, "write-tree"));
});
it("preserves non-UTF8 names in unchanged entries of a rewritten tree", () => {
  const sha = "1".repeat(40), raw = Buffer.concat([Buffer.from("100644 "), Buffer.from([0xff, 0x61]), Buffer.from([0]), Buffer.from(sha, "hex")]);
  expect(treeObjectBytes(parseTreeEntries(raw, 20))).toEqual(raw);
});
it.each([true, false])("matches Git's owner execute bit and core.fileMode=%s", async fileMode => {
  const f = await fixture(["source"]); git(f.maker, "config", "core.fileMode", String(fileMode));
  writeFileSync(join(f.maker, "tracked"), "changed"); chmodSync(join(f.maker, "tracked"), fileMode ? 0o645 : 0o755);
  const captured = await snapshotWorktree(f.source.registry, { ...f.source.authority, base: f.base });
  git(f.maker, "add", "-A"); expect(captured.tree).toBe(git(f.maker, "write-tree"));
});
it("starts a 20000-path carry without exceeding argv limits", async () => {
  const f = await fixture(["checked"]); writeFileSync(join(f.maker, "tracked"), "target"); git(f.maker, "commit", "-qam", "target");
  const paths = Array.from({ length: 20_000 }, (_, at) => `directory/long-monorepo-component-name-${at.toString().padStart(6, "0")}/target.txt`);
  const authority = f.bind(f.checked, { direction: "carry-out", fromEndpointId: "home", toEndpointId: "checker", allowedRefs: ["refs/heads/checker"] });
  const calls = vi.spyOn(processModule, "runProcess");
  expect(await f.checked.port.carryStart({ ...authority, remote: "origin", baseBranch: "main", paths, networkTimeoutMs: 1000 })).toMatchObject({ outcome: "ok", present: false });
  const queries = calls.mock.calls.filter(([, args]) => args.includes("status") && args.includes("--ignored"));
  expect(queries).toHaveLength(40); for (const [, args] of queries) expect(args.length - args.indexOf("--") - 1).toBeLessThanOrEqual(500);
}, 120_000);
it("exports 20000 paths using bounded tree queries and full object IDs", async () => {
  const f = await fixture(["source"]); mkdirSync(join(f.maker, "many"));
  for (let at = 0; at < 20_000; at++) writeFileSync(join(f.maker, "many", `file-${at.toString().padStart(6, "0")}`), "same blob\n");
  git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "many files");
  const calls = vi.spyOn(processModule, "runProcess"), { value } = await exported(f);
  expect(value.changes).toHaveLength(20_000);
  const blob = git(f.maker, "rev-parse", "HEAD:many/file-000000");
  for (const change of value.changes) expect(change).toMatchObject({ status: "A", mode: "100644", blob });
  const queries = calls.mock.calls.filter(([, args]) => args.includes("ls-tree"));
  expect(queries).toHaveLength(80);
  for (const [, args] of queries) expect(args.length - args.indexOf("--") - 1).toBeLessThanOrEqual(500);
}, 120_000);
it.each([false, true])("reads deletion state once and stops before journal writes when cancelled (%s)", async cancel => {
  const f = await fixture(["checked"]); writeFileSync(join(f.maker, "tracked"), "target"); git(f.maker, "commit", "-qam", "target");
  const paths = Array.from({ length: 2000 }, (_, at) => `removed-${at}`);
  const authority = f.bind(f.checked, { direction: "carry-out", fromEndpointId: "home", toEndpointId: "checker", allowedRefs: ["refs/heads/checker"] });
  await f.checked.port.carryStart({ ...authority, remote: "origin", baseBranch: "main", paths, networkTimeoutMs: 1000 });
  const controller = new AbortController(), read = f.checked.registry.readTransferState.bind(f.checked.registry);
  const calls = vi.spyOn(f.checked.registry, "readTransferState").mockImplementation((...args) => {
    const result = Reflect.apply(read, f.checked.registry, args);
    if (cancel && args[1] === "carry-initial.json") controller.abort(new Error("cancel deletions"));
    return result;
  });
  const deleting = f.checked.port.carryDelete({ ...authority, paths }, controller.signal);
  if (cancel) {
    await expect(deleting).rejects.toThrow();
    expect(existsSync(f.checked.registry.transferPath(authority, "carry.json.paths"))).toBe(false);
  } else await expect(deleting).resolves.toEqual({});
  expect(calls.mock.calls.filter(([, name]) => name === "carry-initial.json")).toHaveLength(1);
});
it("rejects foreign blobs, upload handles, invalid base64, bad offsets and oversize chunks before writes", async () => {
  const f = await fixture(["source", "target"]); writeFileSync(join(f.maker, "tracked"), "changed\n"); git(f.maker, "commit", "-qam", "change");
  const { authority, value } = await exported(f), to = f.bind(f.target, { uploads: ["mine"] });
  await expect(f.source.port.readBlob({ ...authority, sha: f.base, offset: 0, length: 1 })).rejects.toThrow(/blob-not-exported/);
  await expect(f.target.port.importChunk({ ...to, upload: "foreign", offset: 0, data: "YQ==" })).rejects.toThrow(/upload-not-granted/);
  await expect(f.target.port.importChunk({ ...to, upload: "mine", offset: 0, data: "not base64!" })).rejects.toThrow(/invalid-chunk/);
  await expect(f.target.port.importChunk({ ...to, upload: "mine", offset: 1, data: "YQ==" })).rejects.toThrow(/chunk-offset/);
  await f.target.port.importChunk({ ...to, upload: "mine", offset: 0, data: "YQ==" });
  await expect(f.target.port.importChunk({ ...to, upload: "mine", offset: 0, data: "Yg==" })).rejects.toThrow(/chunk-conflict/);
  await expect(f.target.port.importChunk({ ...to, upload: "mine", offset: BLOB_MAX_BYTES, data: "YQ==" })).rejects.toThrow(/file-too-large/);
  await expect(f.source.port.readBlob({ ...authority, sha: value.changes[0]!.blob!, offset: 0, length: CHUNK_BYTES + 1 })).rejects.toThrow();
});
it("refuses submodule transport and controller commits in a source-read checkout", async () => {
  const f = await fixture(["source"]); git(f.maker, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module"); git(f.maker, "commit", "-qm", "submodule");
  await expect(exported(f)).rejects.toThrow(/submodule/);
  const initial = await f.endpoint("initial", f.home, "source-read", "initial-placement", []);
  writeFileSync(join(f.home, "tracked"), "user dirty source\n");
  await expect(initial.port.commitAll({ ...initial.authority, message: "must not commit user source" })).rejects.toThrow(/endpoint-access/);
  expect(git(f.home, "rev-parse", "HEAD")).toBe(f.base);
});
async function startedCarry(path = "tracked", contents = "carried\n", full = false) {
  const f = await fixture(["source", "checked"], "sha1", full);
  mkdirSync(dirname(join(f.maker, path)), { recursive: true }); writeFileSync(join(f.maker, path), contents);
  git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "carry source");
  const { value } = await exported(f);
  const authority = f.bind(f.checked, { direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  const input = { ...authority, remote: "origin", baseBranch: "main", paths: [path], networkTimeoutMs: 1000 };
  expect(await f.checked.port.carryStart(input)).toMatchObject({ outcome: "ok", present: false });
  return { ...f, authority, input, value, path, contents };
}
it.each(["beforeRename", "afterRename", "beforeCommit", "afterCommit"] as const)("resumes a carry interrupted at %s without resetting or taking edits", async fault => {
  const f = await startedCarry();
  const write = { ...f.authority, path: f.path, mode: "100644" as const, offset: 0, data: Buffer.from(f.contents).toString("base64") };
  const finish = { ...f.authority, paths: [f.path], message: f.value.message, author: f.value.author };
  carryFaults[fault] = () => { throw new Error("interrupted carry"); };
  if (fault.endsWith("Rename")) await expect(f.checked.port.carryWrite(write)).rejects.toThrow("interrupted carry");
  else { await f.checked.port.carryWrite(write); await expect(f.checked.port.carryFinish(finish)).rejects.toThrow("interrupted carry"); }
  delete carryFaults[fault];
  const start = await f.checked.port.carryStart(f.input);
  expect(start.outcome).toBe("ok");
  if (start.outcome === "ok" && !start.present) await f.checked.port.carryWrite(write);
  expect(await f.checked.port.carryFinish(finish)).toMatchObject({ outcome: "ok", tree: f.value.tree });
  expect(git(f.checker, "status", "--porcelain")).toBe("");
}, 60_000);
it("resumes a staged executable carry with core.fileMode=false", async () => {
  const f = await fixture(["checked"]);
  chmodSync(join(f.checker, "tracked"), 0o755); git(f.checker, "add", "tracked"); git(f.checker, "commit", "-qm", "executable baseline");
  const base = git(f.checker, "rev-parse", "HEAD"); git(f.checker, "config", "core.fileMode", "false");
  writeFileSync(join(f.maker, "tracked"), "executable update"); chmodSync(join(f.maker, "tracked"), 0o755); git(f.maker, "add", "tracked"); git(f.maker, "commit", "-qm", "target");
  const authority = f.bind(f.checked, { base, direction: "carry-out", fromEndpointId: "home", toEndpointId: "checker", allowedRefs: ["refs/heads/checker"] });
  const start = { ...authority, remote: "origin", baseBranch: "main", paths: ["tracked"], expectedHead: base, networkTimeoutMs: 1000 };
  await f.checked.port.carryStart(start);
  await f.checked.port.carryWrite({ ...authority, path: "tracked", mode: "100755", offset: 0, data: Buffer.from("executable update").toString("base64") });
  const finish = { ...authority, paths: ["tracked"], message: "target", author: { name: "Fixture", email: "fixture@example.invalid", date: "1700000000 +0000" } };
  carryFaults.beforeCommit = () => { throw new Error("interrupted after staging"); };
  await expect(f.checked.port.carryFinish(finish)).rejects.toThrow("interrupted after staging"); delete carryFaults.beforeCommit;
  expect(await f.checked.port.carryStart(start)).toMatchObject({ outcome: "ok" });
  expect(await f.checked.port.carryFinish(finish)).toMatchObject({ outcome: "ok", tree: git(f.maker, "rev-parse", "HEAD^{tree}") });
});
it("refuses a dirty carry before writing files or changing the index", async () => {
  const f = await fixture(["checked"]);
  writeFileSync(join(f.maker, "tracked"), "incoming"); git(f.maker, "commit", "-qam", "incoming");
  writeFileSync(join(f.checker, "tracked"), "worker's edit");
  const index = readFileSync(join(f.checker, ".git/index")), to = f.bind(f.checked, { direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  expect(await f.checked.port.carryStart({ ...to, remote: "origin", baseBranch: "main", paths: ["tracked"], networkTimeoutMs: 1000 })).toMatchObject({ outcome: "unavailable", code: "carry-blocked" });
  expect(readFileSync(join(f.checker, "tracked"), "utf8")).toBe("worker's edit"); expect(readFileSync(join(f.checker, ".git/index"))).toEqual(index);
}, 60_000);
it.each(["file-to-directory", "directory-to-file"] as const)("carries %s without staging a directory's foreign files", async kind => {
  const f = await fixture(["source", "checked"]), before = kind === "file-to-directory" ? "node" : "node/file", after = kind === "file-to-directory" ? "node/file" : "node";
  for (const repo of [f.maker, f.checker]) { mkdirSync(dirname(join(repo, before)), { recursive: true }); writeFileSync(join(repo, before), "old"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "structural base"); }
  git(f.checker, "fetch", "-q", f.maker, "HEAD"); git(f.checker, "reset", "--hard", "FETCH_HEAD");
  const base = git(f.checker, "rev-parse", "HEAD");
  rmSync(join(f.maker, "node"), { recursive: true }); mkdirSync(dirname(join(f.maker, after)), { recursive: true }); writeFileSync(join(f.maker, after), "new"); git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "replacement");
  const value = await f.source.port.exportChanges(f.bind(f.source, { base })), to = f.bind(f.checked, { base, direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  expect(await f.checked.port.carryStart({ ...to, remote: "origin", baseBranch: "main", paths: [before, after], networkTimeoutMs: 1000 })).toMatchObject({ outcome: "ok" });
  await f.checked.port.carryDelete({ ...to, paths: [before] });
  await f.checked.port.carryWrite({ ...to, path: after, mode: "100644", offset: 0, data: Buffer.from("new").toString("base64") });
  expect(await f.checked.port.carryFinish({ ...to, paths: [after], message: value.message, author: value.author })).toMatchObject({ outcome: "ok", tree: value.tree });
}, 60_000);
it("gives member checkout scans, staging and commits World-sized Git deadlines", async () => {
  const process = vi.spyOn(processModule, "runProcess"), f = await startedCarry();
  await f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") });
  const finish = { ...f.authority, paths: [f.path], message: f.value.message, author: f.value.author };
  expect(await f.checked.port.carryFinish(finish)).toMatchObject({ outcome: "ok" });
  expect(await f.checked.port.carryFinish(finish)).toMatchObject({ outcome: "ok" });
  expect(await f.checked.port.worktreeState({ ...f.checked.authority, base: f.base })).toMatchObject({ dirty: false });
  writeFileSync(join(f.maker, "tracked"), "next submission\n");
  expect(await f.source.port.commitAll({ ...f.source.authority, message: "member submission" })).toMatchObject({ committed: true });
  const scans = process.mock.calls.filter(([program, args]) => program === "git" &&
    (args.includes("status") || args.includes("add") || args.includes("commit") && !args.includes("cat-file") || args.includes("ls-files") && args.includes("--others")));
  for (const command of ["status", "add", "commit"]) expect(scans.some(([, args]) => args.includes(command))).toBe(true);
  for (const [, args, options] of scans) expect(options.timeoutMs, args.join(" ")).toBeGreaterThanOrEqual(150_000);
  const metadata = process.mock.calls.filter(([, args]) => args.includes("rev-parse") || args.includes("symbolic-ref") || args.includes("config"));
  expect(metadata.length).toBeGreaterThan(0);
  for (const [, , options] of metadata) expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
}, 60_000);
it("does not interleave two transfers into the same member checkout", async () => {
  const f = await startedCarry();
  const another = f.bind(f.checked, { transferId: "another-transfer", direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  await expect(f.checked.port.carryStart({ ...f.input, ...another })).rejects.toThrow(/carry-in-progress/);
}, 60_000);
it("preserves foreign edits on finish and non-destructive abort", async () => {
  const f = await startedCarry();
  await f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") });
  writeFileSync(join(f.checker, f.path), "human edit\n");
  expect(await f.checked.port.carryFinish({ ...f.authority, paths: [f.path], message: f.value.message, author: f.value.author })).toMatchObject({ outcome: "foreign", paths: [f.path] });
  expect(await f.checked.port.carryAbort(f.authority)).toMatchObject({ carried: [{ path: f.path, holds: "changed" }] });
  expect(readFileSync(join(f.checker, f.path), "utf8")).toBe("human edit\n"); expect(git(f.checker, "rev-parse", "HEAD")).toBe(f.base);
}, 60_000);
it.each(["bytes", "mode", "deletion"] as const)("preserves foreign staged %s even when carried files are unchanged", async kind => {
  const f = await startedCarry();
  await f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") });
  if (kind === "bytes") {
    writeFileSync(join(f.checker, f.path), "foreign staged bytes\n"); git(f.checker, "add", f.path);
    writeFileSync(join(f.checker, f.path), f.contents);
  } else if (kind === "mode") {
    git(f.checker, "config", "core.fileMode", "false"); git(f.checker, "add", f.path); git(f.checker, "update-index", "--chmod=+x", f.path);
  } else git(f.checker, "rm", "--cached", "-q", "--", f.path);
  const index = readFileSync(join(f.checker, ".git/index"));
  expect(await f.checked.port.carryFinish({ ...f.authority, paths: [f.path], message: f.value.message, author: f.value.author })).toMatchObject({ outcome: "foreign", paths: [f.path] });
  expect(readFileSync(join(f.checker, ".git/index"))).toEqual(index);
  expect(readFileSync(join(f.checker, f.path), "utf8")).toBe(f.contents); expect(git(f.checker, "rev-parse", "HEAD")).toBe(f.base);
}, 60_000);
it("does not traverse a parent symlink inserted immediately before rename", async () => {
  const f = await startedCarry("folder/file"), outside = join(f.root, "outside"); mkdirSync(outside);
  carryFaults.beforeRename = () => { rmSync(join(f.checker, "folder"), { recursive: true }); symlinkSync(outside, join(f.checker, "folder")); };
  await expect(f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") })).rejects.toThrow(/not as/);
  expect(existsSync(join(outside, "file"))).toBe(false);
}, 60_000);
it("does not rename a carried file after its placement is revoked mid-call", async () => {
  const f = await startedCarry();
  carryFaults.beforeRename = () => { f.checked.registry.revokePlacement({ placementId: "placement-c", generation: 1, reason: "cancel during rename" }); };
  await expect(f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") })).rejects.toMatchObject({ name: "AbortError" });
  await f.checked.registry.settlePlacement("placement-c", 1);
  expect(readFileSync(join(f.checker, f.path), "utf8")).toBe("base\n"); expect(git(f.checker, "rev-parse", "HEAD")).toBe(f.base);
}, 60_000);
it("pins the initial carry paths across duplicate starts", async () => {
  const f = await startedCarry();
  await expect(f.checked.port.carryStart({ ...f.input, paths: ["gone"] })).rejects.toThrow(/transfer-conflict/);
  await expect(f.checked.port.carryWrite({ ...f.authority, path: "gone", mode: "100644", offset: 0, data: "YQ==" })).rejects.toThrow(/path-not-granted/);
}, 60_000);
it("fences a cancelled transfer before accepting a late chunk", async () => {
  const f = await fixture(["target"]), authority = f.bind(f.target, { uploads: ["mine"] });
  f.target.registry.revokePlacement({ placementId: "placement-a", generation: 1, reason: "cancel" });
  await expect(f.target.port.importChunk({ ...authority, upload: "mine", offset: 0, data: "YQ==" })).rejects.toThrow(/placement-revoked/);
});

it.each(["removed", "replaced", "file-to-module", "unchanged"])("checks both gitlink modes when exporting %s", async kind => {
  const f = await fixture(["source"]);
  if (kind === "file-to-module") { writeFileSync(join(f.maker, "module"), "plain"); git(f.maker, "add", "module"); }
  else git(f.maker, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module");
  git(f.maker, "commit", "-qm", "new base"); const base = git(f.maker, "rev-parse", "HEAD");
  if (kind === "file-to-module") { git(f.maker, "rm", "-q", "module"); git(f.maker, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module"); }
  if (kind === "removed" || kind === "replaced") git(f.maker, "update-index", "--force-remove", "module");
  if (kind === "replaced") { writeFileSync(join(f.maker, "module"), "plain"); git(f.maker, "add", "module"); }
  writeFileSync(join(f.maker, "tracked"), "changed"); git(f.maker, "add", "tracked"); git(f.maker, "commit", "-qm", "change");
  const authority = f.bind(f.source, { base });
  if (kind === "unchanged") expect((await f.source.port.exportChanges(authority)).changes.map(change => change.path)).toEqual(["tracked"]);
  else await expect(f.source.port.exportChanges(authority)).rejects.toMatchObject({ code: "submodule-unsupported" });
});
it.skipIf(emulate).each([false, true])("finishes outside-cone carry writes and deletions with porcelain staging (expect outside files: %s)", async expectOutside => {
  const f = await fixture(["source", "checked"]);
  for (const repo of [f.maker, f.checker]) {
    mkdirSync(join(repo, "outside")); writeFileSync(join(repo, "outside/gone"), "base"); writeFileSync(join(repo, "outside/edit"), "base");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "outside base");
  }
  git(f.checker, "fetch", "-q", f.maker, "HEAD"); git(f.checker, "reset", "--hard", "FETCH_HEAD");
  const base = git(f.checker, "rev-parse", "HEAD");
  rmSync(join(f.maker, "outside/gone")); writeFileSync(join(f.maker, "outside/new"), "carried"); writeFileSync(join(f.maker, "outside/edit"), "carried"); git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "outside change");
  const value = await f.source.port.exportChanges(f.bind(f.source, { base }));
  git(f.checker, "sparse-checkout", "set", "--cone", "inside");
  git(f.checker, "config", "core.sparseCheckout", expectOutside ? "yes" : "1");
  git(f.checker, "config", "sparse.expectFilesOutsideOfPatterns", String(expectOutside));
  await inspectHost(f.checked.registry, f.checked.authority);
  const authority = f.bind(f.checked, { base, direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  expect(await f.checked.port.carryStart({ ...authority, remote: "origin", baseBranch: "main", paths: ["outside/gone", "outside/new", "outside/edit"], networkTimeoutMs: 1000 })).toMatchObject({ outcome: "ok" });
  await f.checked.port.carryDelete({ ...authority, paths: ["outside/gone"] });
  await f.checked.port.carryWrite({ ...authority, path: "outside/new", mode: "100644", offset: 0, data: Buffer.from("carried").toString("base64") });
  await f.checked.port.carryWrite({ ...authority, path: "outside/edit", mode: "100644", offset: 0, data: Buffer.from("carried").toString("base64") });
  const spy = vi.spyOn(processModule, "runProcess");
  const finished = await f.checked.port.carryFinish({ ...authority, paths: ["outside/new", "outside/edit"], author: value.author, message: value.message });
  expect(git(f.checker, "ls-tree", "-r", "HEAD")).toBe(git(f.maker, "ls-tree", "-r", "HEAD"));
  expect(finished).toMatchObject({ outcome: "ok", tree: value.tree });
  const stages = spy.mock.calls.filter(([,args]) => args.includes("add") || args.includes("update-index") || args.includes("--cached") && args.includes("rm"));
  expect(stages).toHaveLength(2);
  expect(stages[0]![1]).toContain("--sparse");
  expect(stages[0]![1]).toEqual(expect.arrayContaining(["rm", "--cached", "--sparse", "--ignore-unmatch", "outside/gone", "outside/edit", "outside/new"]));
  expect(stages[1]![1]).toEqual(expect.arrayContaining(["add", "-A", "--sparse", "outside/edit", "outside/new"]));
  expectNoAutoMaintenance(spy.mock.calls.find(([,args]) => args.includes("commit"))![2]);
}, 60_000);
it.skipIf(emulate)("commits new files outside a sparse cone without auto-maintenance", async () => {
  const f = await fixture(["source"]); git(f.maker, "sparse-checkout", "set", "--cone", "inside");
  mkdirSync(join(f.maker, "outside")); writeFileSync(join(f.maker, "outside/new"), "new");
  await inspectHost(f.source.registry, f.source.authority);
  const spy = vi.spyOn(processModule, "runProcess");
  expect(await f.source.port.commitAll({ ...f.source.authority, message: "sparse" })).toMatchObject({ committed: true });
  expect(git(f.maker, "show", "HEAD:outside/new")).toBe("new");
  expectNoAutoMaintenance(spy.mock.calls.find(([,args]) => args.includes("commit"))![2]);
});
it("names oversized untracked listings in worktreeState", async () => {
  const f = await fixture(["source"]), original = processModule.runProcess;
  vi.spyOn(processModule, "runProcess").mockImplementation((program,args,options) => args.includes("--untracked-files=all") ? Promise.reject(new Error("git: maxBuffer length exceeded")) : original(program,args,options));
  await expect(f.source.port.worktreeState({ ...f.source.authority, base: f.base })).rejects.toMatchObject({ code: "too-many-paths", message: expect.stringMatching(/untracked.*listing/i) });
});

it("disables auto-maintenance on both member commits", async () => {
  const f = await startedCarry(), spy = vi.spyOn(processModule, "runProcess");
  await f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") });
  await f.checked.port.carryFinish({ ...f.authority, paths: [f.path], message: f.value.message, author: f.value.author });
  writeFileSync(join(f.maker, "tracked"), "next");
  await f.source.port.commitAll({ ...f.source.authority, message: "next" });
  const commits = spy.mock.calls.filter(([,args]) => args.includes("commit"));
  expect(commits).toHaveLength(2);
  for (const [, , options] of commits) expectNoAutoMaintenance(options);
}, 60_000);
it("refuses an unexpected committed HEAD without resetting the branch", async () => {
  const f = await fixture(["checked"]);
  writeFileSync(join(f.checker, "tracked"), "new head"); git(f.checker, "commit", "-qam", "head to replace");
  const replaces = git(f.checker, "rev-parse", "HEAD^{tree}");
  const authority = f.bind(f.checked, { direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  const spy = vi.spyOn(processModule, "runProcess");
  const head = git(f.checker, "rev-parse", "HEAD");
  expect(await f.checked.port.carryStart({ ...authority, remote: "origin", baseBranch: "main", paths: ["tracked"], replaces, networkTimeoutMs: 1000 })).toMatchObject({ outcome: "unavailable", code: "carry-blocked" });
  expect(spy.mock.calls.some(([, args]) => args.includes("reset"))).toBe(false);
  expect(git(f.checker, "rev-parse", "HEAD")).toBe(head);
}, 60_000);

it.skipIf(emulate)("deletes absent sparse carry files without reading the index", async () => {
  const f = await fixture(["checked"]);
  for (const repo of [f.maker, f.checker]) { mkdirSync(join(repo,"outside")); for (const name of ["a","b","c"]) writeFileSync(join(repo,"outside",name),"base"); git(repo,"add","-A"); git(repo,"commit","-qm","outside"); }
  const base = git(f.checker,"rev-parse","HEAD"); rmSync(join(f.maker,"outside"),{recursive:true}); git(f.maker,"add","-A"); git(f.maker,"commit","-qm","delete");
  git(f.checker,"sparse-checkout","set","--cone","inside");
  const paths = ["outside/a","outside/b","outside/c"], authority=f.bind(f.checked,{base,direction:"carry-out",fromEndpointId:"maker",toEndpointId:"checker"});
  await f.checked.port.carryStart({...authority,remote:"origin",baseBranch:"main",paths,networkTimeoutMs:1000});
  const spy=vi.spyOn(processModule,"runProcess");
  await f.checked.port.carryDelete({...authority,paths});
  expect(spy.mock.calls.filter(([,args])=>args.includes("ls-files"))).toHaveLength(0);
},60_000);
it("does not require new Git for carries or nonsparse commitAll",async()=>{
  const f=await startedCarry(),original=processModule.runProcess;
  vi.spyOn(processModule,"runProcess").mockImplementation((program,args,options)=>args.includes("--version")?Promise.resolve({code:0,stdout:"git version 2.24.0\n",stderr:"",timedOut:false}):original(program,args,options));
  await f.checked.port.carryWrite({...f.authority,path:f.path,mode:"100644",offset:0,data:Buffer.from(f.contents).toString("base64")});
  expect(await f.checked.port.carryFinish({...f.authority,paths:[f.path],message:f.value.message,author:f.value.author})).toMatchObject({outcome:"ok"});
  writeFileSync(join(f.maker,"tracked"),"next");
  expect(await f.source.port.commitAll({...f.source.authority,message:"next"})).toMatchObject({committed:true});
},60_000);
it.skipIf(emulate)("stages and commits a full Git carry without repository programs", async () => {
  const f = await startedCarry("tracked", "carried bytes\n", true), filtered = join(f.root, "filtered"), hooked = join(f.root, "hooked");
  await f.checked.port.carryWrite({ ...f.authority, path: f.path, mode: "100644", offset: 0, data: Buffer.from(f.contents).toString("base64") });
  git(f.checker, "config", "filter.fixture.clean", `touch "${filtered}"; cat`);
  writeFileSync(join(f.checker, ".git/info/attributes"), "tracked filter=fixture\n");
  writeFileSync(join(f.checker, ".git/hooks/post-commit"), `#!/bin/sh\ntouch "${hooked}"\n`, { mode: 0o755 });
  expect(await f.checked.port.carryFinish({ ...f.authority, paths: [f.path], message: f.value.message, author: f.value.author })).toMatchObject({ outcome: "ok", tree: f.value.tree });
  expect([filtered, hooked].filter(existsSync)).toEqual([]);
});

});
