import { afterEach, describe, expect, it } from "vitest";
import { activityAxis, FOLD_PX, labelsOf, stepAt, stepMax } from "../src/ui/insights-axis";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 9);
const at = (minutes: number) => T0 + minutes * MIN;

describe("activityAxis", () => {
  it("covers every event with equal buckets across the width", () => {
    const times = [0, 3, 17, 41, 58].map(at);
    const axis = activityAxis(times, at(0), at(58), 600);
    expect(axis.folds).toEqual([]);
    for (const time of times) expect(axis.buckets.some((bucket) => time >= bucket.from && time < bucket.to)).toBe(true);
    const widths = new Set(axis.buckets.map((bucket) => bucket.w.toFixed(6)));
    expect(widths.size).toBe(1);
    const last = axis.buckets.at(-1)!;
    expect(last.x + last.w).toBeCloseTo(600);
    expect(axis.buckets.every((bucket, index) => index === 0 || bucket.from === axis.buckets[index - 1]!.to)).toBe(true);
  });

  it("folds a long quiet stretch to a narrow gap and keeps x in order", () => {
    const times = [0, 5, 10, 300, 310].map(at);
    const axis = activityAxis(times, at(0), at(310), 600);
    expect(axis.folds).toHaveLength(1);
    expect(axis.folds[0]!.w).toBe(FOLD_PX);
    expect(axis.folds[0]!.from).toBeLessThanOrEqual(at(300));
    expect(axis.folds[0]!.to).toBeGreaterThanOrEqual(at(10));
    const xs = [0, 5, 10, 150, 300, 310].map((minutes) => axis.x(at(minutes)));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(axis.x(at(150))).toBeCloseTo(axis.folds[0]!.x + FOLD_PX / 2);
  });

  it("picks bigger buckets for a longer project, so the bars stay readable", () => {
    const hour = activityAxis([0, 60].map(at), at(0), at(60), 600);
    const day = activityAxis(Array.from({ length: 49 }, (_, index) => at(index * 30)), at(0), at(24 * 60), 600);
    expect(day.bucket).toBeGreaterThan(hour.bucket);
    expect(day.buckets.length).toBeLessThanOrEqual(64);
  });

  it("starts buckets on round minutes of the local clock", () => {
    const axis = activityAxis([at(3), at(47)], at(3), at(47), 600);
    const offset = new Date(axis.buckets[0]!.from).getTimezoneOffset() * MIN;
    expect((axis.buckets[0]!.from - offset) % axis.bucket).toBe(0);
  });
});

describe("labelsOf", () => {
  it("labels the start of each stretch and round times, without overlapping each other or the folds", () => {
    const axis = activityAxis([0, 20, 40, 60, 400, 420].map(at), at(0), at(420), 640);
    const labels = labelsOf(axis, 640, () => 60);
    expect(labels[0]!.date).toBe(true);
    expect(labels.some((label) => label.at >= axis.folds[0]!.to)).toBe(true);
    for (const [index, label] of labels.entries()) {
      if (index > 0) expect(label.x).toBeGreaterThanOrEqual(labels[index - 1]!.x + 60);
      expect(label.x + 60).toBeLessThanOrEqual(640);
      for (const fold of axis.folds) expect(label.x + 60 <= fold.x || label.x >= fold.x + fold.w).toBe(true);
    }
  });
});

describe("the local clock", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const every = (from: number, stepMinutes: number, days: number) => Array.from({ length: Math.floor((days * 24 * 60) / stepMinutes) + 1 }, (_, index) => from + index * stepMinutes * MIN);

  it("keeps every bucket inside the width across a daylight saving change, each starting on the local hour", () => {
    for (const [tz, from] of [
      ["America/New_York", Date.UTC(2026, 9, 30, 12)],
      ["America/New_York", Date.UTC(2026, 2, 5, 12)],
      ["Australia/Lord_Howe", Date.UTC(2026, 3, 1, 12)],
    ] as const) {
      process.env.TZ = tz;
      const times = every(from, 90, 6);
      const axis = activityAxis(times, times[0]!, times.at(-1)!, 640);
      const last = axis.buckets.at(-1)!;
      expect(last.x + last.w, tz).toBeCloseTo(640);
      expect(axis.buckets.every((bucket) => new Date(bucket.from).getMinutes() === 0), tz).toBe(true);
      expect(axis.buckets.every((bucket, index) => index === 0 || bucket.from === axis.buckets[index - 1]!.to), tz).toBe(true);
      for (const time of times) expect(axis.buckets.some((bucket) => time >= bucket.from && time < bucket.to), tz).toBe(true);
    }
  });

  it("dates a label whenever the local day changes, and puts day labels on local midnight", () => {
    process.env.TZ = "America/New_York";
    const times = every(Date.UTC(2026, 9, 20, 4), 6 * 60, 30);
    const axis = activityAxis(times, times[0]!, times.at(-1)!, 800);
    const labels = labelsOf(axis, 800, (_, date) => (date ? 110 : 50));
    expect(labels.length).toBeGreaterThan(2);
    for (const [index, label] of labels.entries()) {
      const day = new Date(label.at).toDateString();
      expect(label.date).toBe(index === 0 || new Date(labels[index - 1]!.at).toDateString() !== day);
      if (index > 0 && axis.bucket >= 24 * 60 * MIN) expect(new Date(label.at).getHours()).toBe(0);
    }
    expect(labels.filter((label) => label.date).length).toBeGreaterThan(1);
  });

  it("keeps two-hour buckets on the local grid after a spring-forward gap, and labels the days after it", () => {
    process.env.TZ = "America/New_York";
    const times = every(Date.UTC(2026, 2, 6, 12), 20, 4);
    const axis = activityAxis(times, times[0]!, times.at(-1)!, 1200);
    expect(axis.bucket).toBe(120 * MIN);
    const offGrid = axis.buckets.filter((bucket) => new Date(bucket.from).getHours() % 2 === 1);
    expect(offGrid.length).toBeLessThanOrEqual(1);
    const labels = labelsOf(axis, 1200, (_, date) => (date ? 110 : 50));
    expect(new Set(labels.map((label) => new Date(label.at).toDateString())).size).toBeGreaterThanOrEqual(4);
    const last = axis.buckets.at(-1)!;
    expect(last.x + last.w).toBeCloseTo(1200);
  });

  it("always labels the first bucket, even beside a fold", () => {
    const fold = activityAxis([0, 2, 300, 302].map(at), at(0), at(302), 400);
    expect(fold.folds).toHaveLength(1);
    expect(labelsOf(fold, 400, () => 120)[0]).toMatchObject({ x: 0, at: fold.buckets[0]!.from, date: true });
  });

  it("always labels the first bucket", () => {
    const axis = activityAxis([at(0), at(1)], at(0), at(1), 280);
    expect(labelsOf(axis, 280, () => 400)).toEqual([{ x: 0, at: axis.buckets[0]!.from, date: true }]);
  });
});

describe("stepAt and stepMax", () => {
  const steps: Array<[number, number]> = [
    [10, 1],
    [20, 3],
    [30, 0],
  ];
  it("reads a step function at a time and its largest value over a stretch", () => {
    expect(stepAt(steps, 5)).toBe(0);
    expect(stepAt(steps, 20)).toBe(3);
    expect(stepAt(steps, 40)).toBe(0);
    expect(stepMax(steps, 12, 25)).toBe(3);
    expect(stepMax(steps, 31, 40)).toBe(0);
    expect(stepMax(steps, 15, 19)).toBe(1);
  });
});
