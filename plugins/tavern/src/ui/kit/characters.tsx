import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefCallback } from "react";
import type { CharacterDef, ClassDef } from "../../shared/schema";
import { LOOK_HAIR_COLOURS, LOOK_HAIRS, LOOK_HATS, LOOK_SKINS, type LookFields } from "../../shared/look";
import { HUE_CSS } from "../../shared/heraldry";
import { motion, type Surface } from "./motion";
import { observeWorld } from "../engine/scheduler";
import "./characters.css";

/**
 * Tavern's characters as pixel art. One small record per character (its id, hue and charge, plus any `look:` traits its file names)
 * drives a 24x26 sprite: the id seeds the body, hair, skin and hat, so a character looks the same everywhere and needs no asset, and a
 * character file's `look:` overrides any trait it names, exactly as editing `hue` or `charge` redraws its crest. Its chest wears the
 * character's heraldic charge in pixels. The art comes from Pip's verified mock (thread-storage/tavern-character-mocks.html).
 *
 * Motion: every automatic cue goes through the motion coordinator, so reduced motion, the typing hold, a held widget row and the window
 * budgets reach the sprites too. Interval mode fires one short gag every `repeatSeconds`; continuous mode loops (a strike, a breath,
 * falling rain). The shared engine schedules the drawing.
 */

export const CHARACTER_GRID = { width: 24, height: 26, ground: 23, centre: 12 } as const;
/**
 * A fire's flicker, around 1: two detuned waves and a slow one, so a flame's reach and warmth never pulse like a metronome. `seed` is
 * the character's own offset, so no two fires beat together, and the result stays in a calm band (about 0.62 to 1.18).
 */
export function fireFlicker(ts: number, seed: number) {
  return 0.9 + 0.13 * Math.sin(ts / 90 + seed) + 0.09 * Math.sin(ts / 47 + seed * 1.7) + 0.06 * Math.sin(ts / 173 + seed * 0.3);
}

export const CHARACTER_STATES = ["idle", "working", "needs-you", "error"] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];
export const CHARACTER_MODES = ["interval", "continuous"] as const;
export type CharacterMode = (typeof CHARACTER_MODES)[number];
export type AmbientMotion = "calm" | "lively" | "off";

export type CharacterGag = "hop" | "wave" | "blink" | "notice" | "tap" | "drop" | "flourish";
/** Each gag's length: the coordinator holds its cue for exactly this, and the drawing follows the same clock. */
export const CHARACTER_GAG_MS: Record<CharacterGag, number> = { hop: 900, wave: 950, blink: 520, notice: 620, tap: 1100, drop: 1200, flourish: 1300 };
/**
 * What a character may do while it waits, by state: idle ones fidget, a working one strikes or blinks, one that needs you bounces, and a
 * failed one slumps under its own rain. A Keeper's flourish is its own; nobody else raises a quill.
 */
export const GAGS_BY_STATE: Record<CharacterState, readonly CharacterGag[]> = {
  idle: ["hop", "wave", "blink", "notice"],
  working: ["tap", "blink"],
  "needs-you": ["hop", "blink"],
  error: ["drop", "blink"],
};
/** What a state is called out loud and in the tooltip; "needs you" is Tavern's own word for an open ask. */
export const CHARACTER_STATE_WORD: Record<CharacterState, string> = { idle: "idle", working: "at work", "needs-you": "needs you", error: "stopped" };

/** A thread state as a character state: a failed or stopped thread reads as error, and an open ask outranks being at work. */
export function characterState(threadState: string | null | undefined, needsYou = false): CharacterState {
  if (threadState === "failed" || threadState === "stopped") return "error";
  if (needsYou) return "needs-you";
  if (threadState === "working" || threadState === "busy") return "working";
  return "idle";
}

/**
 * Which motion a character uses. The Motion setting the tavern already has decides it: Lively loops continuously (the continuous mode),
 * Calm keeps to the interval, Off holds still. A caller naming a mode wins, so a surface can pin one.
 */
export function characterMode(ambientMotion: AmbientMotion, mode?: CharacterMode): CharacterMode {
  if (mode) return mode;
  return ambientMotion === "lively" ? "continuous" : "interval";
}

/** The traits the id seeds. Body and head height are part of the seed, not of `look:`: the seed is the character. */
export type CharacterLook = LookFields & {
  build: NonNullable<LookFields["build"]>;
  hair: NonNullable<LookFields["hair"]>;
  hairColour: NonNullable<LookFields["hairColour"]>;
  skin: NonNullable<LookFields["skin"]>;
  hat: NonNullable<LookFields["hat"]>;
  light: NonNullable<LookFields["light"]>;
  torso: number;
  head: number;
  blinkOff: number;
};

const HUE_NAMES = Object.keys(HUE_CSS) as (keyof typeof HUE_CSS)[];

/** FNV-1a over the id, then a small generator: Pip's mock's `derive`, kept identical so a character keeps the build the mock gave it. */
function hash(text: string) {
  let h = 2166136261;
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A character's look: seeded from its id, with every trait its file's `look:` names winning. Same id, same character, anywhere. */
export function characterLook(character: Pick<CharacterDef, "id" | "look">): CharacterLook {
  const r = rng(hash(character.id));
  const seeded: CharacterLook = {
    build: r() < 0.5 ? "slim" : "broad",
    hair: LOOK_HAIRS[Math.floor(r() * LOOK_HAIRS.length)]!,
    hairColour: LOOK_HAIR_COLOURS[Math.floor(r() * LOOK_HAIR_COLOURS.length)]!,
    skin: LOOK_SKINS[Math.floor(r() * LOOK_SKINS.length)]!,
    hat: r() < 0.4 ? (r() < 0.5 ? "cap" : "pointy") : "none",
    torso: 7 + Math.floor(r() * 3),
    head: 6 + Math.floor(r() * 2),
    blinkOff: Math.floor(r() * 3600),
    // Seeded last: a light for the dark, and the earlier traits stay exactly the mock's, whatever light an id draws.
    light: r() < 0.5 ? "lantern" : r() < 0.5 ? "torch" : "none",
  };
  const over = character.look ?? {};
  return {
    ...seeded,
    build: over.build ?? seeded.build,
    hair: over.hair ?? seeded.hair,
    hairColour: over.hairColour ?? seeded.hairColour,
    skin: over.skin ?? seeded.skin,
    hat: over.hat ?? seeded.hat,
    light: over.light ?? seeded.light,
  };
}

export const bodyWidth = (look: CharacterLook) => (look.build === "broad" ? 10 : 8);

/** The colours one sprite is drawn with. Hue, hearth and card come from Tavern's theme tokens; the ink is a fixed dark in every theme, so the eyes never turn white in the dark; skin, hair and gear are the same warm set in light and dark. */
export type CharacterPalette = {
  hue: Record<string, string>;
  hearth: string;
  bad: string;
  ink: string;
  card: string;
  background: string;
  muted: string;
  skin: string[];
  hair: string[];
  silver?: string;
  cheeks?: string[];
  pants: string;
  belt: string;
  cloak: string;
  wood: string;
  metal: string;
  cloud: string;
  drop: string;
  shadow: string;
  /** True when the page background is dark: the sprite then carries its in-hand light. */
  dark: boolean;
};

/** Used when the theme cannot be read (a detached node, a test): the light palette of Pip's mock. */
export const CHARACTER_PALETTE_FALLBACK: CharacterPalette = {
  hue: { teal: "#2f9e8f", plum: "#a05a92", violet: "#7a5fc0", blue: "#4a7fb5", rose: "#c25e6e", ink: "#3b342a" },
  hearth: "#e8930c", bad: "#b3402e", ink: "#3b342a", card: "#faf6ec", background: "#f3ecdc", muted: "#8a7e68",
  skin: ["#eac49b", "#d8a87e", "#b9835e"],
  hair: ["#5b4632", "#2e2822", "#c9a24a", "#8a8378", "#a34f2e"],
  silver: "#a6a29d", cheeks: ["#dca784", "#c99374", "#a66e57"],
  pants: "#4a4136", belt: "#6b5a3e", cloak: "#7c3040", wood: "#8a6a3e", metal: "#8d949c", cloud: "#9a938a", drop: "#5f88b5", shadow: "rgba(59,52,42,.18)", dark: false,
};

const COLOUR = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(|^#[0-9a-f]{3,8}$/i;

/** A palette's theme from its page colour: the background's luminance decides dark, so a theme switch needs no class read. */
export function darkTheme(background: string): boolean {
  const m = /^rgba?\(([^)]+)\)$/.exec(background.trim());
  if (!m) return false;
  const [r, g, b] = m[1]!.split(/[\s,\/]+/).map(Number);
  if (![r, g, b].every(Number.isFinite)) return false;
  return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255 < 0.4;
}

/**
 * The palette for one sprite, read from the element's own CSS custom properties. A throwaway probe is given `color: var(--tchar-name)`
 * and its computed `color` is read back: `color` is a real property, so the browser resolves the var and any `color-mix()` inside it into
 * something a canvas can paint, which `getPropertyValue("--tchar-name")` would not.
 */
export function readPalette(root: Element | null): CharacterPalette {
  if (!root || typeof getComputedStyle !== "function" || !root.ownerDocument) return CHARACTER_PALETTE_FALLBACK;
  const probe = root.ownerDocument.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  root.appendChild(probe);
  const style = getComputedStyle(probe);
  const read = (name: string, fallback: string) => {
    // An unresolvable var leaves the sentinel in place; some environments hand back the literal token, which no canvas will paint either.
    probe.style.color = "#010203";
    probe.style.color = `var(${name})`;
    const value = style.color.trim();
    return value === "rgb(1, 2, 3)" || !COLOUR.test(value) ? fallback : value;
  };
  const palette: CharacterPalette = {
    hue: Object.fromEntries(HUE_NAMES.map(h => [h, read(`--tchar-${h}`, CHARACTER_PALETTE_FALLBACK.hue[h]!)])),
    hearth: read("--tchar-hearth", CHARACTER_PALETTE_FALLBACK.hearth),
    bad: read("--tchar-bad", CHARACTER_PALETTE_FALLBACK.bad),
    ink: read("--tchar-ink", CHARACTER_PALETTE_FALLBACK.ink),
    card: read("--tchar-card", CHARACTER_PALETTE_FALLBACK.card),
    background: read("--tchar-bg", CHARACTER_PALETTE_FALLBACK.background),
    dark: darkTheme(read("--tchar-bg", CHARACTER_PALETTE_FALLBACK.background)),
    muted: read("--tchar-muted", CHARACTER_PALETTE_FALLBACK.muted),
    skin: CHARACTER_PALETTE_FALLBACK.skin.map((f, i) => read(`--tchar-skin-${i + 1}`, f)),
    hair: CHARACTER_PALETTE_FALLBACK.hair.map((f, i) => read(`--tchar-hair-${i + 1}`, f)),
    silver: read("--tchar-silver", CHARACTER_PALETTE_FALLBACK.silver!),
    cheeks: CHARACTER_PALETTE_FALLBACK.cheeks!.map((f, i) => read(`--tchar-cheek-${i + 1}`, f)),
    pants: read("--tchar-pants", CHARACTER_PALETTE_FALLBACK.pants),
    belt: read("--tchar-belt", CHARACTER_PALETTE_FALLBACK.belt),
    cloak: read("--tchar-cloak", CHARACTER_PALETTE_FALLBACK.cloak),
    wood: read("--tchar-wood", CHARACTER_PALETTE_FALLBACK.wood),
    metal: read("--tchar-metal", CHARACTER_PALETTE_FALLBACK.metal),
    cloud: read("--tchar-cloud", CHARACTER_PALETTE_FALLBACK.cloud),
    drop: read("--tchar-drop", CHARACTER_PALETTE_FALLBACK.drop),
    shadow: read("--tchar-shadow", CHARACTER_PALETTE_FALLBACK.shadow),
  };
  probe.remove();
  return palette;
}

/** A frame: what the body is doing at one instant, all of it in whole pixels. */
export type CharacterPose = {
  bob: number; jump: number; blink: boolean; lookUp: boolean; lookSide: number; slump: boolean; wave: boolean;
  arm: number; spark: boolean; rain: number; err: boolean; ember: number;
};
const STILL: CharacterPose = { bob: 0, jump: 0, blink: false, lookUp: false, lookSide: 0, slump: false, wave: false, arm: 0, spark: false, rain: 0, err: false, ember: 0 };

/** One strike cycle: raise, hold, strike, recover. Degrees of the arm's own swing. */
export function workAngle(phase: number) {
  if (phase < 0.3) return -115 * (phase / 0.3);
  if (phase < 0.45) return -115;
  if (phase < 0.6) return -115 + 150 * ((phase - 0.45) / 0.15);
  if (phase < 0.75) return 35;
  return 35 * (1 - (phase - 0.75) / 0.25);
}

/**
 * The pose at `ts`. Continuous mode keeps the state's own loop running (a strike, a breath, falling rain, and for a Keeper a rising
 * ember); interval mode holds still and only a gag moves it. Reduced motion asks for a constant `ts`, which lands every loop on one still
 * frame.
 */
export function characterPose(input: { look: CharacterLook; state: CharacterState; ts: number; mode: CharacterMode; keeper: boolean; gag?: { kind: CharacterGag; progress: number } | null }): CharacterPose {
  const { look, state, ts, mode, keeper, gag } = input;
  const pose: CharacterPose = { ...STILL };
  const looping = mode === "continuous";
  if (state === "working") {
    if (looping) {
      const phase = ((ts + look.blinkOff * 7) % 1100) / 1100;
      pose.arm = workAngle(phase);
      pose.spark = phase > 0.52 && phase < 0.72;
      pose.bob = Math.floor(ts / 450) % 2;
    }
  } else if (state === "needs-you") {
    pose.lookUp = true;
    if (looping) pose.bob = Math.floor(ts / 500) % 2;
  } else if (state === "error") {
    pose.err = true;
    pose.slump = true;
    if (looping) pose.rain = (ts / 140) % 5;
  }
  if (looping && state === "idle") pose.bob = Math.floor(ts / 500) % 2;
  if (looping && !gag) pose.blink = (ts + look.blinkOff) % 3600 < 130;
  // The Keeper's own idle flourish: an ember rises off the hearth-light on its belt every few seconds. Nobody else has one.
  if (looping && keeper) {
    const cycle = (ts + look.blinkOff * 3) % 5200;
    pose.ember = cycle > 4200 ? (cycle - 4200) / 1000 : 0;
  }
  if (gag) {
    const p = Math.min(1, Math.max(0, gag.progress));
    if (gag.kind === "hop") pose.jump = p < 0.3 ? 3 : p < 0.6 ? 2 : p < 0.85 ? 1 : 0;
    else if (gag.kind === "wave") { pose.wave = true; pose.blink = p > 0.9; }
    else if (gag.kind === "blink") pose.blink = p < 0.5;
    else if (gag.kind === "tap") { pose.arm = workAngle(p); pose.spark = p > 0.52 && p < 0.72; }
    else if (gag.kind === "drop") pose.rain = p * 5;
    else if (gag.kind === "notice") { pose.lookSide = p < 0.5 ? -1 : 1; pose.jump = p < 0.25 ? 1 : 0; }
    else if (gag.kind === "flourish") { pose.arm = 1; pose.spark = p > 0.3; pose.ember = p; }
  }
  return pose;
}

type Pixel = (x: number, y: number, w: number, h: number, colour: string) => void;

/** What a character carries in its hand, by the class it was hired as: period props only, never anything from outside the tavern. */
export function drawTool(px: Pixel, x: number, y: number, dir: number, cls: string | null, p: CharacterPalette) {
  if (cls === "smith") { // a smith's hammer
    if (dir === 2) { px(x, y, 2, 1, p.wood); px(x + 2, y - 1, 2, 3, p.metal); }
    else if (dir === 0) { px(x, y - 1, 1, 2, p.wood); px(x - 1, y - 2, 3, 1, p.metal); }
    else { px(x, y, 1, 2, p.wood); px(x - 1, y + 2, 3, 1, p.metal); }
  } else if (cls === "keeper") { // the Keeper's quill and ink
    if (dir === 2) { px(x, y, 3, 1, p.card); px(x + 3, y, 1, 1, p.ink); }
    else if (dir === 0) { px(x, y - 2, 1, 2, p.card); px(x, y - 3, 1, 1, p.ink); }
    else { px(x, y, 1, 2, p.card); px(x, y + 2, 1, 1, p.ink); }
  } else if (cls === "wanderer") { // a lantern
    if (dir === 2) { px(x, y - 1, 2, 2, p.hearth); px(x - 1, y - 2, 1, 1, p.metal); px(x + 2, y - 2, 1, 1, p.metal); }
    else { px(x, y, 1, 2, p.hearth); px(x, y - 1, 1, 1, p.metal); }
  } else if (cls) { // a ranger's or warden's spyglass
    if (dir === 2) { px(x, y, 3, 1, p.metal); px(x + 3, y, 1, 1, p.wood); }
    else if (dir === 0) { px(x, y - 2, 1, 3, p.metal); }
    else { px(x, y, 1, 3, p.metal); }
  }
}

/** A light in the free hand for the dark: a lantern hung from it or a lit torch held up, its glass or flame lit. */
export function drawLight(px: Pixel, x: number, y: number, kind: "lantern" | "torch", p: CharacterPalette) {
  if (kind === "lantern") {
    px(x, y, 1, 1, p.metal);                        // the bail, in the hand
    px(x - 1, y + 1, 3, 1, p.metal);                 // cap
    px(x - 1, y + 2, 1, 2, p.metal); px(x + 1, y + 2, 1, 2, p.metal);
    px(x, y + 2, 1, 2, p.card);                      // the glass, lit
    px(x, y + 3, 1, 1, p.hearth);
    px(x - 1, y + 4, 3, 1, p.metal);                 // base
  } else {
    px(x, y - 3, 1, 1, p.card);                      // the flame
    px(x, y - 2, 1, 1, p.hearth);
    px(x - 1, y - 1, 1, 1, p.hearth); px(x + 1, y - 1, 1, 1, p.hearth);
    px(x, y, 1, 3, p.wood);                          // the handle, in the hand
  }
}

/**
 * The heraldic charge a character wears on its chest, 5x5 and centred, in the card colour on its torso: each walker carries its own badge,
 * the same charge the crest cuts out of its field. `#` is a pixel. Characters with no charge ("no character") wear none.
 */
export const CHARGE_PIXELS: Record<CharacterDef["charge"], readonly string[]> = {
  chevron: ["..#..", ".#.#.", "#...#", ".....", "....."],
  fess: [".....", ".....", "#####", ".....", "....."],
  cross: ["..#..", "..#..", "#####", "..#..", "..#.."],
  bend: ["#....", ".#...", "..#..", "...#.", "....#"],
  star: ["..#..", ".###.", "#####", ".#.#.", "#...#"],
  pale: ["..#..", "..#..", "..#..", "..#..", "..#.."],
  saltire: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  chief: ["#####", ".....", ".....", ".....", "....."],
  dots: [".....", ".#.#.", ".....", "..#..", "....."],
};

/**
 * One frame of pixel art, part by part, back to front: the shadow on the ground, the legs, the cloak a Keeper wears, the torso in the
 * character's hue, the arms (the right one swings a tool), the head with its hair and hat, the eyes, and the weather over it all. The
 * draw is pure: the same look, palette, pose, class and `flame` always give the same pixels. In the dark it adds the charge, an in-hand
 * light and its flickering glow; `flame` is that flicker at this instant (1 is a steady fire), so the caller owns the clock.
 */
export function drawCharacter(input: { ctx: CanvasRenderingContext2D; hue: string; look: CharacterLook; palette: CharacterPalette; pose: CharacterPose; cls?: string | null; keeper?: boolean; charge?: CharacterDef["charge"] | null; flame?: number; dir?: number }): void {
  const { ctx: g, hue: hueName, look, palette: p, pose, cls = null, keeper = false, charge = null, flame = 1, dir = 0 } = input;
  const { width: GW, height: GH, ground: GROUND, centre: CX } = CHARACTER_GRID;
  const bw = bodyWidth(look);
  const hue = p.hue[hueName] ?? p.hue.ink!;
  const skin = p.skin[Math.max(0, LOOK_SKINS.indexOf(look.skin))] ?? p.skin[0]!;
  const hair = p.hair[Math.max(0, LOOK_HAIR_COLOURS.indexOf(look.hairColour))] ?? p.hair[0]!;
  const px: Pixel = (x, y, w, h, colour) => { g.fillStyle = colour; g.fillRect(x, y, w || 1, h || 1); };
  g.clearRect(0, 0, GW, GH);
  //
  // The light's pool, in the dark: a flat, chunky ellipse on the road under the feet, painted one pixel at a time in three bands (dimmer
  // outward), never a smooth ball and never a ring around the character. Drawn before the sprite, so the character stands in front of its
  // own light. `dir` leans the pool a pixel toward the way it walks.
  if (p.dark && look.light !== "none") {
    const cx = CX + dir, cy = GROUND + 1;
    const flick = Math.min(1.25, Math.max(0.7, flame));
    const bands: readonly (readonly [number, number, number])[] = [[11.5, 3.6, 0.1], [7.5, 2.5, 0.16], [4.5, 1.6, 0.24]];
    const before = typeof g.globalCompositeOperation === "string" ? g.globalCompositeOperation : null;
    g.save();
    g.globalCompositeOperation = "lighter";
    g.fillStyle = p.hearth;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      let alpha = 0;
      for (const [rx, ry, a] of bands) if ((dx / rx) * (dx / rx) + (dy / ry) * (dy / ry) <= 1) alpha = a;
      if (!alpha) continue;
      g.globalAlpha = Math.min(1, alpha * flick);
      g.fillRect(x, y, 1, 1);
    }
    g.restore();
    if (before !== null) g.globalCompositeOperation = before;
  }
  const lift = pose.bob + pose.jump;
  const gy = GROUND - lift, legTop = gy - 4, bodyTop = legTop - look.torso, headTop = bodyTop - look.head;
  const eyeY = headTop + Math.floor(look.head / 2) - 1 + (pose.lookUp ? -1 : 0);
  /* the shadow stays on the ground, however high the hop */
  px(CX - bw / 2 - 1, GROUND, bw + 2, 1, p.shadow);
  px(CX - 3, legTop, 2, 4, p.pants); px(CX + 1, legTop, 2, 4, p.pants);
  /* a Keeper's cloak: one pixel wider than the body and one lower, so its silhouette never matches anybody else's */
  if (keeper) px(CX - bw / 2 - 1, bodyTop + 1, bw + 2, look.torso + 1, p.cloak);
  px(CX - bw / 2, bodyTop, bw, look.torso, hue);
  px(CX - bw / 2, bodyTop + look.torso - 2, bw, 1, p.belt);
  /* the hearth-light a Keeper carries at its belt */
  if (keeper) { px(CX - bw / 2, bodyTop + look.torso - 3, 1, 2, p.hearth); px(CX + bw / 2 - 1, bodyTop + look.torso - 3, 1, 2, p.hearth); }
  /* the character's charge on its chest, between the shoulders and the belt: the same badge its crest cuts out, drawn in pixels */
  if (charge) {
    const rows = CHARGE_PIXELS[charge];
    const cy = bodyTop + Math.floor(Math.max(0, look.torso - 7) / 2);
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < 5; c++) if (rows[r]![c] === "#") px(CX - 2 + c, cy + r, 1, 1, p.card);
  }
  const armLen = look.torso - 3, sy = bodyTop + 1, lx = CX - bw / 2 - 1, sxr = CX + bw / 2;
  if (pose.wave) { const s = pose.jump & 1; px(lx + s - 1, sy - 4, 1, 4, hue); px(lx + s - 1, sy - 5, 1, 1, skin); }
  else if (!pose.err) { px(lx, sy, 1, armLen, hue); px(lx, sy + armLen, 1, 1, skin); }
  else { px(lx, sy + 1, 1, armLen, hue); px(lx, sy + 1 + armLen, 1, 1, skin); }
  if (pose.arm === 0) { px(sxr, sy, 1, armLen, hue); px(sxr, sy + armLen, 1, 1, skin); drawTool(px, sxr + 1, sy + armLen - 1, 1, cls, p); }
  else if (pose.arm === 1) { px(sxr, sy - 4, 1, 4, hue); px(sxr, sy - 5, 1, 1, skin); drawTool(px, sxr, sy - 6, 0, cls, p); }
  else {
    px(sxr + 1, sy, 2, 1, hue); px(sxr + 3, sy, 1, 1, skin); drawTool(px, sxr + 4, sy - 1, 2, cls, p);
    if (pose.spark) { px(sxr + 7, sy - 2, 1, 1, p.hearth); px(sxr + 8, sy, 1, 1, p.hearth); px(sxr + 7, sy + 2, 1, 1, p.hearth); }
  }
  /* head: the hair, then the hat over it */
  const hy = headTop + (pose.slump ? 1 : 0);
  px(CX - 4, hy, 8, look.head, skin);
  if (look.hair === "flat") px(CX - 4, hy, 8, 2, hair);
  else if (look.hair === "spiky") { px(CX - 4, hy, 8, 1, hair); px(CX - 3, hy - 1, 1, 1, hair); px(CX - 1, hy - 1, 1, 1, hair); px(CX + 1, hy - 1, 1, 1, hair); }
  else if (look.hair === "long") { px(CX - 4, hy, 8, 2, hair); px(CX - 5, hy + 1, 1, 3, hair); px(CX + 4, hy + 1, 1, 3, hair); }
  if (look.hat === "cap") { px(CX - 4, hy - 2, 8, 2, hue); px(CX - 5, hy, 9, 1, hue); }
  else if (look.hat === "pointy") { for (let i = 0; i < 4; i++) px(CX - (4 - i), hy - 1 - i, 8 - 2 * i, 1, hue); }
  if (pose.blink || pose.slump) { px(CX - 3, eyeY + 1, 1, 1, p.ink); px(CX + 1, eyeY + 1, 1, 1, p.ink); }
  else { px(CX - 3 + pose.lookSide, eyeY, 1, 2, p.ink); px(CX + 1 + pose.lookSide, eyeY, 1, 2, p.ink); }
  px(CX - 1, eyeY + 3, 2, 1, p.ink);
  /* a Keeper's ember, rising off its belt light */
  if (pose.ember > 0) { const rise = Math.round(pose.ember * 6); px(CX + 2, bodyTop - 2 - rise, 1, 1, p.hearth); if (rise > 3) px(CX, bodyTop - 2 - (rise - 3), 1, 1, p.hearth); }
  /*
  /* In the dark a free hand carries a light: a lantern hung from it or a lit torch held up. Its pool on the road was painted before the
     sprite; here only the light itself is drawn. */
  if (p.dark && look.light !== "none") {
    const hx = lx - 1, hy = sy + armLen;
    drawLight(px, hx, hy, look.light, p);
  }
  /* the rain cloud that comes with a failed step */
  if (pose.err) {
    const cy = headTop - 7;
    px(CX - 5, cy + 1, 8, 2, p.cloud); px(CX - 4, cy, 5, 1, p.cloud); px(CX + 1, cy, 3, 1, p.cloud);
    for (let i = 0; i < 3; i++) { const dy = (pose.rain + i * 1.7) % 5; px(CX - 4 + i * 3, cy + 3 + Math.floor(dy), 1, 1, p.drop); }
  }
}

export type TavernCharacterProps = {
  /** The character to draw. Its id seeds the look; its `look:` traits, hue and charge come from its file. */
  character: Pick<CharacterDef, "id" | "name" | "hue" | "charge" | "look">;
  /** The class whose shape the chest badge takes, from the crest system. */
  cls?: Pick<ClassDef, "shape" | "label"> | null;
  /** The class id, which decides the tool in its hand. */
  classId?: string | null;
  state?: CharacterState;
  /** Target width in px; snapped to a whole multiple of the 24 px grid, so no pixel is ever cut in half. */
  size?: number;
  /** What it says when clicked. */
  line?: string;
  surface: Surface;
  /** Pins the motion; left out, the Motion setting decides (`characterMode`). */
  mode?: CharacterMode;
  ambientMotion?: AmbientMotion;
  /** Seconds between gags in interval mode. */
  repeatSeconds?: number;
  /** A Keeper is drawn with its cloak, its belt light and its own rising ember. */
  keeper?: boolean;
  /** False inside another control: the sprite is then a picture, so it never nests a button. */
  interactive?: boolean;
  /** Set for a sprite in the widget row: the coordinator then holds it whenever the row is held. */
  region?: "widget";
  className?: string;
};

/**
 * A character, drawn. Idle, working, needs-you and error are the thread's own state, not a mood: the caller maps it with `characterState`.
 * Hover turns its head (a notice reaction); a click hops and says the character's line in a bubble. Everything automatic goes through the
 * coordinator, so a character holds still while you type, while its widget row is held by an ask, and whenever motion is reduced.
 */
export function TavernCharacter({
  character, cls = null, classId = null, state = "idle", size = 24, line, surface, mode, ambientMotion = "calm",
  repeatSeconds = 7, keeper = false, interactive = true, region, className,
}: TavernCharacterProps) {
  // The coordinator's listeners must be up before the first reduced-motion read, so a character never starts moving and then stops.
  motion.install();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLElement | null>(null);
  const context = useRef<CanvasRenderingContext2D | null>(null);
  const palette = useRef<CharacterPalette | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const gags = useRef(0);
  const [bubble, setBubble] = useState<string | null>(null);
  const [gag, setGag] = useState<{ kind: CharacterGag; start: number; until: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [dark, setDark] = useState(false);

  const reduced = useSyncExternalStore(motion.subscribe, motion.getReduced, () => false);
  const paused = useSyncExternalStore(motion.subscribe, motion.getPaused, () => false);
  const look = useMemo(() => characterLook(character), [character.id, character.look]);
  const scale = Math.max(1, Math.round(size / CHARACTER_GRID.width));
  const still = ambientMotion === "off" || reduced;
  const settings: CharacterMode = characterMode(ambientMotion, mode);
  const looping = settings === "continuous" && !still && visible && !paused;

  // The 2D context is asked for once: an environment without canvas (a test) answers "no" forever, and asking again is pure noise.
  const context2d = useCallback(() => (context.current ??= canvas.current?.getContext("2d") ?? null), []);
  const draw = useCallback((ts: number) => {
    const ctx = context2d();
    if (!ctx) return;
    palette.current ??= readPalette(wrap.current);
    ctx.imageSmoothingEnabled = false;
    const flame = still ? 1 : fireFlicker(ts, look.blinkOff);
    const pose = characterPose({ look, state, ts, mode: still ? "interval" : settings, keeper, gag: gag ? { kind: gag.kind, progress: (ts - gag.start) / Math.max(1, gag.until - gag.start) } : null });
    drawCharacter({ ctx, hue: character.hue, look, palette: palette.current, pose, cls: classId, keeper, charge: character.charge, flame });
    wrap.current?.style.setProperty("--tchar-flicker", flame.toFixed(3));
  }, [look, state, settings, still, keeper, classId, gag, character.hue, character.charge]);

  // One still frame whenever anything the drawing depends on changes: that is the whole of reduced motion, and the first paint.
  useLayoutEffect(() => {
    if (canvas.current && context2d()) draw(performance.now());
  }, [draw, context2d, scale, visible]);

  // Whether the page is dark decides the in-hand light and its halo: read it with the palette, and again on a theme switch.
  useLayoutEffect(() => { palette.current ??= readPalette(wrap.current); setDark(!!palette.current?.dark); }, []);

  // The theme can change under us (bb's dark switch, a whole different theme): read the palette again and repaint.
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || !canvas.current) return;
    const observer = new MutationObserver(() => { palette.current = readPalette(wrap.current); setDark(!!palette.current?.dark); draw(performance.now()); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer.disconnect();
  }, [draw]);

  // Visibility is a real question: an off-screen character must keep no frame loop and no timer.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const shown = getComputedStyle(el).visibility !== "hidden";
    const hasObserver = typeof IntersectionObserver !== "undefined";
    const inViewport = () => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
    // Until the observer reports, a character is taken as visible: its first frame is what a reader actually sees.
    setVisible(shown && (hasObserver || inViewport()));
    if (!hasObserver) {
      const fallback = () => setVisible(shown && inViewport());
      window.addEventListener("scroll", fallback, true);
      window.addEventListener("resize", fallback);
      return () => { window.removeEventListener("scroll", fallback, true); window.removeEventListener("resize", fallback); };
    }
    const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.target === el) setVisible(shown && entry.isIntersecting); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Fire one gag, and end it when its cue does (its class's animation ends, or the coordinator cuts it). Automatic gags go through the
   * coordinator as ambient cues, so the holds and the budgets can refuse them; a person's own hover and click pass `auto: false`, so they
   * always land. A refused gag never draws, and lands nothing on the sprite.
   */
  const fireGag = useCallback((kind: CharacterGag, auto: boolean) => {
    const el = wrap.current;
    if (!el || still) return;
    const ms = CHARACTER_GAG_MS[kind];
    const now = performance.now();
    const running = { kind, start: now, until: now + ms };
    const accepted = motion.cue(surface, el, "character gag", {
      key: `${character.id}:gag:${(gags.current += 1)}`, ms, className: `mo-char-${kind}`, auto, region,
      onDone: () => setGag(g => (g === running ? null : g)),
    });
    if (accepted) setGag(running);
  }, [surface, character.id, region, still]);

  // Interval mode: one gag every repeatSeconds, from the state's own list, staggered per character so a row never moves in unison.
  useEffect(() => {
    if (settings !== "interval" || still || !visible) return;
    const list = GAGS_BY_STATE[state];
    let turn = look.blinkOff + state.length;
    const timer = setInterval(() => { turn += 1; fireGag(list[turn % list.length]!, true); }, Math.max(2, repeatSeconds) * 1000);
    return () => clearInterval(timer);
  }, [settings, still, visible, state, repeatSeconds, fireGag, look.blinkOff]);

  // A state change gets its own reaction, but only where a person can see it happen.
  const previous = useRef(state);
  useEffect(() => {
    if (previous.current === state) return;
    previous.current = state;
    if (visible) fireGag(state === "error" ? "drop" : state === "needs-you" ? "notice" : state === "working" ? "tap" : "wave", true);
  }, [state, visible, fireGag]);

  const drawRef = useRef(draw); drawRef.current = draw;
  const drawing = looping || gag !== null;
  useEffect(() => {
    const el = wrap.current;
    if (!el || still || !drawing) return;
    const world = observeWorld(el, {
      mode: () => "lively",
      update: () => {},
      draw: () => drawRef.current(performance.now()),
    });
    return world.remove;
  }, [still, drawing]);

  useEffect(() => () => clearTimeout(bubbleTimer.current), []);

  const say = useCallback((text: string) => {
    setBubble(text);
    clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setBubble(null), 2600);
  }, []);

  const label = `${character.name}, ${cls?.label ?? "no class"}${keeper ? ", Keeper" : ""}, ${CHARACTER_STATE_WORD[state]}`;
  const style: CSSProperties = { "--tchar-w": `${CHARACTER_GRID.width * scale}px`, "--tchar-h": `${CHARACTER_GRID.height * scale}px` } as CSSProperties;
  const host: RefCallback<HTMLElement> = useCallback(el => { wrap.current = el; }, []);
  const lit = dark && look.light !== "none";
  const body = <>
    {lit && <span className="tchar-glow" aria-hidden="true" />}
    <canvas ref={canvas} className="tchar-art" width={CHARACTER_GRID.width} height={CHARACTER_GRID.height} style={{ width: "var(--tchar-w)", height: "var(--tchar-h)" }} role="img" aria-label={label} />
    {state === "needs-you" && <span className="tchar-need" aria-hidden="true">!</span>}
    {bubble && <span className="tchar-say" role="status">{bubble}</span>}
  </>;
  const shell = `tchar st-${state} ${keeper ? "is-keeper" : ""} ${className ?? ""}`.trim();
  const shared = { className: shell, style, "data-part": "TavernCharacter", "data-state": state, "data-keeper": keeper || undefined, "data-mode": settings, "data-lit": lit || undefined };
  if (!interactive) return <span ref={host} {...shared} title={label}>{body}</span>;
  return (
    <button
      ref={host as RefCallback<HTMLButtonElement>} type="button" {...shared} className={`${shell} act`} data-role="character"
      title={line ? `${label} · click for a word` : label} aria-label={line ? `${label}. Click for a word.` : label}
      onPointerEnter={() => fireGag("notice", false)}
      onClick={() => { fireGag("hop", false); if (line) say(line); }}
    >{body}</button>
  );
}
