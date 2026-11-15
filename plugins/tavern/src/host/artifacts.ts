import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, type BigIntStats } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BLOB_MAX_BYTES, CHUNK_BYTES, hostContract, repoPathSchema, type HostInput, type HostOutput } from "../host-contract";
import { artifactFileSchema, type ArtifactFile } from "../shared/placement";
import { hostContext, onCheckout, transferContext, type HostContext, type TransferContext } from "./context";
import { decodeChunk, digest, writeChunk } from "./files";
import { authorityOf, HostError, HostRegistry, transferAuthorityOf } from "./registry";

type ArtifactMethod = "inspectArtifacts" | "readArtifact" | "artifactChunk" | "finishArtifact";
export type ArtifactPort = { [M in ArtifactMethod]: (input: HostInput<M>, signal?: AbortSignal) => Promise<HostOutput<M>> };
export const artifactFaults: { beforePublish?: () => void | Promise<void> } = {};
const metadataName = (id: string) => "artifact-" + digest(id) + ".json";
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function readDeclared(context: HostContext, root: string, path: string, range?: { offset: number; length: number }): Promise<{ size: number; sha256: string; bytes: Buffer }> {
  repoPathSchema.parse(path);
  const directories: Array<{ path: string; stat: BigIntStats }> = [];
  let current = root;
  try {
    for (const part of ["", ...path.split("/").slice(0, -1)]) {
      current = join(current, part);
      const stat = lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HostError("unsafe-artifact", "A declared artifact cannot traverse symlinks or non-directory parents.");
      directories.push({ path: current, stat });
    }
    if (realpathSync(root) !== root) throw new HostError("unsafe-artifact", "The declared artifact root no longer resolves to its registered directory.");
    const leaf = lstatSync(join(root, path));
    if (leaf.isSymbolicLink() || !leaf.isFile()) throw new HostError("unsafe-artifact", "Declare regular artifact files, not directories or symlinks.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("artifact-unavailable", "A declared artifact is missing; preserve every declared file before releasing its owner.");
    throw error;
  }
  const file = join(root, path), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new HostError("unsafe-artifact", "The declared artifact is no longer a regular file.");
    const size = Number(before.size);
    if (size > BLOB_MAX_BYTES) throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines.");
    if (range && range.offset + range.length > size) throw new HostError("invalid-range", "The requested bytes exceed the declared artifact.");
    const check = () => {
      context.active();
      if (realpathSync(root) !== root || directories.some(directory => {
        const stat = lstatSync(directory.path, { bigint: true });
        return !stat.isDirectory() || stat.isSymbolicLink() || !sameInode(stat, directory.stat);
      })) throw new HostError("artifact-changed", "An artifact directory changed while its bytes were read.");
      const leaf = lstatSync(file, { bigint: true });
      if (leaf.isSymbolicLink() || !sameInode(leaf, before)) throw new HostError("artifact-changed", "The declared artifact was replaced while it was read.");
    };
    check();
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(size, 1))), bytes = Buffer.alloc(range?.length ?? 0);
    for (let at = 0; at < size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - at), at);
      if (!count) throw new HostError("artifact-changed", "The declared artifact became shorter while it was read.");
      hash.update(buffer.subarray(0, count));
      if (range) {
        const start = Math.max(at, range.offset), end = Math.min(at + count, range.offset + range.length);
        if (end > start) buffer.copy(bytes, start - range.offset, start - at, end - at);
      }
      at += count;
      await setImmediate(undefined, { signal: context.signal });
    }
    check();
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new HostError("artifact-changed", "The declared artifact changed while its bytes were read.");
    return { size, sha256: hash.digest("hex"), bytes };
  } finally { closeSync(fd); }
}
function granted(context: TransferContext, artifactId: string, destination: boolean): ArtifactFile {
  if (context.transfer.direction !== "artifacts" || (destination ? context.transfer.toEndpointId : context.transfer.fromEndpointId) !== context.authority.endpointId)
    throw new HostError("transfer-endpoint", "This endpoint is not the artifact transfer's registered source/destination.");
  const file = context.transfer.artifacts.find(file => file.id === artifactId);
  if (!file || !destination && file.sourceEndpointId !== context.authority.endpointId)
    throw new HostError("artifact-not-granted", "This artifact does not belong to the endpoint and pinned transfer manifest.");
  return file;
}
const stagingPath = (context: TransferContext, file: ArtifactFile) => context.registry.transferPath(context.authority, "artifact-" + digest(file.id));
function privateFile(file: string): void {
  const status = lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) throw new HostError("unsafe-artifact", "Stored artifacts must be private regular files without external hard links.");
}
async function verified(context: HostContext, file: string, declared: ArtifactFile, range?: { offset: number; length: number }) {
  privateFile(file);
  const actual = await readDeclared(context, dirname(file), basename(file), range);
  if (actual.size !== declared.size || actual.sha256 !== declared.sha256) throw new HostError("artifact-mismatch", "The artifact's accepted bytes do not match its declared size and SHA-256; retain its owner and reconcile the transfer.");
  return actual;
}
function syncFile(file: string): void {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncArtifact(registry: HostRegistry, file: string): void {
  syncFile(file);
  const root = dirname(registry.artifactDirectory);
  for (let directory = dirname(file);; directory = dirname(directory)) {
    syncFile(directory);
    if (directory === root) break;
  }
}
function detachStaging(staging: string, target: string): void {
  if (!present(staging)) return;
  const staged = lstatSync(staging, { bigint: true }), stored = lstatSync(target, { bigint: true });
  if (staged.isFile() && stored.isFile() && sameInode(staged, stored)) unlinkSync(staging);
}
export function createArtifacts(registry: HostRegistry): ArtifactPort {
  function method<M extends ArtifactMethod>(name: M, destination: boolean, work: (context: TransferContext, input: HostInput<M>) => Promise<HostOutput<M>>): ArtifactPort[M] {
    return (async (raw: HostInput<M>, signal?: AbortSignal) => {
      const input = hostContract[name].input.parse(raw) as HostInput<M>, authority = authorityOf(input);
      return registry.operation(authority, signal, combined => {
        const access = destination ? ["artifact-store" as const] : ["artifact-read" as const, "member-write" as const];
        const endpoint = registry.endpoint(authority, access);
        return onCheckout(endpoint.realRoot, combined, () => {
          const context = "transferId" in input ? transferContext(registry, transferAuthorityOf(input), access, combined) : hostContext(registry, authority, access, combined);
          return work(context as TransferContext, input);
        });
      });
    }) as ArtifactPort[M];
  }
  return {
    inspectArtifacts: method("inspectArtifacts", false, async (context, input) => {
      const files: ArtifactFile[] = []; let encodedSize = 12;
      for (const relativePath of new Set(input.relativePaths)) {
        const observed = await readDeclared(context, context.root, relativePath);
        const id = "artifact-" + digest(JSON.stringify([input.placementId, input.generation, input.endpointId, relativePath, observed.size, observed.sha256]));
        const file = artifactFileSchema.parse({ id, sourceEndpointId: input.endpointId, relativePath, size: observed.size, sha256: observed.sha256 });
        encodedSize += Buffer.byteLength(JSON.stringify(file)) + 1;
        if (encodedSize > 8 * 1024 * 1024 - 64) throw new HostError("manifest-too-large", "The declared artifact manifest exceeds the host response limit.");
        context.active(); registry.writeEndpointState(authorityOf(input), metadataName(id), artifactFileSchema, file);
        files.push(file);
      }
      return { files };
    }),
    readArtifact: method("readArtifact", false, async (context, input) => {
      const file = granted(context, input.artifactId, false), inspected = registry.readEndpointState(authorityOf(input), metadataName(file.id), artifactFileSchema);
      if (!inspected || JSON.stringify(inspected) !== JSON.stringify(file)) throw new HostError("artifact-not-inspected", "Inspect the declared artifact on its actual source host before reading its bytes.");
      if (input.offset + input.length > file.size) throw new HostError("invalid-range", "The requested range exceeds the pinned artifact size.");
      // Each range must still belong to the same complete file, not a mixture of report versions.
      const actual = await readDeclared(context, context.root, file.relativePath, input);
      if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw new HostError("artifact-changed", "A declared artifact changed after inspection; preserve the new manifest before releasing its owner.");
      return { data: actual.bytes.toString("base64") };
    }),
    artifactChunk: method("artifactChunk", true, async (context, input) => {
      const file = granted(context, input.artifactId, true), bytes = decodeChunk(input.data);
      if (input.offset + bytes.length > file.size) throw new HostError("invalid-range", "The upload exceeds its declared artifact size.");
      const target = registry.artifactPath(context.authority, file.id);
      if (present(target.file)) {
        const actual = await verified(context, target.file, file, { offset: input.offset, length: bytes.length });
        if (!actual.bytes.equals(bytes)) throw new HostError("chunk-conflict", "A retried chunk differs from the artifact already stored.");
        return { size: file.size };
      }
      context.active();
      return { size: writeChunk(stagingPath(context, file), input.offset, bytes) };
    }),
    finishArtifact: method("finishArtifact", true, async (context, input) => {
      const file = granted(context, input.artifactId, true), staging = stagingPath(context, file), target = registry.artifactPath(context.authority, file.id);
      if (present(target.file)) {
        detachStaging(staging, target.file);
        await verified(context, target.file, file);
        syncArtifact(registry, target.file);
        return { storageKey: target.storageKey, size: file.size, sha256: file.sha256 };
      }
      if (!present(staging)) throw new HostError("artifact-unavailable", "The declared artifact has not been uploaded completely.");
      await verified(context, staging, file);
      syncFile(staging);
      await artifactFaults.beforePublish?.(); context.active();
      const destination = registry.artifactPath(context.authority, file.id);
      try { linkSync(staging, destination.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      detachStaging(staging, destination.file);
      await verified(context, destination.file, file);
      syncArtifact(registry, destination.file);
      return { storageKey: destination.storageKey, sha256: file.sha256, size: file.size };
    }),
  };
}
