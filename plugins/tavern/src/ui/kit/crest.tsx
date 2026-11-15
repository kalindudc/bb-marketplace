import { memo, useId } from "react";
import type { CharacterDef, ClassDef } from "../../shared/schema";
import { CREST_EDGE_CSS, CREST_INLAY_PATHS, CREST_RING_PATHS, CREST_SMALL_BELOW, HUE_CSS, crestPath, crestRingPath } from "../../shared/heraldry";
import { MAX_NOTCHES } from "./level";

type Shape = ClassDef["shape"];

/**
 * A character's crest, back to front: an inlay in the page colour, the class shape in the character's hue with the charge cut sharp, and
 * a thin keyline. `level` (from `levelOf`) cuts one notch per level past the first into the keyline, at most five, on crests of 24 px
 * and up; below that a notch doesn't read. The cut shows the surface behind, and its two sides carry the ring's own two layers (the hue,
 * then the keyline), so a notch reads as carved, as strongly as the ring, on a light field as on a dark one.
 */
export const Crest = memo(function Crest({ cls, character, size = 20, title, level }: { cls: Pick<ClassDef, "shape" | "label">; character: Pick<CharacterDef, "hue" | "charge" | "name"> & { plain?: boolean }; size?: number; title?: string; level?: number }) {
  const id = `tavern-notch-${useId().replace(/[^\w-]/g, "")}`;
  const notches = level !== undefined && !character.plain && size >= CREST_SMALL_BELOW ? Math.min(Math.max(level - 1, 0), MAX_NOTCHES) : 0;
  const label = title ?? (character.plain ? `${character.name}, no character` : `${character.name}, ${cls.label}${notches ? `, level ${level}` : ""}`);
  const paths = character.plain ? <PlainCrestPaths shape={cls.shape} size={size} /> : <CrestPaths shape={cls.shape} hue={character.hue} charge={character.charge} size={size} />;
  return (
    <svg className="tavern-crest" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label} style={{ flex: "none" }} data-notches={notches || undefined}>
      {notches ? <>
        <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x="-1" y="-1" width="26" height="26">
          <rect x="-1" y="-1" width="26" height="26" fill="white" />
          <path d={NOTCH_PATHS[cls.shape][notches - 1]} fill="black" />
        </mask>
        <clipPath id={`${id}-f`}><path d={FIELD_PATHS[cls.shape]} /></clipPath>
        <g mask={`url(#${id}-m)`}>
          {paths}
          {/* The keyline along each V, layered as the ring is (the hue, then the keyline over it), so a cut over a light field reads as
              strongly as the ring. A 2-unit stroke on the V's sides, half of it masked away with the cut, clipped to the field inside the
              ring. One path per layer, so crossings paint once. */}
          <path d={NOTCH_SIDES[cls.shape][notches - 1]} fill="none" stroke={HUE_CSS[character.hue]} strokeWidth={2} strokeLinejoin="round" clipPath={`url(#${id}-f)`} />
          <path d={NOTCH_SIDES[cls.shape][notches - 1]} fill="none" stroke={CREST_EDGE_CSS} strokeWidth={2} strokeLinejoin="round" clipPath={`url(#${id}-f)`} />
        </g>
      </> : paths}
    </svg>
  );
});

/**
 * Where each shape takes its notches: along its plainest edge, centred as one group. The top edge for the shield, square and pennant;
 * the left side for the tower, whose top is crenellated and whose base keyline is too thin to carry a cut; the upper-left edge for the
 * lozenge; the top of the roundel's arc. Each notch is a V, 1.5 units wide at the edge and 2.6 deep (2.6 px on a 24 px crest), through
 * the 1-unit keyline into the field, and the gap between two notches is as wide as a notch, so five read as five marks, never as a saw
 * edge. Five span 13.5 units, which every edge holds.
 */
const NOTCH = { width: 1.5, pitch: 3, out: 0.6, in: 2.6 };
type Edge = { c: [number, number]; d: [number, number]; n: [number, number] } | { arc: { cx: number; cy: number; r: number; at: number } };
const H = Math.SQRT1_2;
const NOTCH_EDGES: Record<Shape, Edge> = {
  shield: { c: [12, 1.5], d: [1, 0], n: [0, 1] },
  square: { c: [12, 2.75], d: [1, 0], n: [0, 1] },
  pennant: { c: [13.25, 1.5], d: [1, 0], n: [0, 1] },
  tower: { c: [3, 13], d: [0, 1], n: [1, 0] },
  lozenge: { c: [6.125, 6.125], d: [H, -H], n: [H, H] },
  roundel: { arc: { cx: 12, cy: 12, r: 10.75, at: -Math.PI / 2 } },
};
/** The notches as closed Vs (`sides: false`, the mask) or as each V's two sides alone (`sides: true`, the keyline along the cut). */
export function notchPath(shape: Shape, count: number, sides = false): string {
  const e = NOTCH_EDGES[shape];
  let path = "";
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * NOTCH.pitch;
    let c: [number, number], d: [number, number], n: [number, number];
    if ("arc" in e) {
      const a = e.arc.at + off / e.arc.r;
      c = [e.arc.cx + e.arc.r * Math.cos(a), e.arc.cy + e.arc.r * Math.sin(a)]; d = [-Math.sin(a), Math.cos(a)]; n = [-Math.cos(a), -Math.sin(a)];
    } else { c = [e.c[0] + off * e.d[0], e.c[1] + off * e.d[1]]; d = e.d; n = e.n; }
    const pt = (u: number, v: number) => `${+(c[0] + u * d[0] + v * n[0]).toFixed(2)} ${+(c[1] + u * d[1] + v * n[1]).toFixed(2)}`;
    // The V's sides run on past the edge, so the cut opens cleanly through the keyline's antialiasing.
    const w = NOTCH.width / 2, spread = w * (1 + NOTCH.out / NOTCH.in);
    path += sides ? `M${pt(-spread, -NOTCH.out)}L${pt(0, NOTCH.in)}L${pt(spread, -NOTCH.out)}` : `M${pt(-spread, -NOTCH.out)}L${pt(spread, -NOTCH.out)}L${pt(0, NOTCH.in)}Z`;
  }
  return path;
}
const notchTable = (sides: boolean) => Object.fromEntries(Object.keys(NOTCH_EDGES).map(shape => [shape, Array.from({ length: MAX_NOTCHES }, (_, i) => notchPath(shape as Shape, i + 1, sides))])) as Record<Shape, string[]>;
const NOTCH_PATHS = notchTable(false);
const NOTCH_SIDES = notchTable(true);
/** The field inside each 24 px-and-up keyline: the ring path's second subpath. */
const FIELD_PATHS = Object.fromEntries(Object.entries(CREST_RING_PATHS).map(([shape, ring]) => [shape, ring.slice(ring.indexOf("M", 1))])) as Record<Shape, string>;

/** A member with no character: its class's shape in a neutral fill, with no charge, so it reads as the class and as nobody in particular. */
export const PLAIN_CREST_CSS = "color-mix(in oklab, var(--foreground) 36%, var(--background))";
export function PlainCrestPaths({ shape, size }: { shape: ClassDef["shape"]; size: number }) {
  return <>
    <path d={CREST_INLAY_PATHS[shape]} fill={PLAIN_CREST_CSS} />
    <path d={crestRingPath(shape, size)} fill={CREST_EDGE_CSS} />
  </>;
}

export const CrestPaths = memo(function CrestPaths({ shape, hue, charge, size }: { shape: ClassDef["shape"]; hue: CharacterDef["hue"]; charge: CharacterDef["charge"]; size: number }) {
  return <>
    <path d={CREST_INLAY_PATHS[shape]} fill="var(--background)" />
    <path d={crestPath(shape, charge, size)} fill={HUE_CSS[hue]} fillRule="evenodd" />
    <path d={crestRingPath(shape, size)} fill={CREST_EDGE_CSS} />
  </>;
});
