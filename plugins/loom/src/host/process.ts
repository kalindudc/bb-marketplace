// Runs one child process in its own process group, so a timeout or an abort ends the whole tree. execFile's `timeout`
// signals only the direct child, and git's own children (a connectivity-check rev-list, a pack-objects) outlive it as
// orphans that keep loading the machine.
import { spawn } from "node:child_process";

export interface ProcessResult {
  /** The exit code, or null when a signal ended the process. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The process ran past `timeoutMs` and its group was signalled. */
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Most characters of stdout or stderr kept; the process is killed past it. */
  maxBuffer?: number;
  /** Written to stdin, which closes after it; stdin is empty otherwise. */
  input?: string;
  /** How long a group has after SIGTERM before SIGKILL. */
  graceMs?: number;
}

export const KILL_GRACE_MS = 5000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

/**
 * Resolves with the exit code, or `timedOut` once the group was signalled for running past `timeoutMs`; rejects when the
 * process cannot start, when `signal` aborts (an AbortError) and when stdout or stderr passes `maxBuffer` bytes; that error
 * carries the first `maxBuffer` bytes of each as `stdout` and `stderr`. A timeout, an abort or an overflow sends SIGTERM to
 * the process group, SIGKILL when the leader exits, and SIGKILL after `graceMs` for a leader that ignores SIGTERM. Output that arrives after the limit is read and dropped, so a process that keeps writing cannot grow memory.
 */
export function runProcess(file: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const { signal, graceMs = KILL_GRACE_MS, maxBuffer = DEFAULT_MAX_BUFFER } = options;
  return new Promise<ProcessResult>((resolve, reject) => {
    if (signal?.aborted === true) return reject(abortError());
    const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    let overflowed = false;
    let escalate: NodeJS.Timeout | undefined;

    const killGroup = (how: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? pid : -pid, how);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(how);
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      escalate ??= setTimeout(() => killGroup("SIGKILL"), graceMs);
      escalate.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    // Keeps what fits under the limit and drops the rest; the first byte past it ends the process.
    const keep = (parts: Buffer[], bytes: number, chunk: Buffer): number => {
      const room = maxBuffer - bytes;
      if (chunk.length > room) {
        if (room > 0) parts.push(chunk.subarray(0, room));
        if (!overflowed) {
          overflowed = true;
          stop();
        }
        return maxBuffer;
      }
      parts.push(chunk);
      return bytes + chunk.length;
    };

    child.stdout.on("data", (chunk: Buffer) => (outBytes = keep(out, outBytes, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (errBytes = keep(err, errBytes, chunk)));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = () => {
      clearTimeout(timer);
      clearTimeout(escalate);
      signal?.removeEventListener("abort", onAbort);
    };
    // When the leader exits after a timeout, an abort or an overflow, the rest of its group goes at once: a grandchild that ignores
    // SIGTERM and holds no pipe would otherwise outlive the call, because close cancels the escalation timer. A group id is not
    // given to a new process while any member lives, so if members survive, -pid still names this group; if none do, the kill
    // finds nothing (ESRCH).
    child.on("exit", () => {
      if (timedOut || aborted || overflowed) killGroup("SIGKILL");
    });
    child.on("error", (error) => {
      settle();
      reject(error);
    });
    child.on("close", (code) => {
      settle();
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (aborted) return reject(abortError());
      if (overflowed) return reject(Object.assign(new Error(`${file}: maxBuffer length exceeded`), { stdout, stderr }));
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
