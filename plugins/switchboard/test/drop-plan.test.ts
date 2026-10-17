import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT } from "../src/layout";
import { buildGroups } from "../src/tree";
import { indexGroups, planDrop, planKeyboardMove } from "../src/drop-plan";
import { sidebarSection, sidebarThread } from "./fixtures";

function fixture() {
  const threads = [
    sidebarThread({ id: "pin", displayTitle: "Pinned", isPinned: true, pinnedAt: 10 }),
    sidebarThread({ id: "a", displayTitle: "A", sectionId: "s", createdAt: 5 }),
    sidebarThread({ id: "b", displayTitle: "B", sectionId: "s", createdAt: 4 }),
    sidebarThread({ id: "c", displayTitle: "C", sectionId: "s", parentThreadId: "b", createdAt: 3 }),
    sidebarThread({ id: "d", displayTitle: "D", createdAt: 2 }),
  ];
  return indexGroups(buildGroups({ threads, sections: [sidebarSection("s", "Section")], layout: EMPTY_LAYOUT }));
}
const row = (threadId: string, kind: "above" | "below" | "child" = "child") =>
  ({ kind: "row" as const, threadId, instruction: { kind } });

 describe("drop planning", () => {
  it("indexes parents, heights, visual order and containers", () => {
    const index = fixture();
    expect(index.visualIds).toEqual(["pin", "a", "b", "c", "d"]);
    expect(index.byId.get("b")).toMatchObject({ parentId: null, depth: 1, height: 2, groupKey: "section:s", container: "section:s", siblings: ["a", "b"] });
    expect(index.byId.get("c")).toMatchObject({ parentId: "b", depth: 2, height: 1, container: "parent:b", siblings: ["c"] });
  });

  it("nests a thread, expands the parent and writes full source and destination lists", () => {
    expect(planDrop(fixture(), ["a"], row("b"))).toMatchObject({
      ok: true, writes: [{ kind: "update", threadId: "a", parentThreadId: "b" }],
      orders: [{ container: "section:s", ids: ["b"] }, { container: "parent:b", ids: ["c", "a"] }],
      expand: ["thread:b"], moves: [{ threadId: "a", fromParent: null, toParent: "b" }],
    });
  });

  it("reorders above and below siblings, skipping a dragged descendant and retaining visual order", () => {
    expect(planDrop(fixture(), ["b", "c"], row("a", "below"))).toEqual({ ok: "noop" });
    expect(planDrop(fixture(), ["a"], row("b", "below"))).toMatchObject({
      ok: true, writes: [], orders: [{ container: "section:s", ids: ["b", "a"] }],
    });
    expect(planDrop(fixture(), ["d", "a"], { kind: "group", key: "section:s" })).toMatchObject({
      ok: true, writes: [{ kind: "update", threadId: "d", sectionId: "s" }],
      orders: [{ container: "section:s", ids: ["a", "d", "b"] }, { container: "loose", ids: [] }],
    });
  });

  it("moves a child out to the section and files root drops in Threads", () => {
    expect(planDrop(fixture(), ["c"], { kind: "row", threadId: "c", instruction: { kind: "out", level: 0 } })).toEqual({ ok: "noop" });
    expect(planDrop(fixture(), ["c"], { kind: "row", threadId: "a", instruction: { kind: "below" } })).toMatchObject({
      ok: true, writes: [{ kind: "update", threadId: "c", parentThreadId: null }],
      orders: [{ container: "parent:b", ids: [] }, { container: "section:s", ids: ["a", "c", "b"] }],
    });
    expect(planDrop(fixture(), ["a"], { kind: "group", key: "loose" })).toMatchObject({
      ok: true, writes: [{ kind: "update", threadId: "a", sectionId: null }],
      orders: [{ container: "section:s", ids: ["b"] }, { container: "loose", ids: ["a", "d"] }],
    });
  });

  it("pins at the top, unpins when nesting and uses pinned neighbours for reordering", () => {
    expect(planDrop(fixture(), ["a"], { kind: "group", key: "pinned" })).toMatchObject({
      ok: true, writes: [{ kind: "pin", threadId: "a" },
        { kind: "reorderPinned", threadId: "a", previousThreadId: null, nextThreadId: "pin" }],
      orders: [{ container: "section:s", ids: ["b"] }],
    });
    expect(planDrop(fixture(), ["pin"], row("b"))).toMatchObject({
      ok: true, writes: [{ kind: "update", threadId: "pin", parentThreadId: "b" }, { kind: "unpin", threadId: "pin" }],
    });
    expect(planDrop(fixture(), ["pin"], { kind: "group", key: "section:s" })).toMatchObject({
      ok: true, writes: [{ kind: "update", threadId: "pin", sectionId: "s" }, { kind: "unpin", threadId: "pin" }],
    });
  });

  it("allows pinning even when Pinned is not yet displayed", () => {
    const emptyPinned = indexGroups(buildGroups({ layout: EMPTY_LAYOUT, sections: [], threads: [
      sidebarThread({ id: "a", displayTitle: "A" }),
    ] }));
    expect(planDrop(emptyPinned, ["a"], { kind: "group", key: "pinned" })).toMatchObject({
      ok: true, writes: [{ kind: "pin", threadId: "a" },
        { kind: "reorderPinned", threadId: "a", previousThreadId: null, nextThreadId: null }],
    });
  });

  it("refuses cycles and moves deeper than four levels without writing", () => {
    expect(planDrop(fixture(), ["b"], row("c"))).toEqual({ ok: false, reason: "Can't move a thread inside itself" });
    const chain = indexGroups(buildGroups({ threads: [
      sidebarThread({ id: "one" }), sidebarThread({ id: "two", parentThreadId: "one" }),
      sidebarThread({ id: "three", parentThreadId: "two" }), sidebarThread({ id: "four", parentThreadId: "three" }),
      sidebarThread({ id: "free" }),
    ], sections: [], layout: EMPTY_LAYOUT }));
    expect(planDrop(chain, ["free"], row("four"))).toEqual({ ok: false, reason: "bb allows 4 levels of threads" });
    expect(planDrop(chain, ["one"], row("free"))).toEqual({ ok: false, reason: "bb allows 4 levels of threads" });
  });

  it("refuses sorted root reordering but permits nesting and header moves", () => {
    const groups = buildGroups({ threads: [
      sidebarThread({ id: "a", sectionId: "s", createdAt: 5 }),
      sidebarThread({ id: "b", sectionId: "s", createdAt: 4 }),
      sidebarThread({ id: "child", parentThreadId: "b", createdAt: 3 }),
      sidebarThread({ id: "loose", createdAt: 2 }),
    ], sections: [sidebarSection("s", "Section")], layout: EMPTY_LAYOUT });
    for (const mode of ["recent", "status"] as const) {
      const index = indexGroups(groups, { "section:s": mode });
      const reason = mode === "recent" ? "Sorted by recent activity" : "Sorted by status";
      expect(planDrop(index, ["a"], row("b", "below"))).toEqual({ ok: false, reason });
      expect(planDrop(index, ["loose"], row("b", "above"))).toEqual({ ok: false, reason });
      expect(planKeyboardMove(index, "b", "up")).toEqual({ ok: false, reason });
      expect(planDrop(index, ["child"], row("a", "below"))).toEqual({ ok: false, reason });
      expect(planDrop(index, ["loose"], row("b"))).toMatchObject({ ok: true });
      expect(planDrop(index, ["loose"], { kind: "group", key: "section:s" })).toMatchObject({ ok: true });
    }
  });

  it("maps Alt+arrows to sibling, child and parent moves and ignores edges", () => {
    const index = fixture();
    expect(planKeyboardMove(index, "a", "up")).toEqual({ ok: "noop" });
    expect(planKeyboardMove(index, "b", "down")).toEqual({ ok: "noop" });
    expect(planKeyboardMove(index, "b", "right")).toMatchObject({ ok: true, writes: [{ kind: "update", threadId: "b", parentThreadId: "a" }] });
    expect(planKeyboardMove(index, "c", "left")).toMatchObject({ ok: true, writes: [{ kind: "update", threadId: "c", parentThreadId: null }] });
    expect(planKeyboardMove(index, "a", "left")).toEqual({ ok: "noop" });
    expect(planKeyboardMove(index, "b", "up")).toMatchObject({ ok: true, orders: [{ container: "section:s", ids: ["b", "a"] }] });
  });
});
