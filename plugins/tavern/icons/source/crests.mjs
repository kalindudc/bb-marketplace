// Generates src/shared/heraldry.ts: Tavern's crests on a 24x24 grid.
//
// A crest is three filled paths, back to front: an inlay in var(--background) under the field,
// the silhouette in the character's hue with the charge cut out of it (fill-rule evenodd), and a
// thin keyline ring round the silhouette in a subtle foreground mix. The silhouette is the class;
// the charge runs sharp to the keyline, and the keyline keeps the outline whole. Two cuts: SMALL
// (bolder charges and keyline, under 24 px, such as sidebar rows) and standard.
//
// Run from plugins/tavern:  PAPER=/path/to/node_modules/paper node icons/source/crests.mjs
// paper.js does the boolean operations; it is a scratch dependency (npm i paper@0.12 in any
// folder), not one of the plugin's.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const paper = require(path.join(process.env.PAPER ?? "paper", "dist/paper-core.js"));
paper.setup(new paper.Size(24, 24));

const OUT = process.argv[2] ?? "src/shared/heraldry.ts";
const JSON_OUT = process.argv[3];

// ---------- geometry helpers ----------
const d = pts => "M" + pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join("L") + "Z";
const r2 = n => +n.toFixed(2);
function area(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; } return a / 2; }
/** Inset a simple polygon by r with mitred corners. */
function inset(pts, r) {
  const sign = area(pts) > 0 ? 1 : -1; // y points down: positive area is clockwise on screen
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]; const dx = q[0] - p[0], dy = q[1] - p[1]; const len = Math.hypot(dx, dy);
    const nx = -dy / len * sign, ny = dx / len * sign; // inward normal
    return { p: [p[0] + nx * r, p[1] + ny * r], v: [dx, dy] };
  });
  return lines.map((l, i) => {
    const a = lines[(i - 1 + lines.length) % lines.length], b = l;
    const det = a.v[0] * b.v[1] - a.v[1] * b.v[0];
    const t = ((b.p[0] - a.p[0]) * b.v[1] - (b.p[1] - a.p[1]) * b.v[0]) / det;
    return [a.p[0] + a.v[0] * t, a.p[1] + a.v[1] * t];
  });
}
const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
const P = s => new paper.CompoundPath(s);
const circle = (r, cx = 12, cy = 12) => `M${r2(cx - r)} ${cy}A${r2(r)} ${r2(r)} 0 1 1 ${r2(cx + r)} ${cy}A${r2(r)} ${r2(r)} 0 1 1 ${r2(cx - r)} ${cy}Z`;

// ---------- silhouettes (the class) ----------
// Shield: square top, straight flanks, then two arcs to the point. Insetting keeps the arc centres.
const SH = { x1: 2.5, x2: 21.5, top: 1.5, flank: 8.5, point: 22.5 };
function shield(i) {
  const w = (SH.x2 - SH.x1) / 2, h = SH.point - SH.flank, R = (w * w + h * h) / (2 * w);
  const r = R - i, cxL = SH.x1 + R, dx = 12 - cxL;
  const yP = SH.flank + Math.sqrt(r * r - dx * dx);
  return `M${r2(SH.x1 + i)} ${r2(SH.top + i)}H${r2(SH.x2 - i)}V${SH.flank}A${r2(r)} ${r2(r)} 0 0 1 12 ${r2(yP)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(SH.x1 + i)} ${SH.flank}Z`;
}
// Pennant: a swallowtailed flag flying from a staff, so it reads as a flag even at 14 px.
const FLAG = [[4.5, 1.5], [23, 1.5], [18.75, 9.5], [23, 17.5], [4.5, 17.5]];
const STAFF = rect(1.75, 0.5, 4.5, 23.5);
// The staff is the flag's keyline on its hoist side, so the inner field starts right at the staff.
const flagAt = i => FLAG.map(([x, y]) => [x === 4.5 ? 4.5 - i : x, y]);
// Tower: a battlement of three merlons over a keep.
const TOWER = (() => { const x1 = 3, x2 = 21, top = 1.25, cren = 6, base = 22.75, gap = 3.5, m = (x2 - x1 - 2 * gap) / 3;
  return [[x1, base], [x1, top], [x1 + m, top], [x1 + m, cren], [x1 + m + gap, cren], [x1 + m + gap, top], [x1 + 2 * m + gap, top], [x1 + 2 * m + gap, cren], [x1 + 2 * m + 2 * gap, cren], [x1 + 2 * m + 2 * gap, top], [x2, top], [x2, base]]; })();
const TOWER_BODY = rect(3, 6, 21, 22.75);
const LOZENGE = [[12, 0.25], [23.75, 12], [12, 23.75], [0.25, 12]];
const SQUARE = rect(2.75, 2.75, 21.25, 21.25);

const SHAPES = {
  shield: { outer: () => shield(0), field: i => shield(i), ring: i => shield(i), inlay: () => shield(0.5), frame: { cx: 12, cy: 11.2, s: 0.92 } },
  pennant: { outer: () => P(d(FLAG)).unite(P(d(STAFF))).pathData, field: i => d(inset(flagAt(i), i)), ring: i => d(inset(flagAt(i), i)), inlay: () => d(inset(FLAG, 0.5)), frame: { cx: 11.4, cy: 9.5, s: 0.66 } },
  tower: { outer: () => d(TOWER), field: i => P(d(inset(TOWER_BODY, i))).intersect(P(d(inset(TOWER, i)))).pathData, ring: i => d(inset(TOWER, i)), inlay: () => d(inset(TOWER, 0.5)), frame: { cx: 12, cy: 14.4, s: 0.8 } },
  lozenge: { outer: () => d(LOZENGE), field: i => d(inset(LOZENGE, i)), ring: i => d(inset(LOZENGE, i)), inlay: () => d(inset(LOZENGE, 0.5)), frame: { cx: 12, cy: 12, s: 0.76 } },
  roundel: { outer: () => circle(10.75), field: i => circle(10.75 - i), ring: i => circle(10.75 - i), inlay: () => circle(10.25), frame: { cx: 12, cy: 12, s: 0.92 } },
  square: { outer: () => d(SQUARE), field: i => d(inset(SQUARE, i)), ring: i => d(inset(SQUARE, i)), inlay: () => d(inset(SQUARE, 0.5)), frame: { cx: 12, cy: 12, s: 0.9 } },
};
// Some charges need a little less room on a narrow field.
const FIT = { shield: { dots: 0.8, star: 0.88 }, pennant: { star: 0.62, dots: 0.6 }, lozenge: { star: 0.7, dots: 0.64, cross: 0.72 }, tower: { star: 0.74 } };

// ---------- charges (the character), in a frame centred on 0,0 for a 16-unit field ----------
function star(R, r, cy) { const pts = []; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r : R; pts.push([rr * Math.cos(a), cy + rr * Math.sin(a)]); } return [pts]; }
const band = (t, x1 = -30, x2 = 30) => rect(x1, -t / 2, x2, t / 2);
const vband = t => rect(-t / 2, -30, t / 2, 30);
function diag(t, flip = false) { const k = t / 2 / Math.SQRT1_2 / 2; const L = 30; const pts = [[-L - k, -L + k], [-L + k, -L - k], [L + k, L - k], [L - k, L + k]]; return flip ? pts.map(([x, y]) => [-x, y]) : pts; }
function chevron(apex, t) { const L = 30; return [[-L, apex + L], [0, apex], [L, apex + L], [L, apex + L + t], [0, apex + t], [-L, apex + L + t]]; }
// Fess dancetty: a band with parallel zigzag edges, peaks on the centre line. A plain fess or cross in a
// roundel reads as a minus or plus button, so these two charges are drawn sharp but unmistakable on every shape.
function dancetty(t, A, wl) { const top = [], bottom = []; for (let k = -6; k <= 6; k++) { const x = k * wl / 2, y = (k % 2 === 0 ? -A / 2 : A / 2); top.push([x, y - t / 2]); bottom.unshift([x, y + t / 2]); } return [...top, ...bottom]; }
// Cross pattée: four arms that flare from the centre and run sharp to the keyline.
function pattee(w0, slope) { const L = 30, w1 = w0 / 2 + slope * L; const arm = [[-w0 / 2, 0], [-w1, -L], [w1, -L], [w0 / 2, 0]]; return [0, 1, 2, 3].map(q => arm.map(([x, y]) => [[x, y], [-y, x], [-x, -y], [y, -x]][q])).concat([rect(-w0 / 2, -w0 / 2, w0 / 2, w0 / 2)]); }
const square = (cx, cy, s) => rect(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2);
const CUTS = {
  small: { edge: 1.4, chevron: [chevron(-5.5, 5.6)], fess: [dancetty(4.6, 3.2, 8)], pale: [vband(5.6)], cross: pattee(3.0, 0.36), bend: [diag(5.2)], saltire: [diag(4.4), diag(4.4, true)], star: star(7.4, 3.5, 0.7), chief: [rect(-30, -30, 30, -3.2)], dots: [square(0, -4.1, 4.8), square(-4.3, 3.5, 4.8), square(4.3, 3.5, 4.8)] },
  standard: { edge: 1.0, chevron: [chevron(-5.25, 4.6)], fess: [dancetty(3.8, 3, 8)], pale: [vband(4.8)], cross: pattee(2.4, 0.32), bend: [diag(4.4)], saltire: [diag(3.6), diag(3.6, true)], star: star(7.2, 2.95, 0.7), chief: [rect(-30, -30, 30, -3.6)], dots: [square(0, -4, 4), square(-4.2, 3.4, 4), square(4.2, 3.4, 4)] },
};
const CHARGES = ["chevron", "fess", "cross", "bend", "star", "pale", "saltire", "chief", "dots"];

function chargeShape(cut, shape, charge) {
  const f = SHAPES[shape].frame, s = FIT[shape]?.[charge] ?? f.s;
  const polys = CUTS[cut][charge].map(poly => poly.map(([x, y]) => [f.cx + x * s, f.cy + y * s]));
  return polys.map(p => P(d(p))).reduce((a, b) => a.unite(b));
}
const fmt = p => p.getPathData(null, 2).replace(/,/g, " ").replace(/ -/g, "-");
function crest(cut, shape, charge) {
  const sh = SHAPES[shape];
  const holes = chargeShape(cut, shape, charge).intersect(P(sh.field(CUTS[cut].edge)));
  return fmt(P(sh.outer()).subtract(holes));
}
// The keyline: the silhouette minus its inset. A pennant's staff is narrower than two keylines, so it is all keyline.
const ringPath = (cut, shape) => fmt(P(SHAPES[shape].outer()).subtract(P(SHAPES[shape].ring(CUTS[cut].edge))));

// Legacy charges for consumers that clip CHARGE_PATHS to SHAPE_PATHS: the standard cut on a generic field.
function legacyCharge(charge) {
  return CUTS.standard[charge].map(poly => P(d(poly.map(([x, y]) => [12 + x * 0.9, 12 + y * 0.9])))).reduce((a, b) => a.unite(b)).intersect(P(d(rect(0, 0, 24, 24))));
}

const shapes = Object.keys(SHAPES);
const table = cut => Object.fromEntries(shapes.map(s => [s, Object.fromEntries(CHARGES.map(c => [c, crest(cut, s, c)]))]));
const data = {
  SHAPE_PATHS: Object.fromEntries(shapes.map(s => [s, fmt(P(SHAPES[s].outer()))])),
  CHARGE_PATHS: Object.fromEntries(CHARGES.map(c => [c, [{ d: fmt(legacyCharge(c)) }]])),
  CREST_PATHS_SMALL: table("small"),
  CREST_PATHS: table("standard"),
  CREST_RING_PATHS_SMALL: Object.fromEntries(shapes.map(s => [s, ringPath("small", s)])),
  CREST_RING_PATHS: Object.fromEntries(shapes.map(s => [s, ringPath("standard", s)])),
  CREST_INLAY_PATHS: Object.fromEntries(shapes.map(s => [s, fmt(P(SHAPES[s].inlay()))])),
};

// Hues: bb theme tokens mixed in oklab, valid anywhere in bb (row icons sit outside .tavern).
// No status colour (success, warning, destructive, attention) and no diff colour: identity only.
// light-dark() picks by color-scheme, which bb sets per mode. Light mode keeps the rich mixes;
// dark mode lifts each hue toward foreground so it clears 3:1 on the active sidebar row too.
// Measured on sidebar, hover, active, selected, background and card in gruve light, gruve dark
// and gruvbox dark: every hue clears 3:1 everywhere (design/icons/why.md has the numbers).
const HUES_BY_MODE = {
  teal: ["var(--timeline-accent)", "color-mix(in oklab, var(--timeline-accent) 92%, var(--foreground))"],
  plum: ["color-mix(in oklab, var(--pr-merged) 70%, var(--foreground))", "color-mix(in oklab, color-mix(in oklab, var(--pr-merged) 90%, var(--input)) 84%, var(--foreground))"],
  violet: ["color-mix(in oklab, var(--pr-merged) 45%, var(--brand-discord, var(--timeline-accent)))", "color-mix(in oklab, color-mix(in oklab, color-mix(in oklab, var(--pr-merged) 60%, var(--timeline-accent)) 70%, var(--input)) 70%, var(--foreground))"],
  blue: ["color-mix(in oklab, var(--timeline-accent) 60%, var(--brand-discord, var(--foreground)))", "color-mix(in oklab, var(--timeline-accent) 42%, var(--foreground))"],
  rose: ["color-mix(in oklab, var(--pr-merged) 88%, var(--background))", "color-mix(in oklab, var(--pr-merged) 55%, var(--foreground))"],
  ink: ["var(--foreground)", "var(--foreground)"],
};
const HUE_CSS = Object.fromEntries(Object.entries(HUES_BY_MODE).map(([h, [l, dk]]) => [h, l === dk ? l : `light-dark(${l}, ${dk})`]));

const q = s => JSON.stringify(s);
const rec = (o, ind = "  ") => "{\n" + Object.entries(o).map(([k, v]) => `${ind}${k}: ${typeof v === "string" ? q(v) : rec(v, ind + "  ")},`).join("\n") + `\n${ind.slice(2)}}`;
const ts = `import type { CHARGES, HUES, SHAPES } from "./schema";

// Generated by icons/source/crests.mjs; edit the geometry there and regenerate.
// Crests on a 24x24 grid: the silhouette is the class, the charge and hue are the character.
// A crest is three filled paths, back to front, on a 24 grid; crestPath() and crestRingPath()
// pick the cut for the drawn size:
//   <path d={CREST_INLAY_PATHS[shape]} fill="var(--background)" />
//   <path d={crestPath(shape, charge, size)} fill={HUE_CSS[hue]} fillRule="evenodd" />
//   <path d={crestRingPath(shape, size)} fill={CREST_EDGE_CSS} />

type Shape = (typeof SHAPES)[number];
type Charge = (typeof CHARGES)[number];
type Hue = (typeof HUES)[number];

/** Class silhouettes alone, for places that show the class without a character. */
export const SHAPE_PATHS: Record<Shape, string> = ${rec(data.SHAPE_PATHS)};

/** Each charge is a list of paths; "stroke" paths are drawn as lines of the given width, the rest are filled. Clip them to SHAPE_PATHS. Prefer crestPath(), which keeps a rim. */
export type ChargePath = { d: string; stroke?: number };
export const CHARGE_PATHS: Record<Charge, ChargePath[]> = {
${CHARGES.map(c => `  ${c}: [{ d: ${q(data.CHARGE_PATHS[c][0].d)} }],`).join("\n")}
};

/** The silhouette in the hue with the charge cut out, bold cut for crests drawn under 24 px (sidebar rows, the composer, the widget row). Draw with fillRule="evenodd". */
export const CREST_PATHS_SMALL: Record<Shape, Record<Charge, string>> = ${rec(data.CREST_PATHS_SMALL)};

/** The silhouette in the hue with the charge cut out, standard cut from 24 px. Draw with fillRule="evenodd". */
export const CREST_PATHS: Record<Shape, Record<Charge, string>> = ${rec(data.CREST_PATHS)};

/** The keyline round each silhouette, drawn on top in CREST_EDGE_CSS: under 24 px. */
export const CREST_RING_PATHS_SMALL: Record<Shape, string> = ${rec(data.CREST_RING_PATHS_SMALL)};

/** The keyline round each silhouette, drawn on top in CREST_EDGE_CSS: from 24 px. */
export const CREST_RING_PATHS: Record<Shape, string> = ${rec(data.CREST_RING_PATHS)};

/** The field, filled under the crest in var(--background) so the charge keeps its contrast on hover, active and selected rows. It never shows outside the crest. */
export const CREST_INLAY_PATHS: Record<Shape, string> = ${rec(data.CREST_INLAY_PATHS)};

export const CREST_SMALL_BELOW = 24;

/** The hue path for a crest drawn at this size in CSS pixels. Draw it with fillRule="evenodd". */
export function crestPath(shape: Shape, charge: Charge, size: number): string {
  return size < CREST_SMALL_BELOW ? CREST_PATHS_SMALL[shape][charge] : CREST_PATHS[shape][charge];
}

/** The keyline path for a crest drawn at this size in CSS pixels. */
export function crestRingPath(shape: Shape, size: number): string {
  return size < CREST_SMALL_BELOW ? CREST_RING_PATHS_SMALL[shape] : CREST_RING_PATHS[shape];
}

/** The keyline colour: the kit's --tavern-crest-edge mix, written from bb tokens so it also works outside .tavern. */
export const CREST_EDGE_CSS = "color-mix(in oklab, var(--foreground) 72%, transparent)";

/** Crest hues as CSS colours made from bb theme tokens only, so they work outside .tavern too (sidebar rows). They need color-scheme set, as bb sets it. */
export const HUE_CSS: Record<Hue, string> = ${rec(HUE_CSS)};
`;
fs.writeFileSync(OUT, ts);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...data, HUE_CSS, HUES_BY_MODE }, null, 1));
console.log(`wrote ${OUT} (${(ts.length / 1024).toFixed(1)} KiB)`);
