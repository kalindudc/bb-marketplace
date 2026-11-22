// The contract between the engine (scheduler, physics, strip) and the generator (sprites). The moods live in shared, which never imports the UI.
import type { LookFields } from "../../shared/look";
import type { Mood } from "../../shared/mood";
import type { CharacterPalette } from "../kit/characters";

export { MOODS, type Mood, type MoodOrGone } from "../../shared/mood";

/** One-shot animations. Each lasts `CUE_MS[cue]`. */
export const CUES = ["tap", "notice", "wave", "flourish", "drop", "blink", "hop", "tip", "signature"] as const;
export type Cue = (typeof CUES)[number];
export const CUE_MS: Record<Cue, number> = { tap: 1100, notice: 620, wave: 950, flourish: 1300, drop: 1200, blink: 520, hop: 900, tip: 720, signature: 1000 };

/** stand: the mood's resting pose with its slow breath; walk: travelling; quiet: the class's quiet idle while the user types; cue: a one-shot. */
export type Activity = "stand" | "walk" | "quiet" | "cue";
export type Signature = "quill" | "lantern" | "spyglass" | "hammer" | "staff" | "nod";

/** Everything the art needs to draw one frame. The engine owns time and physics; the art is a pure function of this. */
export type ArtFrame = {
  activity: Activity;
  /** Set when activity is "cue". */
  cue: Cue | null;
  /** 0 to 1 through the cue; unused otherwise. */
  progress: number;
  /** ms on the engine clock, for loops the art owns (breath, blink, the class idle). */
  t: number;
  mood: Mood;
  facing: 1 | -1;
  /** Quantized phase in the current gait cycle (0 to 7). */
  step: number;
  /** Member identity's seed, independent of the avatar's traits. */
  motionSeed?: number;
  /** The hanging light's pendulum angle in radians, from the engine's physics; 0 hangs straight. */
  swing: number;
  /** The flame's flicker around 1; exactly 1 when still. */
  flame: number;
  /** Use the smaller idle beside an ask or an attention mood. A deliberate cue can still play. */
  small?: boolean;
  /** Reduced motion or Motion off: draw the mood's rest pose and nothing time-based. */
  still: boolean;
  dark?: boolean;
};

export type LampKind = "lantern" | "hearth" | "torch";
export type ClassLight = "runewood" | "shutter" | "ember" | "crystal";
export type LightAnchor = { x: number; y: number; kind: LampKind | ClassLight };

export function isLampKind(kind: LightAnchor["kind"]): kind is LampKind {
  return kind === "lantern" || kind === "hearth" || kind === "torch";
}

export interface CharacterArt {
  /** The art's grid in art pixels; the engine draws it at a whole multiple. */
  readonly width: number;
  readonly height: number;
  /** The row the feet stand on. */
  readonly ground: number;
  readonly signature: Signature;
  /** Time until the next art pixel change, in ms. External changes to walking, cues and physics are the scene's responsibility. */
  nextChange(frame: ArtFrame): number | null;
  /** A key for the rendered layers with the palette held fixed. */
  pixelKey(frame: ArtFrame): number;
  /** Pure: the same frame and palette always give the same pixels. Clears its own width by height first. */
  draw(ctx: CanvasRenderingContext2D, frame: ArtFrame, palette: CharacterPalette): void;
  /** Where a carried light emits from, in art pixels, for this frame; null when the character carries none. */
  lightAnchor(frame: ArtFrame): LightAnchor | null;
  /** The name of the class's quiet idle for a mood (for example "reads a scroll"), for tests and the debug readout. */
  quietIdle(mood: Mood): string;
}

export type ArtInput = {
  /** The avatar seed: the character's `avatar:` when set, else its id. */
  seed: string;
  /** The class it was hired as; null for no class. */
  classId: string | null;
  hue: string;
  charge: string | null;
  /** Traits the character file pins on top of the seed. */
  look?: LookFields;
  keeper: boolean;
};

export type ArtFactory = (input: ArtInput) => CharacterArt;
