import { describe, expect, it } from "vitest";
import { buildQuestGraph, gutterLayout, trailLayout, type MapStep } from "../../../src/ui/kit/quest-map-layout";

type Point = [number, number];
const step = (id: string, dependsOn: string[] = [], fields: Partial<MapStep> = {}): MapStep => ({ id, dependsOn, actor: "agent", state: "todo", ...fields });
const fieldNotes = [
  step("w1"), step("w2"), step("w3"), step("w4", ["w1", "w3"]), step("w5", ["w3"]),
  step("w6", ["w5"]), step("w7", ["w2"]), step("w8", ["w2"]), step("w10", ["w7", "w8"]),
  step("w11", ["w4", "w5"]), step("w12"), step("w13", ["w1", "w16"]), step("w14", ["w10"]),
  step("w15"), step("w16", ["w1", "w2"]), step("w17", ["w16"]), step("w18", ["w16"]),
];
const sizes = new Map(fieldNotes.map((w, i) => [w.id, 64 + (i % 7) * 27]));

function samples(path: string): Point[] {
  const points: Point[] = [];
  let previous: Point = [0, 0];
  for (const [_, command, values] of path.matchAll(/([MCHV])([^MCHV]+)/g)) {
    const [a, b, c, d, e, f] = values!.trim().split(/\s+/).map(Number) as [number, number, number, number, number, number];
    const [x, y] = previous;
    const end: Point = command === "C" ? [e, f] : command === "H" ? [a, y] : command === "V" ? [x, a] : [a, b];
    for (let i = 1; i < 30 && command !== "M"; i++) {
      const t = i / 30, s = 1 - t;
      points.push(command === "C"
        ? [s ** 3 * x + 3 * s ** 2 * t * a + 3 * s * t ** 2 * c + t ** 3 * e, s ** 3 * y + 3 * s ** 2 * t * b + 3 * s * t ** 2 * d + t ** 3 * f]
        : [x + t * (end[0] - x), y + t * (end[1] - y)]);
    }
    points.push(end);
    previous = end;
  }
  return points;
}

function expectClear(layout: ReturnType<typeof gutterLayout>) {
  for (const road of layout.roads) for (const [id, box] of layout.cards) {
    const enters = samples(road.path).some(([x, y]) => x > box.x + .01 && x < box.x + box.width - .01 && y > box.y && y < box.y + box.height);
    expect(enters, `${road.from} → ${road.to} crosses card ${id}`).toBe(false);
  }
}

function crosses(a: Point[], b: Point[]) {
  const side = ([x, y]: Point, [u, v]: Point, [p, q]: Point) => (u - x) * (q - y) - (v - y) * (p - x);
  return a.slice(1).some((end, i) => b.slice(1).some((otherEnd, j) => {
    const start = a[i]!, otherStart = b[j]!;
    return side(start, end, otherStart) * side(start, end, otherEnd) < 0 &&
      side(otherStart, otherEnd, start) * side(otherStart, otherEnd, end) < 0;
  }));
}

describe("the quest map layout", () => {
  it("routes the 17-waypoint field-notes shape without crossing another road or entering a card", () => {
    const layout = gutterLayout(buildQuestGraph(fieldNotes), sizes, 1400);
    expect(layout.cards.size).toBe(17);
    expect(layout.roads).toHaveLength(17);
    expectClear(layout);
    const roads = layout.roads.map(road => ({ ...road, points: samples(road.path) }));
    for (const [i, a] of roads.entries()) for (const b of roads.slice(i + 1)) {
      if ([a.from, a.to].some(id => id === b.from || id === b.to)) continue;
      expect(crosses(a.points, b.points), `${a.from} → ${a.to} crosses ${b.from} → ${b.to}`).toBe(false);
    }
    const skip = layout.roads.find(r => r.from === "w1" && r.to === "w13")!;
    expect(skip.path).toMatch(/H/);
    const fan = layout.roads.filter(r => r.from === "w1");
    expect(new Set(fan.map(r => samples(r.path)[0]!.join(","))).size).toBe(1);
  });

  it("computes the full width required for a deep graph without squeezing cards", () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(`w${i}`, i ? [`w${i - 1}`] : []));
    const layout = gutterLayout(buildQuestGraph(steps), new Map(), 640);
    expect([...layout.cards.keys()]).toEqual(steps.map(w => w.id));
    expect(layout.width).toBeGreaterThan(640);
    expectClear(layout);
  });

  it("raises your move as soon as its dependencies allow and keeps phone loops away from content", () => {
    const steps = [step("root", [], { state: "verified" }), step("work", ["root"]), step("you", ["root"], { actor: "user" }), step("merge", ["work", "you"])];
    const layout = trailLayout(buildQuestGraph(steps), new Map(), 390);
    expect([...layout.cards.keys()]).toEqual(["root", "you", "work", "merge"]);
    expect(layout.width).toBe(390);
    expect(layout.roads.some(road => road.path.includes("C"))).toBe(true);
    expect(layout.roads.some(road => !road.path.includes("C"))).toBe(true);
    expectClear(layout);
    expectClear(trailLayout(buildQuestGraph(fieldNotes), sizes, 390));
  });

  it("lights the longest unfinished chain and uses the starting step to break ties", () => {
    const steps = [step("done", [], { state: "verified" }), step("waiting", ["done"], { state: "doing" }), step("wait-end", ["waiting"]),
      step("blocked", [], { state: "blocked" }), step("block-end", ["blocked"]), step("you", ["done"], { actor: "user" }), step("you-end", ["you"])];
    const graph = buildQuestGraph(steps);
    expect(graph.lit).toEqual(["you", "you-end"]);
    expect(gutterLayout(graph, new Map(), 1000).roads.filter(r => r.lit).map(r => [r.from, r.to])).toEqual([["you", "you-end"]]);
    expect(buildQuestGraph(steps, false).lit).toEqual(["blocked", "block-end"]);
    expect(buildQuestGraph([...steps, step("last", ["wait-end"])]).lit).toEqual(["waiting", "wait-end", "last"]);
    expect(buildQuestGraph([step("done", [], { state: "done" })]).lit).toEqual([]);
  });
});
