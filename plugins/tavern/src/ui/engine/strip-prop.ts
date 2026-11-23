import type { StripProp } from "../../shared/strip-scene";
import type { CharacterPalette } from "../kit/characters";

export const PROP_WIDTH = 32;
const gap = 6;

export function propLeft(x: number, spriteWidth: number, lane: number, ask: boolean) {
  const right = ask ? Math.max(92, x + spriteWidth) + gap : x + spriteWidth + gap;
  if (right + PROP_WIDTH <= lane) return right;
  if (!ask && x >= PROP_WIDTH + gap) return x - PROP_WIDTH - gap;
  return null;
}

export function drawStripProp(ctx: CanvasRenderingContext2D, prop: StripProp, left: number, foot: number, palette: CharacterPalette, contact: boolean) {
  const rect = (colour: string, x: number, y: number, width: number, height: number) => {
    ctx.fillStyle = colour;
    ctx.fillRect(left + 2 * x, foot - 30 + 2 * y, 2 * width, 2 * height);
  };
  const { ink, wood, metal, cloak, muted, hearth } = palette;
  const paper = palette.skin[0]!;
  switch (prop) {
    case "scroll":
      rect(ink, 1, 5, 14, 10);
      rect(wood, 0, 6, 3, 8);
      rect(wood, 13, 6, 3, 8);
      rect(paper, 3, 6, 10, 8);
      rect(muted, 5, 11, 4, 1);
      rect(muted, 8, 9, 3, 1);
      rect(contact ? hearth : cloak, 10, 7, 1, 2);
      break;
    case "book":
    case "bookmarked":
      rect(ink, 1, 5, 14, 10);
      rect(wood, 2, 12, 12, 2);
      rect(paper, 2, 5, 5, 7);
      rect(paper, 9, contact ? 3 : 5, 5, contact ? 9 : 7);
      rect(muted, 3, 7, 3, 1);
      rect(muted, 10, 8, 3, 1);
      rect(prop === "bookmarked" ? cloak : wood, 7, 7, 2, 7);
      break;
    case "folio":
      rect(ink, 2, 7, 12, 8);
      rect(wood, 3, 8, 10, 4);
      rect(paper, 4, 12, 8, 2);
      rect(contact ? hearth : muted, 5, 9, 6, 1);
      break;
    case "anvil":
      rect(ink, 0, 5, 16, 4);
      rect(metal, 1, 5, 14, 2);
      rect(ink, 5, 9, 6, 4);
      rect(ink, 3, 13, 10, 2);
      rect(metal, 6, 9, 4, 1);
      rect(wood, 4, contact ? 2 : 3, 6, 1);
      rect(metal, 9, contact ? 3 : 2, 3, 2);
      break;
    case "seal":
      rect(paper, 2, 9, 12, 6);
      rect(wood, 3, 14, 10, 1);
      rect(cloak, 6, 10, 5, 3);
      rect(cloak, 7, 9, 3, 5);
      rect(contact ? ink : hearth, 8, 11, 1, 1);
      rect(ink, 7, contact ? 6 : 2, 3, 4);
      rect(wood, 6, contact ? 5 : 1, 5, 2);
      break;
  }
}
