import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { HostError } from "./registry";
import { runProcess, type ProcessOptions } from "./process";

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
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, PWD: root, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PRINT_SHA1_ELLIPSIS: "no" };
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

const budgets = new AsyncLocalStorage<{ until: number; slowest: string; elapsed: number; signal: AbortSignal }>();
export async function withGitDeadline<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 170_000): Promise<T> {
  const existing = budgets.getStore();
  if (existing) return work(existing.signal);
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const budget = { until: Date.now() + timeoutMs, slowest: "metadata", elapsed: 0, signal: combined };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await budgets.run(budget, () => work(combined)); }
  catch (error) {
    if (controller.signal.aborted && !signal?.aborted)
      throw new HostError("git-timeout", "The Git operation exceeded its deadline; the slowest step was " + budget.slowest + ".", true);
    throw error;
  } finally { clearTimeout(timer); }
}
export async function runGitProcess(argv: readonly string[], options: ProcessOptions) {
  const budget = budgets.getStore(), start = Date.now();
  const command = argv.find((arg, at) => at > 1 && !arg.startsWith("-") && argv[at - 1] !== "-c") ?? argv.at(-1) ?? "operation";
  const remaining = budget ? budget.until - start : options.timeoutMs;
  const timeout = () => new HostError("git-timeout", `Git ${command} exceeded its deadline; the slowest step was ${budget?.slowest ?? command}.`, true);
  if (remaining <= 0) throw timeout();
  try {
    const result = await runProcess("git", argv, { ...options, timeoutMs: Math.min(options.timeoutMs, remaining), signal: budget ? AbortSignal.any([budget.signal, ...(options.signal ? [options.signal] : [])]) : options.signal });
    const elapsed = Date.now() - start;
    if (budget && elapsed > budget.elapsed) { budget.elapsed = elapsed; budget.slowest = command; }
    if (result.timedOut || budget && Date.now() >= budget.until) throw timeout();
    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    if (budget && elapsed > budget.elapsed) { budget.elapsed = elapsed; budget.slowest = command; }
    if (argv.includes("ls-files") && argv.includes("--others") && error instanceof Error && error.message.includes("maxBuffer"))
      throw new HostError("too-many-paths", "The untracked file listing was too large to transfer safely.");
    throw error;
  }
}
export async function requireSparseGit(context: { git(args: readonly string[], options?: Partial<GitOptions>): Promise<string> }): Promise<void> {
  const version = await context.git(["--version"], { timeoutMs: 3000 });
  const match = /git version (\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 2 || Number(match[1]) === 2 && Number(match[2]) < 35)
    throw new HostError("git-capability", "Sparse staging requires Git 2.35 or later; this host reports " + version + ".");
}
export function rawChanges(text: string): { status: "A" | "M" | "T" | "D"; path: string }[] {
  const fields = text.split("\0").filter(Boolean), changes: { status: "A" | "M" | "T" | "D"; path: string }[] = [];
  for (let at = 0; at < fields.length; at += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMTD])$/.exec(fields[at]!);
    if (!match || !fields[at + 1]) throw new HostError("unsupported-change", "The source diff contains an unsupported change kind.");
    if (match[1] === "160000" || match[2] === "160000")
      throw new HostError("submodule-unsupported", "Submodules cannot be transferred between machines in this version: " + fields[at + 1]);
    changes.push({ status: match[3] as "A" | "M" | "T" | "D", path: fields[at + 1]! });
  }
  return changes;
}

export async function runGit(root: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  options.check?.();
  const argv = ["-C", root, ...args];
  const result = await experimental_runVcsProcess("git", argv, async () => {
    options.check?.();
    return runGitProcess(argv, { env: gitEnvironment(root, options.dataDir, options.env), input: options.input, signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024 });
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
