import { describe, expect, it } from "vitest";
import { FOLD_MS, axisOf, countsAt, eventIndexAt, foldsOf, packRows } from "../src/ui/timeline-axis";

const MINUTE = 60_000;

describe("packRows", () => {
  it("gives overlapping bars their own rows and lets a later bar reuse the first free row", () => {
    const { rows, bars } = packRows([
      { id: "d", from: 20 * MINUTE, to: 30 * MINUTE },
      { id: "a", from: 0, to: 10 * MINUTE },
      { id: "b", from: MINUTE, to: 5 * MINUTE },
      { id: "c", from: 2 * MINUTE, to: 4 * MINUTE },
    ]);
    expect(rows).toBe(3);
    expect(bars.map((bar) => [bar.id, bar.row])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 0],
    ]);
  });

  it("keeps 30 seconds between two bars in one row", () => {
    const { rows, bars } = packRows([
      { from: 0, to: MINUTE },
      { from: MINUTE + 10_000, to: 2 * MINUTE },
      { from: 3 * MINUTE, to: 4 * MINUTE },
    ]);
    expect(rows).toBe(2);
    expect(bars.map((bar) => bar.row)).toEqual([0, 1, 0]);
    expect(packRows([])).toEqual({ rows: 0, bars: [] });
  });
});

describe("foldsOf", () => {
  it("folds a gap of 15 minutes or more between events, and nothing shorter", () => {
    const times = [0, MINUTE, 21 * MINUTE, 31 * MINUTE, 31 * MINUTE + FOLD_MS];
    expect(foldsOf(times)).toEqual([
      { from: MINUTE, to: 21 * MINUTE },
      { from: 31 * MINUTE, to: 31 * MINUTE + FOLD_MS },
    ]);
    expect(foldsOf([0, 10 * MINUTE])).toEqual([]);
  });
});

describe("axisOf", () => {
  const folds = [{ from: 10 * MINUTE, to: 70 * MINUTE }];
  const axis = axisOf(folds, 0, 80 * MINUTE, 416);

  it("runs from 0 to the width and gives each fold 16 pixels", () => {
    expect(axis.x(0)).toBe(0);
    expect(axis.x(80 * MINUTE)).toBe(416);
    expect(axis.x(70 * MINUTE) - axis.x(10 * MINUTE)).toBeCloseTo(16);
    expect(axis.x(10 * MINUTE)).toBeCloseTo(200);
    expect(axis.x(-MINUTE)).toBe(0);
    expect(axis.x(90 * MINUTE)).toBe(416);
  });

  it("turns a position back into its time outside the folds", () => {
    for (const time of [0, 3 * MINUTE, 10 * MINUTE, 70 * MINUTE, 75 * MINUTE + 1234, 80 * MINUTE]) expect(Math.abs(axis.at(axis.x(time)) - time)).toBeLessThanOrEqual(1);
    expect(axis.at(-5)).toBe(0);
    expect(axis.at(500)).toBe(80 * MINUTE);
  });

  it("keeps only the part of a fold inside a zoomed window", () => {
    const zoomed = axisOf(folds, 60 * MINUTE, 80 * MINUTE, 116);
    expect(zoomed.x(70 * MINUTE)).toBeCloseTo(16);
    expect(zoomed.x(80 * MINUTE)).toBe(116);
  });
});

describe("eventIndexAt", () => {
  const events: Array<[number, number]> = [
    [4, 1000],
    [9, 2000],
    [12, 3000],
  ];

  it("finds the last event at or before a time, and the first before them all", () => {
    expect(eventIndexAt(events, 500)).toBe(0);
    expect(eventIndexAt(events, 1000)).toBe(0);
    expect(eventIndexAt(events, 2500)).toBe(1);
    expect(eventIndexAt(events, 3000)).toBe(2);
    expect(eventIndexAt(events, 9000)).toBe(2);
  });
});

describe("countsAt", () => {
  it("gives the ticket counts after the last ticket event at or before a time", () => {
    const flow = [
      { at: 1000, counts: { queued: 2 } },
      { at: 2000, counts: { queued: 1, working: 1 } },
    ];
    expect(countsAt(flow, 500)).toEqual({});
    expect(countsAt(flow, 1500)).toEqual({ queued: 2 });
    expect(countsAt(flow, 2000)).toEqual({ queued: 1, working: 1 });
  });
});
