import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { sourceFetchSchema, gitOidSchema } from "../shared/placement";
import { gitRefSchema } from "../host-contract";
import { worktreeState } from "./member-worktree";
import { execGit } from "./exec-git";

const extra = { GIT_NO_REPLACE_OBJECTS: "1" };
async function git(root: string, args: string[], input?: string | Buffer, index?: string, cwd = root) {
  return (await execGit(root, args, {
    cwd, encoding: "utf8", input, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, gitDir: root, extra: { ...extra, ...(index ? { GIT_INDEX_FILE: index } : {}) },
  })).trim();
}
export async function cleanRebaseMatches(repository: string, verifiedCommit: string, commit: string, destination?: string) {
  if (!destination || ![verifiedCommit, commit, destination].every(oid => gitOidSchema.safeParse(oid).success)) return false;
  let directory: string | undefined;
  try {
    const verifiedBase = await git(repository, ["merge-base", verifiedCommit, destination]);
    const mergeBase = await git(repository, ["merge-base", commit, destination]);
    const range = async (base: string, tip: string) => (await git(repository, ["rev-list", "--reverse", "--topo-order", `${base}..${tip}`])).split("\n").filter(Boolean);
    const before = await range(verifiedBase, verifiedCommit), after = await range(mergeBase, commit);
    if (!before.length || before.length !== after.length) return false;
    const patchesFor = async (oids: string[]) => {
      const patches: string[] = [];
      for (const oid of oids) {
        if ((await git(repository, ["rev-list", "--parents", "-n", "1", oid])).split(" ").length !== 2) throw new Error("A merge inside the range needs a fresh verdict");
        patches.push(`${await git(repository, ["show", "--format=", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", oid])}\n`);
      }
      return patches;
    };
    const patches = await patchesFor(before), targetPatches = await patchesFor(after);
    const identity = async (diff: string) => (await git(repository, ["patch-id", "--stable"], diff)).split(" ")[0];
    for (const [i, diff] of patches.entries()) {
      const id = await identity(diff);
      if (!id || id !== await identity(targetPatches[i]!)) return false;
    }
    directory = await mkdtemp(join(repository, "replay-"));
    const index = join(directory, "index");
    await git(repository, ["read-tree", mergeBase], undefined, index);
    for (const diff of patches) await git(repository, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], diff, index);
    return await git(repository, ["write-tree"], undefined, index) === await git(repository, ["rev-parse", `${commit}^{tree}`]);
  } catch {
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export type RebaseHome = { root: string | null; remoteUrl: string; dataDir: string; base?: string };
export async function homeRebaseMatches(maker: string, home: RebaseHome, verifiedCommit: string, commit: string) {
  if (![verifiedCommit, commit].every(oid => gitOidSchema.safeParse(oid).success) || !sourceFetchSchema.shape.remoteUrl.safeParse(home.remoteUrl).success) return false;
  let directory: string | undefined;
  try {
    const state = await worktreeState(maker);
    if (state.dirty || state.unfinishedMerge || state.head !== commit) return false;
    await mkdir(home.dataDir, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(home.dataDir, "merge-home-"));
    const repository = join(directory, "objects.git");
    await execGit(directory, ["init", "--quiet", "--bare", repository], { cwd: directory, extra, timeout: 15_000 });
    // Keep the Git config private too: linked worktrees share their repository config with the maker.
    const cwd = home.root ?? repository;
    const advertised = home.base ? null : await git(repository, ["ls-remote", "--symref", "--", home.remoteUrl, "HEAD"], undefined, undefined, cwd);
    const branch = home.base ? (home.base.startsWith("refs/heads/") ? home.base : "refs/heads/" + home.base) : /^ref: (refs\/heads\/[^\s]+)\tHEAD$/m.exec(advertised ?? "")?.[1];
    if (!branch || !gitRefSchema.safeParse(branch).success) return false;
    const resolve = async () => {
      const lines = (await git(repository, ["ls-remote", "--refs", "--", home.remoteUrl, branch], undefined, undefined, cwd)).split("\n");
      if (lines.length !== 1) throw new Error("The destination branch cannot be resolved uniquely");
      const [oid, ref] = lines[0]!.split("\t");
      if (ref !== branch || !gitOidSchema.safeParse(oid).success) throw new Error("The destination branch has no verified commit");
      return oid!;
    };
    const destination = await resolve();
    if (advertised && !advertised.split("\n").includes(`${destination}\tHEAD`)) return false;
    await git(repository, ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "--", home.remoteUrl, branch]);
    await git(repository, ["cat-file", "-e", `${destination}^{commit}`]);
    const common = (await execGit(maker, ["merge-base", verifiedCommit, commit], { extra, encoding: "utf8", timeout: 15_000 })).trim();
    await git(repository, ["cat-file", "-e", `${common}^{commit}`]);
    const pack = await execGit(maker, ["pack-objects", "--stdout", "--revs"], { extra, input: `${verifiedCommit}\n${commit}\n^${common}\n`, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
    await git(repository, ["index-pack", "--stdin"], pack);
    const matches = await cleanRebaseMatches(repository, verifiedCommit, commit, destination);
    const final = await worktreeState(maker);
    return matches && !final.dirty && !final.unfinishedMerge && final.head === commit && await resolve() === destination;
  } catch {
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
