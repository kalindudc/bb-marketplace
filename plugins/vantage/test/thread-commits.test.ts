import { describe, expect, it, vi } from "vitest";
import type { CollectDeps, HostCall } from "../src/collect";
import type { ThreadEdits } from "../src/edits";
import { createRepoCache } from "../src/repo-cache";
import { attachThreadCommits, commitWindows, fewEnough, isOnBase, leaveOutHistory, MAX_WINDOWS, wantsHistoryLeftOut } from "../src/thread-commits";
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

describe("leaveOutHistory", () => {
  const SINCE = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const theirs = commit({ sha: "c".repeat(40), shortSha: "ccccccc", subject: "One of mine" });
  const file = (path: string) => ({ path, previousPath: null, status: "added" as const, additions: 3, deletions: 0, binary: false });
  const far = worktree({
    aheadCount: 612, behindCount: 4, base: "origin/main", head: HEAD, committed: Array.from({ length: 40 }, (_, index) => ({ ...file(`old/${index}.ts`), untracked: false, tooLarge: false, edits: null })),
    ref: { kind: "workspace", environmentId: "env_1", base: "origin/main", root: "/work/one", hostId: "host_1" },
  });
  const edits = new Map([["thr_1", threadEdits([run(1_000, 2_000)])]]);
  const attribution = { edits, running: new Set<string>(), now: 10_000 };

  function setup(made: unknown, counting = { pick: true, folderLimit: 200, historyThreshold: 50, historyShare: 10 }) {
    const host = vi.fn(async (method: string, input: { base?: string }) => {
      if (method === "threadCommits") return made;
      if (method === "checkoutStatus") {
        return {
          outcome: "available", branch: "feature/work", head: HEAD, base: input.base, skippedBase: null, aheadCount: input.base === SINCE ? 1 : 612, behindCount: 0,
          commits: input.base === SINCE ? [theirs] : [], uncommitted: [file("wip.ts")], committed: input.base === SINCE ? [file("mine.ts")] : [], truncated: false,
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    return { deps: { host: host as unknown as HostCall, cache: createRepoCache(), counting } as unknown as CollectDeps, host };
  }

  it("shows only its threads' commits and the uncommitted files when they made few of the commits ahead", async () => {
    const { deps, host } = setup({ outcome: "available", commits: [theirs], total: 1, since: SINCE });
    const { worktrees, warnings } = await leaveOutHistory(deps, [far], attribution);
    expect(warnings).toEqual([]);
    expect(worktrees[0]).toMatchObject({
      base: "origin/main", aheadCount: 1, behindCount: 4, leftOut: { aheadCount: 612, kept: 1 },
      ref: { base: SINCE }, commits: [theirs],
    });
    expect(worktrees[0]!.committed.map((entry) => entry.path)).toEqual(["mine.ts"]);
    expect(host).toHaveBeenCalledWith("checkoutStatus", { root: "/work/one", base: SINCE, pick: false, folderLimit: 200 }, expect.anything());
  });

  it("compares with HEAD when its threads made none of the commits, so only uncommitted files are left", async () => {
    const { deps, host } = setup({ outcome: "available", commits: [], total: 0, since: null });
    const { worktrees } = await leaveOutHistory(deps, [far], attribution);
    // HEAD comes from the row's own read: one more read, against HEAD, and none just to learn it.
    expect(host.mock.calls.filter(([method]) => method === "checkoutStatus").map(([, input]) => input.base)).toEqual([HEAD]);
    expect(worktrees[0]).toMatchObject({ leftOut: { aheadCount: 612, kept: 0 }, ref: { base: HEAD } });
  });

  it("keeps the whole branch below the threshold, for a worktree shown whole, and when its threads made enough of the commits", async () => {
    const { deps, host } = setup({ outcome: "available", commits: Array.from({ length: 70 }, () => theirs), total: 70, since: SINCE });
    expect((await leaveOutHistory(deps, [worktree({ aheadCount: 50 }), worktree({ aheadCount: 612, whole: true })], attribution)).worktrees.map((entry) => entry.leftOut)).toEqual([undefined, undefined]);
    expect(host).not.toHaveBeenCalled();
    expect((await leaveOutHistory(deps, [far], attribution)).worktrees[0]).toBe(far);
    const off = setup({ outcome: "available", commits: [], total: 0, since: null }, { pick: true, folderLimit: 200, historyThreshold: 0, historyShare: 10 });
    expect((await leaveOutHistory(off.deps, [far], attribution)).worktrees[0]).toBe(far);
  });

  it("judges the share by every commit of its threads, not the 100 it lists", async () => {
    const { deps } = setup({ outcome: "available", commits: Array.from({ length: 100 }, () => theirs), total: 250, since: SINCE });
    expect((await leaveOutHistory(deps, [{ ...far, aheadCount: 2000 }], attribution)).worktrees[0]!.leftOut).toBeUndefined();
  });

  it("keeps the whole branch when a merge stands between its threads' first commit and HEAD, or a thread's events did not load", async () => {
    const merged = setup({ outcome: "available", commits: [theirs], total: 1, since: null });
    expect((await leaveOutHistory(merged.deps, [far], attribution)).worktrees[0]).toBe(far);
    const unknown = setup({ outcome: "available", commits: [], total: 0, since: null });
    expect((await leaveOutHistory(unknown.deps, [{ ...far, threadIds: ["thr_1", "thr_unread"] }], attribution)).worktrees[0]!.leftOut).toBeUndefined();
    expect(unknown.host).not.toHaveBeenCalled();
  });

  it("keeps the whole branch and warns when git cannot say which commits are its threads'", async () => {
    const { deps } = setup({ outcome: "unavailable", reason: "git-failed", message: "boom" });
    const { worktrees, warnings } = await leaveOutHistory(deps, [far], attribution);
    expect(worktrees[0]).toBe(far);
    expect(warnings).toEqual(["Could not tell which commits in /work/one its threads made: boom"]);
  });
});

describe("history rule", () => {
  it("applies above the threshold to a readable worktree that is not a kept branch or shown whole", () => {
    expect(wantsHistoryLeftOut({ state: "ready", kind: "workspace", aheadCount: 51, whole: undefined }, 50)).toBe(true);
    expect(wantsHistoryLeftOut({ state: "ready", kind: "workspace", aheadCount: 50, whole: undefined }, 50)).toBe(false);
    expect(wantsHistoryLeftOut({ state: "ready", kind: "branch", aheadCount: 500, whole: undefined }, 50)).toBe(false);
    expect(wantsHistoryLeftOut({ state: "ready", kind: "checkout", aheadCount: 500, whole: true }, 50)).toBe(false);
    expect(wantsHistoryLeftOut({ state: "ready", kind: "checkout", aheadCount: 500, whole: undefined }, 0)).toBe(false);
  });

  it("counts a share below the percentage as few", () => {
    expect(fewEnough(2, 612, 10)).toBe(true);
    expect(fewEnough(61, 612, 10)).toBe(true);
    expect(fewEnough(62, 612, 10)).toBe(false);
  });
});
