import type { ArtFrame, ClassLight, LightAnchor } from "./art";

const CELL = 4;
export const LANTERN_RADIUS = 176;
export const LANTERN_BANDS = [0.35, 0.66, 1] as const;
export const LANTERN_STRENGTH = { low: 0.4, medium: 0.7, high: 1 } as const;
export function lanternAlpha(strength: keyof typeof LANTERN_STRENGTH, dark: boolean) {
  return LANTERN_STRENGTH[strength] * (dark ? 0.3 : 0.22);
}

const CLASS_GLOW = {
  runewood: { colour: "#9fdf9a", strength: 0.88 },
  shutter: { colour: "#ffd996", strength: 0.66 },
  ember: { colour: "#ff713b", strength: 0.96 },
  crystal: { colour: "#abacff", strength: 0.83 },
} satisfies Record<ClassLight, { colour: string; strength: number }>;

export function sourceGlow(kind: LightAnchor["kind"], colour: string, alpha: number) {
  const glow = Object.hasOwn(CLASS_GLOW, kind) ? CLASS_GLOW[kind as ClassLight] : null;
  return glow ? { colour: glow.colour, alpha: alpha * glow.strength } : { colour, alpha };
}

type Rect = { left: number; top: number; right: number; bottom: number };
export type LightSurface = { rect: Rect; clip?: Rect; rim?: readonly [top: number, right: number, bottom: number, left: number] };
export type LightSpan = Rect & { band: 1 | 2 | 3 };

export const roundToLightCell = (px: number) => Math.floor(px / CELL) * CELL + CELL / 2;
export const intersect = (a: Rect, b: Rect): Rect => ({
  left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom),
});
export const hasArea = ({ left, top, right, bottom }: Rect) => left < right && top < bottom;
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function facingRims({ left, top, right, bottom }: Rect, rim: NonNullable<LightSurface["rim"]>, x: number, y: number) {
  const [t, r, b, l] = rim;
  const edges: Rect[] = [];
  if (y <= top) edges.push({ left: left + t, top, right: right - t, bottom: Math.min(bottom, top + CELL) });
  if (y >= bottom) edges.push({ left: left + b, top: Math.max(top, bottom - CELL), right: right - b, bottom });
  if (x <= left) edges.push({ left, top: top + Math.max(CELL, l), right: Math.min(right, left + CELL), bottom: bottom - Math.max(CELL, l) });
  if (x >= right) edges.push({ left: Math.max(left, right - CELL), top: top + Math.max(CELL, r), right, bottom: bottom - Math.max(CELL, r) });
  return edges;
}

export function lightMap(anchor: LightAnchor, surfaces: readonly LightSurface[], exclusions: readonly Rect[]): LightSpan[] {
  const x = roundToLightCell(anchor.x), y = roundToLightCell(anchor.y);
  const reach = { left: x - LANTERN_RADIUS, right: x + LANTERN_RADIUS, top: y - LANTERN_RADIUS, bottom: y + LANTERN_RADIUS };
  const spans: LightSpan[] = [];
  for (const { rect, rim, clip } of surfaces) {
    for (const edge of rim ? facingRims(rect, rim, x, y) : [rect]) {
      const area = intersect(clip ? intersect(edge, clip) : edge, reach);
      if (!hasArea(area)) continue;
      const protectedRects = exclusions.filter(rect => overlaps(area, rect));
      for (let row = Math.floor(area.top / CELL) * CELL; row < area.bottom; row += CELL) {
        let run: LightSpan | undefined;
        for (let col = Math.floor(area.left / CELL) * CELL; col < area.right; col += CELL) {
          const d = (col + CELL / 2 - x) ** 2 + (row + CELL / 2 - y) ** 2;
          const band = d >= LANTERN_RADIUS ** 2 ? 0 : d >= (LANTERN_RADIUS * 0.74) ** 2 ? 1 : d >= (LANTERN_RADIUS * 0.52) ** 2 ? 2 : 3;
          const cell = intersect(area, { left: col, top: row, right: col + CELL, bottom: row + CELL });
          if (!band || protectedRects.some(rect => overlaps(cell, rect))) { run = undefined; continue; }
          if (run?.band === band) run.right = cell.right;
          else spans.push(run = { ...cell, band });
        }
      }
    }
  }
  return spans;
}

function oval(x: number, y: number, rx: number, ry: number): LightSpan[] {
  const spans: LightSpan[] = [];
  for (let dy = -ry; dy < ry; dy += CELL) for (let dx = -rx; dx < rx; dx += CELL) {
    const d = ((dx + CELL / 2) / rx) ** 2 + ((dy + CELL / 2) / ry) ** 2;
    if (d >= 1) continue;
    spans.push({ left: x + dx, top: y + dy, right: x + dx + CELL, bottom: y + dy + CELL, band: d >= 0.6 ? 1 : d >= 0.22 ? 2 : 3 });
  }
  return spans;
}

const haloPattern = oval(0, 0, 24, 24);
const poolPattern = oval(0, 0, 60, 8);
export const DAY_SHADOW_CELLS = oval(0, 0, 20, 8);
export function lanternIslands(x: number, y: number, foot: number) {
  const place = (pattern: LightSpan[], cy: number) => pattern.map(span => ({ ...span,
    left: span.left + x, right: span.right + x, top: span.top + cy, bottom: span.bottom + cy,
  }));
  return { halo: place(haloPattern, y), pool: place(poolPattern, foot) };
}

export function sameLightMap(a: readonly LightSpan[], b: readonly LightSpan[]) {
  return a.length === b.length && a.every((span, i) => {
    const next = b[i]!;
    return span.band === next.band && span.left === next.left && span.top === next.top && span.right === next.right && span.bottom === next.bottom;
  });
}

export function holdsLantern(frame: ArtFrame, typing: boolean, held: boolean, motionOff: boolean) {
  return frame.still || typing || held || motionOff || (frame.activity !== "walk" && frame.activity !== "cue");
}

type LanternListener = (strip: HTMLElement, anchor: LightAnchor | null) => void;
const carriers = new Map<HTMLElement, LightAnchor>();
const listeners = new Set<LanternListener>();
const presenceListeners = new Set<() => void>();

export const hasStripLantern = () => carriers.size > 0;
export function subscribeLanternPresence(listener: () => void) {
  presenceListeners.add(listener);
  return () => { presenceListeners.delete(listener); };
}

export function connectStripLantern(strip: HTMLElement) {
  let pose: string | undefined;
  const publish = (anchor: LightAnchor | null, steady = false, nextPose?: string) => {
    const previous = carriers.get(strip);
    const changedPose = nextPose !== pose;
    pose = nextPose;
    if (!anchor && !previous) return;
    if (anchor && previous?.kind === anchor.kind && ((steady && !changedPose &&
        Math.abs(previous.x - anchor.x) < CELL * 2 && Math.abs(previous.y - anchor.y) < CELL * 2) ||
        (previous.x === anchor.x && previous.y === anchor.y))) return;
    const wasPresent = hasStripLantern();
    if (anchor) carriers.set(strip, anchor);
    else carriers.delete(strip);
    for (const listener of listeners) listener(strip, anchor);
    if (wasPresent !== hasStripLantern()) for (const listener of presenceListeners) listener();
  };
  return publish;
}

export function subscribeStripLantern(listener: LanternListener) {
  listeners.add(listener);
  for (const [strip, anchor] of carriers) listener(strip, anchor);
  return () => { listeners.delete(listener); };
}
