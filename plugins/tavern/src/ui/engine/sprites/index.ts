import { readPalette, type CharacterPalette } from "../../kit/characters";
import type { ArtFactory, ArtInput, LightAnchor, Mood } from "../art";
import { actor, lamp, rainCloud } from "./parts";
import { blit, GROUND, HEIGHT, spriteColours, WIDTH } from "./pixels";
import { poseBook } from "./poses";
import { classKit, HANDWORK, seedTraits } from "./traits";

const SWING = [-2, -1, 0, 1, 2];
const LIGHTS = {
  hearth: SWING.map(shift => [lamp("hearth", shift, false), lamp("hearth", shift, true)] as const),
  lantern: SWING.map(shift => [lamp("lantern", shift, false), lamp("lantern", shift, true)] as const),
  torch: SWING.map(shift => [lamp("torch", shift, false), lamp("torch", shift, true)] as const),
};
const RAIN = rainCloud();

function mirror(anchor: LightAnchor | null): LightAnchor | null {
  return anchor && { ...anchor, x: WIDTH - 1 - anchor.x };
}

export const createArt: ArtFactory = input => {
  const traits = seedTraits(input);
  const kit = classKit(input.classId);
  const handwork = (mood: Mood) => mood === "blocked" || mood === "error" ? "hands" : kit.quiet[mood] ?? kit.idle;
  const { poses, index } = poseBook(handwork, traits.blinkOffset);
  const drawings = poses.map(pose => {
    const { runs, anchor } = actor(traits, pose, input.charge);
    return { runs, anchor, mirrored: mirror(anchor) };
  });
  const colours = spriteColours(input.hue, traits);
  return {
    width: WIDTH, height: HEIGHT, ground: GROUND,
    quietIdle: mood => HANDWORK[handwork(mood)],
    lightAnchor(frame) {
      const pose = drawings[index(frame)]!;
      return frame.facing === -1 && !frame.still ? pose.mirrored : pose.anchor;
    },
    draw(ctx, frame, palette) {
      const { runs, anchor } = drawings[index(frame)]!;
      const facing = frame.still ? 1 : frame.facing;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      blit(ctx, runs, colours, palette, facing);
      if (anchor) {
        const swing = frame.still ? 2 : 2 + Math.round(2 * Math.sin(frame.swing));
        const bright = !frame.still && frame.flame > 1.04 ? 1 : 0;
        blit(ctx, LIGHTS[anchor.kind][swing]![bright], colours, palette, facing, anchor.x - 4, anchor.y - (anchor.kind === "torch" ? 7 : 0));
      }
      if (frame.mood === "error") blit(ctx, RAIN, colours, palette, facing);
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
