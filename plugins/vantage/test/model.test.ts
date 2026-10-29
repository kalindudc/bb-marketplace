import { describe, expect, it } from "vitest";
import type { Overview, ReviewMarks, Worktree } from "../src/contract";
import { buildRows, chipCounts, firstToOpen, groupRows, hiddenCount, matchesChip, outsideEntries, reviewStarted, type Bucket, type RowsInput } from "../src/model";
import { markId, signature } from "../src/reviewed";
import { checkoutRepo, fileChange, overview, sharedFile, sidebarThread, threadSummary, worktree } from "./fixtures";

const file = fileChange({ path: "src/a.ts", additions: 3, deletions: 1 });
const one = worktree({ key: "w1", threadIds: ["thr_1"], uncommitted: [file], label: "Shop" });
const two = worktree({ key: "w2", threadIds: ["thr_2"], committed: [fileChange({ path: "src/b.ts" })], label: "Api", hostName: "Laptop" });
const quiet = worktree({ key: "w3", threadIds: ["thr_3"], label: "Shop" });

function input(over: Partial<Overview>, options: Partial<RowsInput> = {}): RowsInput {
  return {
    overview: overview({
      threads: [threadSummary({ id: "thr_1" }), threadSummary({ id: "thr_2", title: "Api work" }), threadSummary({ id: "thr_3" })],
      worktrees: [one, two, quiet], ...over,
    }),
    live: new Map([
      ["thr_1", sidebarThread({ id: "thr_1", displayTitle: "Shop work", indicator: "waiting-for-input" })],
      ["thr_2", sidebarThread({ id: "thr_2", displayTitle: "Api work", indicator: "runtime" })],
    ]),
    marks: {},
    currentThreadId: null,
    text: "",
    ...options,
  };
}

describe("buildRows", () => {
  it("leaves out worktrees with nothing changed and names each row by its thread", () => {
    const rows = buildRows(input({}));
    expect(rows.map((row) => [row.worktree.key, row.title])).toEqual([["w1", "Shop work"], ["w2", "Api work"]]);
    expect(rows[0]).toMatchObject({ additions: 3, deletions: 1, progress: { reviewed: 0, total: 1 } });
  });

  it("files a thread that waits for you under Needs you, as bb's sidebar marks it", () => {
    expect(buildRows(input({}))[0]!.bucket).toBe("needs");
    const failed = new Map([["thr_1", sidebarThread({ id: "thr_1", indicator: "unread-error" })]]);
    expect(buildRows(input({}, { live: failed }))[0]!.bucket).toBe("needs");
  });

  it("files a worktree with changes and no question under To review", () => {
    const idle = new Map([["thr_1", sidebarThread({ id: "thr_1", indicator: "none" })]]);
    expect(buildRows(input({}, { live: idle }))[0]!.bucket).toBe("review");
  });

  it("files a worktree that cannot be read under Unavailable, never To review", () => {
    const idle = new Map([["thr_1", sidebarThread({ id: "thr_1", indicator: "none" })]]);
    const broken = worktree({ ...one, state: "unavailable", uncommitted: [], message: "git failed" });
    const rows = buildRows(input({ worktrees: [broken] }, { live: idle }));
    expect(rows.map((row) => row.bucket)).toEqual(["unavailable"]);
    expect(chipCounts(rows).review).toBe(0);
    expect(groupRows(rows, "status").map((group) => group.label)).toEqual(["Unavailable"]);
  });

  it("puts a running thread under Working", () => {
    expect(buildRows(input({}))[1]!.bucket).toBe("working");
  });

  it("counts reviewed files in every worktree, and calls one reviewed once every part is ticked", () => {
    const idle = new Map([["thr_1", sidebarThread({ id: "thr_1", indicator: "none" })]]);
    const marks: Record<string, ReviewMarks> = { w1: { [markId("uncommitted", "src/a.ts")]: signature(file) } };
    expect(buildRows(input({}, { live: idle, marks }))[0]).toMatchObject({ bucket: "reviewed", progress: { reviewed: 1, total: 1 } });
  });

  it("says a review has started only once a file is ticked, and has no progress before the files are read", () => {
    expect(reviewStarted({ progress: { reviewed: 0, total: 3 } })).toBe(false);
    expect(reviewStarted({ progress: { reviewed: 1, total: 3 } })).toBe(true);
    expect(reviewStarted({ progress: null })).toBe(false);
    const loading = worktree({ ...one, state: "loading" });
    const rows = buildRows(input({ worktrees: [loading] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.progress).toBeNull();
  });

  it("does not count a tick from before the file changed", () => {
    const idle = new Map([["thr_1", sidebarThread({ id: "thr_1", indicator: "none" })]]);
    const marks: Record<string, ReviewMarks> = { w1: { [markId("uncommitted", "src/a.ts")]: "modified:1:1:" } };
    expect(buildRows(input({}, { live: idle, marks }))[0]).toMatchObject({ bucket: "review", progress: { reviewed: 0, total: 1 } });
  });

  it("files an archived thread's worktree under Archived, even when it is waiting", () => {
    const rows = buildRows(input({ threads: [threadSummary({ id: "thr_1", archived: true }), threadSummary({ id: "thr_2" })] }));
    expect(rows[0]!.bucket).toBe("archived");
  });

  it("reads overlaps from the shared files once the overview is complete", () => {
    const shared = [sharedFile({ projectId: "proj_1", path: "src/a.ts", worktreeKeys: ["w1", "w2"] })];
    expect(buildRows(input({ sharedFiles: shared }))[0]!.overlaps).toEqual([{ path: "src/a.ts", otherKeys: ["w2"] }]);
    expect(buildRows(input({ sharedFiles: shared, partial: true }))[0]!.overlaps).toEqual([]);
  });

  it("calls the panel's own worktree This thread", () => {
    expect(buildRows(input({}, { currentThreadId: "thr_1" }))[0]!.title).toBe("This thread");
  });

  it("filters by text over titles, branches and file paths", () => {
    expect(buildRows(input({}, { text: "b.ts" })).map((row) => row.worktree.key)).toEqual(["w2"]);
  });
});

describe("firstToOpen", () => {
  const rows = buildRows(input({}));

  it("opens the worktree that most needs a person, in a fixed order, and never an archived one", () => {
    const withBuckets = (...buckets: Bucket[]) => buckets.map((bucket, index) => ({ ...rows[index % rows.length]!, bucket }));
    expect(firstToOpen([])).toBeNull();
    expect(firstToOpen(withBuckets("archived"))).toBeNull();
    expect(firstToOpen(withBuckets("needs", "review", "working"))?.bucket).toBe("needs");
    expect(firstToOpen(withBuckets("unavailable", "reviewed", "working"))?.bucket).toBe("working");
    expect(firstToOpen(withBuckets("unavailable", "archived", "reviewed"))?.bucket).toBe("reviewed");
    expect(firstToOpen(withBuckets("unavailable"))?.bucket).toBe("unavailable");
  });
});

describe("groups and chips", () => {
  const rows = buildRows(input({ sharedFiles: [sharedFile({ path: "src/a.ts", worktreeKeys: ["w1", "w2"] })] }));

  it("groups by what needs doing, in a fixed order, and leaves out empty groups", () => {
    expect(groupRows(rows, "status").map((group) => [group.label, group.rows.length])).toEqual([["Waiting on you", 1], ["Still working", 1]]);
  });

  it("groups by project, archived last", () => {
    const archived = buildRows(input({ threads: [threadSummary({ id: "thr_1", archived: true }), threadSummary({ id: "thr_2" })] }));
    expect(groupRows(archived, "project").map((group) => group.label)).toEqual(["Api", "Archived"]);
  });

  it("counts each chip and filters by it", () => {
    expect(chipCounts(rows)).toEqual({ needs: 1, working: 1, review: 0, overlaps: 2 });
    expect(rows.filter((row) => matchesChip(row, "working")).map((row) => row.worktree.key)).toEqual(["w2"]);
    expect(rows.filter((row) => matchesChip(row, null))).toHaveLength(2);
  });
});

describe("outside entries and hidden worktrees", () => {
  it("lists repositories edited by path and files outside any repository", () => {
    const edited = checkoutRepo({ files: [fileChange({ path: "docs/a.md", additions: 2, deletions: 0 })] });
    const worked = checkoutRepo({ key: "worked", ref: { kind: "checkout", hostId: "host_1", root: "/c", base: null, worked: true }, files: [fileChange()] });
    const entries = outsideEntries(overview({ repos: [edited, worked], otherFiles: [fileChange({ path: "/tmp/x" })] }), "");
    expect(entries.map((entry) => [entry.kind, entry.title, entry.files])).toEqual([["repo", "commons", 1], ["otherFiles", "Other files", 1]]);
    expect(outsideEntries(overview({ repos: [edited] }), "zzz")).toEqual([]);
  });

  it("counts the worktrees left out for having no changes", () => {
    const worktrees: Worktree[] = [one, quiet];
    expect(hiddenCount(overview({ worktrees }), "")).toBe(1);
    expect(hiddenCount(overview({ worktrees }), "a")).toBe(0);
  });
});
