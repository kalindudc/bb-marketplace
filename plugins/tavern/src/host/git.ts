import { AsyncLocalStorage } from "node:async_hooks";
import { gitArguments, gitContainmentStderr, gitEnvironment, gitInvocation, type GitKind, type GitMetadata } from "../shared/git-safety";
import { experimental_runVcsProcess } from "@get-bb/plugin-sdk/host";
import { HostError } from "./registry";
import { abortError, runProcess, type ProcessOptions } from "./process";

export interface GitOptions {
  dataDir: string;
  signal?: AbortSignal;
  input?: string | Buffer;
  raw?: boolean;
  timeoutMs?: number;
  check?(): void;
  env?: Record<string, string>;
  kind?: GitKind;
  privateIndex?: string;
  snapshotWorktreeDir?: string;
  metadata?: GitMetadata | null;
  networkRemote?: boolean;
  readOnly?: boolean;
}
export interface GitResult { code: number; stdout: string; stderr: string }

const budgets = new AsyncLocalStorage<{ until: number; slowest: string; elapsed: number; signal: AbortSignal }>();
export async function withGitDeadline<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 300_000, separateBudget = false): Promise<T> {
  const existing = budgets.getStore();
  if (existing && !separateBudget) return work(existing.signal);
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
async function runGitProcess(root: string, argv: readonly string[], options: ProcessOptions, git: GitOptions) {
  const budget = budgets.getStore(), start = Date.now();
  const command = argv.find((arg, at) => at > 1 && !arg.startsWith("-") && argv[at - 1] !== "-c") ?? argv.at(-1) ?? "operation";
  const remaining = budget ? budget.until - start : options.timeoutMs;
  const timeout = () => new HostError("git-timeout", `Git ${command} exceeded its deadline; the slowest step was ${budget?.slowest ?? command}.`, true);
  if (remaining <= 0) throw timeout();
  try {
    const signal = budget ? AbortSignal.any([budget.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
    const timeoutMs = Math.min(options.timeoutMs, remaining);
    const setup = { kind: git.kind, extra: git.env, privateIndex: git.privateIndex, snapshotWorktreeDir: git.snapshotWorktreeDir, metadata: git.metadata, networkRemote: git.networkRemote, readOnly: git.readOnly, signal, timeoutMs };
    const { env, invocation } = await (async () => {
      try {
        const env = await gitEnvironment(root, setup);
        return { env, invocation: await gitInvocation(root, argv, env, setup) };
      } catch (error) {
        const failure = error as Error & { killed?: boolean; stderr?: string | Buffer; code?: string };
        if (signal?.aborted || failure.code === "ABORT_ERR") throw abortError();
        if (failure.killed || failure.code === "ETIMEDOUT") throw timeout();
        throw new HostError("git-preflight", "Tavern could not prepare Git safely: " + (failure.stderr?.toString().trim() || failure.message).slice(0, 1200));
      }
    })();
    git.check?.();
    const left = timeoutMs - (Date.now() - start);
    if (left <= 0) throw timeout();
    const result = await runProcess("git", argv, { ...options, env, invocation, timeoutMs: left, signal });
    const elapsed = Date.now() - start;
    if (budget && elapsed > budget.elapsed) { budget.elapsed = elapsed; budget.slowest = command; }
    if (result.timedOut || budget && Date.now() >= budget.until) throw timeout();
    return { ...result, stderr: gitContainmentStderr(invocation, result.stderr) };
  } catch (error) {
    const elapsed = Date.now() - start;
    if (budget && elapsed > budget.elapsed) { budget.elapsed = elapsed; budget.slowest = command; }
    if ((argv.includes("status") || argv.includes("ls-files") && argv.includes("--others")) && error instanceof Error && error.message.includes("maxBuffer"))
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
export function rawChanges(text: string): { status: "A" | "M" | "T" | "D"; path: string; mode?: "100644" | "100755" | "120000"; blob?: string }[] {
  const fields = text.split("\0").filter(Boolean), changes: ReturnType<typeof rawChanges> = [];
  for (let at = 0; at < fields.length; at += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ ([a-f0-9]+) ([AMTD])$/.exec(fields[at]!);
    if (!match || !fields[at + 1]) throw new HostError("unsupported-change", "The source diff contains an unsupported change kind.");
    if (match[1] === "160000" || match[2] === "160000")
      throw new HostError("submodule-unsupported", "Submodules cannot be transferred between machines in this version: " + fields[at + 1]);
    changes.push({ status: match[4] as "A" | "M" | "T" | "D", path: fields[at + 1]!, ...(match[4] === "D" ? {} : { mode: match[2] as "100644" | "100755" | "120000", blob: match[3]! }) });
  }
  return changes;
}

export async function runGit(root: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  options.check?.();
  const argv = ["-C", root, ...gitArguments(args, options.kind)];
  const result = await experimental_runVcsProcess("git", argv, async () => {
    options.check?.();
    return runGitProcess(root, argv, { input: options.input, signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024 }, options);
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
