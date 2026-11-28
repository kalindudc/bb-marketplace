import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, type GitOptions } from "../host/git";
import { realPath, within } from "../scope/paths";
import { gitWorktreeRoot } from "../scope/worktree";
import { checkerSnapshotsPath } from "../scope/control-files";

const snapshotId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identity = { GIT_AUTHOR_NAME: "Tavern", GIT_AUTHOR_EMAIL: "tavern@example.invalid",
  GIT_COMMITTER_NAME: "Tavern", GIT_COMMITTER_EMAIL: "tavern@example.invalid", GIT_NO_REPLACE_OBJECTS: "1" };

export class CheckerSnapshots {
  private readonly directory: string;
  private readonly records: string;
  private readonly removing = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.directory = checkerSnapshotsPath(realPath(dataDir));
    this.records = join(realPath(dataDir), "scopes", "checker-snapshot-sources");
  }

  async capture(path: string, id: string) {
    if (!snapshotId.test(id)) throw new Error("Invalid checker snapshot ID");
    const sourceWorktree = gitWorktreeRoot(path, "dedicated-machine");
    if (within(realPath(this.directory), sourceWorktree) || within(sourceWorktree, realPath(this.directory)))
      throw new Error("The checker snapshot storage must be separate from the maker's checkout");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.records, { recursive: true, mode: 0o700 });
    if (realPath(this.directory) !== this.directory || realPath(this.records) !== this.records)
      throw new Error("Checker snapshot storage must not be redirected");
    const directory = join(this.directory, id), index = join(directory, "index"), worktree = join(directory, "worktree");
    await writeFile(join(this.records, id), sourceWorktree, { flag: "wx", mode: 0o600 });
    try {
      await mkdir(directory, { mode: 0o700 });
      const run = (args: string[], options: Partial<GitOptions> = {}) => git(sourceWorktree, args, {
        dataDir: directory, snapshotWorktreeDir: directory, env: identity, ...options,
      });
      const indexed = (args: string[], options: Partial<GitOptions> = {}) => run(["-c", "core.splitIndex=false", ...args], {
        privateIndex: index, env: { ...identity, GIT_INDEX_FILE: index }, ...options,
      });
      const head = await run(["rev-parse", "--verify", "HEAD"], { readOnly: true });
      const sourceIndex = resolve(sourceWorktree, await run(["rev-parse", "--git-path", "index"], { readOnly: true }));
      if (existsSync(sourceIndex)) await copyFile(sourceIndex, index);
      else await indexed(["read-tree", head]);
      if (await indexed(["ls-files", "--unmerged"], { readOnly: true })) throw new Error("Resolve unmerged files before taking a checker snapshot");
      await indexed(["add", "-A"]);
      if ((await indexed(["ls-files", "--stage", "-z"], { raw: true, readOnly: true })).split("\0").some(entry => entry.startsWith("160000 ")))
        throw new Error("A checker snapshot cannot include nested Git repositories or submodules");
      const tree = await indexed(["write-tree"]);
      if (await indexed(["diff-files", "--name-only"], { readOnly: true }) ||
          await indexed(["ls-files", "--others", "--exclude-standard"], { readOnly: true }) ||
          await run(["rev-parse", "HEAD"], { readOnly: true }) !== head)
        throw new Error("The maker's checkout changed during the snapshot; retry when it is idle");
      const commit = await run(["commit-tree", tree, "-p", head, "--no-gpg-sign", "-m", "Tavern checker snapshot"]);
      await run(["worktree", "add", "--detach", "--", worktree, commit]);
      await rm(index, { force: true });
      return { snapshot: { id, commit }, worktree: gitWorktreeRoot(worktree), sourceWorktree };
    } catch (error) {
      try { await this.remove(id); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}; checker snapshot cleanup failed: ${String(cleanup)}`); }
      throw error;
    }
  }

  remove(id: string): Promise<void> {
    if (!snapshotId.test(id)) throw new Error("Invalid checker snapshot ID");
    const current = this.removing.get(id);
    if (current) return current;
    const removal = this.removeRecorded(id).finally(() => this.removing.delete(id));
    this.removing.set(id, removal);
    return removal;
  }

  private async removeRecorded(id: string) {
    const record = join(this.records, id), directory = join(this.directory, id), worktree = join(directory, "worktree");
    if (!existsSync(record)) return;
    if (!(await lstat(record)).isFile()) throw new Error("Invalid checker snapshot cleanup record");
    const source = await readFile(record, "utf8");
    if (existsSync(directory)) {
      if (realPath(directory) !== directory || source !== gitWorktreeRoot(source, "dedicated-machine")) throw new Error("Checker snapshot paths changed before cleanup");
      const options = { dataDir: directory, snapshotWorktreeDir: directory, env: identity };
      const listed = await git(source, ["worktree", "list", "--porcelain", "-z"], { ...options, readOnly: true, raw: true });
      const fields = listed.split("\0");
      if (fields.includes("worktree " + worktree)) {
        await git(source, ["worktree", "remove", "--force", "--", worktree], options);
        // Removal clears our registration. Do not prune unrelated stale worktrees.
        if (!fields.some(field => field.startsWith("prunable ")))
          await git(source, ["worktree", "prune", "--expire=never"], options);
      }
      await rm(directory, { recursive: true });
    }
    await rm(record);
  }

  async sweep(keep: ReadonlySet<string>, onError: (error: unknown) => void) {
    if (!existsSync(this.records)) return;
    for (const id of await readdir(this.records)) if (snapshotId.test(id) && !keep.has(id)) {
      try { await this.remove(id); }
      catch (error) { onError(error); }
    }
  }
}
