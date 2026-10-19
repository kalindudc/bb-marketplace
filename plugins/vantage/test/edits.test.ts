import { describe, expect, it, vi } from "vitest";
import { createEditIndex, editsFromRows, findRecordedEdits, MAX_WORK_DIRS, workDirsOf, type EventsSdk } from "../src/edits";

type EventRow = Parameters<typeof editsFromRows>[1][number];
type Change = { path: string; kind: "add" | "delete" | "update"; movePath?: string; diff?: string };

function row(seq: number, item: object, threadId = "thr_1"): EventRow {
  return { id: `evt_${seq}`, scope: { kind: "thread" }, threadId, seq, createdAt: seq * 1000, type: "item/completed", data: { item } } as unknown as EventRow;
}
function fileChange(seq: number, changes: Change[], extra: object = {}, threadId = "thr_1"): EventRow {
  return row(seq, { type: "fileChange", id: `item_${seq}`, status: "completed", approvalStatus: null, changes, ...extra }, threadId);
}
function command(seq: number, cwd: string, text = "ls"): EventRow {
  return row(seq, { type: "commandExecution", id: `item_${seq}`, command: text, cwd, status: "completed", approvalStatus: null });
}

function fakeSdk(threads: Record<string, EventRow[]>) {
  const list = vi.fn(async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
    if (Number(args.limit ?? "0") > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    const after = args.afterSeq === undefined ? 0 : Number(args.afterSeq);
    return (threads[args.threadId] ?? []).filter((event) => event.seq > after).slice(0, Number(args.limit ?? "100"));
  });
  return { sdk: { threads: { events: { list } } } as unknown as EventsSdk, list };
}

describe("workDirsOf", () => {
  it("finds every cd, pushd and git -C folder in a command line", () => {
    expect(workDirsOf("cd ~/world/trees/study-events/src && git status; pushd /tmp/x >/dev/null; git -C /code/other log -1")).toEqual([
      "~/world/trees/study-events/src", "/tmp/x", "/code/other",
    ]);
  });

  it("reads quoted folders, and folders inside a shell -c string", () => {
    expect(workDirsOf(`/bin/zsh -lc 'cd "/code/with space" && ls'`)).toEqual(["/code/with space"]);
    expect(workDirsOf(`bash -c "cd '/code/single' && ls"`)).toEqual(["/code/single"]);
    expect(workDirsOf("(cd /code/sub && make)")).toEqual(["/code/sub"]);
  });

  it("normalizes the folder and drops a trailing slash", () => {
    expect(workDirsOf("cd /code/a/../b/ && cd ~/src/./x/")).toEqual(["/code/b", "~/src/x"]);
  });

  it("skips relative folders, variables, globs, the home folder and the file system root", () => {
    expect(workDirsOf('cd envoy/modules && cd "$T" && cd ~ && cd / && cd /code/* && cd -- ~/ok && cd `pwd`')).toEqual(["~/ok"]);
  });

  it("does not take a word that only ends in cd", () => {
    expect(workDirsOf("abcd /code/x; git-C /code/y")).toEqual([]);
  });
});

describe("editsFromRows", () => {
  it("records completed changes with line counts and the move target", () => {
    const rows = [
      fileChange(1, [
        { path: "src/a.ts", kind: "update", diff: "--- a\n+++ b\n@@ @@\n-old\n+new\n+more" },
        { path: "src/b.ts", kind: "add", diff: "+one\n+two" },
        { path: "src/c.ts", kind: "update", movePath: "src/d.ts", diff: "-x" },
        { path: "/abs/e.ts", kind: "delete" },
      ]),
    ];
    const { records, lastSeq } = editsFromRows("thr_1", rows);
    expect(lastSeq).toBe(1);
    expect(records).toEqual([
      { threadId: "thr_1", path: "src/a.ts", movePath: null, kind: "update", added: 2, removed: 1, at: 1000 },
      { threadId: "thr_1", path: "src/b.ts", movePath: null, kind: "add", added: 2, removed: 0, at: 1000 },
      { threadId: "thr_1", path: "src/c.ts", movePath: "src/d.ts", kind: "update", added: 0, removed: 1, at: 1000 },
      { threadId: "thr_1", path: "/abs/e.ts", movePath: null, kind: "delete", added: 0, removed: 0, at: 1000 },
    ]);
  });

  it("keeps several changes to one file as separate records", () => {
    const { records } = editsFromRows("thr_1", [
      fileChange(1, [{ path: "a.ts", kind: "update", diff: "+1" }, { path: "a.ts", kind: "update", diff: "+2\n+3" }]),
    ]);
    expect(records.map((record) => record.added)).toEqual([1, 2]);
  });

  it("skips failed, interrupted, pending and denied items and other item kinds", () => {
    const changes: Change[] = [{ path: "a.ts", kind: "update", diff: "+x" }];
    const { records } = editsFromRows("thr_1", [
      fileChange(1, changes, { status: "failed" }),
      fileChange(2, changes, { status: "interrupted" }),
      fileChange(3, changes, { status: "pending" }),
      fileChange(4, changes, { approvalStatus: "denied" }),
      row(5, { type: "agentMessage", id: "m", text: "hi" }),
      fileChange(6, changes),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.at).toBe(6000);
  });

  it("takes the working directory of the first command as primaryCwd", () => {
    const result = editsFromRows("thr_1", [command(1, "/work/one"), command(2, "/work/two")]);
    expect(result).toEqual({ records: [], primaryCwd: "/work/one", workDirs: [], lastSeq: 2 });
  });

  it("lists the folders commands changed into, once each and least recently used first", () => {
    const result = editsFromRows("thr_1", [
      command(1, "/work/one", "cd /code/a && ls"),
      command(2, "/work/one", "cd /code/b"),
      command(3, "/work/one", "cd /code/a && git diff"),
    ]);
    expect(result.workDirs).toEqual(["/code/b", "/code/a"]);
  });

  it("reports no last sequence for no rows", () => {
    expect(editsFromRows("thr_1", [])).toEqual({ records: [], primaryCwd: null, workDirs: [], lastSeq: null });
  });
});

describe("createEditIndex", () => {
  const edit = (seq: number) => fileChange(seq, [{ path: `f${seq}.ts`, kind: "add", diff: "+x" }]);

  it("reads 100-row pages until a short page, then only what is new", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => edit(index + 1));
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);

    const first = await index.get("thr_1");
    expect(first.records).toHaveLength(250);
    expect(list.mock.calls.map(([args]) => args)).toEqual([
      { threadId: "thr_1", types: ["item/completed"], limit: "100", order: "asc", signal: undefined },
      { threadId: "thr_1", types: ["item/completed"], limit: "100", order: "asc", afterSeq: "100", signal: undefined },
      { threadId: "thr_1", types: ["item/completed"], limit: "100", order: "asc", afterSeq: "200", signal: undefined },
    ]);

    rows.push(edit(251));
    const second = await index.get("thr_1");
    expect(second.records).toHaveLength(251);
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls[3]?.[0]).toMatchObject({ afterSeq: "250" });
  });

  it("asks again after exactly one full page", async () => {
    const { sdk, list } = fakeSdk({ thr_1: Array.from({ length: 100 }, (_, i) => edit(i + 1)) });
    await createEditIndex(sdk).get("thr_1");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("returns the same edits without copying when nothing is new", async () => {
    const { sdk } = fakeSdk({ thr_1: [edit(1)] });
    const index = createEditIndex(sdk);
    const first = await index.get("thr_1");
    expect(await index.get("thr_1")).toBe(first);
  });

  it("keeps the first command's directory as later rows arrive", async () => {
    const rows = [command(1, "/work/one"), edit(2)];
    const { sdk } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    expect((await index.get("thr_1")).primaryCwd).toBe("/work/one");
    rows.push(command(3, "/work/three"));
    expect((await index.get("thr_1")).primaryCwd).toBe("/work/one");
  });

  it("adds the folders of new commands and keeps the same edits when a command only repeats the last folder", async () => {
    const rows = [command(1, "/work/one", "cd /code/a"), command(2, "/work/one", "cd /code/b")];
    const { sdk } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    expect((await index.get("thr_1")).workDirs).toEqual(["/code/a", "/code/b"]);
    rows.push(command(3, "/work/one", "cd /code/a"));
    const moved = await index.get("thr_1");
    expect(moved.workDirs).toEqual(["/code/b", "/code/a"]);
    rows.push(command(4, "/work/one", "cd /code/a && ls"));
    expect(await index.get("thr_1")).toBe(moved);
  });

  it("keeps only the most recent folders", async () => {
    const rows = Array.from({ length: MAX_WORK_DIRS + 5 }, (_, i) => command(i + 1, "/work/one", `cd /code/d${i}`));
    const { sdk } = fakeSdk({ thr_1: rows });
    const { workDirs } = await createEditIndex(sdk).get("thr_1");
    expect(workDirs).toHaveLength(MAX_WORK_DIRS);
    expect(workDirs[0]).toBe("/code/d5");
    expect(workDirs.at(-1)).toBe(`/code/d${MAX_WORK_DIRS + 4}`);
  });

  it("peeks at what an earlier read found without asking bb", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1)] });
    const index = createEditIndex(sdk);
    expect(index.peek("thr_1")).toBeUndefined();
    const read = await index.get("thr_1");
    expect(index.peek("thr_1")).toBe(read);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("forgets a thread so the next read starts over", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1)], thr_2: [edit(1)] });
    const index = createEditIndex(sdk);
    await index.get("thr_1");
    await index.get("thr_2");
    index.forget(["thr_1"]);
    await index.get("thr_1");
    await index.get("thr_2");
    const afterSeqs = list.mock.calls.map(([args]) => [args.threadId, args.afterSeq]);
    expect(afterSeqs).toEqual([["thr_1", undefined], ["thr_2", undefined], ["thr_1", undefined], ["thr_2", "1"]]);
  });

  it("evicts the least recently used thread past maxThreads", async () => {
    const { sdk, list } = fakeSdk({ a: [edit(1)], b: [edit(1)], c: [edit(1)] });
    const index = createEditIndex(sdk, { maxThreads: 2 });
    await index.get("a");
    await index.get("b");
    await index.get("a");
    await index.get("c");
    list.mockClear();
    await index.get("a");
    expect(list.mock.calls[0]?.[0]).toMatchObject({ threadId: "a", afterSeq: "1" });
    await index.get("b");
    expect(list.mock.calls[1]?.[0]).toMatchObject({ threadId: "b" });
    expect(list.mock.calls[1]?.[0].afterSeq).toBeUndefined();
  });

  it("keeps only the most recent records past maxRecords", async () => {
    const { sdk } = fakeSdk({ thr_1: [edit(1), edit(2), edit(3), edit(4)] });
    const { records } = await createEditIndex(sdk, { maxRecords: 2 }).get("thr_1");
    expect(records.map((record) => record.path)).toEqual(["f3.ts", "f4.ts"]);
  });

  it("makes no events call for a settled thread that is already indexed", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1)] });
    const index = createEditIndex(sdk);
    const first = await index.get("thr_1");
    list.mockClear();
    expect(await index.get("thr_1", undefined, { settled: true })).toBe(first);
    expect(list).not.toHaveBeenCalled();
  });

  it("still reads a settled thread that was never indexed", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1)] });
    const { records } = await createEditIndex(sdk).get("thr_1", undefined, { settled: true });
    expect(records).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps reading new events for a thread that is not settled", async () => {
    const rows = [edit(1)];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    await index.get("thr_1", undefined, { settled: false });
    rows.push(edit(2));
    list.mockClear();
    expect((await index.get("thr_1", undefined, { settled: false })).records).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("shares one read between simultaneous callers", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1)] });
    const index = createEditIndex(sdk);
    const [first, second] = await Promise.all([index.get("thr_1"), index.get("thr_1")]);
    expect(first).toBe(second);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not keep a thread whose read failed", async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([edit(1)]);
    const index = createEditIndex({ threads: { events: { list } } } as unknown as EventsSdk);
    await expect(index.get("thr_1")).rejects.toThrow("boom");
    expect((await index.get("thr_1")).records).toHaveLength(1);
  });
});

describe("findRecordedEdits", () => {
  it("matches by path or move target and returns them oldest first with their diffs", async () => {
    const { sdk } = fakeSdk({
      thr_1: [
        fileChange(3, [{ path: "src/new.ts", kind: "update", movePath: "src/moved.ts", diff: "+c" }]),
        fileChange(1, [{ path: "src/a.ts", kind: "update", diff: "+a" }]),
        fileChange(2, [{ path: "src/other.ts", kind: "update", diff: "+z" }]),
      ].sort((a, b) => a.seq - b.seq),
      thr_2: [fileChange(2, [{ path: "src/a.ts", kind: "add" }], {}, "thr_2")],
    });
    const edits = await findRecordedEdits(sdk, ["thr_1", "thr_2"], new Set(["src/a.ts", "src/moved.ts"]), 50);
    expect(edits).toEqual([
      { threadId: "thr_1", at: 1000, kind: "update", diff: "+a", truncated: false },
      { threadId: "thr_2", at: 2000, kind: "add", diff: null, truncated: false },
      { threadId: "thr_1", at: 3000, kind: "update", diff: "+c", truncated: false },
    ]);
  });

  it("keeps at most the limit, the oldest first", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => fileChange(index + 1, [{ path: "a.ts", kind: "update", diff: `+${index}` }]));
    const { sdk } = fakeSdk({ thr_1: rows });
    const edits = await findRecordedEdits(sdk, ["thr_1"], new Set(["a.ts"]), 3);
    expect(edits.map((edit) => edit.at)).toEqual([1000, 2000, 3000]);
  });

  it("cuts a diff at 60,000 characters and says so", async () => {
    const diff = `+${"x".repeat(70_000)}`;
    const { sdk } = fakeSdk({ thr_1: [fileChange(1, [{ path: "a.ts", kind: "update", diff }])] });
    const [edit] = await findRecordedEdits(sdk, ["thr_1"], new Set(["a.ts"]), 50);
    expect(edit?.diff).toHaveLength(60_000);
    expect(edit?.truncated).toBe(true);
  });

  it("skips failed and denied edits and reads every page", async () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, index) => row(index + 1, { type: "agentMessage", id: `m${index}`, text: "x" })),
      fileChange(101, [{ path: "a.ts", kind: "update", diff: "+late" }]),
      fileChange(102, [{ path: "a.ts", kind: "update", diff: "+no" }], { status: "failed" }),
      fileChange(103, [{ path: "a.ts", kind: "update", diff: "+no" }], { approvalStatus: "denied" }),
    ];
    const { sdk } = fakeSdk({ thr_1: rows });
    const edits = await findRecordedEdits(sdk, ["thr_1"], new Set(["a.ts"]), 50);
    expect(edits.map((edit) => edit.diff)).toEqual(["+late"]);
  });
});
