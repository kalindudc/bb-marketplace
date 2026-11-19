import type { CharacterDef } from "../../shared/schema";
import { CHARACTER_GRID, characterLook, characterPose, drawCharacter, type CharacterState } from "../kit/characters";
import type { ArtFactory, Mood } from "./art";

const QUIET_IDLE: Partial<Record<Mood, string>> = {
  working: "reads a scroll", waiting: "tends the lantern", resting: "leans on the tool",
};
const STATE: Record<Mood, CharacterState> = {
  idle: "idle", working: "working", waiting: "needs-you", reported: "idle",
  verified: "idle", blocked: "idle", resting: "idle", error: "error",
};

export const legacyArt: ArtFactory = ({ seed, classId, hue, charge, look, keeper }) => {
  const traits = characterLook({ id: seed, look });
  // The old cap has a modern brim, and the broad build widens only the shoulders.
  traits.build = "slim";
  if (traits.hat === "cap") traits.hat = "none";
  if (traits.hair === "bald") traits.hair = "flat";
  return {
    width: CHARACTER_GRID.width,
    height: 28,
    ground: CHARACTER_GRID.ground + 2,
    draw(ctx, frame, palette) {
      ctx.clearRect(0, 0, CHARACTER_GRID.width, 28);
      ctx.save();
      ctx.translate(frame.facing === 1 ? 0 : CHARACTER_GRID.width, 2);
      ctx.scale(frame.facing, 1);
      const pose = characterPose({
        look: traits, state: STATE[frame.mood], ts: frame.t, keeper, mode: "interval",
        gag: frame.cue && frame.cue !== "hop" ? { kind: frame.cue, progress: frame.progress } : null,
      });
      if (frame.mood === "blocked") pose.slump = true;
      if (!frame.still && frame.activity !== "cue") {
        pose.bob = frame.activity === "walk" ? frame.step % 2 : Math.floor(frame.t / 850) % 2;
        pose.blink = frame.activity !== "walk" && (frame.t + traits.blinkOff) % 4200 < 150;
        if (frame.activity === "walk") pose.lookSide = 1;
      }
      drawCharacter({ ctx, hue, look: traits, palette, pose, cls: classId, keeper, charge: charge as CharacterDef["charge"] | null });
      ctx.restore();
    },
    lightAnchor: () => null,
    quietIdle: mood => QUIET_IDLE[mood] ?? "breathes",
  };
};
