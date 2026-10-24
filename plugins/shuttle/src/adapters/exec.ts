// The only code that starts processes. Commands run in bb's server process with the user's
// environment, plus the usual tool directories, since bb may start without a login shell's PATH.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  env?: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  signal?: AbortSignal;
}

export type Runner = (bin: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 8 * 1024 * 1024;

export function toolPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const extra = [join(home, ".local/state/tec/toolchain/base_profile/bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local/bin")];
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

export const runProcess: Runner = (bin, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, PATH: toolPath(), ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) kill();
      else into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });

/** Resolves after ms, or at once on abort, leaving no listener behind. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One POSIX shell word, whatever it holds. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Placeholders filled with server data are quoted, so a hostile repo name or URL stays one argument. */
export function fillCommand(template: string, repo: string, number: number, url: string): string {
  return template.replaceAll("{repo}", shellQuote(repo)).replaceAll("{number}", String(number)).replaceAll("{url}", shellQuote(url));
}

export function tail(text: string, lines = 4, chars = 600): string {
  return text.trim().split("\n").slice(-lines).join(" ").slice(-chars);
}
