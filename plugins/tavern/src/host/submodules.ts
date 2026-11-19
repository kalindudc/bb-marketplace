import { missingSubmoduleConfig, populatedSubmodules, submoduleConfigReads } from "../shared/submodules";
import { git, runGit, type GitOptions } from "./git";
import { HostError } from "./registry";

export async function dirtySubmodules(root: string, options: GitOptions): Promise<string[]> {
  const configs: string[] = [];
  for (const { args, blob } of submoduleConfigReads(root)) {
    const result = await runGit(root, args, { ...options, readOnly: true, timeoutMs: Math.min(options.timeoutMs ?? 3000, 3000) });
    if (result.code === 0) configs.push(result.stdout);
    else if (!missingSubmoduleConfig(blob, result.code, result.stderr))
      throw new HostError("submodule-unavailable", "Tavern could not read the submodule paths: " + result.stderr.trim().slice(-1200));
  }
  const dirty: string[] = [], nested = { ...options, metadata: undefined };
  for (const module of populatedSubmodules(root, configs)) {
    if (await git(module.root, ["status", "--porcelain", "-z"], nested) || (await dirtySubmodules(module.root, nested)).length)
      dirty.push(module.path);
  }
  return dirty;
}
