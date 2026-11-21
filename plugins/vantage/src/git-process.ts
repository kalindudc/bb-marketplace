import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { addAbortListener } from "node:events";
import type { Readable } from "node:stream";

const MAX_ACTIVE = 2;
const MAX_QUEUED = 48;
const DEADLINE_MS = 8_000;
const STDOUT_LIMIT = 2 * 1024 * 1024;
const MAX_STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 32 * 1024;
const STDIN_LIMIT = 1024 * 1024;

const GIT_CONFIG_ARGS = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "submodule.recurse=false",
  "diff.submodule=short",
  "diff.algorithm=myers",
  "core.bigFileThreshold=16m",
  "core.deltaBaseCacheLimit=16m",
  "core.packedGitWindowSize=16m",
  "core.packedGitLimit=32m",
  "pack.windowMemory=16m",
  "pack.threads=1",
].flatMap((setting) => ["-c", setting]);

interface RunnerOptions {
  command?: { file: string; args?: readonly string[] };
  maxActive?: number;
  maxQueued?: number;
  deadlineMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
}

// Background reads never take the last slot, so a diff the reader opens starts without waiting behind them.
export type GitLane = "interactive" | "background";

interface RunOptions {
  lane?: GitLane;
  signal?: AbortSignal;
  outputLimit?: number;
  stdin?: string;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

type FailureKind =
  | "queue-full"
  | "aborted"
  | "timeout"
  | "stdout-limit"
  | "stderr-limit"
  | "stdin-limit"
  | "invalid-limit"
  | "unsupported-platform"
  | "disposed"
  | "start"
  | "signal"
  | "transport"
  | "cleanup";

export class GitRunnerError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = "GitRunnerError";
  }
}

interface Job {
  lane: GitLane;
  start(): void;
  cancel(error: GitRunnerError): void;
}

function within(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function errno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string")
    return undefined;
  return error.code;
}

function failedStart(error: unknown): GitRunnerError {
  const code = errno(error);
  const hint =
    code === "ENOENT"
      ? " (ENOENT): Git was not found on this machine"
      : code === "EACCES"
        ? " (EACCES): Git is not executable"
        : code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ENOMEM"
          ? ` (${code}): the machine could not allocate resources`
          : " on this machine";
  return new GitRunnerError("start", `Could not start Git${hint}.`);
}

export function createGitRunner(options: RunnerOptions = {}) {
  const {
    command = { file: "git" },
    maxActive = MAX_ACTIVE,
    maxQueued = MAX_QUEUED,
    deadlineMs = DEADLINE_MS,
    stdoutLimit = STDOUT_LIMIT,
    stderrLimit = STDERR_LIMIT,
  } = options;
  if (
    !within(maxActive, 1, MAX_ACTIVE) ||
    !within(maxQueued, 0, MAX_QUEUED) ||
    !within(deadlineMs, 1, DEADLINE_MS) ||
    !within(stdoutLimit, 1, STDOUT_LIMIT) ||
    !within(stderrLimit, 1, STDERR_LIMIT)
  )
    throw new RangeError("Invalid Git runner limits.");

  const waiting: Record<GitLane, Job[]> = { interactive: [], background: [] };
  const active = new Set<Job>();
  const backgroundLimit = Math.max(1, maxActive - 1);
  let backgroundActive = 0;
  let disposal: Promise<void> | undefined;
  let finishDisposal: (() => void) | undefined;

  function canStart(lane: GitLane) {
    return active.size < maxActive && (lane === "interactive" || backgroundActive < backgroundLimit);
  }

  function pump() {
    while (!disposal) {
      const lane: GitLane | null =
        waiting.interactive.length > 0 && canStart("interactive")
          ? "interactive"
          : waiting.background.length > 0 && canStart("background")
            ? "background"
            : null;
      if (lane === null) return;
      const job = waiting[lane].shift()!;
      active.add(job);
      if (lane === "background") backgroundActive++;
      job.start();
    }
  }

  function release(job: Job) {
    if (!active.delete(job)) return;
    if (job.lane === "background") backgroundActive--;
    if (!disposal) pump();
    else if (active.size === 0) finishDisposal?.();
  }

  function disposedError() {
    return new GitRunnerError("disposed", "The Git reader was shut down. Retry after it restarts.");
  }

  function run(root: string, args: readonly string[], opts: RunOptions = {}): Promise<GitResult> {
    const { lane = "interactive", signal, outputLimit = stdoutLimit, stdin } = opts;
    if (disposal) return Promise.reject(disposedError());
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return Promise.reject(
        new GitRunnerError("unsupported-platform", "Safe Git subprocess cleanup is not supported on this host."),
      );
    }
    const aborted = () => new GitRunnerError("aborted", "The Git request was cancelled.");
    if (signal?.aborted) return Promise.reject(aborted());
    if (!within(outputLimit, 1, MAX_STDOUT_LIMIT)) {
      return Promise.reject(
        new GitRunnerError("invalid-limit", `The Git stdout limit must be between 1 and ${MAX_STDOUT_LIMIT} bytes.`),
      );
    }
    if (stdin !== undefined && Buffer.byteLength(stdin) > STDIN_LIMIT) {
      return Promise.reject(new GitRunnerError("stdin-limit", `Git input exceeds ${STDIN_LIMIT} bytes.`));
    }
    if (!canStart(lane) && waiting[lane].length >= maxQueued) {
      return Promise.reject(
        new GitRunnerError("queue-full", `The Git queue is full (${maxQueued} waiting allowed). Try again shortly.`),
      );
    }

    const deadline = performance.now() + deadlineMs;
    const argv = [...(command.args ?? []), "--no-pager", ...GIT_CONFIG_ARGS, "-C", root, ...args];
    return new Promise<GitResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams | undefined;
      let settled = false;
      const expired = () =>
        new GitRunnerError("timeout", `Git exceeded its ${deadlineMs} ms time budget, including time in the queue.`);
      const timer = setTimeout(() => cancel(expired()), deadlineMs);
      const onAbort = signal && addAbortListener(signal, () => cancel(aborted()));
      const job: Job = { lane, start, cancel };

      function settle(result: GitResult | GitRunnerError) {
        settled = true;
        clearTimeout(timer);
        onAbort?.[Symbol.dispose]();
        if (result instanceof GitRunnerError) reject(result);
        else resolve(result);
      }

      function cancel(error: GitRunnerError) {
        if (settled) return;
        const index = waiting[lane].indexOf(job);
        if (index !== -1) waiting[lane].splice(index, 1);
        // The detached child's group can still own the pipes after its leader exits.
        const pid = child?.pid;
        if (pid !== undefined && pid > 1) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (killError) {
            if (errno(killError) !== "ESRCH") {
              error = new GitRunnerError("cleanup", "Git could not be stopped. Its slot is held until it closes.");
            }
          }
        }
        settle(error);
      }

      function capture(stream: Readable, name: "stdout" | "stderr", limit: number) {
        let buffer = Buffer.alloc(0);
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          const needed = size + chunk.length;
          if (needed > limit) {
            cancel(new GitRunnerError(`${name}-limit`, `Git ${name} exceeds ${limit} bytes.`));
            return;
          }
          if (needed > buffer.length) {
            const next = Buffer.allocUnsafe(Math.min(limit, Math.max(needed, 2 * buffer.length)));
            buffer.copy(next, 0, 0, size);
            buffer = next;
          }
          chunk.copy(buffer, size);
          size = needed;
        });
        stream.on("error", () => cancel(new GitRunnerError("transport", `Could not read Git ${name}.`)));
        return () => buffer.subarray(0, size);
      }

      function start() {
        if (signal?.aborted || performance.now() >= deadline) {
          cancel(signal?.aborted ? aborted() : expired());
          release(job);
          return;
        }
        try {
          child = spawn(command.file, argv, {
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              // Git's repository overrides take precedence over discovery after -C.
              ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "/usr/bin/false",
              SSH_ASKPASS: "/usr/bin/false",
              GIT_NO_LAZY_FETCH: "1",
              // A cached size check must refer to the same object that a later diff reads.
              GIT_NO_REPLACE_OBJECTS: "1",
              GIT_ALLOW_PROTOCOL: "",
              LC_ALL: "C",
            },
          });
        } catch (error) {
          settle(failedStart(error));
          release(job);
          return;
        }
        const stdout = capture(child.stdout, "stdout", outputLimit);
        const stderr = capture(child.stderr, "stderr", stderrLimit);
        child.on("error", (error) =>
          cancel(child?.pid ? new GitRunnerError("transport", "Git subprocess failed.") : failedStart(error)),
        );
        child.once("close", (code, exitSignal) => {
          if (!settled) {
            if (performance.now() >= deadline) settle(expired());
            else if (exitSignal) settle(new GitRunnerError("signal", `Git ended unexpectedly (${exitSignal}).`));
            else if (code === null) settle(new GitRunnerError("transport", "Git ended without an exit status."));
            else settle({ code, stdout: stdout(), stderr: stderr() });
          }
          // Reject promptly on guards, but only reuse capacity after reaping and pipe closure.
          release(job);
        });
        child.stdin.on("error", (error) => {
          if (errno(error) !== "EPIPE" && errno(error) !== "ERR_STREAM_DESTROYED") {
            cancel(new GitRunnerError("transport", "Could not write Git stdin."));
          }
        });
        child.stdin.end(stdin);
      }

      waiting[lane].push(job);
      pump();
    });
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposal = new Promise<void>((resolve) => {
      finishDisposal = resolve;
    });
    const error = disposedError();
    for (const job of [...waiting.interactive, ...waiting.background, ...active]) job.cancel(error);
    if (active.size === 0) finishDisposal?.();
    return disposal;
  }

  return { run, dispose };
}
