import { describe, expect, it, vi } from "vitest";
import type { CollectDeps, HostCall } from "../src/collect";
import type { ThreadEdits } from "../src/edits";
import { createRepoCache } from "../src/repo-cache";
import { attachThreadCommits, commitWindows, isOnBase, MAX_WINDOWS } from "../src/thread-commits";
import { branchWorktree, checkoutWorktree, commit, worktree } from "./fixtures";

type Run = ThreadEdits["commitRuns"][number];
const threadEdits = (commitRuns: Run[], lastEventAt: number | null = null): ThreadEdits => ({
  records: [], primaryCwd: null, workDirs: [], commitRuns, lastEventAt,
});
const run = (startedAt: number, endedAt: number | null, id = `c${startedAt}`): Run => ({ id, startedAt, endedAt });

describe("commitWindows", () => {
  it("joins every thread's commit runs, oldest first", () => {
    const edits = new Map([["thr_1", threadEdits([run(5_000, 6_000)])], ["thr_2", threadEdits([run(1_000, 2_000)])]]);
    expect(commitWindows(["thr_1", "thr_2"], edits, new Set(), 99_000)).toEqual([{ start: 1_000, end: 2_000 }, { start: 5_000, end: 6_000 }]);
  });

  it("runs a command still going until now in a running thread, and until its last event in a stopped one", () => {
    const edits = new Map([["thr_1", threadEdits([run(1_000, null)], 4_000)], ["thr_2", threadEdits([run(2_000, null)], 9_000)]]);
    expect(commitWindows(["thr_1", "thr_2"], edits, new Set(["thr_1"]), 50_000)).toEqual([{ start: 1_000, end: 50_000 }, { start: 2_000, end: 9_000 }]);
  });

  it("has none for a thread whose edits were not read, and keeps only the most recent windows", () => {
    expect(commitWindows(["thr_x"], new Map(), new Set(), 1)).toEqual([]);
    const runs = Array.from({ length: MAX_WINDOWS + 5 }, (_, i) => run(i * 10, i * 10 + 5));
    const windows = commitWindows(["thr_1"], new Map([["thr_1", threadEdits(runs)]]), new Set(), 1);
    expect(windows).toHaveLength(MAX_WINDOWS);
    expect(windows[0]).toEqual({ start: 50, end: 55 });
  });
});

describe("isOnBase", () => {
  it.each([
    ["main", "main", true], ["main", "origin/main", true], ["feature/x", "origin/feature/x", true],
    ["feature/work", "origin/main", false], ["main", null, false], [null, "main", false],
  ] as const)("branch %s on base %s is %s", (branch, base, expected) => {
    expect(isOnBase(branch, base)).toBe(expected);
  });
});

describe("attachThreadCommits", () => {
  const mine = commit({ sha: "f".repeat(40), shortSha: "fffffff", subject: "Add the parser" });
  const onMain = worktree({ branch: "main", base: "main", onBase: true, ref: { kind: "workspace", environmentId: "env_1", base: "main" } });
  const edits = new Map([["thr_1", threadEdits([run(1_000, 2_000)])]]);

  function setup(answer: unknown = { outcome: "available", commits: [mine] }) {
    const host = vi.fn(async (..._args: unknown[]) => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const deps = { host: host as unknown as HostCall } as CollectDeps;
    return { deps, host };
  }

  it("asks git for the commits its threads made when nothing is ahead of the base", async () => {
    const { deps, host } = setup();
    const { worktrees, warnings } = await attachThreadCommits(deps, [onMain], { edits, running: new Set(), now: 10_000 });
    expect(host).toHaveBeenCalledWith("threadCommits", { root: "/work/one", windows: [{ start: 1_000, end: 2_000 }] }, { hostId: "host_1", signal: undefined });
    expect(worktrees[0]?.threadCommits).toEqual([mine]);
    expect(warnings).toEqual([]);
  });

  it("reads a checkout a thread works in the same way", async () => {
    const { deps, host } = setup();
    const { worktrees } = await attachThreadCommits(deps, [checkoutWorktree({ base: "origin/side-work", onBase: true })], { edits, running: new Set(), now: 1 });
    expect(host.mock.calls[0]?.[1]).toMatchObject({ root: "/clones/side" });
    expect(worktrees[0]?.threadCommits).toEqual([mine]);
  });

  it("does not ask when commits are ahead, its threads ran no git commit, or the worktree is not readable", async () => {
    const { deps, host } = setup();
    const skipped = [
      worktree({ key: "ahead", aheadCount: 2, commits: [commit()] }),
      worktree({ key: "quiet", threadIds: ["thr_2"] }),
      branchWorktree({ threadIds: ["thr_1"], aheadCount: 0 }),
      worktree({ key: "gone", state: "unavailable", message: "no" }),
      worktree({ key: "wait", state: "loading" }),
    ];
    const { worktrees } = await attachThreadCommits(deps, skipped, { edits, running: new Set(), now: 1 });
    expect(host).not.toHaveBeenCalled();
    expect(worktrees).toEqual(skipped);
  });

  it("warns and lists none when git cannot answer", async () => {
    for (const answer of [{ outcome: "unavailable", reason: "git-failed", message: "locked" }, new Error("offline")]) {
      const { deps } = setup(answer);
      const { worktrees, warnings } = await attachThreadCommits(deps, [onMain], { edits, running: new Set(), now: 1 });
      expect(worktrees[0]?.threadCommits).toEqual([]);
      expect(warnings).toEqual([`Could not read the commits its threads made in /work/one: ${answer instanceof Error ? "offline" : "locked"}`]);
    }
  });

  it("shares one git read while the windows stay the same", async () => {
    const { deps, host } = setup();
    const cached = { ...deps, cache: createRepoCache() };
    await attachThreadCommits(cached, [onMain], { edits, running: new Set(), now: 1 });
    await attachThreadCommits(cached, [onMain], { edits, running: new Set(), now: 2 });
    expect(host).toHaveBeenCalledTimes(1);
    await attachThreadCommits(cached, [onMain], { edits: new Map([["thr_1", threadEdits([run(1_000, 3_000)])]]), running: new Set(), now: 3 });
    expect(host).toHaveBeenCalledTimes(2);
  });
});
