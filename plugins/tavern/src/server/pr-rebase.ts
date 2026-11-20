import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "../host/process";
import { gitRefSchema } from "../host-contract";
import { gitArguments, gitEnvironment, gitInvocation } from "../shared/git-safety";
import { gitOidSchema, sourceFetchSchema } from "../shared/placement";

export async function homePullRequestRebaseMatches(worktree: string, target: { remoteUrl: string; base: string; dataDir: string }, verified: string, head: string) {
  const branch = target.base.startsWith("refs/heads/") ? target.base : `refs/heads/${target.base}`;
  if (!gitRefSchema.safeParse(branch).success || !sourceFetchSchema.shape.remoteUrl.safeParse(target.remoteUrl).success ||
      ![verified, head].every(oid => gitOidSchema.safeParse(oid).success) || verified.length !== head.length) return false;
  let scratch: string | undefined;
  const signal = AbortSignal.timeout(45_000);
  const runner = async (root: string, options: { readOnly?: boolean; gitDir?: string; index?: string } = {}) => {
    const config = { ...options, signal, extra: { GIT_NO_REPLACE_OBJECTS: "1", ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) }, privateIndex: options.index };
    const env = await gitEnvironment(root, config);
    return async (args: string[], input?: string) => {
      const invocation = await gitInvocation(root, [...(options.gitDir ? ["--git-dir", options.gitDir] : ["-C", root]), ...gitArguments(args)], env, config);
      const result = await runProcess(invocation.file, invocation.args, { cwd: root, env, timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024, input, signal });
      if (result.code !== 0 || result.timedOut) throw new Error("Git could not prove the pull request rebase.");
      return result.stdout;
    };
  };
  try {
    const maker = await runner(worktree, { readOnly: true });
    const objects = await realpath(resolve(worktree, (await maker(["rev-parse", "--git-path", "objects"])).trim()));
    if (/[\r\n]/.test(objects)) return false;
    await mkdir(target.dataDir, { recursive: true, mode: 0o700 });
    scratch = await mkdtemp(join(target.dataDir, "pr-rebase-"));
    const repo = join(scratch, "proof.git");
    await (await runner(scratch))(["init", "--quiet", "--bare", `--object-format=${head.length === 64 ? "sha256" : "sha1"}`, repo]);
    // Replay writes go only to the private repository and index; the project lends objects without a fetch.
    await writeFile(join(repo, "objects", "info", "alternates"), objects + "\n", { mode: 0o600 });
    const git = await runner(repo, { gitDir: repo, index: join(repo, "proof-index") });
    const resolveBase = async () => {
      const lines = (await git(["ls-remote", "--refs", "--", target.remoteUrl, branch])).trim().split("\n");
      const [oid, ref] = lines[0].split("\t");
      if (lines.length !== 1 || ref !== branch || !gitOidSchema.safeParse(oid).success) throw new Error("The PR base could not be resolved.");
      return oid;
    };
    const destination = await resolveBase();
    const range = async (tip: string) => {
      const base = (await git(["merge-base", tip, destination])).trim();
      const commits = (await git(["rev-list", "--reverse", "--topo-order", `${base}..${tip}`])).trim().split("\n").filter(Boolean);
      return { base, commits };
    };
    const prior = await range(verified), next = await range(head);
    if (!prior.commits.length || prior.commits.length > 40 || prior.commits.length !== next.commits.length) return false;
    await git(["read-tree", next.base]);
    const patch = async (oid: string) => {
      if ((await git(["rev-list", "--parents", "-n", "1", oid])).trim().split(" ").length !== 2) throw new Error("Merges need a new Warden verdict.");
      return git(["show", "--format=", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", oid]);
    };
    for (let i = 0; i < prior.commits.length; i++) {
      const before = await patch(prior.commits[i]), after = await patch(next.commits[i]);
      const id = async (diff: string) => (await git(["patch-id", "--stable"], diff)).split(" ")[0].trim();
      const previous = await id(before);
      if (!previous || previous !== await id(after)) return false;
      await git(["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], before);
    }
    return (await git(["write-tree"])).trim() === (await git(["rev-parse", `${head}^{tree}`])).trim() && destination === await resolveBase();
  } catch {
    return false;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
