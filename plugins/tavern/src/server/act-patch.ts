import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sourceFetchSchema, gitOidSchema } from "../shared/placement";
import { gitRefSchema } from "../host-contract";
import { worktreeState } from "./member-worktree";
import { execGitSync } from "../shared/git-safety";

const extra = { GIT_NO_REPLACE_OBJECTS: "1" };
function git(root: string, args: string[], input?: string | Buffer, index?: string, cwd = root) {
  return execGitSync(root, args, {
    cwd, encoding: "utf8", input, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], gitDir: root, extra: { ...extra, ...(index ? { GIT_INDEX_FILE: index } : {}) },
  }).trim();
}
export function cleanRebaseMatches(repository: string, verifiedCommit: string, commit: string, destination?: string) {
  if (!destination || ![verifiedCommit, commit, destination].every(oid => gitOidSchema.safeParse(oid).success)) return false;
  let directory: string | undefined;
  try {
    const verifiedBase = git(repository, ["merge-base", verifiedCommit, destination]);
    const mergeBase = git(repository, ["merge-base", commit, destination]);
    const range = (base: string, tip: string) => git(repository, ["rev-list", "--reverse", "--topo-order", `${base}..${tip}`]).split("\n").filter(Boolean);
    const before = range(verifiedBase, verifiedCommit), after = range(mergeBase, commit);
    if (!before.length || before.length !== after.length) return false;
    const patch = (oid: string) => {
      if (git(repository, ["rev-list", "--parents", "-n", "1", oid]).split(" ").length !== 2) throw new Error("A merge inside the range needs a fresh verdict");
      return `${git(repository, ["show", "--format=", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", oid])}\n`;
    };
    const patches = before.map(patch), targetPatches = after.map(patch);
    const identity = (diff: string) => git(repository, ["patch-id", "--stable"], diff).split(" ")[0];
    const beforeIds = patches.map(identity), afterIds = targetPatches.map(identity);
    if (beforeIds.some((id, i) => !id || id !== afterIds[i])) return false;
    directory = mkdtempSync(join(repository, "replay-"));
    const index = join(directory, "index");
    git(repository, ["read-tree", mergeBase], undefined, index);
    for (const diff of patches) git(repository, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], diff, index);
    return git(repository, ["write-tree"], undefined, index) === git(repository, ["rev-parse", `${commit}^{tree}`]);
  } catch {
    return false;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
export type RebaseHome = { root: string | null; remoteUrl: string; dataDir: string };
export function homeRebaseMatches(maker: string, home: RebaseHome, verifiedCommit: string, commit: string) {
  if (![verifiedCommit, commit].every(oid => gitOidSchema.safeParse(oid).success) || !sourceFetchSchema.shape.remoteUrl.safeParse(home.remoteUrl).success) return false;
  let directory: string | undefined;
  try {
    const state = worktreeState(maker);
    if (state.dirty || state.unfinishedMerge || state.head !== commit) return false;
    mkdirSync(home.dataDir, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(home.dataDir, "merge-home-"));
    const repository = join(directory, "objects.git");
    execGitSync(directory, ["init", "--quiet", "--bare", repository], { cwd: directory, extra, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    // Keep the Git config private too: linked worktrees share their repository config with the maker.
    const cwd = home.root ?? repository;
    const advertised = git(repository, ["ls-remote", "--symref", "--", home.remoteUrl, "HEAD"], undefined, undefined, cwd);
    const branch = /^ref: (refs\/heads\/[^\s]+)\tHEAD$/m.exec(advertised)?.[1];
    if (!branch || !gitRefSchema.safeParse(branch).success) return false;
    const resolve = () => {
      const lines = git(repository, ["ls-remote", "--refs", "--", home.remoteUrl, branch], undefined, undefined, cwd).split("\n");
      if (lines.length !== 1) throw new Error("The destination branch cannot be resolved uniquely");
      const [oid, ref] = lines[0]!.split("\t");
      if (ref !== branch || !gitOidSchema.safeParse(oid).success) throw new Error("The destination branch has no verified commit");
      return oid!;
    };
    const destination = resolve();
    if (!advertised.split("\n").includes(`${destination}\tHEAD`)) return false;
    git(repository, ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "--", home.remoteUrl, branch]);
    git(repository, ["cat-file", "-e", `${destination}^{commit}`]);
    const common = execGitSync(maker, ["merge-base", verifiedCommit, commit], { extra, encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    git(repository, ["cat-file", "-e", `${common}^{commit}`]);
    const pack = execGitSync(maker, ["pack-objects", "--stdout", "--revs"], { extra, input: `${verifiedCommit}\n${commit}\n^${common}\n`, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    git(repository, ["index-pack", "--stdin"], pack);
    const matches = cleanRebaseMatches(repository, verifiedCommit, commit, destination);
    const final = worktreeState(maker);
    return matches && !final.dirty && !final.unfinishedMerge && final.head === commit && resolve() === destination;
  } catch {
    return false;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
