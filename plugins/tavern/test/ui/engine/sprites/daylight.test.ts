// @vitest-environment node
import { expect, it } from "vitest";
import type { ArtFrame } from "../../../../src/ui/engine/art";
import { createArt } from "../../../../src/ui/engine/sprites";
import { CHARACTER_PALETTE_FALLBACK as palette } from "../../../../src/ui/kit/characters";

const art = createArt({ seed: "wren", classId: "keeper", hue: "teal", charge: "chevron", keeper: true });
const rest: ArtFrame = { activity: "stand", cue: null, progress: 0, t: 0, mood: "idle", facing: 1, step: 0, swing: 0, flame: 1, still: true };
const { width, height } = art;

function paint(frame: ArtFrame, daylight: boolean) {
  const pixels = new Array<string>(width * height).fill("");
  const light: { x: number; y: number; alpha: number }[] = [];
  const ctx = {
    globalAlpha: 1, fillStyle: "", clearRect() {}, save() {}, restore() { this.globalAlpha = 1; },
    fillRect(x: number, y: number, w: number, h: number) {
      if (this.globalAlpha < 1) {
        expect([w, h]).toEqual([1, 1]);
        light.push({ x, y, alpha: this.globalAlpha });
      } else {
        for (let row = y; row < y + h; row++) pixels.fill(this.fillStyle, row * width + x, row * width + x + w);
      }
    },
  };
  art.draw(ctx as unknown as CanvasRenderingContext2D, frame, palette, daylight ? { sunGlint: 0.48 } : undefined);
  return { pixels, light };
}

it.each(["stand", "walk"] as const)("keeps the sun on the same screen side in both %s facings, on outline cells only", activity => {
  for (const facing of [1, -1] as const) {
    const { pixels, light } = paint({ ...rest, activity, facing, still: activity === "stand", step: 2 }, true);
    const body = (x: number, y: number) => pixels[y * width + x];
    expect(light.length).toBeGreaterThan(2);
    expect(light.every(p => p.x <= width / 2)).toBe(true);
    const offOutline = light.filter(({ x, y }) => !body(x, y) || (x > 0 && body(x - 1, y) && body(x, y - 1)));
    expect(offOutline).toEqual([]);
    expect(light.some(({ x, y }) => x > 0 && !body(x - 1, y) && !!body(x, y - 1))).toBe(true);
    const peak = Math.max(...light.map(p => p.alpha));
    const brightest = light.filter(p => p.alpha === peak);
    expect(peak).toBeGreaterThan(Math.min(...light.map(p => p.alpha)));
    expect(brightest.length).toBeLessThanOrEqual(2);
    expect(brightest.every(({ x, y }) => !body(x, y - 1))).toBe(true);
    expect(pixels).toContain("#f7edd4");
  }
});

it("does not light dark-mode sprites or day portraits", () => {
  expect(paint({ ...rest, dark: true }, true)).toEqual(paint({ ...rest, dark: true }, false));
  expect(paint(rest, false).light).toEqual([]);
});
