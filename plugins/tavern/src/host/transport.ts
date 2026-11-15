import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { BLOB_MAX_BYTES, hostContract, type Authority, type EndpointRegistration, type HostInput, type HostOutput, type TransferAuthority } from "../host-contract";
import { nativeCarry } from "./carry";
import { assertRepository, hostContext, onCheckout, transferContext, type HostContext, type TransferContext } from "./context";
import { decodeChunk, digest, writeChunk } from "./files";
import { git, gitEnvironment, runGit } from "./git";
import { abortError } from "./process";
import { authorityOf, completedImportSchema, HostError, HostRegistry, transferAuthorityOf } from "./registry";
import { rewriteTree, type TreeEntry, type TreeIO } from "./tree";
export { carryFaults } from "./carry";

type TransportMethod = "worktreeState" | "commitAll" | "exportChanges" | "readBlob" | "importChunk" | "dropUploads" | "importCommit" | "releaseSnapshotRef" | "carryStart" | "carryWrite" | "carryDelete" | "carryFinish" | "carryAbort";
export type Transport = { [M in TransportMethod]: (input: HostInput<M>, signal?: AbortSignal) => Promise<HostOutput<M>> };
const literal = { GIT_LITERAL_PATHSPECS: "1" };
const carryPlanSchema = z.object({ paths: z.array(z.string()), replaces: z.string().optional() }).strict();
const uploadFile = (context: TransferContext, upload: string) => {
  if (!context.transfer.uploads.includes(upload)) throw new HostError("upload-not-granted", "This upload handle does not belong to the registered transfer.");
  return context.registry.transferPath(context.authority, "upload-" + digest(upload));
};
const inputDigest = (input: Authority) => { const { operationId: _operationId, ...value } = input; return digest(JSON.stringify(value)); };
const hasCommit = async (context: HostContext, sha: string) => (await context.run(["cat-file", "-e", sha + "^{commit}"])).code === 0;
const treeOf = (context: HostContext, sha: string) => context.git(["rev-parse", "--verify", sha + "^{tree}"]);
async function firstParentWithTree(context: HostContext, head: string, tree: string): Promise<string | null> {
  let sha: string | undefined = head;
  for (let step = 0; sha !== undefined && step < 200; step++) {
    const raw = await context.git(["cat-file", "commit", sha], { raw: true });
    const end = raw.indexOf("\n\n"), headers = end < 0 ? raw : raw.slice(0, end);
    if (/^tree ([a-f0-9]+)$/mu.exec(headers)?.[1] === tree) return sha;
    sha = /^parent ([a-f0-9]+)$/mu.exec(headers)?.[1];
  }
  return null;
}
async function identity(context: HostContext): Promise<string[]> {
  return (await context.run(["config", "--get", "user.email"])).stdout.trim() ? [] : ["-c", "user.name=Tavern", "-c", "user.email=tavern@localhost"];
}
function requireDirection(context: TransferContext, direction: "bring-home" | "carry-out"): void {
  if (context.transfer.direction !== direction || context.transfer.toEndpointId !== context.authority.endpointId)
    throw new HostError("transfer-endpoint", "This operation is not permitted on the transfer's source/destination.");
}
async function fetchBase(context: TransferContext, remote: string, branch: string, timeoutMs: number): Promise<boolean> {
  if (await hasCommit(context, context.transfer.base)) return true;
  for (const ref of [branch.startsWith("refs/") ? branch : "refs/heads/" + branch, context.transfer.base]) {
    await context.run(["-c", "fetch.uriprotocols=", "-c", "transfer.bundleURI=false", "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", remote, ref], { timeoutMs });
    if (await hasCommit(context, context.transfer.base)) return true;
  }
  return false;
}
function parseCommit(raw: string): Pick<HostOutput<"exportChanges">, "author" | "message"> {
  const split = raw.indexOf("\n\n"), match = /^author (.*) <([^>]*)> (\d+ [+-]\d{4})$/mu.exec(split < 0 ? raw : raw.slice(0, split));
  if (!match) throw new HostError("invalid-commit", "The pinned source commit has no readable author identity.");
  return { author: { name: match[1]!, email: match[2]!, date: match[3]! }, message: split < 0 ? "" : raw.slice(split + 2) };
}
async function exportChanges(context: TransferContext): Promise<HostOutput<"exportChanges">> {
  if (context.transfer.fromEndpointId !== context.authority.endpointId) throw new HostError("transfer-endpoint", "Only the pinned source endpoint may export this snapshot.");
  const { base, head, tree } = context.transfer;
  if (await context.git(["merge-base", base, head]) !== base || await treeOf(context, head) !== tree)
    throw new HostError("snapshot-mismatch", "The registered source base/head/tree do not match the immutable repository objects.");
  const metadata = parseCommit(await context.git(["cat-file", "commit", head], { raw: true }));
  const fields = (await context.git(["diff", "--name-status", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", base, head, "--"], { raw: true })).split("\0");
  const changes: HostOutput<"exportChanges">["changes"] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const status = fields[at];
    if (!["A", "M", "T", "D"].includes(status!)) throw new HostError("unsupported-change", "The source diff contains an unsupported change kind.");
    changes.push({ status: status as "A" | "M" | "T" | "D", path: fields[at + 1]! });
  }
  const kept = changes.filter(change => change.status !== "D"), entries = new Map<string, { mode: string; type: string; blob: string }>();
  for (let at = 0; at < kept.length; at += 500) {
    const output = await context.git(["ls-tree", "-z", "--full-tree", head, "--", ...kept.slice(at, at + 500).map(change => change.path)], { raw: true, env: literal });
    for (const row of output.split("\0")) {
      if (!row) continue;
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.*)$/su.exec(row);
      if (!match) throw new HostError("invalid-tree", "The source tree contains an unreadable entry.");
      entries.set(match[4]!, { mode: match[1]!, type: match[2]!, blob: match[3]! });
    }
  }
  for (const change of kept) {
    const entry = entries.get(change.path);
    if (!entry) throw new HostError("invalid-tree", "The pinned tree does not contain a declared changed path.");
    if (entry.type !== "blob") throw new HostError("submodule-unsupported", "Submodules cannot be transferred between machines in this version.");
    change.mode = entry.mode as typeof change.mode; change.blob = entry.blob;
  }
  const blobs = [...new Set(kept.map(change => change.blob!))], sizes = new Map<string, number>();
  if (blobs.length) for (const row of (await context.git(["cat-file", "--batch-check"], { input: blobs.join("\n") + "\n" })).split("\n")) {
    const [blob, type, size] = row.split(" "); if (type === "blob") sizes.set(blob!, Number(size));
  }
  for (const change of kept) { const size = sizes.get(change.blob!); if (size === undefined) throw new HostError("invalid-blob", "A pinned source blob could not be sized."); change.size = size; }
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const value = hostContract.exportChanges.output.parse({ base, head, tree, ...metadata, changes });
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new HostError("manifest-too-large", "This snapshot's changed-file manifest exceeds the host response limit.");
  context.registry.writeTransferState(context.authority, "export.json", hostContract.exportChanges.output, value);
  return value;
}
async function blobRange(context: TransferContext, sha: string, offset: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const args = ["-C", context.root, "cat-file", "blob", sha];
  return experimental_runVcsProcess("git", args, () => new Promise<Buffer>((resolvePromise, reject) => {
    context.active();
    const child = spawn("git", args, { env: gitEnvironment(context.root, context.registry.dataDir), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let seen = 0, kept = 0, enough = false, timedOut = false, stderr = ""; const parts: Buffer[] = [];
    const stop = () => { if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); } } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 30_000);
    const abort = () => stop(); context.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (bytes: Buffer) => {
      if (enough) return;
      const start = Math.max(0, offset - seen), end = Math.min(bytes.length, offset + length - seen); seen += bytes.length;
      if (end > start) { parts.push(bytes.subarray(start, end)); kept += end - start; }
      if (kept === length) { enough = true; stop(); }
    });
    child.stderr.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString("utf8")).slice(-2000); });
    const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (context.signal.aborted) return reject(abortError());
      if (timedOut) return reject(new HostError("git-timeout", "Reading a pinned blob exceeded its deadline.", true));
      if (!enough && (code !== 0 || kept !== length)) return reject(new HostError("blob-read-failed", "The pinned blob range could not be read: " + stderr));
      resolvePromise(Buffer.concat(parts, kept));
    });
    if (context.signal.aborted) stop();
  }), { priority: "background", signal: context.signal });
}
async function readBlob(context: TransferContext, input: HostInput<"readBlob">): Promise<HostOutput<"readBlob">> {
  const manifest = context.registry.readTransferState(context.authority, "export.json", hostContract.exportChanges.output);
  const file = manifest?.changes.find(change => change.blob === input.sha);
  if (!file || context.transfer.fromEndpointId !== context.authority.endpointId) throw new HostError("blob-not-exported", "The blob does not belong to this transfer's exported manifest.");
  if (input.offset + input.length > file.size!) throw new HostError("invalid-range", "The requested bytes exceed the pinned source blob.");
  return { data: (await blobRange(context, input.sha, input.offset, input.length)).toString("base64") };
}
async function importCommit(context: TransferContext, input: HostInput<"importCommit">): Promise<HostOutput<"importCommit">> {
  requireDirection(context, "bring-home");
  if (input.refs.some(ref => !context.transfer.allowedRefs.includes(ref))) throw new HostError("ref-ownership", "This transfer cannot write the requested refs.");
  const requestDigest = inputDigest(input), previous = context.registry.readTransferState(context.authority, "import.json", completedImportSchema);
  if (previous) {
    if (previous.digest !== requestDigest) throw new HostError("operation-conflict", "This completed import was retried with different contents or refs.");
    for (const ref of input.refs) if (await context.git(["rev-parse", "--verify", ref]) !== previous.sha) throw new HostError("ref-changed", "A completed import's private ref changed; reconcile before retrying.");
    return { outcome: "ok", sha: previous.sha };
  }
  const files = [...new Set(input.entries.flatMap(entry => "upload" in entry ? [entry.upload] : []))];
  for (const upload of files) {
    const path = uploadFile(context, upload);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > BLOB_MAX_BYTES) throw new HostError("upload-missing", "A declared upload is absent, unsafe or too large.");
  }
  if (!await fetchBase(context, input.remote, input.baseBranch, input.networkTimeoutMs)) return { outcome: "unavailable", code: "base-unavailable", retryable: true, message: "The pinned base commit is not available on the home host." };
  const hashed = new Map<string, string>();
  for (const upload of files) hashed.set(upload, await context.git(["hash-object", "-w", "--no-filters", "--", uploadFile(context, upload)]));
  const io: TreeIO = {
    async list(tree) {
      const entries = new Map<string, TreeEntry>();
      for (const line of (await context.git(["ls-tree", "-z", "--full-tree", tree], { raw: true })).split("\0")) {
        if (!line) continue; const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.*)$/su.exec(line);
        if (!match) throw new HostError("invalid-tree", "A base tree entry cannot be read.");
        entries.set(match[4]!, { mode: match[1]!, type: match[2]!, sha: match[3]! });
      }
      return entries;
    },
    write: entries => context.git(["mktree", "-z"], { input: [...entries].map(([name, entry]) => `${entry.mode} ${entry.type} ${entry.sha}\t${name}\0`).join("") }),
  };
  const written = await rewriteTree(io, await treeOf(context, context.transfer.base), input.entries.map(entry => [entry.path, "upload" in entry ? { mode: entry.mode, sha: hashed.get(entry.upload)! } : null] as const));
  if (written !== context.transfer.tree) return { outcome: "mismatch", tree: written };
  const { author } = input;
  const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_COMMITTER_DATE: author.date };
  const sha = await context.git(["commit-tree", written, "-p", input.parent ?? context.transfer.base, "--no-gpg-sign", "-F", "-"], { input: input.message, env });
  context.active();
  if (input.refs.length) await context.git(["update-ref", "--stdin"], { input: "start\n" + input.refs.map(ref => `update ${ref} ${sha}\n`).join("") + "prepare\ncommit\n" });
  context.registry.writeTransferState(context.authority, "import.json", completedImportSchema, { digest: requestDigest, sha, tree: written, refs: input.refs });
  for (const upload of files) rmSync(uploadFile(context, upload), { force: true });
  return { outcome: "ok", sha };
}
async function releaseSnapshotRef(registry: HostRegistry, input: TransferAuthority, signal: AbortSignal): Promise<HostOutput<"releaseSnapshotRef">> {
  const intent = registry.beginSnapshotRefRelease(input, signal);
  if (intent.phase === "released") { registry.finishSnapshotRefRelease(input, signal); return { released: true }; }
  const endpoint = registry.assertSnapshotRefClaim(input), root = endpoint.realRoot;
  const active = () => {
    if (signal.aborted) throw abortError();
    const current = registry.assertSnapshotRefClaim(input);
    let actual: string, device: string, inode: string;
    try { actual = realpathSync(current.registration.endpoint.root); const stat = statSync(actual, { bigint: true }); device = String(stat.dev); inode = String(stat.ino); }
    catch { throw new HostError("endpoint-replaced", "The snapshot repository disappeared or changed during cleanup; preserve its pending release."); }
    if (actual !== root || device !== endpoint.device || inode !== endpoint.inode) throw new HostError("endpoint-replaced", "The snapshot repository changed during cleanup; reconcile its exact owning host.");
  };
  const options = (extra?: Partial<Parameters<typeof git>[2]>) => ({ ...extra, dataDir: registry.dataDir, signal, check: active });
  const context: HostContext = { registry, authority: input, signal, endpoint, root, active, git: (args, extra) => git(root, args, options(extra)), run: (args, extra) => runGit(root, args, options(extra)) };
  await assertRepository(context);
  const symbolic = await context.run(["symbolic-ref", "-q", intent.ref]);
  if (symbolic.code === 0) throw new HostError("ref-changed", "The private snapshot ref became symbolic; preserve it and reconcile rather than following it.");
  if (symbolic.code !== 1) throw new HostError("snapshot-ref-read", "Git could not prove the private ref's type; preserve it and retry after reconciliation.", true);
  const exists = await context.run(["show-ref", "--verify", "--quiet", intent.ref]);
  if (exists.code !== 0 && exists.code !== 1) throw new HostError("snapshot-ref-read", "Git could not inspect the exact private snapshot ref; preserve its pending release.", true);
  if (exists.code === 0) {
    if (await context.git(["rev-parse", "--verify", intent.ref]) !== intent.sha) throw new HostError("ref-changed", "The private snapshot ref no longer matches its completed import SHA; reconcile it without deleting newer work.");
    const result = await context.run(["update-ref", "--no-deref", "-d", intent.ref, intent.sha]);
    if (result.code !== 0) throw new HostError("snapshot-ref-cas", "Git refused the exact old-SHA ref deletion; preserve and reconcile it: " + result.stderr.trim(), true);
  }
  active(); registry.finishSnapshotRefRelease(input, signal); return { released: true };
}
export function createTransport(registry: HostRegistry): Transport {
  function method<M extends TransportMethod>(name: M, access: EndpointRegistration["access"][], work: (context: TransferContext, input: HostInput<M>) => Promise<HostOutput<M>>, repository = true): Transport[M] {
    return (async (raw: HostInput<M>, signal?: AbortSignal) => {
      const input = hostContract[name].input.parse(raw) as HostInput<M>;
      const authority = authorityOf(input);
      return registry.operation(authority, signal, combined => {
        const endpoint = registry.endpoint(authority, access);
        return onCheckout(endpoint.inspection?.commonDir ?? endpoint.realRoot, combined, async () => {
          const context = "transferId" in input ? transferContext(registry, transferAuthorityOf(input), access, combined) : hostContext(registry, authority, access, combined);
          if (repository) await assertRepository(context);
          return work(context as TransferContext, input);
        });
      });
    }) as Transport[M];
  }
  const carryMethod = <M extends "carryStart" | "carryWrite" | "carryDelete" | "carryFinish" | "carryAbort">(name: M): Transport[M] => method(name, ["member-write"], async (context, input) => {
    requireDirection(context, "carry-out");
    if (name === "carryStart") {
      registry.carryLease(context.authority, "claim");
      const start = input as HostInput<"carryStart">;
      const plan = { paths: [...new Set(start.paths)].sort(), ...(start.replaces === undefined ? {} : { replaces: start.replaces }) };
      const previous = registry.readTransferState(context.authority, "carry-plan.json", carryPlanSchema);
      if (previous && JSON.stringify(previous) !== JSON.stringify(plan)) throw new HostError("transfer-conflict", "A repeated carry start cannot change its initial paths or replacement tree.");
      if (!previous) registry.writeTransferState(context.authority, "carry-plan.json", carryPlanSchema, plan);
    } else {
      const plan = registry.readTransferState(context.authority, "carry-plan.json", carryPlanSchema);
      if (!plan) throw new HostError("carry-not-started", "Start this transfer before applying or finishing its files.");
      const paths = "path" in input ? [input.path] : "paths" in input ? input.paths : [];
      if (paths.some(path => !plan.paths.includes(path))) throw new HostError("path-not-granted", "A carry path was not declared by this transfer's start call.");
    }
    if (name === "carryFinish") registry.carryLease(context.authority, "claim");
    else if (name !== "carryStart" && (name !== "carryAbort" || registry.endpoint(authorityOf(context.authority)).activeTransfer)) registry.carryLease(context.authority, "check");
    if (name === "carryFinish" && await treeOf(context, "HEAD") === context.transfer.tree && (await context.git(["status", "--porcelain"])).length === 0) {
      const result = { outcome: "ok", head: await context.git(["rev-parse", "HEAD"]), tree: context.transfer.tree };
      registry.carryLease(context.authority, "release");
      return result as HostOutput<M>;
    }
    const native = nativeCarry(context), command = native[name] as (input: unknown, signal?: AbortSignal) => Promise<HostOutput<M>>;
    const result = await command({ ...input, worktree: context.root, base: context.transfer.base, tree: context.transfer.tree }, context.signal);
    if (name === "carryFinish" && "outcome" in result && result.outcome === "ok" || name === "carryStart" && "present" in result && result.present || name === "carryAbort" && !existsSync(registry.transferPath(context.authority, "carry.json"))) registry.carryLease(context.authority, "release");
    return result;
  });
  return {
    exportChanges: method("exportChanges", ["source-read", "member-write", "home-import"], exportChanges),
    readBlob: method("readBlob", ["source-read", "member-write", "home-import"], readBlob),
    importChunk: method("importChunk", ["home-import"], async (context, input) => {
      requireDirection(context, "bring-home"); const bytes = decodeChunk(input.data); context.active();
      if (input.offset + bytes.length > BLOB_MAX_BYTES) throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines.");
      return { size: writeChunk(uploadFile(context, input.upload), input.offset, bytes) };
    }, false),
    dropUploads: method("dropUploads", ["home-import"], async (context, input) => { for (const upload of input.uploads) { context.active(); rmSync(uploadFile(context, upload), { force: true }); } return {}; }, false),
    importCommit: method("importCommit", ["home-import"], importCommit),
    releaseSnapshotRef: async (raw, signal) => {
      const input = hostContract.releaseSnapshotRef.input.parse(raw);
      if (signal?.aborted) throw abortError();
      return registry.snapshotRefOperation(input, signal, combined => {
        const endpoint = registry.snapshotImport(input).endpoint;
        registry.beginSnapshotRefRelease(input, combined);
        return onCheckout(endpoint.inspection?.commonDir ?? endpoint.realRoot, combined, () => releaseSnapshotRef(registry, input, combined));
      });
    },
    carryStart: carryMethod("carryStart"), carryWrite: carryMethod("carryWrite"), carryDelete: carryMethod("carryDelete"), carryFinish: carryMethod("carryFinish"), carryAbort: carryMethod("carryAbort"),
    commitAll: method("commitAll", ["member-write"], async (context, input) => {
      await context.git(["add", "-A"]); const diff = await context.run(["diff", "--cached", "--quiet"]);
      if (diff.code !== 0 && diff.code !== 1) throw new HostError("git-failed", "Cannot determine the member's staged snapshot.");
      if (diff.code === 1) await context.git([...(await identity(context)), "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", input.message]);
      return { sha: await context.git(["rev-parse", "HEAD"]), committed: diff.code === 1 };
    }),
    worktreeState: method("worktreeState", ["source-read", "member-write", "home-import"], async (context, input) => {
      const branch = await context.run(["symbolic-ref", "--short", "-q", "HEAD"]), head = await context.git(["rev-parse", "HEAD"]), tree = await treeOf(context, "HEAD");
      const status = await context.git(["status", "--porcelain", ...(input.trackedOnly ? ["--untracked-files=no"] : [])]);
      const onBase = input.baseTree === undefined ? null : await firstParentWithTree(context, head, input.baseTree);
      const base = onBase ?? await context.git(["merge-base", input.base, head]);
      const tracked = await context.git(["diff", "--name-only", "-z", "--no-renames", base], { raw: true });
      const untracked = await context.git(["ls-files", "--others", "--exclude-standard", "-z"], { raw: true });
      const changed = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
      const merge = resolve(context.root, await context.git(["rev-parse", "--git-path", "MERGE_HEAD"]));
      return { branch: branch.code === 0 ? branch.stdout.trim() : null, head, tree, dirty: !!status, changed, unfinishedMerge: existsSync(merge) };
    }),
  };
}
