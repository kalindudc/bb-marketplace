import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { gitOidSchema } from "../shared/placement";
import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { BLOB_MAX_BYTES, hostContract, repoPathSchema, type HostOutput } from "../host-contract";
import type { HostContext } from "./context";
import { gitEnvironment, gitInvocation } from "../shared/git-safety";
import { HostError } from "./registry";
import { rewriteTree, type TreeEntry } from "./tree";

export const virtualSnapshotSchema = z.object({
  base: gitOidSchema, head: gitOidSchema, tree: gitOidSchema, committedHead: gitOidSchema,
  author: hostContract.exportChanges.output.shape.author, message: z.string(),
  edits: z.array(z.object({ path: repoPathSchema, mode: z.enum(["100644", "100755", "120000"]).optional(), sha: gitOidSchema.optional(), size: z.number().int().min(0).max(BLOB_MAX_BYTES).optional() }).strict()).max(50_000),
}).strict();

export function objectCache(context: HostContext, oid: string): string {
  const dir = join(context.registry.dataDir, "porcelain-objects");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, oid);
}
export const objectId = (format: "sha1" | "sha256", type: string, bytes: Buffer) => createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

export function parseTreeEntries(bytes: Buffer, oidBytes: number): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at), nul = bytes.indexOf(0, space);
    if (space < at || nul < space || nul + 1 + oidBytes > bytes.length) throw new HostError("invalid-tree", "The pinned tree is truncated.");
    const mode = bytes.subarray(at, space).toString().padStart(6, "0"), name = bytes.subarray(space + 1, nul).toString("latin1");
    entries.set(name, { mode, type: mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob", sha: bytes.subarray(nul + 1, nul + 1 + oidBytes).toString("hex") });
    at = nul + 1 + oidBytes;
  }
  return entries;
}
export function treeObjectBytes(entries: ReadonlyMap<string, TreeEntry>): Buffer {
  const sorted = [...entries].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av.type === "tree" ? "/" : ""), "latin1"), Buffer.from(b + (bv.type === "tree" ? "/" : ""), "latin1")));
  return Buffer.concat(sorted.flatMap(([name, entry]) => [Buffer.from(entry.mode.replace(/^0/u, "") + " "), Buffer.from(name, "latin1"), Buffer.from([0]), Buffer.from(entry.sha, "hex")]));
}

export async function readTreeBytes(context: HostContext, tree: string): Promise<Buffer> {
  const args = ["-C", context.root, "cat-file", "tree", tree];
  return experimental_runVcsProcess("git", args, async () => {
    const setup = { kind: context.endpoint.registration.git, metadata: context.endpoint.inspection, signal: context.signal };
    const env = await gitEnvironment(context.root, setup);
    const command = await gitInvocation(context.root, args, env, setup);
    context.active();
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(command.file, command.args, { env, signal: context.signal, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let size = 0, stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > 64 * 1024 * 1024) child.kill("SIGKILL"); else chunks.push(bytes); });
      child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); try { context.active(); if (code !== 0 || size > 64 * 1024 * 1024) reject(new HostError("tree-read-failed", "Cannot read the pinned tree: " + stderr)); else resolve(Buffer.concat(chunks)); } catch (error) { reject(error); } });
    });
  }, { priority: "background", signal: context.signal });
}

// Ported from plugins/loom/src/host/ops.ts. The member hashes trees without writing Git objects or an index.
export async function porcelainSnapshot(context: HostContext, base: string): Promise<Extract<HostOutput<"snapshotWorktree">, { commit: string }>> {
  const head = await context.git(["rev-parse", "--verify", "HEAD"]), headTree = await context.git(["rev-parse", "--verify", "HEAD^{tree}"]);
  const format = head.length === 40 ? "sha1" : "sha256", oidBytes = head.length / 2;
  if (await context.git(["ls-files", "--unmerged", "-z"], { raw: true })) throw new HostError("unfinished-merge", "Resolve unmerged entries before taking a snapshot.");
  const statusArgs = ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"];
  const before = await context.git(statusArgs, { raw: true, timeoutMs: 300_000 });
  const changed = before.split("\0").filter(Boolean).map(row => ({ xy: row.slice(0, 2), path: row.slice(3) }));
  if (changed.length > 50_000) throw new HostError("too-many-paths", "This snapshot exceeds the 50000 changed-path transfer limit.");
  const trees = new Map<string, Map<string, TreeEntry>>();
  const io = {
    async list(tree: string) {
      if (!trees.has(tree)) trees.set(tree, parseTreeEntries(await readTreeBytes(context, tree), oidBytes));
      return new Map(trees.get(tree)!);
    },
    async write(entries: ReadonlyMap<string, TreeEntry>) { return objectId(format, "tree", treeObjectBytes(entries)); },
  };
  const modeResult = await context.run(["config", "--type=bool", "--get", "core.filemode"]);
  if (![0, 1].includes(modeResult.code)) throw new HostError("git-capability", "Cannot read core.fileMode.");
  const fileMode = modeResult.stdout.trim() !== "false";
  const headMode = async (path: string) => {
    let tree = headTree;
    const names = Buffer.from(path).toString("latin1").split("/");
    for (const [at, name] of names.entries()) {
      if (!trees.has(tree)) await io.list(tree);
      const entry = trees.get(tree)!.get(name);
      if (!entry) return "100644";
      if (at === names.length - 1) return entry.mode;
      if (entry.type !== "tree") return "100644";
      tree = entry.sha;
    }
    return "100644";
  };
  const edits: [string, { mode: string; sha: string } | null][] = [];
  const contents = new Map<string, { sha: string; size: number; mode: string }>();
  for (const { path, xy } of changed) {
    if (path.endsWith("/")) throw new HostError("submodule-unsupported", "Nested repositories cannot be transferred: " + path);
    repoPathSchema.parse(path);
    let current = context.root, absent = false;
    for (const name of path.split("/").slice(0, -1)) {
      current = join(current, name);
      if (!existsSync(current)) break;
      const parent = lstatSync(current);
      if (parent.isSymbolicLink()) throw new HostError("unsafe-path", "A snapshot path traverses a symlink.");
      if (!parent.isDirectory()) { absent = true; break; }
    }
    const file = join(context.root, path);
    let stat;
    if (!absent) try { stat = lstatSync(file); } catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
    if (!stat || stat.isDirectory() && /D/u.test(xy)) { edits.push([path, null]); continue; }
    if (stat.isDirectory()) throw new HostError("submodule-unsupported", "Nested repositories and submodules cannot be transferred: " + path);
    if (!stat.isSymbolicLink() && !stat.isFile()) throw new HostError("unsupported-path", "Only files and symlinks can be transferred: " + path);
    if (stat.size > BLOB_MAX_BYTES) throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines: " + path);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    const sha = objectId(format, "blob", bytes), mode = stat.isSymbolicLink() ? "120000" : fileMode ? stat.mode & 0o100 ? "100755" : "100644" : await headMode(path);
    contents.set(path, { sha, size: bytes.length, mode }); writeFileSync(objectCache(context, sha), bytes);
    edits.push([path, { mode, sha }]);
  }
  const tree = edits.length ? await rewriteTree(io, headTree, edits.map(([path, edit]) => [Buffer.from(path).toString("latin1"), edit] as const)) : headTree;
  if (before !== await context.git(statusArgs, { raw: true, timeoutMs: 300_000 }) || head !== await context.git(["rev-parse", "--verify", "HEAD"])) throw new HostError("source-changed", "The source changed during capture; retry when it is idle.", true);
  for (const [path, saved] of contents) {
    const file = join(context.root, path), stat = lstatSync(file), now = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    const mode = stat.isSymbolicLink() ? "120000" : fileMode ? stat.mode & 0o100 ? "100755" : "100644" : await headMode(path);
    if (saved.sha !== objectId(format, "blob", now) || saved.mode !== mode) throw new HostError("source-changed", "The source changed during capture; retry when it is idle.", true);
  }
  const raw = await context.git(["cat-file", "commit", head], { raw: true }), split = raw.indexOf("\n\n"), headers = raw.slice(0, split);
  const author = /^author (.*) <([^>]*)> (\d+ [+-]\d{4})$/mu.exec(headers);
  if (!author) throw new HostError("invalid-commit", "The source commit has no readable author.");
  const message = "Tavern read-only working-tree snapshot\n";
  const commit = tree === headTree ? head : objectId(format, "commit", Buffer.from(`tree ${tree}\nparent ${head}\n${headers.split("\n").filter(line => /^(author|committer) /u.test(line)).join("\n")}\n\n${message}`));
  if (commit !== head) writeFileSync(objectCache(context, commit) + ".json", JSON.stringify({ base, head: commit, tree, committedHead: head, author: { name: author[1], email: author[2], date: author[3] }, message, edits: edits.map(([path, edit]) => ({ path, ...edit, size: contents.get(path)?.size })) }));
  return hostContract.snapshotWorktree.output.parse({ head, headTree, commit, tree, includesUncommitted: tree !== headTree, modifiedPaths: tree === headTree ? 0 : changed.filter(row => row.xy !== "??").length, untrackedPaths: tree === headTree ? 0 : changed.filter(row => row.xy === "??").length }) as Extract<HostOutput<"snapshotWorktree">, { commit: string }>;
}
