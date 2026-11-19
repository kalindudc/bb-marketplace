import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, gitEnvironment, runGit, runGitProcess, type GitOptions } from "./git";
import { HostError } from "./registry";

export async function repositoryObjectFormat(root: string, options: GitOptions, head?: string): Promise<"sha1" | "sha256"> {
  const oid = head ?? await git(root, ["rev-parse", "--verify", "HEAD"], options);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
    throw new HostError("object-format-mismatch", "The repository returned an invalid HEAD object id.");
  const format = oid.length === 40 ? "sha1" : "sha256";
  const configured = await runGit(root, ["config", "--get", "extensions.objectformat"], options);
  if (configured.code !== 0 && configured.code !== 1)
    throw new HostError("git-capability", "The host cannot read its repository object format: " + (configured.stderr || configured.stdout).trim().slice(0, 200));
  if (configured.code === 0 && configured.stdout.trim() !== format)
    throw new HostError("object-format-mismatch", "The repository returned object ids inconsistent with its declared object format.");
  return format;
}
const unsupported = (command: string, reason: string) => new HostError("git-unsupported", `This machine's Git can't carry Tavern's work (${(`${command}: ${reason}`).replace(/\s+/g, " ").trim().slice(0, 200)}). Members can't be placed on it yet.`);

export async function inspectGitCapabilities(root: string, options: GitOptions, bare: boolean): Promise<Set<string>> {
  const commands = await runGit(root, ["--list-cmds=builtins"], options);
  if (commands.code !== 0) throw unsupported("git --list-cmds=builtins", commands.stderr || commands.stdout);
  const builtins = new Set(commands.stdout.split(/\s+/));
  for (const name of ["commit-tree", "write-tree", "update-index", "read-tree"])
    if (!builtins.has(name)) throw unsupported("git " + name, "not listed by git --list-cmds=builtins");
  const temporary = mkdtempSync(join(options.dataDir, "git-probe-")), index = join(temporary, "index");
  try {
    const realIndex = resolve(root, await git(root, ["rev-parse", "--git-path", "index"], options));
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const indexed = async (args: string[]) => {
      options.check?.();
      const argv = ["-C", root, ...(bare ? ["--work-tree=" + temporary] : []), ...args];
      const result = await experimental_runVcsProcess("git", argv, () => {
        options.check?.();
        return runGitProcess(argv, { env: { ...gitEnvironment(root, options.dataDir), GIT_INDEX_FILE: index }, signal: options.signal, timeoutMs: 150_000, maxBuffer: 64 * 1024 * 1024 });
      }, { priority: "background", signal: options.signal });
      options.check?.();
      if (result.timedOut) throw new HostError("git-timeout", "The temporary-index Git probe exceeded its deadline.", true);
      if (result.code !== 0) throw unsupported("GIT_INDEX_FILE=<temporary> git " + args.join(" "), result.stderr || result.stdout);
    };
    if (!existsSync(index)) await indexed(["read-tree", "--empty"]);
    await indexed(["status", "--porcelain", "--untracked-files=no"]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return builtins;
}
