import { expect, it } from "vitest";
import { layoutRoad, placeWords, PLACE_TARGET } from "../../../src/ui/engine/road-places";

const places = Array.from({ length: 16 }, (_, index) => ({
  id: `w${index}`, kind: index % 2 ? "review" as const : "make" as const,
  state: index < 15 ? "done" as const : "held" as const,
}));

it.each([390, 780, 1400])("folds completed places into the first three quarters at %dpx", width => {
  const road = layoutRoad({ key: "fixture", places, current: "w15" }, width, 48);
  const fold = road.items[0]!.place;
  expect(fold.kind).toBe("milestones");
  expect(fold.kind === "milestones" && fold.count).toBeGreaterThan(0);
  expect(road.home + 48).toBeLessThanOrEqual(Math.floor(width * 0.75));
  for (const { target } of road.items) {
    expect(target).toBeGreaterThanOrEqual(0);
    expect(target + PLACE_TARGET).toBeLessThanOrEqual(road.home);
  }
  expect(road.items.at(-1)?.place.id).toBe("w15");
  expect(road.items.slice(1).map(item => item.place)).toEqual(places.slice(-(road.items.length - 1)));
  expect(fold.kind === "milestones" && fold.count).toBe(places.length + 1 - road.items.length);
});

it.each([1, 2])("names the %d folded road stops with the right plural", count => {
  const place = { id: "milestones", kind: "milestones", state: "done", count } as const;
  expect(placeWords(place, "Wren", false).detail).toBe(
    count === 1 ? "1 earlier place behind Wren on this road." : "2 earlier places behind Wren on this road.",
  );
});

it("places new work ahead while keeping the earlier signpost fixed", () => {
  const signpost = { id: "plan", kind: "plan", state: "active" } as const;
  const start = layoutRoad({ key: "fixture", current: "plan", places: [signpost] }, 390, 48);
  const next = layoutRoad({ key: "fixture", current: "w0", places: [{ ...signpost, state: "done" }, places[0]!] }, 390, 48);
  expect(start.items[0]?.x).toBe(next.items[0]?.x);
  expect(next.home).toBeGreaterThan(start.home);
});
