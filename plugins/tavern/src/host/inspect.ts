import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { hostContract, type Authority, type HostOutput } from "../host-contract";
import { piAgentDir } from "../scope/install";
import { objectFormatSchema } from "../shared/placement";
import { git, runGit, type GitOptions } from "./git";
import { abortError } from "./process";
import { HostError, HostRegistry } from "./registry";
import { inspectSourceBase } from "./source-base";

function remoteIdentity(value: string): string | undefined {
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value) || value !== value.trim()) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol)) return;
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return url.href.length <= 4096 ? url.href : undefined;
    } catch { return; }
  }
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) return value;
  if (!/[:@?#]/.test(value)) return value;
  const scp = /^(?:[^@/\s]+@)?(\[[a-f0-9:]+\]|[a-z0-9._-]+):([^\s]+)$/i.exec(value);
  const path = scp?.[2]?.split(/[?#]/)[0];
  if (!scp || !path || path.startsWith(":")) return;
  return scp[1]!.toLowerCase() + ":" + path;
}
async function repositoryRemotes(root: string, options: GitOptions): Promise<string[] | undefined> {
  try {
    const namesResult = await runGit(root, ["remote"], { ...options, timeoutMs: 3000 });
    if (namesResult.code !== 0) return;
    const names = namesResult.stdout.split("\n").filter(Boolean), identities = new Set<string>();
    if (names.length > 50) return;
    let count = 0;
    for (const name of names) for (const push of [false, true]) {
      const result = await runGit(root, ["remote", "get-url", "--all", ...(push ? ["--push"] : []), "--", name], { ...options, timeoutMs: 3000 });
      if (result.code !== 0) return;
      const values = result.stdout.split("\n").filter(Boolean);
      if (!values.length || (count += values.length) > 200) return;
      for (const value of values) { const identity = remoteIdentity(value); if (!identity) return; identities.add(identity); }
    }
    return [...identities].sort();
  } catch {
    options.check?.();
    if (options.signal?.aborted) throw abortError();
    return;
  }
}

export async function inspectHost(registry: HostRegistry, authority: Authority, signal?: AbortSignal): Promise<HostOutput<"inspect">> {
  const endpoint = registry.endpoint(authority, ["source-read", "member-write", "home-import"]);
  const options = { dataDir: registry.dataDir, signal, check: () => { registry.endpoint(authority); } };
  const root = endpoint.realRoot;
  const bare = await git(root, ["rev-parse", "--is-bare-repository"], options);
  if (bare !== "true" && bare !== "false") throw new HostError("git-capability", "The host cannot identify its repository layout.");
  const actualRoot = await git(root, ["rev-parse", bare === "true" ? "--absolute-git-dir" : "--show-toplevel"], options);
  const gitRoot = realpathSync(isAbsolute(actualRoot) ? actualRoot : resolve(root, actualRoot));
  if (endpoint.registration.access === "member-write" && gitRoot !== root)
    throw new HostError("endpoint-root-mismatch", "A writable member endpoint must name its complete private checkout, not a subdirectory.");
  const [head, tree, format, branchResult, dirs, status, commands, repoRemotes] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"], options),
    git(root, ["rev-parse", "--verify", "HEAD^{tree}"], options),
    git(root, ["rev-parse", "--show-object-format"], options),
    runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"], options),
    git(root, ["rev-parse", "--git-dir", "--git-common-dir"], options),
    bare === "true" ? Promise.resolve(null) : runGit(root, ["status", "--porcelain", "-z"], options),
    runGit(root, ["--list-cmds=builtins"], options),
    repositoryRemotes(root, options),
  ]);
  const objectFormat = objectFormatSchema.safeParse(format);
  if (!objectFormat.success) throw new HostError("git-capability", "The host cannot establish the repository's object format.");
  if (branchResult.code !== 0 && branchResult.code !== 1)
    throw new HostError("git-capability", "The host cannot establish the repository's current branch.");
  const [gitDir, commonDir] = dirs.split("\n");
  if (!gitDir || !commonDir) throw new HostError("git-capability", "The host cannot identify its Git metadata directories.");
  const normalized = (path: string) => realpathSync(resolve(root, path));
  const builtins = new Set(commands.code === 0 ? commands.stdout.split(/\s+/) : []);
  const porcelain = status?.code === 0;
  const objectImport = ["hash-object", "mktree", "commit-tree", "update-ref", "ls-tree", "cat-file"].every(name => builtins.has(name));
  const sourceBase = await inspectSourceBase(root, head, options);
  const result = hostContract.inspect.output.parse({
    platform: process.platform, home: realpathSync(homedir()), tmp: [...new Set([tmpdir(), realpathSync(tmpdir())])], piAgentDir: piAgentDir(),
    root, artifactDirectory: registry.artifactDirectory, sourceBase, ...(repoRemotes === undefined ? {} : { repoRemotes }), branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
    head, tree, objectFormat: objectFormat.data, linkedWorktree: normalized(gitDir) !== normalized(commonDir),
    features: { porcelain, exportChanges: porcelain && gitRoot === root, objectImport: objectImport && gitRoot === root },
  });
  if (result.head.length !== (result.objectFormat === "sha1" ? 40 : 64) || result.tree.length !== result.head.length)
    throw new HostError("object-format-mismatch", "The repository returned object ids inconsistent with its declared object format.");
  registry.recordInspection(authority, { objectFormat: result.objectFormat, branch: result.branch, gitDir: normalized(gitDir), commonDir: normalized(commonDir) });
  return result;
}
