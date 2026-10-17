import { describe, expect, it } from "vitest";
import { applyDelta, childRowsOf, prependOlderRows, spliceLatestWindow } from "../src/merge";
import type { TimelineRow } from "../src/types";
import { assistantRow, commandRow, delegationRow, timelineResponse, turnRow, userRow } from "./fixtures";

describe("prependOlderRows", () => {
  it("preserves server order and skips duplicate ids in either page", () => {
    const older = userRow("old");
    const sharedOld = commandRow("shared", { output: "old" });
    const sharedNew = commandRow("shared", { output: "new" });
    const duplicateNew = commandRow("shared", { output: "duplicate" });
    const latest = assistantRow("latest");

    expect(prependOlderRows([older, older, sharedOld], [sharedNew, duplicateNew, latest])).toEqual([
      older, sharedNew, latest,
    ]);
  });

  it("joins split turn and delegation children recursively, older-only first", () => {
    const a = commandRow("a");
    const bOld = commandRow("b", { output: "old" });
    const bNew = commandRow("b", { output: "new" });
    const c = commandRow("c");
    const older = turnRow("turn", {
      children: [delegationRow("delegate", { childRows: [a, bOld] })],
    });
    const newer = turnRow("turn", {
      children: [delegationRow("delegate", { childRows: [bNew, c] })],
    });

    const [joined] = prependOlderRows([older], [newer]);
    expect(childRowsOf(joined!)).toHaveLength(1);
    const children = childRowsOf(childRowsOf(joined!)![0]!)!;
    expect(children).toEqual([a, bNew, c]);
  });

  it("returns the newer object when no older child is added", () => {
    const child = commandRow("child");
    const older = turnRow("turn", { children: [child] });
    const newer = turnRow("turn", { children: [child] });
    expect(prependOlderRows([older], [newer])[0]).toBe(newer);

    const delegationOlder = delegationRow("delegate", { childRows: [child] });
    const delegationNewer = delegationRow("delegate", { childRows: [child] });
    expect(prependOlderRows([delegationOlder], [delegationNewer])[0]).toBe(delegationNewer);
    expect(childRowsOf(child)).toBeNull();
  });
});

describe("applyDelta", () => {
  it("upserts changed rows and obeys the server's row order, not sequence sorting", () => {
    const first = userRow("first");
    const old = commandRow("tool", { output: "old" });
    const latest = commandRow("tool", { output: "new" });
    const next = assistantRow("next");

    expect(applyDelta([first, old], {
      upsertRows: [latest, next],
      rowOrder: ["tool", "first", "next"],
    })).toEqual([latest, first, next]);
  });

  it("returns null for an id in rowOrder not supplied by the last window or upserts", () => {
    expect(applyDelta([userRow("known")], {
      upsertRows: [],
      rowOrder: ["known", "missing"],
    })).toBeNull();
  });

  it("keeps the array identity for an empty or unchanged delta", () => {
    const rows: TimelineRow[] = [userRow("known")];
    expect(applyDelta(rows, { upsertRows: [] })).toBe(rows);
    expect(applyDelta(rows, { upsertRows: [rows[0]!] })).toBe(rows);
  });
});

describe("spliceLatestWindow", () => {
  it("keeps the loaded prefix, applies older updates and joins the latest window", () => {
    const first = userRow("first");
    const oldChild = commandRow("old-child");
    const prefix = turnRow("prefix", { children: [oldChild] });
    const prefixUpdate = turnRow("prefix", { children: [commandRow("new-child")] });
    const oldWindow = commandRow("shared", { output: "old" });
    const newWindow = commandRow("shared", { output: "new" });
    const page = timelineResponse([], {
      timelinePage: {
        historySnapshot: "snapshot-1",
        olderCursor: { anchorId: "prefix", anchorSeq: 10 },
        olderRowsSourceSeqEnd: 10,
        returnedSegmentCount: 1,
        olderRowUpdates: [prefixUpdate],
      },
    }).timelinePage;

    const next = spliceLatestWindow([first, prefix, oldWindow], [newWindow, assistantRow("new")], page);
    expect(next?.map((row) => row.id)).toEqual(["first", "prefix", "shared", "new"]);
    expect(childRowsOf(next![1]!)).toEqual([oldChild, prefixUpdate.children![0]]);
    expect(next![2]).toBe(newWindow);
  });

  it("returns null if the first window row is unknown", () => {
    const page = timelineResponse([], {
      timelinePage: {
        historySnapshot: "snapshot-1",
        olderCursor: { anchorId: "old", anchorSeq: 10 },
        olderRowsSourceSeqEnd: 10,
        returnedSegmentCount: 1,
      },
    }).timelinePage;
    expect(spliceLatestWindow([userRow("old")], [assistantRow("missing")], page)).toBeNull();
  });

  it("uses only the window when there is no older cursor", () => {
    const only = assistantRow("only");
    expect(spliceLatestWindow([userRow("old")], [only], timelineResponse([only]).timelinePage)).toEqual([only]);
  });

  it("returns the prior array if no row references changed", () => {
    const prefix = userRow("prefix");
    const window = commandRow("window");
    const loaded: TimelineRow[] = [prefix, window];
    const page = timelineResponse([], {
      timelinePage: {
        historySnapshot: "snapshot-1",
        olderCursor: { anchorId: "prefix", anchorSeq: 10 },
        olderRowsSourceSeqEnd: 10,
        returnedSegmentCount: 1,
      },
    }).timelinePage;
    expect(spliceLatestWindow(loaded, [window], page)).toBe(loaded);
  });
});
