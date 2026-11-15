// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BLOB_MAX_BYTES, CHUNK_BYTES, type Authority, type EndpointRegistration, type HostOutput, type TransferAuthority, type TransferRegistration } from "../../src/host-contract";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport, carryFaults } from "../../src/host/transport";

const roots: string[] = [];
afterEach(() => { for (const key of Object.keys(carryFaults)) delete carryFaults[key as keyof typeof carryFaults]; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "transport-")); roots.push(root);
  const home = join(root, "home"), maker = join(root, "maker"), checker = join(root, "checker"); mkdirSync(home);
  git(home, "init", "-q", "-b", "main", "--object-format=" + format); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); writeFileSync(join(home, "gone"), "remove me\n"); writeFileSync(join(home, ".gitignore"), "ignored/\n");
  git(home, "add", "-A"); git(home, "commit", "-qm", "baseline"); const base = git(home, "rev-parse", "HEAD");
  for (const [path, branch] of [[maker, "maker"], [checker, "checker"]]) {
    git(home, "clone", "-q", "--no-hardlinks", home, path!); git(path!, "checkout", "-qb", branch!);
    git(path!, "config", "user.name", "Fixture"); git(path!, "config", "user.email", "fixture@example.invalid");
  }
  const endpoint = async (id: string, path: string, access: EndpointRegistration["access"], placementId: string, refs: string[]) => {
    const data = join(root, id + "-data"); mkdirSync(data);
    const registry = new HostRegistry(data), port = createTransport(registry);
    const registration: EndpointRegistration = { placementId, generation: 1, endpointId: id, endpoint: { hostId: id + "-host", environmentId: id + "-environment", root: path }, ownerThreadId: access === "member-write" ? id + "-thread" : null, access, workspaceKind: access === "member-write" ? "dedicated-machine" : null, objectFormat: format, allowedRefs: refs };
    const authority: Authority = { placementId, generation: 1, endpointId: id, operationId: "operation-a" };
    registry.registerEndpoint(registration); await inspectHost(registry, authority);
    return { registry, port, authority, data, path };
  };
  const source = await endpoint("maker", maker, "member-write", "placement-a", ["refs/heads/maker"]);
  const target = await endpoint("home", home, "home-import", "placement-a", ["refs/tavern/keeper/snapshot-a"]);
  const checked = await endpoint("checker", checker, "member-write", "placement-c", ["refs/heads/checker"]);
  const bind = (side: typeof source, values: Partial<TransferRegistration> = {}): TransferAuthority => {
    const registration: TransferRegistration = { ...side.authority, transferId: "transfer-a", snapshotId: "snapshot-a", direction: "bring-home", objectFormat: format, base, head: git(maker, "rev-parse", "HEAD"), tree: git(maker, "rev-parse", "HEAD^{tree}"), fromEndpointId: "maker", toEndpointId: "home", allowedRefs: [], uploads: [], artifacts: [], ...values };
    side.registry.registerTransfer(registration);
    return { ...side.authority, transferId: registration.transferId };
  };
  return { root, home, maker, checker, base, format, source, target, checked, endpoint, bind };
}
async function exported(f: Awaited<ReturnType<typeof fixture>>) {
  const authority = f.bind(f.source);
  return { authority, value: await f.source.port.exportChanges(authority) };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, value: HostOutput<"exportChanges">) {
  const files = value.changes.filter(change => change.status !== "D"), uploads = files.map((_, at) => "upload-" + at);
  const authority = f.bind(f.target, { uploads, allowedRefs: ["refs/tavern/keeper/snapshot-a"] });
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
  const f = await fixture(format), bytes = Buffer.alloc(CHUNK_BYTES + 19, 0xa7);
  writeFileSync(join(f.maker, "tracked"), "maker\n"); unlinkSync(join(f.maker, "gone")); writeFileSync(join(f.maker, "binary"), bytes); symlinkSync("tracked", join(f.maker, "link"));
  git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "maker snapshot");
  writeFileSync(join(f.home, "tracked"), "user's staged work\n"); git(f.home, "add", "tracked");
  const index = readFileSync(join(f.home, ".git/index")), status = git(f.home, "status", "--porcelain");
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
it("rejects foreign blobs, upload handles, invalid base64, bad offsets and oversize chunks before writes", async () => {
  const f = await fixture(); writeFileSync(join(f.maker, "tracked"), "changed\n"); git(f.maker, "commit", "-qam", "change");
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
  const f = await fixture(); git(f.maker, "update-index", "--add", "--cacheinfo", "160000," + f.base + ",module"); git(f.maker, "commit", "-qm", "submodule");
  await expect(exported(f)).rejects.toThrow(/submodule/);
  const initial = await f.endpoint("initial", f.home, "source-read", "initial-placement", []);
  writeFileSync(join(f.home, "tracked"), "user dirty source\n");
  await expect(initial.port.commitAll({ ...initial.authority, message: "must not commit user source" })).rejects.toThrow(/endpoint-access/);
  expect(git(f.home, "rev-parse", "HEAD")).toBe(f.base);
});
async function startedCarry(path = "tracked", contents = "carried\n") {
  const f = await fixture();
  mkdirSync(dirname(join(f.maker, path)), { recursive: true }); writeFileSync(join(f.maker, path), contents);
  git(f.maker, "add", "-A"); git(f.maker, "commit", "-qm", "carry source");
  const { value } = await exported(f);
  const authority = f.bind(f.checked, { direction: "carry-out", fromEndpointId: "maker", toEndpointId: "checker" });
  const input = { ...authority, remote: "origin", baseBranch: "main", paths: [path], networkTimeoutMs: 1000 };
  expect(await f.checked.port.carryStart(input)).toMatchObject({ outcome: "ok", present: false });
  return { ...f, authority, input, value, path, contents };
}
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
  const f = await fixture(), authority = f.bind(f.target, { uploads: ["mine"] });
  f.target.registry.revokePlacement({ placementId: "placement-a", generation: 1, reason: "cancel" });
  await expect(f.target.port.importChunk({ ...authority, upload: "mine", offset: 0, data: "YQ==" })).rejects.toThrow(/placement-revoked/);
});
