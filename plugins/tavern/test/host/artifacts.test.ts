// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BLOB_MAX_BYTES, CHUNK_BYTES, type Authority, type EndpointRegistration, type HostOutput, type TransferAuthority } from "../../src/host-contract";
import { createArtifacts, artifactFaults } from "../../src/host/artifacts";
import { HostRegistry } from "../../src/host/registry";

type ArtifactFile = HostOutput<"inspectArtifacts">["files"][number];
const roots: string[] = [];
afterEach(() => { delete artifactFaults.beforePublish; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "artifacts-")); roots.push(root);
  const workspace = join(root, "workspace"), sourceData = join(root, "source-data"), homeData = join(root, "home-data");
  for (const directory of [workspace, sourceData, homeData]) mkdirSync(directory);
  const source = new HostRegistry(sourceData), home = new HostRegistry(homeData);
  const registration = (id: string, path: string, access: EndpointRegistration["access"]): EndpointRegistration => ({ placementId: "placement-a", generation: 1, endpointId: id, endpoint: { hostId: id + "-host", environmentId: null, root: path }, ownerThreadId: "member-thread", access, git: "full", workspaceKind: null, objectFormat: null, allowedRefs: [] });
  const authority = (id: string): Authority => ({ placementId: "placement-a", generation: 1, endpointId: id, operationId: "operation-a" });
  source.registerEndpoint(registration("reports", workspace, "artifact-read"));
  home.registerEndpoint(registration("home", home.artifactDirectory, "artifact-store"));
  const from = authority("reports"), to = authority("home"), reader = createArtifacts(source), writer = createArtifacts(home);
  function bind(files: ArtifactFile[], transferId = "transfer-a") {
    for (const [registry, endpoint] of [[source, from], [home, to]] as const) registry.registerTransfer({ ...endpoint, transferId, snapshotId: "snapshot-a", direction: "artifacts", objectFormat: "sha1", base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), fromEndpointId: from.endpointId, toEndpointId: to.endpointId, allowedRefs: [], uploads: [], artifacts: files });
    return { from: { ...from, transferId } as TransferAuthority, to: { ...to, transferId } as TransferAuthority };
  }
  const savedPath = (key: string) => join(homeData, key);
  return { root, workspace, sourceData, homeData, source, home, registration, authority, from, to, reader, writer, bind, savedPath };
}
it("copies only declared binary, ignored and thread-storage evidence with verified durable receipts", async () => {
  const f = fixture(), bytes = Buffer.alloc(CHUNK_BYTES + 19, 0x91);
  mkdirSync(join(f.workspace, "ignored")); writeFileSync(join(f.workspace, "ignored/report.bin"), bytes);
  writeFileSync(join(f.workspace, "empty"), ""); writeFileSync(join(f.workspace, "not-declared"), "not exported");
  const declared = await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["ignored/report.bin", "empty"] });
  expect(declared.files).toHaveLength(2); expect(declared.files[0]).toMatchObject({ relativePath: "ignored/report.bin", size: bytes.length, sha256: sha256(bytes), sourceEndpointId: "reports" });
  const transfer = f.bind(declared.files);
  for (const file of declared.files) {
    for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK_BYTES) {
      const chunk = await f.reader.readArtifact({ ...transfer.from, artifactId: file.id, offset, length: Math.min(CHUNK_BYTES, file.size - offset) });
      const input = { ...transfer.to, artifactId: file.id, offset, data: chunk.data };
      await f.writer.artifactChunk(input); await f.writer.artifactChunk(input);
    }
    const receipt = await f.writer.finishArtifact({ ...transfer.to, artifactId: file.id });
    expect(receipt).toMatchObject({ size: file.size, sha256: file.sha256 });
    expect(receipt.storageKey.startsWith("artifacts/")).toBe(true);
    expect(readFileSync(f.savedPath(receipt.storageKey)).equals(file.size ? bytes : Buffer.alloc(0))).toBe(true);
    expect(await createArtifacts(new HostRegistry(f.homeData)).finishArtifact({ ...transfer.to, artifactId: file.id })).toEqual(receipt);
    const first = await f.reader.readArtifact({ ...transfer.from, artifactId: file.id, offset: 0, length: Math.min(file.size, CHUNK_BYTES) });
    expect(await f.writer.artifactChunk({ ...transfer.to, artifactId: file.id, offset: 0, data: first.data })).toEqual({ size: file.size });
  }
  expect(readFileSync(join(f.workspace, "not-declared"), "utf8")).toBe("not exported");
  expect(readdirSync(f.home.artifactDirectory, { recursive: true }).filter(path => String(path).endsWith("not-declared"))).toEqual([]);
});
it("registers artifact storage only at the host-owned destination, never a caller root or symlink", () => {
  const f = fixture(), foreign = join(f.root, "foreign"); mkdirSync(foreign);
  expect(() => f.home.registerEndpoint(f.registration("foreign", foreign, "artifact-store"))).toThrow(/artifact-root/);
  expect(() => f.home.registerEndpoint(f.registration("escape", join(f.home.artifactDirectory, "..", "..", "foreign"), "artifact-store"))).toThrow(/artifact-root/);
  const isolated = join(f.root, "isolated-data"); mkdirSync(isolated); const registry = new HostRegistry(isolated);
  symlinkSync(foreign, registry.artifactDirectory);
  expect(() => registry.registerEndpoint(f.registration("aliased", registry.artifactDirectory, "artifact-store"))).toThrow(/authority-state-invalid|artifact-root/);
  expect(readdirSync(foreign)).toEqual([]);
});
it.each(["../outside", "/absolute", ".git/config", "nested/../../outside"])("rejects escaping or Git-metadata declaration %s", async relativePath => {
  const f = fixture(); await expect(f.reader.inspectArtifacts({ ...f.from, relativePaths: [relativePath] })).rejects.toThrow();
});
it("refuses symlink leaves and parents, but may read an explicitly declared regular hard link", async () => {
  const f = fixture(), outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "file"), "evidence");
  symlinkSync(outside, join(f.workspace, "parent")); symlinkSync(join(outside, "file"), join(f.workspace, "leaf"));
  for (const path of ["parent/file", "leaf"]) await expect(f.reader.inspectArtifacts({ ...f.from, relativePaths: [path] })).rejects.toThrow(/unsafe-artifact/);
  linkSync(join(outside, "file"), join(f.workspace, "declared-hardlink"));
  expect((await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["declared-hardlink"] })).files[0]?.sha256).toBe(sha256("evidence"));
  expect(readFileSync(join(outside, "file"), "utf8")).toBe("evidence");
});
it("fails the declaration when any requested file is missing or too large", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "available"), "evidence"); writeFileSync(join(f.workspace, "large"), ""); truncateSync(join(f.workspace, "large"), BLOB_MAX_BYTES + 1);
  await expect(f.reader.inspectArtifacts({ ...f.from, relativePaths: ["available", "missing"] })).rejects.toThrow(/artifact-unavailable/);
  await expect(f.reader.inspectArtifacts({ ...f.from, relativePaths: ["large"] })).rejects.toThrow(/file-too-large/);
});
it("rejects invented handles, changed bytes and reads outside the pinned artifact manifest", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "report"), "original");
  const [file] = (await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["report"] })).files, transfer = f.bind([file!]);
  await expect(f.reader.readArtifact({ ...transfer.from, artifactId: "invented", offset: 0, length: 1 })).rejects.toThrow(/artifact-not-granted/);
  await expect(f.writer.artifactChunk({ ...transfer.to, artifactId: "invented", offset: 0, data: "YQ==" })).rejects.toThrow(/artifact-not-granted/);
  await expect(f.reader.readArtifact({ ...transfer.from, artifactId: file!.id, offset: file!.size, length: 1 })).rejects.toThrow(/invalid-range/);
  writeFileSync(join(f.workspace, "report"), "changed!");
  await expect(f.reader.readArtifact({ ...transfer.from, artifactId: file!.id, offset: 0, length: 1 })).rejects.toThrow(/artifact-changed/);
});
it("rejects uninspected source declarations and artifact ids belonging to a different endpoint", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "report"), "original");
  const invented = { id: "invented", relativePath: "report", sourceEndpointId: f.from.endpointId, size: 8, sha256: sha256("original") };
  const transfer = f.bind([invented]);
  await expect(f.reader.readArtifact({ ...transfer.from, artifactId: invented.id, offset: 0, length: 1 })).rejects.toThrow(/artifact-not-inspected/);
  const another = f.bind([{ ...invented, sourceEndpointId: "foreign-endpoint" }], "foreign-transfer");
  await expect(f.reader.readArtifact({ ...another.from, artifactId: invented.id, offset: 0, length: 1 })).rejects.toThrow(/artifact-not-granted/);
});
it("rejects wrong byte counts and hashes, preserving the upload for reconciliation", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "report"), "original"); const [file] = (await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["report"] })).files;
  const transfer = f.bind([file!]), input = { ...transfer.to, artifactId: file!.id };
  await expect(f.writer.artifactChunk({ ...input, offset: 0, data: Buffer.alloc(9).toString("base64") })).rejects.toThrow(/invalid-range/);
  await f.writer.artifactChunk({ ...input, offset: 0, data: Buffer.from("wrong!!!").toString("base64") });
  await expect(f.writer.finishArtifact(input)).rejects.toThrow(/artifact-mismatch/);
  await expect(f.writer.artifactChunk({ ...input, offset: 0, data: Buffer.from("original").toString("base64") })).rejects.toThrow(/chunk-conflict/);
});
it("refuses an incomplete upload until all declared bytes arrive", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "report"), "original"); const [file] = (await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["report"] })).files;
  const transfer = f.bind([file!]), input = { ...transfer.to, artifactId: file!.id };
  await f.writer.artifactChunk({ ...input, offset: 0, data: Buffer.from("orig").toString("base64") });
  await expect(f.writer.finishArtifact(input)).rejects.toThrow(/artifact-mismatch/);
  await f.writer.artifactChunk({ ...input, offset: 4, data: Buffer.from("inal").toString("base64") });
  expect(await f.writer.finishArtifact(input)).toMatchObject({ size: 8, sha256: file!.sha256 });
});
it("copies core thread-storage evidence from its own registered host and root", async () => {
  const f = fixture(), storage = join(f.root, "core-thread-storage"), data = join(f.root, "storage-host-data"); mkdirSync(storage); mkdirSync(data);
  writeFileSync(join(storage, "evidence.md"), "actual storage host evidence");
  const registry = new HostRegistry(data), registration = f.registration("thread-storage", storage, "artifact-read");
  registry.registerEndpoint(registration); const reader = createArtifacts(registry), authority = f.authority("thread-storage");
  const files = (await reader.inspectArtifacts({ ...authority, relativePaths: ["evidence.md"] })).files, file = files[0]!;
  const from = { ...authority, transferId: "storage-transfer" }, to = { ...f.to, transferId: "storage-transfer" };
  for (const [host, endpoint] of [[registry, from], [f.home, to]] as const) host.registerTransfer({ ...endpoint, snapshotId: "snapshot-a", direction: "artifacts", objectFormat: "sha1", base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), fromEndpointId: authority.endpointId, toEndpointId: f.to.endpointId, allowedRefs: [], uploads: [], artifacts: files });
  const bytes = await createArtifacts(new HostRegistry(data)).readArtifact({ ...from, artifactId: file.id, offset: 0, length: file.size });
  await f.writer.artifactChunk({ ...to, artifactId: file.id, offset: 0, data: bytes.data });
  const receipt = await f.writer.finishArtifact({ ...to, artifactId: file.id });
  expect(readFileSync(f.savedPath(receipt.storageKey), "utf8")).toBe("actual storage host evidence");
});
it("refuses a private storage parent swapped for a symlink before publication", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "report"), "original"); const [file] = (await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["report"] })).files;
  const transfer = f.bind([file!]), input = { ...transfer.to, artifactId: file!.id }, outside = join(f.root, "outside"); mkdirSync(outside);
  await f.writer.artifactChunk({ ...input, offset: 0, data: Buffer.from("original").toString("base64") });
  artifactFaults.beforePublish = () => {
    const [placementDirectory] = readdirSync(f.home.artifactDirectory);
    rmSync(join(f.home.artifactDirectory, placementDirectory!), { recursive: true }); symlinkSync(outside, join(f.home.artifactDirectory, placementDirectory!));
  };
  await expect(f.writer.finishArtifact(input)).rejects.toThrow(/authority-state-invalid/);
  expect(readdirSync(outside)).toEqual([]);
});
it("rechecks cancellation immediately before publishing a verified artifact", async () => {
  const f = fixture(); writeFileSync(join(f.workspace, "report"), "original"); const [file] = (await f.reader.inspectArtifacts({ ...f.from, relativePaths: ["report"] })).files;
  const transfer = f.bind([file!]), input = { ...transfer.to, artifactId: file!.id };
  await f.writer.artifactChunk({ ...input, offset: 0, data: Buffer.from("original").toString("base64") });
  artifactFaults.beforePublish = () => { f.home.revokePlacement({ placementId: "placement-a", generation: 1, reason: "cancel" }); };
  await expect(f.writer.finishArtifact(input)).rejects.toMatchObject({ name: "AbortError" }); await f.home.settlePlacement("placement-a", 1);
  expect(readdirSync(f.home.artifactDirectory, { recursive: true }).filter(path => existsSync(join(f.home.artifactDirectory, String(path))) && String(path).endsWith(".artifact"))).toEqual([]);
});
