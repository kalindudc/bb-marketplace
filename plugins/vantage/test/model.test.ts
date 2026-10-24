import { describe, expect, it } from "vitest";
import type { Overview, ReviewMarks, Worktree } from "../src/contract";
import { buildRows, chipCounts, groupRows, hiddenCount, matchesChip, outsideEntries, type RowsInput } from "../src/model";
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
    watched: () => false,
    reviewing: () => false,
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
    expect(rows[0]).toMatchObject({ additions: 3, deletions: 1, progress: null });
  });

  it("says nothing about a thread waiting for you unless its tree is watched", () => {
    expect(buildRows(input({}))[0]!.bucket).toBe("changed");
    expect(buildRows(input({}, { watched: (id) => id === "thr_1" }))[0]!.bucket).toBe("needs");
  });

  it("asks only the row's own thread whether it is watched, so a watched sibling in the same checkout does not leak in", () => {
    const shared = worktree({ key: "w1", threadIds: ["thr_1", "thr_2"], uncommitted: [file], label: "Shop" });
    const rows = buildRows(input({ worktrees: [shared] }, { watched: (id) => id === "thr_2" }));
    expect(rows[0]).toMatchObject({ threadId: "thr_1", watched: false, bucket: "changed" });
  });

  it("puts a running thread under Working, watched or not", () => {
    expect(buildRows(input({}))[1]!.bucket).toBe("working");
  });

  it("tracks reviews only where they are on, and calls a worktree reviewed once every part is ticked", () => {
    const reviewing = () => true;
    expect(buildRows(input({}, { reviewing }))[0]).toMatchObject({ bucket: "review", progress: { reviewed: 0, total: 1 } });
    const marks: Record<string, ReviewMarks> = { w1: { [markId("uncommitted", "src/a.ts")]: signature(file) } };
    expect(buildRows(input({}, { reviewing, marks }))[0]).toMatchObject({ bucket: "reviewed", progress: { reviewed: 1, total: 1 } });
  });

  it("does not count a tick from before the file changed", () => {
    const marks: Record<string, ReviewMarks> = { w1: { [markId("uncommitted", "src/a.ts")]: "modified:1:1:" } };
    expect(buildRows(input({}, { reviewing: () => true, marks }))[0]).toMatchObject({ bucket: "review", progress: { reviewed: 0, total: 1 } });
  });

  it("files an archived thread's worktree under Archived, even when it is watched and waiting", () => {
    const rows = buildRows(input({ threads: [threadSummary({ id: "thr_1", archived: true }), threadSummary({ id: "thr_2" })] }, { watched: () => true }));
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

describe("groups and chips", () => {
  const rows = buildRows(input({ sharedFiles: [sharedFile({ path: "src/a.ts", worktreeKeys: ["w1", "w2"] })] }, { watched: () => true }));

  it("groups by what needs doing, in a fixed order, and leaves out empty groups", () => {
    expect(groupRows(rows, "status").map((group) => [group.label, group.rows.length])).toEqual([["Needs you", 1], ["Working", 1]]);
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
