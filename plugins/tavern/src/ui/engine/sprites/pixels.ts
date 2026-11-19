import type { CharacterPalette } from "../../kit/characters";
import { materialIndex, type SeedTraits } from "./traits";

export const WIDTH = 24;
export const HEIGHT = 28;
export const GROUND = 26;

export const enum Ink {
  Empty, Shadow, Outline, Garment, Secondary, Skin, Hair, Boot, Leather, Wood,
  Metal, Paper, Flame, Seal, DarkCloth, Cloud, Rain, Cream,
}

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
            (y > 0 && art[i - WIDTH]! > Ink.Shadow)) this.cells[i] = Ink.Outline;
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

type Colour = (p: CharacterPalette) => string;
const MATERIAL_COLOURS: readonly Colour[] = [p => p.card, p => p.muted, p => p.hue.teal ?? p.muted, p => p.cloak, p => p.metal, p => p.wood];

export function spriteColours(hue: string, traits: SeedTraits): readonly Colour[] {
  return [
    () => "transparent", p => p.shadow, p => p.ink,
    p => p.hue[hue] ?? p.hue.teal ?? p.ink, MATERIAL_COLOURS[materialIndex(traits.secondary)]!,
    p => p.skin[traits.skin]!, p => p.hair[traits.hairColour]!, p => p.pants,
    p => p.belt, p => p.wood, p => p.metal, p => p.dark ? p.metal : p.card,
    p => p.hearth, p => p.bad, p => p.cloak, p => p.cloud, p => p.drop, p => p.skin[0]!,
  ];
}

export function blit(ctx: CanvasRenderingContext2D, runs: Run, colours: readonly Colour[], palette: CharacterPalette, facing: 1 | -1, ox = 0, oy = 0) {
  let last = -1;
  for (let i = 0; i < runs.length; i += 4) {
    const ink = runs[i]!;
    if (last !== ink) ctx.fillStyle = colours[last = ink]!(palette);
    const x = runs[i + 1]! + ox;
    const w = runs[i + 3]!;
    ctx.fillRect(facing === 1 ? x : WIDTH - x - w, runs[i + 2]! + oy, w, 1);
  }
}
