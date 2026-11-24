import { expect, it } from "vitest";
import { layoutRoad, PLACE_TARGET } from "../../../src/ui/engine/road-places";

const places = Array.from({ length: 12 }, (_, index) => ({
  id: `w${index}`, kind: index % 2 ? "review" as const : "make" as const,
  state: index < 11 ? "done" as const : "held" as const,
}));

it.each([390, 780])("folds completed places without crowding the actor or ask at %dpx", width => {
  const road = layoutRoad({ key: "fixture", places, current: "w11" }, width, 48, true);
  const fold = road.items[0]!.place;
  expect(fold.kind).toBe("milestones");
  expect(fold.kind === "milestones" && fold.count).toBeGreaterThan(0);
  expect(road.home + 48).toBeLessThanOrEqual(road.askX!);
  expect(road.askX! + PLACE_TARGET).toBeLessThanOrEqual(width);
  for (const { target } of road.items) {
    expect(target).toBeGreaterThanOrEqual(0);
    expect(target + PLACE_TARGET).toBeLessThanOrEqual(road.home);
  }
  expect(road.items.at(-1)?.place.id).toBe("w11");
});

it("places new work ahead while keeping the earlier signpost fixed", () => {
  const signpost = { id: "plan", kind: "plan", state: "active" } as const;
  const start = layoutRoad({ key: "fixture", current: "plan", places: [signpost] }, 390, 48, false);
  const next = layoutRoad({ key: "fixture", current: "w0", places: [{ ...signpost, state: "done" }, places[0]!] }, 390, 48, false);
  expect(start.items[0]?.x).toBe(next.items[0]?.x);
  expect(next.home).toBeGreaterThan(start.home);
});
