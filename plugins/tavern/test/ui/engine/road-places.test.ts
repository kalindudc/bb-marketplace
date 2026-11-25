import { expect, it } from "vitest";
import { drawRoad, layoutRoad, placeWords, PLACE_TARGET } from "../../../src/ui/engine/road-places";
import { CHARACTER_PALETTE_FALLBACK } from "../../../src/ui/kit/characters";
import type { KeeperRoad } from "../../../src/shared/strip-scene";

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

const quests: KeeperRoad["places"] = Array.from({ length: 16 }, (_, i) => ({
  id: `q${i}`, kind: "quest", name: `Quest ${i}`, state: "building", done: 3, total: 5,
}));

it.each([390, 780, 1400])("folds Keeper quests within three quarters at %dpx without folding the current quest", width => {
  const road = layoutRoad({ kind: "keeper", key: "keeper", places: quests, current: "q0" }, width, 48);
  expect(road.items[0]?.place.kind).toBe("milestones");
  expect(road.items.some(item => item.place.id === "q0" && item.target + PLACE_TARGET === road.home)).toBe(true);
  expect(road.home + 48).toBeLessThanOrEqual(Math.floor(width * 0.75));
  expect(road.items.every(item => item.target + PLACE_TARGET <= Math.floor(width * 0.75))).toBe(true);
});

it("folds overflow back into a reachable milestone if a hold starts partway along the road", () => {
  const road: KeeperRoad = { kind: "keeper", key: "keeper", places: quests.slice(0, 3), current: "q1" };
  const { items } = layoutRoad(road, 390, 48, { left: 140, right: 232 });
  expect(items.map(i => [i.place.id, i.target])).toEqual([["milestones", 8], ["q1", 232]]);
  expect(items[0]?.place).toMatchObject({ count: 2, quests: [road.places[0], road.places[2]] });
});

it("keeps the camp in bounds without displacing signs and gives the hearth priority", () => {
  const goal = { kind: "keeper", key: "keeper", current: "q0" } as const;
  const wide = layoutRoad({ ...goal, places: quests.slice(0, 1) }, 780, 48);
  expect(wide.camp?.props.map(prop => prop.kind)).toEqual(["hearth", "cat", "barrels", "board"]);
  expect(wide.camp?.home).toBeGreaterThan(wide.home);
  expect(wide.camp?.props.every(prop => prop.x + prop.width <= 585)).toBe(true);
  const narrow = layoutRoad({ ...goal, places: quests.slice(0, 3) }, 390, 48);
  expect(narrow.items.map(item => item.place.id)).toEqual(["q0", "q1", "q2"]);
  expect(narrow.camp?.props.length ?? 0).toBeLessThan(wide.camp!.props.length);
});

it.each([
  ["Gruve light", "#e7e3d8", "#9d0006", false],
  ["Gruve dark", "#32302f", "#fd9d85", true],
  ["Gruvbox dark", "#282828", "#fb4934", true],
] as const)("draws held pennant and seal fills at 3:1 or more in %s", (_theme, background, bad, dark) => {
  const palette = { ...CHARACTER_PALETTE_FALLBACK, background, bad, dark };
  const road = layoutRoad({ kind: "keeper", key: "keeper", current: "q0", places: [
    { ...quests[0]!, state: "held" }, { ...quests[1]!, state: "sealed" },
  ] }, 390, 48);
  const [pennant, seal] = road.items;
  const points = [{ x: pennant!.x + 6, y: 24, color: "" }, { x: seal!.x + 14, y: 31, color: "" }];
  const canvas = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      for (const p of points) if (p.x >= x && p.x < x + w && p.y >= y && p.y < y + h) p.color = this.fillStyle;
    },
  };
  drawRoad(canvas as unknown as CanvasRenderingContext2D, road, 390, 66, palette, palette.hue.plum!, null, -1, 1, false);
  const luminance = (hex: string) => (hex.match(/[\da-f]{2}/gi) ?? []).map(channel => {
    const n = parseInt(channel, 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  const base = luminance(background) + 0.05;
  for (const { color } of points) {
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    const ink = luminance(color) + 0.05;
    expect(Math.max(ink / base, base / ink)).toBeGreaterThanOrEqual(3);
  }
});

it("places new work ahead while keeping the earlier signpost fixed", () => {
  const signpost = { id: "plan", kind: "plan", state: "active" } as const;
  const start = layoutRoad({ key: "fixture", current: "plan", places: [signpost] }, 390, 48);
  const next = layoutRoad({ key: "fixture", current: "w0", places: [{ ...signpost, state: "done" }, places[0]!] }, 390, 48);
  expect(start.items[0]?.x).toBe(next.items[0]?.x);
  expect(next.home).toBeGreaterThan(start.home);
});
