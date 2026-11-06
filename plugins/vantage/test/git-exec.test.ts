import { describe, expect, it } from "vitest";
import { GIT_CONCURRENCY, limitGit } from "../src/git-exec";

function slowExec() {
  const state = { running: 0, peak: 0, started: 0 };
  const releases: Array<() => void> = [];
  const exec = (name: string): Promise<string> => {
    state.started++;
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    return new Promise<string>((resolve) => {
      releases.push(() => { state.running--; resolve(name); });
    });
  };
  const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { state, exec, releases, flush };
}

describe("limitGit", () => {
  it("allows about three git processes at once by default", () => {
    expect(GIT_CONCURRENCY).toBe(3);
  });

  it("never runs more than the limit at once and still answers every call in turn", async () => {
    const { state, exec, releases, flush } = slowExec();
    const run = limitGit(exec, 3);
    const answers = Array.from({ length: 10 }, (_, index) => run(`git-${index}`));
    await flush();
    expect(state).toMatchObject({ running: 3, started: 3 });
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    expect(await Promise.all(answers)).toEqual(Array.from({ length: 10 }, (_, index) => `git-${index}`));
    expect(state.peak).toBe(3);
    expect(state.started).toBe(10);
  });

  it("frees the slot when a call fails", async () => {
    const run = limitGit(async (fail: boolean) => { if (fail) throw new Error("boom"); return "ok"; }, 1);
    const first = run(true);
    const second = run(false);
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });
});
