import { describe, expect, it } from "vitest";
import {
  LATEST_WINDOW, holdWindow, resolveRange, rowsAfter, windowAround, windowDown, windowUp, windowWith,
  type RenderWindow,
} from "../src/window";

const all = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}` }));
const order = new Map(all.map((row, index) => [row.id, index]));
const evens = all.filter((_, index) => index % 2 === 0);
const held = (startId: string, endId: string | null = null): RenderWindow => ({ startId, endId, count: null });

describe("render window", () => {
  it("draws the newest page, or `count` rows, up to the newest row", () => {
    expect(resolveRange(LATEST_WINDOW, all, order, 10, 40)).toEqual({ start: 20, end: 30 });
    expect(resolveRange({ ...LATEST_WINDOW, count: 25 }, all, order, 10, 40)).toEqual({ start: 5, end: 30 });
    expect(resolveRange({ ...LATEST_WINDOW, count: 25 }, all, order, 10, 20)).toEqual({ start: 10, end: 30 });
    expect(resolveRange(LATEST_WINDOW, [], order, 10, 40)).toEqual({ start: 0, end: 0 });
  });

  it("holds its edges by entry, through filters that hide the edge rows and rows that arrive", () => {
    expect(resolveRange(held("r12"), all, order, 10, 40)).toEqual({ start: 12, end: 30 });
    expect(resolveRange(held("r12", "r17"), all, order, 10, 40)).toEqual({ start: 12, end: 18 });
    // r13 and r17 are hidden, so the window starts at r14 and ends at r16.
    expect(resolveRange(held("r13", "r17"), evens, order, 10, 40)).toEqual({ start: 7, end: 9 });
    expect(resolveRange(held("r2"), all, order, 10, 15)).toEqual({ start: 2, end: 17 });
    // A window whose rows the filter hides entirely shows the page around where it was.
    expect(resolveRange(held("r13", "r13"), evens, order, 4, 40)).toEqual({ start: 5, end: 9 });
    // A window from a reloaded history falls back to the newest page.
    expect(resolveRange(held("gone", "gone"), all, order, 10, 40)).toEqual({ start: 20, end: 30 });
  });

  it("holds the drawn rows when follow pauses, so new rows add to the end", () => {
    const window = holdWindow({ start: 20, end: 30 }, all);
    expect(window).toEqual(held("r20"));
    const more = [...all, { id: "r30" }];
    expect(resolveRange(window, more, new Map(more.map((row, index) => [row.id, index])), 10, 40)).toEqual({ start: 20, end: 31 });
  });

  it("grows a page up or down and drops rows from the far end past the limit", () => {
    expect(windowUp(held("r20"), { start: 20, end: 30 }, all, 10, 40)).toEqual(held("r10"));
    expect(windowUp(held("r10"), { start: 10, end: 30 }, all, 10, 15)).toEqual(held("r0", "r14"));
    expect(windowUp(held("r0"), { start: 0, end: 30 }, all, 10, 40)).toBeNull();
    expect(windowUp(LATEST_WINDOW, { start: 20, end: 30 }, all, 10, 40)).toEqual({ ...LATEST_WINDOW, count: 20 });
    expect(windowUp({ ...LATEST_WINDOW, count: 15 }, { start: 15, end: 30 }, all, 10, 15)).toBeNull();
    expect(windowDown({ start: 0, end: 10 }, all, 10, 40)).toEqual(held("r0", "r19"));
    expect(windowDown({ start: 0, end: 25 }, all, 10, 40)).toEqual(held("r0"));
    expect(windowDown({ start: 0, end: 20 }, all, 10, 15)).toEqual(held("r15"));
    expect(windowDown({ start: 20, end: 30 }, all, 10, 40)).toBeNull();
  });

  it("reaches a row next to the drawn ones by a page, and a far one with a page around it", () => {
    const range = { start: 10, end: 20 };
    expect(windowWith(15, held("r10", "r19"), range, all, 10, 40)).toBeNull();
    expect(windowWith(9, held("r10", "r19"), range, all, 10, 40)).toEqual(held("r0", "r19"));
    expect(windowWith(20, held("r10", "r19"), range, all, 10, 40)).toEqual(held("r10"));
    expect(windowWith(0, held("r20"), { start: 20, end: 30 }, all, 10, 40)).toEqual(held("r0", "r9"));
    expect(windowAround(28, all, 10)).toEqual(held("r20"));
    expect(windowAround(14, all, 10)).toEqual(held("r9", "r18"));
  });

  it("counts the visible rows after an entry, hidden or not", () => {
    expect(rowsAfter(all, order, "r27")).toBe(2);
    expect(rowsAfter(evens, order, "r25")).toBe(2);
    expect(rowsAfter(all, order, "gone")).toBe(0);
  });
});
