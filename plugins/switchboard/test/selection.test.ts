import { describe, expect, it } from "vitest";
import { buildGroups } from "../src/tree";
import { EMPTY_LAYOUT } from "../src/layout";
import { indexGroups } from "../src/drop-plan";
import { EMPTY_SELECTION, selectRange, selectedRuns, selectionRoots, toggleRow } from "../src/selection";
import { sidebarSection, sidebarThread } from "./fixtures";

const visible = ["a", "child", "b", "c", "d"];

describe("thread selection", () => {
  it("toggles rows on and off and updates the anchor", () => {
    const a = toggleRow(EMPTY_SELECTION, "a");
    expect([...a.ids]).toEqual(["a"]);
    expect(a.anchor).toBe("a");
    const b = toggleRow(a, "b");
    expect([...b.ids]).toEqual(["a", "b"]);
    expect(b.anchor).toBe("b");
    const removed = toggleRow(b, "b");
    expect([...removed.ids]).toEqual(["a"]);
    expect(removed.anchor).toBe("a");
    expect(toggleRow(removed, "a")).toEqual(EMPTY_SELECTION);
  });

  it("selects ranges in either direction and across groups", () => {
    const forward = selectRange(toggleRow(EMPTY_SELECTION, "a"), visible, "c");
    expect([...forward.ids]).toEqual(["a", "child", "b", "c"]);
    expect(forward.anchor).toBe("a");
    const backward = selectRange(toggleRow(EMPTY_SELECTION, "d"), visible, "child");
    expect(backward.ids).toEqual(new Set(["child", "b", "c", "d"]));
    expect(selectRange(EMPTY_SELECTION, visible, "b").ids.has("b")).toBe(true);
  });

  it("joins consecutive selected rows only within the same visible group", () => {
    const runs = selectedRuns([["a", "b", "c", "d"], ["e", "f"], ["g"], ["h", "i", "j"]],
      new Set(["a", "b", "c", "e", "f", "g", "h", "j"]));
    expect([...runs]).toEqual([["a", "start"], ["b", "middle"], ["c", "end"],
      ["e", "start"], ["f", "end"]]);
  });

  it("returns visual roots and drops selected descendants", () => {
    const index = indexGroups(buildGroups({
      layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Section")], threads: [
        sidebarThread({ id: "a", sectionId: "s", createdAt: 10 }),
        sidebarThread({ id: "child", parentThreadId: "a", createdAt: 11 }),
        sidebarThread({ id: "b", sectionId: "s", createdAt: 9 }),
        sidebarThread({ id: "c", createdAt: 8 }),
      ],
    }));
    expect(selectionRoots({ ids: new Set(["c", "child", "a"]), anchor: "a" }, index)).toEqual(["a", "c"]);
  });
});
