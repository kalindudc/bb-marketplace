import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { HostError } from "./registry";
import { runProcess } from "./process";

export interface GitOptions {
  dataDir: string;
  signal?: AbortSignal;
  input?: string;
  raw?: boolean;
  timeoutMs?: number;
  check?(): void;
  env?: Record<string, string>;
}
export interface GitResult { code: number; stdout: string; stderr: string }

export function gitEnvironment(root: string, dataDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const hooks = join(dataDir, "empty-hooks");
  if (existsSync(hooks)) {
    if (lstatSync(hooks).isSymbolicLink() || !lstatSync(hooks).isDirectory() || readdirSync(hooks).length)
      throw new HostError("host-hooks-invalid", "Tavern's private hooks directory is no longer empty and safe.");
  } else mkdirSync(hooks, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, PWD: root, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CONFIG_PARAMETERS"])
    delete (env as NodeJS.ProcessEnv)[name];
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024)
    throw new HostError("git-environment", "The host's inherited Git config count is invalid.");
  const config = [["core.fsmonitor", "false"], ["core.hooksPath", hooks], ["commit.gpgsign", "false"]];
  for (const [index, [key, value]] of config.entries()) {
    (env as NodeJS.ProcessEnv)[`GIT_CONFIG_KEY_${count + index}`] = key;
    (env as NodeJS.ProcessEnv)[`GIT_CONFIG_VALUE_${count + index}`] = value;
  }
  (env as NodeJS.ProcessEnv).GIT_CONFIG_COUNT = String(count + config.length);
  return env;
}

export async function runGit(root: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  options.check?.();
  const argv = ["-C", root, ...args];
  const result = await experimental_runVcsProcess("git", argv, async () => {
    options.check?.();
    return runProcess("git", argv, { env: gitEnvironment(root, options.dataDir, options.env), input: options.input, signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024 });
  }, { priority: "background", signal: options.signal });
  options.check?.();
  if (result.timedOut) throw new HostError("git-timeout", `Git ${args[0] ?? "operation"} exceeded its deadline.`, true);
  if (result.code === null) throw new HostError("git-failed", "The Git operation ended without an exit code.", true);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}
export async function git(root: string, args: readonly string[], options: GitOptions): Promise<string> {
  const result = await runGit(root, args, options);
  if (result.code !== 0) throw new HostError("git-failed", `Git ${args[0] ?? "operation"} failed (${result.code}): ${(result.stderr.trim() || result.stdout.trim()).slice(-2000)}`);
  return options.raw ? result.stdout : result.stdout.trim();
}
