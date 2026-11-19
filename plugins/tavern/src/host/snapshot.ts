import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { BLOB_MAX_BYTES, hostContract, repoPathSchema, type HostInput, type HostOutput } from "../host-contract";
import { assertRepository, hostContext, onCheckout, type HostContext } from "./context";
import { gitEnvironment, rawChanges, requireSparseGit, runGitProcess, withGitDeadline } from "./git";
import { porcelainSnapshot } from "./porcelain";
import { authorityOf, HostError, type HostRegistry } from "./registry";

const config = ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.splitIndex=false"];
const paths = (text: string) => text.split("\0").filter(Boolean);
type Snapshot = Extract<HostOutput<"snapshotWorktree">, { commit: string }>;

async function capture(context: HostContext, input: HostInput<"snapshotWorktree">): Promise<Snapshot> {
  await assertRepository(context);
  if (context.endpoint.registration.git === "porcelain") return porcelainSnapshot(context, input.base);
  await requireSparseGit(context);
  const git = (args: string[], options?: Parameters<HostContext["git"]>[1]) => context.git([...config, ...args], options);
  const head = await git(["rev-parse", "HEAD"]), headTree = await git(["rev-parse", "HEAD^{tree}"]);
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (existsSync(resolve(context.root, await git(["rev-parse", "--git-path", name]))))
      throw new HostError("unfinished-merge", "Resolve the checkout's unfinished merge, cherry-pick, revert or rebase before taking a source snapshot.");
  }
  const unmerged = await git(["ls-files", "--unmerged", "-z"], { raw: true });
  if (unmerged)
    throw new HostError("unfinished-merge", "Resolve the checkout's unmerged index entries before taking a source snapshot.");
  const temporary = mkdtempSync(join(context.registry.dataDir, "snapshot-")), index = join(temporary, "index");
  try {
    const realIndex = resolve(context.root, await git(["rev-parse", "--git-path", "index"]));
    if (existsSync(realIndex)) {
      const stat = statSync(realIndex);
      copyFileSync(realIndex, index);
      utimesSync(index, stat.atime, stat.mtime);
    }
    const indexed = async (args: string[], input?: string, extra?: Record<string, string>): Promise<string> => {
      context.active();
      const argv = ["-C", context.root, ...config, ...args];
      const result = await experimental_runVcsProcess("git", argv, () => {
        context.active();
        return runGitProcess(argv, { env: { ...gitEnvironment(context.root, context.registry.dataDir, extra), GIT_INDEX_FILE: index }, input, signal: context.signal, timeoutMs: ["read-tree", "diff-files", "diff-index", "ls-files", "update-index", "add", "write-tree"].includes(args[0]!) ? 300_000 : 30_000, maxBuffer: 64 * 1024 * 1024 });
      }, { priority: "background", signal: context.signal });
      context.active();
      if (result.timedOut) throw new HostError("git-timeout", "Git " + args[0] + " exceeded the source snapshot deadline.", true);
      if (result.code !== 0) throw new HostError("snapshot-failed", "Git " + args[0] + " failed while taking a read-only source snapshot: " + (result.stderr.trim() || result.stdout.trim()).slice(-2000));
      return args.includes("-z") ? result.stdout : result.stdout.trim();
    };
    if (!existsSync(index)) await indexed(["read-tree", "HEAD"]);
    const candidates = paths(await indexed(["diff-files", "--name-only", "--no-ext-diff", "--no-textconv", "-z", "--"]));
    const untracked = paths(await indexed(["ls-files", "--others", "--exclude-standard", "-z"]));
    const changed = [...new Set([...candidates, ...untracked])];
    if (changed.length > 50_000) throw new HostError("too-many-paths", "This snapshot exceeds the 50000 changed-path transfer limit.");
    for (const path of changed) {
      if (path.endsWith("/")) throw new HostError("submodule-unsupported", "Nested repositories and submodules cannot be transferred between machines in this version: " + path);
      if (!repoPathSchema.safeParse(path).success) throw new HostError("unsupported-path", "This snapshot contains a path that cannot be transferred safely: " + path);
      const file = join(context.root, path);
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      if (stat.isDirectory()) throw new HostError("submodule-unsupported", "Nested repositories and submodules cannot be transferred between machines in this version.");
      if (stat.size > BLOB_MAX_BYTES || stat.isSymbolicLink() && Buffer.byteLength(readlinkSync(file)) > BLOB_MAX_BYTES)
        throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines: " + path);
    }
    rawChanges(await indexed(["diff-index", "--cached", "--raw", "-z", "--no-renames", "HEAD", "--"]));
    await indexed(["update-index", "--no-split-index"]);
    await indexed(["add", "-A", "--sparse", "--", "."]);
    const untrackedSet = new Set(untracked);
    const modified = paths(await indexed(["diff-index", "--cached", "--name-only", "--no-ext-diff", "--no-textconv", "-z", "HEAD", "--"])).filter(path => !untrackedSet.has(path));
    const tree = await indexed(["write-tree"]);
    const delta = rawChanges(await git(["diff", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", input.base, tree, "--"], { raw: true }));
    for (const { path } of delta) {
      if (!repoPathSchema.safeParse(path).success) throw new HostError("unsupported-path", "This snapshot contains a path that cannot be transferred safely: " + path);
    }
    if (delta.length > 50_000) throw new HostError("too-many-paths", "This snapshot exceeds the 50000 changed-path transfer limit.");
    const entries = new Map<string, { mode: string; blob: string; size: number }>();
    for (let at = 0; at < delta.length; at += 500) {
      const listed = await git(["ls-tree", "-lz", "--full-tree", tree, "--", ...delta.slice(at, at + 500).map(change => change.path)], { raw: true, env: { GIT_LITERAL_PATHSPECS: "1" } });
      for (const row of paths(listed)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t(.*)$/su.exec(row);
        if (!match) throw new HostError("invalid-tree", "The source snapshot contains an unreadable tree entry.");
        if (match[2] !== "blob") throw new HostError("submodule-unsupported", "Submodules cannot be transferred between machines in this version.");
        if (!repoPathSchema.safeParse(match[5]).success) throw new HostError("unsupported-path", "This snapshot contains a path that cannot be transferred safely: " + match[5]);
        if (Number(match[4]) > BLOB_MAX_BYTES) throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines: " + match[5]);
        entries.set(match[5]!, { mode: match[1]!, blob: match[3]!, size: Number(match[4]) });
      }
    }
    const changedAfterAdd = await indexed(["diff-files", "--name-only", "--no-ext-diff", "--no-textconv", "-z", "--ignore-submodules=none", "--"]);
    if (changedAfterAdd || paths(await indexed(["ls-files", "--others", "--exclude-standard", "-z"])).length || await git(["rev-parse", "HEAD"]) !== head)
      throw new HostError("source-changed", "The source changed during its read-only snapshot; retry when it is idle.", true);
    const [name, email, authorDate, committerName, committerEmail, committerDate] = (await git(["show", "-s", "--format=%an%x00%ae%x00%at %ai%x00%cn%x00%ce%x00%ct %ci", head], { raw: true })).trimEnd().split("\0");
    const date = (value: string) => { const parts = value.split(" "); return `${parts[0]} ${parts.at(-1)}`; };
    const commit = tree === headTree ? head : await indexed(["commit-tree", tree, "-p", head, "--no-gpg-sign", "-F", "-"], "Tavern read-only working-tree snapshot\n", {
      GIT_AUTHOR_NAME: name!, GIT_AUTHOR_EMAIL: email!, GIT_AUTHOR_DATE: date(authorDate!),
      GIT_COMMITTER_NAME: committerName!, GIT_COMMITTER_EMAIL: committerEmail!, GIT_COMMITTER_DATE: date(committerDate!),
    });
    const raw = await git(["cat-file", "commit", commit], { raw: true }), split = raw.indexOf("\n\n");
    const author = /^author (.*) <([^>]*)> (\d+ [+-]\d{4})$/mu.exec(split < 0 ? raw : raw.slice(0, split));
    if (!author) throw new HostError("invalid-commit", "The source snapshot has no readable author identity.");
    const manifest = hostContract.exportChanges.output.parse({ base: input.base, head: commit, tree,
      author: { name: author[1], email: author[2], date: author[3] }, message: split < 0 ? "" : raw.slice(split + 2),
      changes: delta.map(change => ({ ...change, ...entries.get(change.path) })),
    });
    if (Buffer.byteLength(JSON.stringify(manifest)) > 8 * 1024 * 1024)
      throw new HostError("manifest-too-large", "This snapshot's changed-file manifest exceeds the host response limit.");
    const includesUncommitted = tree !== headTree;
    return { head, headTree, commit, tree, includesUncommitted, modifiedPaths: includesUncommitted ? modified.length : 0, untrackedPaths: includesUncommitted ? untracked.length : 0 };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function snapshotWorktree(registry: HostRegistry, raw: HostInput<"snapshotWorktree">, signal?: AbortSignal): Promise<Snapshot> {
  const input = hostContract.snapshotWorktree.input.parse(raw);
  const authority = authorityOf(input);
  return registry.operation(authority, signal, combined => {
    const endpoint = registry.endpoint(authority, ["source-read", "member-write"]);
    return withGitDeadline(bounded => onCheckout(endpoint.inspection?.commonDir ?? endpoint.realRoot, bounded, () => capture(hostContext(registry, authority, ["source-read", "member-write"], bounded), input)), combined);
  });
}
