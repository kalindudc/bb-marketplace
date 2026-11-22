import type { CharacterPalette } from "../../kit/characters";
import { PROP_COLOURS, spriteFabric } from "./palette";
import type { SeedTraits } from "./traits";

export const WIDTH = 24;
export const HEIGHT = 28;
export const GROUND = 26;

export const enum Ink {
  Empty, Shadow, Outline, Garment, Secondary, Skin, Hair, Boot, Leather, Wood,
  Metal, Paper, Flame, Seal, DarkCloth, Cloud, Rain, Cream, Glint, Cheek,
  Edge, TopEdge, Brass, Lens, Crystal, Facet, Charge, ChargeGlint, PaperShade, Lip,
  ShadeOuter, ShadeMiddle, ShadeCore, Prop,
}

const LIP = ["#bb806d", "#a96f5b", "#8e5848"];

type Run = Uint8Array;

export class PixelGrid {
  private readonly cells = new Uint8Array(WIDTH * HEIGHT);

  rect(x: number, y: number, w: number, h: number, ink: Ink) {
    const left = Math.max(0, x);
    const right = Math.min(WIDTH, x + w);
    if (left >= right) return;
    for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + h); row++) {
      this.cells.fill(ink, row * WIDTH + left, row * WIDTH + right);
    }
  }

  mask(x: number, y: number, pattern: readonly string[], ink: Ink) {
    for (let row = 0; row < pattern.length; row++) {
      const line = pattern[row]!;
      for (let col = 0; col < line.length; col++) {
        if (line[col] === "#") this.rect(x + col, y + row, 1, 1, ink);
      }
    }
  }

  outline() {
    const art = this.cells.slice();
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = y * WIDTH + x;
        if (art[i]! > Ink.Shadow) continue;
        if ((x > 0 && art[i - 1]! > Ink.Shadow) || (x < WIDTH - 1 && art[i + 1]! > Ink.Shadow) ||
            (y > 0 && art[i - WIDTH]! > Ink.Shadow)) this.cells[i] = Ink.Edge;
        else if (y + 1 < HEIGHT && art[i + WIDTH]! > Ink.Shadow) this.cells[i] = Ink.TopEdge;
      }
    }
  }

  runs(): Run {
    const runs: number[] = [];
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH;) {
        const colour = this.cells[y * WIDTH + x]!;
        let end = x + 1;
        while (end < WIDTH && this.cells[y * WIDTH + end] === colour) end++;
        if (colour !== Ink.Empty) runs.push(colour, x, y, end - x);
        x = end;
      }
    }
    return Uint8Array.from(runs);
  }
}

export function spriteColours(hue: string, traits: SeedTraits, p: CharacterPalette): readonly string[] {
  const cloth = spriteFabric(hue, traits.secondary, p);
  return [
    "transparent", p.shadow, p.ink, cloth.garment, cloth.secondary,
    p.skin[traits.skin]!, traits.hairColour === 3 && p.silver ? p.silver : p.hair[traits.hairColour]!, p.pants,
    cloth.leather, p.wood, p.metal, p.dark ? p.metal : p.card,
    p.hearth, p.bad, cloth.fold, p.cloud, p.drop, p.skin[0]!, p.dark ? p.metal : p.card, p.cheeks?.[traits.skin] ?? p.skin[traits.skin]!,
    cloth.rim, cloth.topRim, "#b68a42", "#bad4cf", "#a792cc", "#6b5799", "#96bbc4", "#e4f2f5", "#a5987b", LIP[traits.skin]!,
    "rgba(59, 52, 42, 0.025)", "rgba(59, 52, 42, 0.05)", "rgba(59, 52, 42, 0.08)", ...PROP_COLOURS,
  ];
}

export function blit(ctx: CanvasRenderingContext2D, runs: Run, colours: readonly string[], facing: 1 | -1, ox = 0, oy = 0) {
  let last = -1;
  for (let i = 0; i < runs.length; i += 4) {
    const ink = runs[i]!;
    if (colours[ink] === "transparent") continue;
    if (last !== ink) ctx.fillStyle = colours[last = ink]!;
    const x = runs[i + 1]! + ox;
    const w = runs[i + 3]!;
    ctx.fillRect(facing === 1 ? x : WIDTH - x - w, runs[i + 2]! + oy, w, 1);
  }
}
