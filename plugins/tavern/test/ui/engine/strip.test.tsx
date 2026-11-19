import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PartyStrip } from "../../../src/ui/engine/strip";
import * as engine from "../../../src/ui/engine/scheduler";
import * as sprites from "../../../src/ui/engine/sprites";

const character = { id: "wren", avatar: "a-new-roll", name: "Wren", hue: "teal", charge: "chevron", look: { hat: "pointy" } } as const;

afterEach(() => vi.restoreAllMocks());

it("uses the avatar seed and member class and places the carried light in page coordinates", () => {
  let world: engine.EngineWorld | undefined;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    world = candidate;
    return { invalidate: () => candidate.draw(true), remove() {} };
  });
  const createArt = vi.spyOn(sprites, "createArt");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const props = { character, classLabel: "Wanderer", classId: "wanderer", mood: "idle", keeper: false, surface: "thread:wren" } as const;
  const { rerender } = render(<PartyStrip {...props} />);
  expect(createArt).toHaveBeenCalledWith({ seed: "a-new-roll", classId: "wanderer", hue: "teal", charge: "chevron", look: { hat: "pointy" }, keeper: false });
  const strip = document.querySelector(".twalk")!;
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(31, 99, 100, 64));
  world!.draw(true);
  const anchor = world!.lightAnchors?.()[0];
  expect(anchor).toEqual({ x: 42, y: expect.any(Number), kind: "lantern" });
  expect(anchor!.y).toBeGreaterThan(99);
  expect(anchor!.y).toBeLessThan(157);
  rerender(<PartyStrip {...props} character={{ ...character, avatar: undefined }} />);
  expect(createArt.mock.lastCall?.[0].seed).toBe("wren");
  rerender(<PartyStrip {...props} classId="smith" />);
  expect(world!.lightAnchors?.()).toEqual([]);
});
