import { afterEach, describe, expect, it } from "vitest";
import type { TicketBar } from "../src/replay";
import { FOLD_MS, axisOf, foldsOf, lastIndexAt, nearestIndex, stateAt, ticksOf } from "../src/ui/timeline-axis";

const MINUTE = 60_000;

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

  it("narrows the folds when there are too many for 16 pixels each, so every time stays inside the width", () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ from: (index * 2 + 1) * 20 * MINUTE, to: (index * 2 + 2) * 20 * MINUTE }));
    const end = 101 * 20 * MINUTE;
    const wide = axisOf(many, 0, end, 720);
    for (const fold of many) expect(wide.x(fold.to)).toBeLessThanOrEqual(720);
    expect(wide.x(many.at(-1)!.to)).toBeLessThan(720);
    expect(wide.x(many[0]!.to) - wide.x(many[0]!.from)).toBeCloseTo((0.4 * 720) / 50);
    expect(wide.scale).toBeGreaterThan(0);
    const narrow = axisOf(many.slice(0, 20), 0, 41 * 20 * MINUTE, 250);
    expect(narrow.x(many[19]!.to)).toBeLessThan(250);
  });

  it("keeps only the part of a fold inside a zoomed window", () => {
    const zoomed = axisOf(folds, 60 * MINUTE, 80 * MINUTE, 116);
    expect(zoomed.x(70 * MINUTE)).toBeCloseTo(16);
    expect(zoomed.x(80 * MINUTE)).toBe(116);
  });
});

describe("ticksOf across a daylight saving change", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  const twelveHourly = (start: number, end: number) => ticksOf([], start, end, axisOf([], start, end, 800), 800, { startRoom: 0, endRoom: 0, gap: 0 }).map((tick) => new Date(tick.at));

  it("keeps round labels on local round hours after the clocks go back", () => {
    process.env.TZ = "America/New_York";
    const ticks = twelveHourly(new Date(2026, 9, 30, 0, 0).getTime(), new Date(2026, 10, 3, 0, 0).getTime());
    expect(ticks.length).toBeGreaterThan(4);
    for (const local of ticks) {
      expect(local.getMinutes()).toBe(0);
      expect(local.getHours() % 12).toBe(0);
    }
  });

  it("skips no label when the clocks go forward", () => {
    process.env.TZ = "America/New_York";
    const ticks = twelveHourly(new Date(2026, 2, 6, 6, 0).getTime(), new Date(2026, 2, 10, 6, 0).getTime());
    expect(ticks.map((local) => `${local.getDate()} ${local.getHours()}`)).toEqual(["6 12", "7 0", "7 12", "8 0", "8 12", "9 0", "9 12", "10 0"]);
  });
});

describe("lastIndexAt and nearestIndex", () => {
  const times = [1000, 2000, 3000];

  it("finds the last value at or below a value, and the first below them all", () => {
    expect(lastIndexAt(times, 500)).toBe(0);
    expect(lastIndexAt(times, 1000)).toBe(0);
    expect(lastIndexAt(times, 2500)).toBe(1);
    expect(lastIndexAt(times, 3000)).toBe(2);
    expect(lastIndexAt(times, 9000)).toBe(2);
  });

  it("finds the nearest value either side, and nothing in an empty list", () => {
    expect(nearestIndex(times, 0)).toBe(0);
    expect(nearestIndex(times, 1400)).toBe(0);
    expect(nearestIndex(times, 1600)).toBe(1);
    expect(nearestIndex(times, 2900)).toBe(2);
    expect(nearestIndex(times, 9000)).toBe(2);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe("stateAt", () => {
  const bar: TicketBar = {
    key: "CSV-1",
    title: "Order rows",
    from: 10 * MINUTE,
    to: 40 * MINUTE,
    parts: [
      { from: 10 * MINUTE, to: 20 * MINUTE, state: "working" },
      { from: 20 * MINUTE, to: 30 * MINUTE, state: "review" },
      { from: 30 * MINUTE, to: 40 * MINUTE, state: "merging" },
    ],
    sentBack: [],
    final: "done",
  };

  it("is queued before the first start, the part's state inside it, and how it finished after", () => {
    expect(stateAt(bar, 0)).toBe("queued");
    expect(stateAt(bar, 10 * MINUTE)).toBe("working");
    expect(stateAt(bar, 25 * MINUTE)).toBe("review");
    expect(stateAt(bar, 40 * MINUTE)).toBe("done");
    expect(stateAt(bar, Infinity)).toBe("done");
    expect(stateAt({ ...bar, final: null }, Infinity)).toBe("merging");
  });
});

describe("ticksOf", () => {
  it("labels where work resumed after an hour-long fold, then round times that keep their distance", () => {
    const start = new Date(2026, 9, 22, 9, 3).getTime();
    const resumed = new Date(2026, 9, 22, 13, 17).getTime();
    const end = resumed + 2 * 60 * MINUTE;
    const folds = [{ from: start + 50 * MINUTE, to: resumed }];
    const axis = axisOf(folds, start, end, 800);
    const ticks = ticksOf(folds, start, end, axis, 800);
    expect(ticks.find((tick) => tick.resume)?.at).toBe(resumed);
    expect(ticks.every((tick) => tick.x >= 130 && tick.x <= 720)).toBe(true);
    for (let index = 1; index < ticks.length; index += 1) expect(ticks[index]!.x - ticks[index - 1]!.x).toBeGreaterThanOrEqual(76);
    const round = ticks.filter((tick) => !tick.resume);
    expect(round.length).toBeGreaterThan(0);
    expect(round.every((tick) => new Date(tick.at).getMinutes() % 15 === 0)).toBe(true);
    expect(round.every((tick) => tick.at <= folds[0]!.from - 4 * MINUTE || tick.at >= folds[0]!.to + 4 * MINUTE)).toBe(true);
  });
});
