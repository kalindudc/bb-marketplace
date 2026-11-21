import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { buildOverview } from "../src/collect";
import {
  createEditIndex,
  editsFromRows,
  findRecordedEdits,
  isCommitCommand,
  MAX_COMMIT_RUNS,
  MAX_WORK_DIRS,
  workDirsOf,
  type EventsSdk,
} from "../src/edits";

type EventRow = Parameters<typeof editsFromRows>[1][number];
type Change = { path: string; kind: "add" | "delete" | "update"; movePath?: string; diff?: string };

function row(seq: number, item: object, threadId = "thr_1", type = "item/completed"): EventRow {
  return {
    id: `evt_${seq}`,
    scope: { kind: "thread" },
    threadId,
    seq,
    createdAt: seq * 1000,
    type,
    data: { item },
  } as unknown as EventRow;
}
function fileChange(seq: number, changes: Change[], extra: object = {}, threadId = "thr_1"): EventRow {
  return row(
    seq,
    { type: "fileChange", id: `item_${seq}`, status: "completed", approvalStatus: null, changes, ...extra },
    threadId,
  );
}
function command(seq: number, cwd: string, text = "ls"): EventRow {
  return row(seq, {
    type: "commandExecution",
    id: `item_${seq}`,
    command: text,
    cwd,
    status: "completed",
    approvalStatus: null,
  });
}
// A command's start and end are two events about one item.
function started(seq: number, id: string, text: string): EventRow {
  return row(
    seq,
    { type: "commandExecution", id, command: text, cwd: "/work/one", status: "pending", approvalStatus: null },
    "thr_1",
    "item/started",
  );
}
function finished(seq: number, id: string, text: string): EventRow {
  return row(seq, {
    type: "commandExecution",
    id,
    command: text,
    cwd: "/work/one",
    status: "completed",
    approvalStatus: null,
  });
}

function fakeSdk(threads: Record<string, EventRow[]>) {
  const list = vi.fn(
    async (args: { threadId: string; afterSeq?: string; limit?: string; types?: readonly string[] }) => {
      if (Number(args.limit ?? "0") > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
      const after = args.afterSeq === undefined ? 0 : Number(args.afterSeq);
      return (threads[args.threadId] ?? [])
        .filter((event) => event.seq > after && (args.types === undefined || args.types.includes(event.type)))
        .slice(0, Number(args.limit ?? "100"));
    },
  );
  return { sdk: { threads: { events: { list } } } as unknown as EventsSdk, list };
}

function archivedTree(children: readonly string[]) {
  const root = "thr_root";
  const { list } = fakeSdk(
    Object.fromEntries(
      children.map((id) => [
        id,
        [
          fileChange(1, [{ path: `${id}-first.ts`, kind: "add" }], {}, id),
          ...Array.from({ length: 399 }, (_, i) => row(i + 2, { type: "agentMessage", id: `m${i}`, text: "x" }, id)),
          fileChange(401, [{ path: `${id}-last.ts`, kind: "add" }], {}, id),
        ],
      ]),
    ),
  );
  const { sdk } = createFakeSdk({
    pluginId: "vantage",
    overrides: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            title: threadId === root ? "Parent" : "Worker",
            parentThreadId: threadId === root ? null : root,
            archivedAt: threadId === root ? null : 1,
            environmentId: null,
          }),
        experimental_listDescendants: async () => ({ threads: [{ threadId: root, descendantIds: [...children] }] }),
        events: { list },
      },
      projects: { list: async () => [] },
      hosts: { list: async () => [] },
    },
  });
  const host = vi.fn(async (): Promise<never> => {
    throw new Error("unexpected host call");
  });
  const edits = createEditIndex(sdk);
  const input = { target: { kind: "tree", threadId: root }, scope: "branch", includeArchived: true } as const;
  return {
    list,
    host,
    edits,
    overview: (refresh = false) => buildOverview({ sdk, host, edits }, { ...input, refresh }),
    cursors: (id: string) => list.mock.calls.filter(([args]) => args.threadId === id).map(([args]) => args.afterSeq),
  };
}

describe("workDirsOf", () => {
  it("finds every cd, pushd and git -C folder in a command line", () => {
    expect(
      workDirsOf("cd ~/clones/side/src && git status; pushd /tmp/x >/dev/null; git -C /code/other log -1"),
    ).toEqual(["~/clones/side/src", "/tmp/x", "/code/other"]);
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
    expect(workDirsOf('cd lib/modules && cd "$T" && cd ~ && cd / && cd /code/* && cd -- ~/ok && cd `pwd`')).toEqual([
      "~/ok",
    ]);
  });

  it("does not take a word that only ends in cd", () => {
    expect(workDirsOf("abcd /code/x; git-C /code/y")).toEqual([]);
  });
});

describe("isCommitCommand", () => {
  it.each([
    "git commit -m x",
    'cd /code/a && git add -A && git commit -q -m "ship it" && git push',
    "git -C /code/a commit --amend --no-edit",
    "git -c user.name=Ada --no-pager commit -m x",
    "/usr/bin/git commit -m x",
    "bash -lc 'git commit -m x'",
  ])("sees a commit in %s", (text) => {
    expect(isCommitCommand(text)).toBe(true);
  });

  it.each([
    "git log --grep commit",
    "git commit-tree HEAD^{tree}",
    "git status",
    "gitcommit",
    "git -C /code/commit status",
  ])("sees none in %s", (text) => {
    expect(isCommitCommand(text)).toBe(false);
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
      fileChange(1, [
        { path: "a.ts", kind: "update", diff: "+1" },
        { path: "a.ts", kind: "update", diff: "+2\n+3" },
      ]),
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
    expect(result).toEqual({
      records: [],
      primaryCwd: "/work/one",
      workDirs: [],
      commitRuns: [],
      lastEventAt: 2000,
      lastSeq: 2,
    });
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
    expect(editsFromRows("thr_1", [])).toEqual({
      records: [],
      primaryCwd: null,
      workDirs: [],
      commitRuns: [],
      lastEventAt: null,
      lastSeq: null,
    });
  });

  it("records when each git commit command started and finished, and leaves a running one open", () => {
    const result = editsFromRows("thr_1", [
      started(1, "c1", "git commit -m one"),
      started(2, "ls", "ls"),
      finished(3, "ls", "ls"),
      finished(5, "c1", "git commit -m one"),
      started(7, "c2", "git add -A && git commit -m two && git push"),
    ]);
    expect(result.commitRuns).toEqual([
      { id: "c1", startedAt: 1000, endedAt: 5000 },
      { id: "c2", startedAt: 7000, endedAt: null },
    ]);
    expect(result.lastEventAt).toBe(7000);
  });

  it("starts a commit command with no start event at the event before it", () => {
    const result = editsFromRows("thr_1", [command(4, "/work/one"), finished(9, "c1", "git commit -m one")]);
    expect(result.commitRuns).toEqual([{ id: "c1", startedAt: 4000, endedAt: 9000 }]);
  });

  it("closes a run an earlier read left open, and keeps the earlier runs untouched when nothing is new", () => {
    const first = editsFromRows("thr_1", [started(1, "c1", "git commit -m one")]);
    const known = { commitRuns: first.commitRuns, lastEventAt: first.lastEventAt };
    expect(editsFromRows("thr_1", [finished(4, "c1", "git commit -m one")], known).commitRuns).toEqual([
      { id: "c1", startedAt: 1000, endedAt: 4000 },
    ]);
    expect(editsFromRows("thr_1", [command(5, "/work/one")], known).commitRuns).toBe(first.commitRuns);
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
      { threadId: "thr_1", types: ["item/started", "item/completed"], limit: "100", order: "asc", signal: undefined },
      {
        threadId: "thr_1",
        types: ["item/started", "item/completed"],
        limit: "100",
        order: "asc",
        afterSeq: "100",
        signal: undefined,
      },
      {
        threadId: "thr_1",
        types: ["item/started", "item/completed"],
        limit: "100",
        order: "asc",
        afterSeq: "200",
        signal: undefined,
      },
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
    expect(afterSeqs).toEqual([
      ["thr_1", undefined],
      ["thr_2", undefined],
      ["thr_1", undefined],
      ["thr_2", "1"],
    ]);
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

  it("reads the final events from the prior cursor, then reuses a finalized archive", async () => {
    const rows = [edit(1), started(2, "c1", "git commit -m one")];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    await index.get("thr_1");
    rows.push(edit(3), command(4, "/work/one", "cd /work/two"), finished(5, "c1", "git commit -m one"));

    const final = await index.get("thr_1", undefined, { settled: true });
    expect(final).toMatchObject({
      records: [
        { threadId: "thr_1", path: "f1.ts" },
        { threadId: "thr_1", path: "f3.ts" },
      ],
      workDirs: ["/work/two"],
      commitRuns: [{ id: "c1", startedAt: 2000, endedAt: 5000 }],
    });
    expect(await index.get("thr_1", undefined, { settled: true })).toBe(final);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "2"]);
  });

  it("reads a first-ever archive once and forget starts it over", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1)] });
    const index = createEditIndex(sdk);
    const settled = { settled: true };
    const first = await index.get("thr_1", undefined, settled);
    expect(first.records).toHaveLength(1);
    expect(await index.get("thr_1", undefined, settled)).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);
    index.forget(["thr_1"]);
    expect(await index.get("thr_1", undefined, settled)).not.toBe(first);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, undefined]);
  });

  it("coalesces archive callers but does not finalize an active read that started before archive", async () => {
    const rows = [edit(1)];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    let release!: () => void;
    list.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([edit(1)]))));
    const active = index.get("thr_1");
    rows.push(edit(2));
    const archive = index.get("thr_1", undefined, { settled: true });
    const alsoArchive = index.get("thr_1", undefined, { settled: true });
    expect(list).toHaveBeenCalledTimes(1);
    release();

    const [before, final, same] = await Promise.all([active, archive, alsoArchive]);
    expect(before.records).toHaveLength(1);
    expect(final.records).toHaveLength(2);
    expect(same).toBe(final);
    expect(await index.get("thr_1", undefined, { settled: true })).toBe(final);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "1"]);
  });

  it("keeps the prior index if a later archive page fails and retries the same cursor", async () => {
    const rows = [edit(1)];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    const first = await index.get("thr_1");
    const trailing = Array.from({ length: 100 }, (_, i) => edit(i + 2));
    rows.push(...trailing, edit(102));
    list.mockResolvedValueOnce(trailing).mockRejectedValueOnce(new Error("event store unavailable"));
    const settled = { settled: true };

    const incomplete = await index.get("thr_1", undefined, settled);
    expect(incomplete).toMatchObject({ archiveIncomplete: true, eventsIncomplete: true });
    expect(incomplete.records).toBe(first.records);
    expect(index.peek("thr_1")).toBe(incomplete);
    const final = await index.get("thr_1", undefined, settled);
    expect(final.records).toHaveLength(102);
    expect(final).not.toHaveProperty("archiveIncomplete");
    expect(final).not.toHaveProperty("eventsIncomplete");
    expect(await index.get("thr_1", undefined, settled)).toBe(final);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "1", "101", "1", "101"]);
  });

  it("does not finalize an aborted archive even if the event store still responds", async () => {
    const rows = [edit(1)];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    const first = await index.get("thr_1");
    rows.push(edit(2));
    const controller = new AbortController();
    const settled = { settled: true };
    const aborted = index.get("thr_1", controller.signal, settled);
    controller.abort(new Error("archive cancelled"));

    await expect(aborted).rejects.toThrow("archive cancelled");
    expect(index.peek("thr_1")).toBe(first);
    expect((await index.get("thr_1", undefined, settled)).records).toHaveLength(2);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "1", "1"]);
  });

  it("catches up after a thread is observed active again, even if its active read failed", async () => {
    const rows = [edit(1)];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    const settled = { settled: true };
    await index.get("thr_1", undefined, settled);
    list.mockRejectedValueOnce(new Error("active read failed"));
    await expect(index.get("thr_1")).rejects.toThrow("active read failed");
    rows.push(edit(2));

    const final = await index.get("thr_1", undefined, settled);
    expect(final.records).toHaveLength(2);
    expect(await index.get("thr_1", undefined, settled)).toBe(final);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "1", "1"]);
  });

  it("keeps complete evidence until a bounded recheck reaches the end, then replaces it", async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => edit(i + 1));
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    const first = await index.get("thr_1");
    expect(first.records.at(-1)?.path).toBe("f1201.ts");

    rows[0] = fileChange(1, [{ path: "corrected-early.ts", kind: "add" }]);
    rows[1200] = fileChange(1201, [{ path: "corrected-late.ts", kind: "add" }]);
    list.mockClear();
    const partial = await index.get("thr_1", undefined, { recheck: true });
    expect(partial.records).toBe(first.records);
    expect(index.peek("thr_1")).toBe(partial);
    expect(partial).toMatchObject({ eventsIncomplete: true });

    rows.push(edit(1202));
    const next = await index.get("thr_1");
    expect(next.records.at(-1)?.path).toBe("f1202.ts");
    expect(next.records).toHaveLength(1202);
    expect(next.records[0]?.path).toBe("f1.ts");
    expect(next.records.at(-2)?.path).toBe("f1201.ts");
    expect(next).toMatchObject({ eventsIncomplete: true });
    expect(index.peek("thr_1")).toBe(next);

    expect(await index.get("thr_1")).toBe(next);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([
      undefined,
      "100",
      "200",
      "300",
      "1201",
      "400",
      "500",
      "600",
      "700",
      "1201",
      "800",
      "900",
      "1000",
      "1100",
      "1202",
    ]);

    const complete = await index.get("thr_1", undefined, { settled: true });
    expect(list.mock.calls.at(-1)?.[0].afterSeq).toBe("1200");
    expect(complete).not.toHaveProperty("archiveIncomplete");
    expect(complete).not.toHaveProperty("eventsIncomplete");
    expect(complete.records.map(({ path }) => path)).toEqual(
      rows.map((event, i) => (i === 0 ? "corrected-early.ts" : i === 1200 ? "corrected-late.ts" : `f${event.seq}.ts`)),
    );
  });

  it.each(["400", "801"])("holds both recheck cursors when a settled read fails at %s", async (failedCursor) => {
    const rows = Array.from({ length: 801 }, (_, i) => edit(i + 1));
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    await index.get("thr_1");
    const partial = await index.get("thr_1", undefined, { recheck: true });
    rows.push(edit(802));
    const normal = list.getMockImplementation()!;
    list.mockClear();
    list.mockImplementation(async (args) => {
      if (args.afterSeq === failedCursor) throw new Error("event store unavailable");
      return normal(args);
    });

    const settled = { settled: true };
    const incomplete = await index.get("thr_1", undefined, settled);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toContain(failedCursor);
    expect(incomplete).toMatchObject({ archiveIncomplete: true, eventsIncomplete: true });
    expect(incomplete.records).toBe(partial.records);
    expect(index.peek("thr_1")).toBe(incomplete);

    list.mockImplementation(normal).mockClear();
    const resumed = await index.get("thr_1", undefined, settled);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual(["400", "500", "600", "700", "801"]);
    expect(resumed).toMatchObject({ archiveIncomplete: true, eventsIncomplete: true });
    expect(resumed.records.at(-1)?.path).toBe("f802.ts");
    expect(await index.get("thr_1", undefined, settled)).toBe(resumed);
    const complete = await index.get("thr_1", undefined, { ...settled, refresh: true });
    expect(complete).not.toHaveProperty("archiveIncomplete");
    expect(complete).not.toHaveProperty("eventsIncomplete");
    expect(complete.records).toHaveLength(802);
  });

  it.each(["abort", "forget"])("does not publish a recheck after %s during the tail read", async (action) => {
    const rows = Array.from({ length: 801 }, (_, i) => edit(i + 1));
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    await index.get("thr_1");
    const partial = await index.get("thr_1", undefined, { recheck: true });
    rows.push(edit(802));
    const controller = new AbortController();
    const message = action === "abort" ? "recheck cancelled" : "Edit index was reset";
    const normal = list.getMockImplementation()!;
    list.mockImplementation((args) => {
      if (args.afterSeq === "801") {
        if (action === "abort") controller.abort(new Error(message));
        else index.forget(["thr_1"]);
      }
      return normal(args);
    });

    await expect(index.get("thr_1", controller.signal)).rejects.toThrow(message);
    expect(index.peek("thr_1")).toBe(action === "abort" ? partial : undefined);
  });

  it("does not join or cache a pre-reset read after forget", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [edit(1), edit(2)] });
    const index = createEditIndex(sdk);
    let release!: () => void;
    list.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([edit(1)]))));
    const old = index.get("thr_1", undefined, { settled: true });
    index.forget(["thr_1"]);
    const fresh = index.get("thr_1", undefined, { settled: true });
    release();

    const [, final] = await Promise.all([expect(old).rejects.toThrow("Edit index was reset"), fresh]);
    expect(final.records).toHaveLength(2);
    expect(await index.get("thr_1", undefined, { settled: true })).toBe(final);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, undefined]);
  });

  it("keeps partial archive data and paces retries when the page budget is exhausted", async () => {
    const rows = [edit(1)];
    const { sdk, list } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    await index.get("thr_1");
    rows.push(...Array.from({ length: 401 }, (_, i) => edit(i + 2)));
    const settled = { settled: true };
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const partial = await index.get("thr_1", undefined, settled);
      expect(partial.records).toHaveLength(401);
      expect(partial).toMatchObject({ archiveIncomplete: true });
      expect(await index.get("thr_1", undefined, settled)).toBe(partial);
      expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "1", "101", "201", "301"]);

      now.mockReturnValue(15_000);
      const complete = await index.get("thr_1", undefined, settled);
      expect(complete.records).toHaveLength(402);
      expect(complete).not.toHaveProperty("archiveIncomplete");
      expect(await index.get("thr_1", undefined, settled)).toBe(complete);
      expect(list.mock.calls.at(-1)?.[0].afterSeq).toBe("401");
      expect(list).toHaveBeenCalledTimes(6);
    } finally {
      now.mockRestore();
    }
  });

  it("continues a long archived child on tree hard Refresh without rereading page one", async () => {
    const { overview, cursors, host } = archivedTree(["thr_child"]);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const partial = await overview();
      expect(partial.otherFiles.map((file) => file.path)).toEqual(["thr_child-first.ts"]);
      expect(cursors("thr_child")).toEqual([undefined, "100", "200", "300"]);
      const complete = await overview(true);
      expect(complete.otherFiles).toMatchObject([
        { path: "thr_child-first.ts", edits: { threadIds: ["thr_child"], rawPaths: ["thr_child-first.ts"] } },
        { path: "thr_child-last.ts", edits: { threadIds: ["thr_child"], rawPaths: ["thr_child-last.ts"] } },
      ]);
      expect(complete.warnings).toEqual([]);
      expect(cursors("thr_child")).toEqual([undefined, "100", "200", "300", "400"]);
      expect((await overview(true)).otherFiles).toEqual(complete.otherFiles);
      expect(cursors("thr_child")).toEqual([undefined, "100", "200", "300", "400", "401"]);
      expect(host).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("emits one actionable archive warning for two incomplete children with the same title", async () => {
    const { overview, host } = archivedTree(["thr_first", "thr_second"]);
    const partial = await overview();
    expect(partial.threads.filter((thread) => thread.archived).map((thread) => thread.title)).toEqual([
      "Worker",
      "Worker",
    ]);
    expect(partial.otherFiles.map((file) => file.path)).toEqual(["thr_first-first.ts", "thr_second-first.ts"]);
    expect(partial.warnings).toEqual([expect.stringMatching(/2 archived threads.*Refresh/)]);
    expect(host).not.toHaveBeenCalled();
  });

  it("joins a pending continuation instead of rejecting it or discarding its archive cursor", async () => {
    const { overview, list, edits, cursors, host } = archivedTree(["thr_child"]);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => (notifyStarted = resolve));
    let releaseRead!: () => void;
    const release = new Promise<void>((resolve) => (releaseRead = resolve));
    try {
      await overview();
      now.mockReturnValue(15_000);
      const original = list.getMockImplementation()!;
      list.mockImplementation(async (args) => {
        if (args.threadId === "thr_child" && args.afterSeq === "400") {
          notifyStarted();
          await release;
        }
        return original(args);
      });
      const pending = edits.get("thr_child", undefined, { settled: true });
      const result = Promise.allSettled([pending]);
      await started;
      let notifyJoined!: () => void;
      const joined = new Promise<void>((resolve) => (notifyJoined = resolve));
      const originalGet = edits.get.bind(edits);
      vi.spyOn(edits, "get").mockImplementation((...args) => {
        const read = originalGet(...args);
        if (args[0] === "thr_child") notifyJoined();
        return read;
      });
      const refresh = overview(true);
      await joined;
      releaseRead();
      const [outcome] = await result;
      expect(outcome?.status).toBe("fulfilled");
      expect((await refresh).warnings).toEqual([]);
      expect(cursors("thr_child")).toEqual([undefined, "100", "200", "300", "400"]);
      expect(host).not.toHaveBeenCalled();
    } finally {
      releaseRead();
      now.mockRestore();
    }
  });

  it("shows recorded final edits in an archived overview without calling a host", async () => {
    const rows = [edit(1)];
    const { list } = fakeSdk({ thr_1: rows });
    let archivedAt: number | null = null;
    const { sdk } = createFakeSdk({
      pluginId: "vantage",
      overrides: {
        threads: {
          get: async () => makeThreadResponse({ id: "thr_1", archivedAt, environmentId: null }),
          experimental_listDescendants: async () => ({ threads: [{ threadId: "thr_1", descendantIds: [] }] }),
          events: { list },
        },
        projects: { list: async () => [] },
        hosts: { list: async () => [] },
      },
    });
    const host = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected host call");
    });
    const deps = { sdk, host, edits: createEditIndex(sdk) };
    const input = { target: { kind: "tree", threadId: "thr_1" }, scope: "branch", includeArchived: true } as const;
    const active = await buildOverview(deps, input);
    expect(active.otherFiles.map((file) => file.path)).toEqual(["f1.ts"]);
    rows.push(edit(2));
    archivedAt = 1;
    list.mockRejectedValueOnce(new Error("event store unavailable"));
    const incomplete = await buildOverview(deps, input);
    expect(incomplete.otherFiles).toEqual(active.otherFiles);
    expect(incomplete.warnings).toEqual([
      expect.stringContaining("Recorded edits may be incomplete for 1 archived thread"),
    ]);

    const archived = await buildOverview(deps, input);
    expect(archived.threads[0]?.archived).toBe(true);
    expect(archived.otherFiles).toMatchObject([
      { path: "f1.ts", edits: { threadIds: ["thr_1"], rawPaths: ["f1.ts"] } },
      { path: "f2.ts", edits: { threadIds: ["thr_1"], rawPaths: ["f2.ts"] } },
    ]);
    expect(archived.warnings).toEqual([]);
    expect((await buildOverview(deps, input)).otherFiles).toEqual(archived.otherFiles);
    expect((await buildOverview(deps, { ...input, refresh: true })).otherFiles).toEqual(archived.otherFiles);
    expect(list.mock.calls.map(([args]) => args.afterSeq)).toEqual([undefined, "1", "1", "2"]);
    expect(host).not.toHaveBeenCalled();
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

  it("closes a commit run on a later read, and gives the last event's time only while one is open", async () => {
    const rows = [started(1, "c1", "git commit -m one")];
    const { sdk } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    expect(await index.get("thr_1")).toMatchObject({
      commitRuns: [{ id: "c1", startedAt: 1000, endedAt: null }],
      lastEventAt: 1000,
    });
    rows.push(command(2, "/work/one"));
    expect((await index.get("thr_1")).lastEventAt).toBe(2000);
    rows.push(finished(3, "c1", "git commit -m one"));
    const later = await index.get("thr_1");
    expect(later.commitRuns).toEqual([{ id: "c1", startedAt: 1000, endedAt: 3000 }]);
    expect(later.lastEventAt).toBeNull();
    rows.push(command(4, "/work/one"));
    expect(await index.get("thr_1")).toBe(later);
  });

  it("starts a commit command with no start event at the last event an earlier read saw", async () => {
    const rows = [command(1, "/work/one")];
    const { sdk } = fakeSdk({ thr_1: rows });
    const index = createEditIndex(sdk);
    await index.get("thr_1");
    rows.push(finished(6, "c1", "git commit -m one"));
    expect((await index.get("thr_1")).commitRuns).toEqual([{ id: "c1", startedAt: 1000, endedAt: 6000 }]);
  });

  it("keeps only the most recent commit runs", async () => {
    const rows = Array.from({ length: MAX_COMMIT_RUNS + 3 }, (_, i) => finished(i + 1, `c${i}`, "git commit -m x"));
    const { sdk } = fakeSdk({ thr_1: rows });
    const { commitRuns } = await createEditIndex(sdk).get("thr_1");
    expect(commitRuns).toHaveLength(MAX_COMMIT_RUNS);
    expect(commitRuns[0]?.id).toBe("c3");
  });

  it("does not keep a thread whose read failed", async () => {
    const list = vi
      .fn()
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
    const rows = Array.from({ length: 10 }, (_, index) =>
      fileChange(index + 1, [{ path: "a.ts", kind: "update", diff: `+${index}` }]),
    );
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

  it("reads completed items only", async () => {
    const { sdk, list } = fakeSdk({ thr_1: [fileChange(1, [{ path: "a.ts", kind: "update", diff: "+a" }])] });
    await findRecordedEdits(sdk, ["thr_1"], new Set(["a.ts"]), 50);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ types: ["item/completed"] });
  });

  it("skips failed and denied edits and reads every page", async () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, index) =>
        row(index + 1, { type: "agentMessage", id: `m${index}`, text: "x" }),
      ),
      fileChange(101, [{ path: "a.ts", kind: "update", diff: "+late" }]),
      fileChange(102, [{ path: "a.ts", kind: "update", diff: "+no" }], { status: "failed" }),
      fileChange(103, [{ path: "a.ts", kind: "update", diff: "+no" }], { approvalStatus: "denied" }),
    ];
    const { sdk } = fakeSdk({ thr_1: rows });
    const edits = await findRecordedEdits(sdk, ["thr_1"], new Set(["a.ts"]), 50);
    expect(edits.map((edit) => edit.diff)).toEqual(["+late"]);
  });
});
