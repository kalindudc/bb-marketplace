// runProcess ends a process's whole group on a timeout and on an abort: execFile's own timeout signals only the direct child,
// and the children git starts (a connectivity-check rev-list, a pack-objects) lived on as orphans.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "../src/host/process";

let scratch: string;
let counter = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "loom-process-"));
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const gone = async (pid: number) => {
  for (let wait = 0; wait < 100 && alive(pid); wait += 1) await sleep(50);
  return !alive(pid);
};

/** A shell that starts a long-sleeping grandchild, records its pid in a file, and waits for it. */
const withGrandchild = (extra = "") => {
  const pidFile = join(scratch, `pid-${counter++}`);
  const pid = () => Number(readFileSync(pidFile, "utf8").trim());
  const recorded = async () => {
    for (let wait = 0; wait < 100; wait += 1) {
      try {
        if (pid() > 0) return pid();
      } catch {
        await sleep(50);
      }
    }
    throw new Error("the grandchild never started");
  };
  return { pidFile, args: ["-c", `${extra}sleep 300 & echo $! > ${pidFile}; wait`], pid, recorded };
};

describe("runProcess", () => {
  it("returns the exit code, the output and the input it was given", async () => {
    expect(await runProcess("sh", ["-c", "cat; echo err >&2; exit 3"], { timeoutMs: 10_000, input: "in\n" })).toEqual({ code: 3, stdout: "in\n", stderr: "err\n", timedOut: false });
  });

  it("ends the grandchild with the child when the time runs out", async () => {
    const run = withGrandchild();
    const started = Date.now();
    const ended = await runProcess("sh", run.args, { timeoutMs: 1500 });
    expect(ended.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await gone(run.pid())).toBe(true);
  });

  it("ends the grandchild when the call is aborted, and rejects with an AbortError", async () => {
    const run = withGrandchild();
    const controller = new AbortController();
    const pending = runProcess("sh", run.args, { timeoutMs: 60_000, signal: controller.signal });
    const pid = await run.recorded();
    expect(alive(pid)).toBe(true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await gone(pid)).toBe(true);
  });

  it("rejects at once for a signal that is already aborted, without starting anything", async () => {
    const run = withGrandchild();
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess("sh", run.args, { timeoutMs: 60_000, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(() => readFileSync(run.pidFile)).toThrow();
  });

  it("kills a group that ignores SIGTERM once the grace period is over", async () => {
    const run = withGrandchild(`trap '' TERM; `);
    const ended = await runProcess("sh", run.args, { timeoutMs: 1500, graceMs: 300 });
    expect(ended.timedOut).toBe(true);
    expect(await gone(run.pid())).toBe(true);
  });

  it("ends a grandchild that ignores SIGTERM and holds no pipe, as soon as the leader is gone after a timeout", async () => {
    const pidFile = join(scratch, `pid-${counter++}`);
    // The leader dies of SIGTERM and closes its pipes, so the call resolves while the grandchild, stdio redirected, still runs.
    const args = ["-c", `(trap '' TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; wait`];
    const ended = await runProcess("sh", args, { timeoutMs: 1500, graceMs: 30_000 });
    expect(ended.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await gone(pid)).toBe(true);
  });

  it("ends the same grandchild when the call is aborted", async () => {
    const pidFile = join(scratch, `pid-${counter++}`);
    const args = ["-c", `(trap '' TERM; exec sleep 300) </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; wait`];
    const controller = new AbortController();
    const pending = runProcess("sh", args, { timeoutMs: 60_000, graceMs: 30_000, signal: controller.signal });
    for (let wait = 0; wait < 100; wait += 1) {
      try {
        if (Number(readFileSync(pidFile, "utf8").trim()) > 0) break;
      } catch {
        await sleep(50);
      }
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await gone(pid)).toBe(true);
  });

  it("tolerates a group that has already ended", async () => {
    expect(await runProcess("sh", ["-c", "exit 0"], { timeoutMs: 10_000 })).toMatchObject({ code: 0, timedOut: false });
  });

  it("rejects when the program does not exist", async () => {
    await expect(runProcess("loom-no-such-program", [], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the process and rejects when its output passes maxBuffer", async () => {
    await expect(runProcess("sh", ["-c", "yes"], { timeoutMs: 10_000, maxBuffer: 1000 })).rejects.toThrow(/maxBuffer/u);
  });

  it("keeps no more than maxBuffer bytes of either stream, even from a process that ignores SIGTERM and keeps writing", async () => {
    const started = Date.now();
    const failure = (await runProcess("sh", ["-c", "trap '' TERM; while :; do echo xxxxxxxxxx; echo yyyyyyyyyy >&2; done"], { timeoutMs: 10_000, maxBuffer: 100, graceMs: 700 }).catch((error: unknown) => error)) as Error & { stdout: string; stderr: string };
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/maxBuffer/u);
    expect(Buffer.byteLength(failure.stdout)).toBe(100);
    expect(Buffer.byteLength(failure.stderr)).toBeLessThanOrEqual(100);
    // It was still writing while the group had its grace period, and was killed after it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });

  it("keeps exactly maxBuffer bytes without failing", async () => {
    expect(await runProcess("sh", ["-c", "printf 0123456789"], { timeoutMs: 10_000, maxBuffer: 10 })).toMatchObject({ code: 0, stdout: "0123456789" });
  });
});
