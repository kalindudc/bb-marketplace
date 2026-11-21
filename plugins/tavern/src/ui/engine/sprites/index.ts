import { readPalette, type CharacterPalette } from "../../kit/characters";
import type { ArtFactory, ArtFrame, ArtInput, LightAnchor, Mood } from "../art";
import { actor, lamp, rainCloud } from "./parts";
import { blit, GROUND, HEIGHT, spriteColours, WIDTH } from "./pixels";
import { poseBook, smallIdle } from "./poses";
import { classKit, HANDWORK, seedTraits } from "./traits";

const SWING = [-2, -1, 0, 1, 2];
const LIGHTS = {
  hearth: SWING.map(shift => [lamp("hearth", shift, false), lamp("hearth", shift, true)] as const),
  lantern: SWING.map(shift => [lamp("lantern", shift, false), lamp("lantern", shift, true)] as const),
  torch: SWING.map(shift => [lamp("torch", shift, false), lamp("torch", shift, true)] as const),
};
const RAIN = rainCloud();

export const createArt: ArtFactory = input => {
  const traits = seedTraits(input);
  const kit = classKit(input.classId);
  const handwork = (mood: Mood) => mood === "blocked" || mood === "error" ? "hands" : kit.quiet[mood] ?? kit.idle;
  const { poses, at, index } = poseBook(handwork, traits.blinkOffset, kit.signature);
  const drawings = new Map<number, { runs: Uint8Array; anchor: LightAnchor | null; bodyKey: number }>();
  const bodies = new Map<string, number>();
  const drawing = (i: number) => {
    const cached = drawings.get(i);
    if (cached) return cached;
    const { runs, anchor } = actor(traits, poses[i]!, input.charge);
    const encoding = `${runs}|${anchor?.x},${anchor?.y}`;
    const bodyKey = bodies.get(encoding) ?? bodies.size;
    bodies.set(encoding, bodyKey);
    const result = { runs, anchor, bodyKey };
    drawings.set(i, result);
    return result;
  };
  const swingFor = (frame: ArtFrame, i: number) => {
    if (frame.still || (smallIdle(frame) && frame.cue !== "signature")) return 2;
    return poses[i]?.action === "lantern" && frame.activity === "stand" ? 3 : 2 + Math.round(2 * Math.sin(frame.swing));
  };
  const brightFor = (frame: ArtFrame, i: number, ember: boolean | undefined) => {
    if (poses[i]?.action === "lantern" && poses[i]?.accent === "peak") return 1;
    if (frame.still || smallIdle(frame) || frame.activity === "quiet") return 0;
    if (frame.activity === "walk" || frame.activity === "cue") return Number(frame.flame > 1.04);
    return Number(!!ember);
  };
  const pixelKey = (frame: ArtFrame) => {
    const { index: i, ember } = at(frame);
    const { bodyKey, anchor } = drawing(i);
    const light = anchor ? swingFor(frame, i) * 2 + brightFor(frame, i, ember) : 0;
    return ((bodyKey * 10 + light) * 2 + Number(frame.facing === -1)) * 2 + Number(frame.mood === "error");
  };
  const palettes = new WeakMap<CharacterPalette, readonly string[]>();
  function coloursFor(palette: CharacterPalette) {
    const known = palettes.get(palette);
    if (known) return known;
    const colours = spriteColours(input.hue, traits, palette);
    palettes.set(palette, colours);
    return colours;
  }
  return {
    width: WIDTH, height: HEIGHT, ground: GROUND, signature: kit.signature,
    quietIdle: mood => HANDWORK[handwork(mood)],
    pixelKey,
    nextChange(frame) {
      if (frame.still || frame.activity === "walk" || frame.activity === "cue") return null;
      const key = pixelKey(frame);
      let t = frame.t;
      while (true) {
        const { next } = at({ ...frame, t });
        if (next === null) return null;
        const boundary = t + next;
        t = boundary + 1e-7;
        if (pixelKey({ ...frame, t }) !== key) return boundary - frame.t;
        if (frame.activity === "quiet") return null;
      }
    },
    lightAnchor(frame) {
      const i = index(frame);
      const { anchor } = drawing(i);
      if (!anchor) return null;
      const { flameX, flameY } = LIGHTS[anchor.kind][swingFor(frame, i)]![0];
      const x = anchor.x + flameX;
      return { kind: anchor.kind, x: frame.facing === -1 ? WIDTH - 1 - x : x, y: anchor.y + flameY };
    },
    draw(ctx, frame, palette) {
      const { index: i, ember } = at(frame);
      const { runs, anchor } = drawing(i);
      const { facing } = frame;
      const colours = coloursFor(palette);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      blit(ctx, runs, colours, facing);
      if (anchor) {
        const lamp = LIGHTS[anchor.kind][swingFor(frame, i)]![brightFor(frame, i, ember) as 0 | 1];
        blit(ctx, lamp.runs, colours, facing, anchor.x - 4, anchor.y + lamp.topOffset);
      }
      if (frame.mood === "error") blit(ctx, RAIN, colours, 1);
    },
  };
};

export function drawStillAvatar(canvas: HTMLCanvasElement, input: ArtInput, mood: Mood, scale: number, palette: CharacterPalette = readPalette(canvas.parentElement)): void {
  if (!Number.isInteger(scale) || scale < 1) throw new RangeError("Avatar scale must be a positive whole number");
  canvas.width = WIDTH * scale;
  canvas.height = HEIGHT * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  createArt(input).draw(ctx, { activity: "stand", cue: null, progress: 0, t: 0, mood, facing: 1, step: 0, swing: 0, flame: 1, still: true }, palette);
}
