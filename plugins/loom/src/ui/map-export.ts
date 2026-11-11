// The dependency map as a picture to share: one standalone SVG drawn from the map's own layout (its placed nodes, routed
// edges, bundles and bands), with a header, the legend and a solid background. Pure: no DOM. Every colour, font and
// glyph arrives resolved in an `ExportTheme`, so the SVG has no CSS variables and no foreignObject and renders the same
// in a browser, a rasterizer or a design tool.
import type { Kind } from "./deps";
import { nodeWidth, type MapNode, type MapPicture } from "./dep-map";
import { PAD, type PlacedNode } from "./map-layout";
import { STATE_WORDS } from "./groups";
import { markOf, type Tone } from "./marks";
import type { TicketState } from "../states";

/** A colour in sRGB, channels 0 to 255 and alpha 0 to 1. */
export interface Ink {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type InkName = "background" | "ink" | "muted" | "link" | "node" | "line" | "edge" | "band" | "selvedge" | "primary" | "primarySoft" | "attention" | "ok" | "bad";

export interface ExportTheme {
  inks: Readonly<Record<InkName, Ink>>;
  /** Font-family lists as the page computes them. */
  fonts: { mono: string; sans: string };
  /** @font-face rules with the fonts inlined, for fonts the page loads itself; "" when the fonts are the system's. */
  fontFaces: string;
  /** Corner radii as the theme draws them (the user's themes square everything): a node, a closed node's edge, a band, a legend chip and a bundle bar. */
  radii: Readonly<Record<"node" | "edge" | "band" | "chip" | "bar", number>>;
  /** Each font's ascent and descent in em, which place a centred line's baseline as CSS does. */
  em: Readonly<Record<"mono" | "sans", { ascent: number; descent: number }>>;
  measure(text: string, px: number, weight: number, family: "mono" | "sans"): number;
  /** bb's glyph for each mark, by icon name: the inner markup of its 24 by 24 SVG, painted with currentColor. */
  icons: Readonly<Record<string, string>>;
}

export interface ExportHeader {
  key: string;
  name: string;
  /** What the map covers: "Phase 2 of 3 · Directions · 8 tickets · 3 done". */
  scope: string;
  /** The day it shows, or "as of <time>" when rewound. */
  when: string;
}

export interface MapSvg {
  svg: string;
  width: number;
  height: number;
  tickets: number;
}

export const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const hex2 = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
export const hexOf = (ink: Ink) => `#${hex2(ink.r)}${hex2(ink.g)}${hex2(ink.b)}`;
const num = (value: number) => (Math.round(value * 100) / 100).toString();

/** A paint as SVG attributes: the colour, and its opacity when it has one, which every SVG renderer reads. */
function paint(attribute: "fill" | "stroke", ink: Ink): string {
  const alpha = Math.round(ink.a * 1000) / 1000;
  return `${attribute}="${hexOf(ink)}"${alpha < 1 ? ` ${attribute}-opacity="${alpha}"` : ""}`;
}

/** Any colour the page computes (hex, rgb, oklab, oklch, color(srgb)) in sRGB; null for a form it does not know. */
export function parseColor(css: string): Ink | null {
  const text = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex !== null) {
    const h = hex[1]!;
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    if (full.length !== 6 && full.length !== 8) return null;
    const at = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
  }
  const fn = /^([a-z-]+)\((.*)\)$/.exec(text);
  if (fn === null) return text === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  const [name, body] = [fn[1]!, fn[2]!];
  const [main, slash] = body.split("/");
  const parts = main!.replace(/,/g, " ").trim().split(/\s+/);
  const value = (part: string | undefined, percent = 1) => (part === undefined || part === "none" ? 0 : part.endsWith("%") ? (parseFloat(part) / 100) * percent : parseFloat(part));
  const commaAlpha = body.includes(",") && parts.length === 4 ? parts.pop() : undefined;
  const alphaText = slash?.trim() ?? commaAlpha;
  const a = alphaText === undefined ? 1 : value(alphaText);
  if (name === "rgb" || name === "rgba") return { r: value(parts[0], 255), g: value(parts[1], 255), b: value(parts[2], 255), a };
  if (name === "oklab" || name === "oklch") {
    const L = value(parts[0]);
    let A = value(parts[1], 0.4);
    let B = value(parts[2], 0.4);
    if (name === "oklch") {
      const hue = (value(parts[2]) * Math.PI) / 180;
      const chroma = value(parts[1], 0.4);
      A = chroma * Math.cos(hue);
      B = chroma * Math.sin(hue);
    }
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return { r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), a };
  }
  if (name === "color" && (parts[0] === "srgb" || parts[0] === "srgb-linear")) {
    const channel = (part: string | undefined) => (parts[0] === "srgb" ? value(part) * 255 : gamma(value(part)));
    return { r: channel(parts[1]), g: channel(parts[2]), b: channel(parts[3]), a };
  }
  return null;
}

/** Linear light to an sRGB channel, 0 to 255, clamped to the gamut. */
function gamma(linear: number): number {
  const v = Math.min(1, Math.max(0, linear));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
}

/** The order states are counted in the legend: where work stands, from the start of the line to its end. */
const STATE_ORDER: readonly TicketState[] = ["blocked", "queued", "working", "checking", "review", "approved", "pr_open", "merging", "done", "cancelled"];
const KIND_DASH: Record<Kind, string | null> = { work: null, merge: "6 3", live: "1.5 3" };
const KIND_WORDS: Record<Kind, string> = { work: "work", merge: "merges after", live: "needs live" };
/** Loom's own mark (icons/loom.svg), for the picture's signature; keep the two in step. */
const LOOM_GLYPH = "loom:mark";
const LOOM_MARKUP = '<g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.75" width="12" height="3" rx="1"/><rect x="2.5" y="18.25" width="12" height="3" rx="1"/><path d="M4.5 5.75V18.25M12.5 5.75V18.25"/><path d="M4.5 10L12.5 8.5M4.5 14L12.5 12.5"/><path d="M12.5 12.5C16.5 12.5 15 18 18.5 18C20.5 18 21.5 16.5 21.5 15"/></g>';
/** Chrome's dashed 1 px border: 3 px on, 3 px off. */
const BORDER_DASH = "3 3";

const toneInk = (tone: Tone): InkName => (tone === "att" ? "attention" : tone === "bad" ? "bad" : tone === "ok" ? "ok" : tone === "on" ? "link" : "muted");

/** Words broken into lines no wider than `max`; a word wider than a line is cut with an ellipsis. */
function wrap(text: string, max: number, width: (text: string) => number, lines = 3): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((one) => one !== "")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (width(next) <= max || line === "") line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  const kept = out.slice(0, lines);
  if (out.length > lines) kept[lines - 1] = `${kept[lines - 1]} ${out.slice(lines).join(" ")}`;
  return kept.map((one) => fit(one, max, width));
}

/** `text` cut with an ellipsis to fit `max`, as the live map truncates a band's title. */
export function fit(text: string, max: number, width: (text: string) => number): string {
  if (width(text) <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (width(`${text.slice(0, mid).trimEnd()}…`) <= max) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}

/**
 * The map as one SVG: Loom's card with its woven edge, a header (the project, what the map covers, and when), the map
 * at its own layout's coordinates with nothing lit or dimmed, and the legend with a count for each state. `scale` sets
 * the pixel size of the root (the PNG is drawn from it at 2x); the view box stays in CSS pixels.
 */
export function buildMapSvg(picture: MapPicture, header: ExportHeader, theme: ExportTheme, scale = 1): MapSvg {
  const { layout, nodes, bands, metrics, small, closed } = picture;
  const ink = theme.inks;
  // Text grows with the page's text size, as the map's nodes did.
  const t = Math.max(1, (metrics.icon ?? 14) / 14);
  const px = (value: number) => Math.round(value * t * 100) / 100;
  const font = (family: "mono" | "sans") => `font-family="${esc(family === "mono" ? theme.fonts.mono : theme.fonts.sans)}"`;
  const measure = (text: string, size: number, weight: number, family: "mono" | "sans") => theme.measure(text, size, weight, family);
  // A line's baseline when its box is centred on `centre`, as a flex row centres text with line-height 1.
  const baseline = (centre: number, size: number, family: "mono" | "sans") => centre + ((theme.em[family].ascent - theme.em[family].descent) / 2) * size;
  const parts: string[] = [];
  const defs: string[] = [];
  let clipId = 0;
  const clip = (d: string) => {
    const id = `c${clipId++}`;
    defs.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
    return id;
  };
  const text = (x: number, centre: number, size: number, value: string, family: "mono" | "sans", fill: Ink, weight = 400, extra = "") => `<text x="${num(x)}" y="${num(baseline(centre, size, family))}" ${font(family)} font-size="${num(size)}" font-weight="${weight}" ${paint("fill", fill)}${extra}>${esc(value)}</text>`;
  const glyph = (name: string, x: number, y: number, size: number, colour: Ink) => {
    const inner = (name === LOOM_GLYPH ? LOOM_MARKUP : (theme.icons[name] ?? theme.icons.Circle ?? '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>')).replace(/currentColor/g, hexOf(colour));
    return `<g transform="translate(${num(x)} ${num(y)}) scale(${num(size / 24)})" fill="none"${colour.a < 1 ? ` opacity="${num(colour.a)}"` : ""}>${inner}</g>`;
  };
  const stripes = (x: number, y: number, width: number, height: number, on: number, period: number) => {
    const runs: string[] = [];
    for (let at = 0; at < height - 0.01; at += period) runs.push(`M${num(x)} ${num(y + at)}h${num(width)}v${num(Math.min(on, height - at))}h${num(-width)}z`);
    return runs.join("");
  };
  const leftRounded = (x: number, y: number, width: number, height: number, r: number) => (r <= 0 ? `M${num(x)} ${num(y)}h${num(width)}v${num(height)}h${num(-width)}z` : `M${num(x + r)} ${num(y)}H${num(x + width)}V${num(y + height)}H${num(x + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x)} ${num(y + height - r)}V${num(y + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + r)} ${num(y)}z`);
  const rounded = (x: number, y: number, width: number, height: number, r: number) => (r <= 0 ? leftRounded(x, y, width, height, 0) : `M${num(x + r)} ${num(y)}H${num(x + width - r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + width)} ${num(y + r)}V${num(y + height - r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + width - r)} ${num(y + height)}H${num(x + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x)} ${num(y + height - r)}V${num(y + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + r)} ${num(y)}z`);

  // A done ticket's woven edge and a cancelled one's hatched edge, inside the node's border, as the map draws them.
  const closedEdge = (placed: PlacedNode, state: "done" | "cancelled") => {
    const x = placed.x + 1;
    const y = placed.y + 1;
    const height = placed.height - 2;
    if (state === "done") return `<path clip-path="url(#${clip(leftRounded(x, y, 4, height, theme.radii.edge))})" d="${stripes(x, y, 4, height, 2, 3)}" ${paint("fill", ink.ok)}/>`;
    const id = clip(leftRounded(x, y, 5, height, theme.radii.edge));
    // 135deg stripes, 1.5 px of ink every 3.5 px across them: filled bands where x + y runs from c to c + 1.5√2.
    const step = 3.5 * Math.SQRT2;
    const wide = 1.5 * Math.SQRT2;
    const bands: string[] = [];
    for (let c = x + y - wide; c < x + 5 + y + height; c += step) bands.push(`M${num(c - y)} ${num(y)}H${num(c + wide - y)}L${num(c + wide - y - height)} ${num(y + height)}H${num(c - y - height)}z`);
    return `<path clip-path="url(#${id})" d="${bands.join("")}" ${paint("fill", ink.muted)}/>`;
  };

  const drawNode = (placed: PlacedNode, node: MapNode): string => {
    const { x, y, width, height } = placed;
    if (placed.kind === "bundle") return `<rect data-bundle="${esc(placed.id)}" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="${num(theme.radii.bar)}" ${paint("fill", ink.edge)}/>`;
    const card = node.card;
    const centre = y + height / 2;
    const box = (stroke: Ink, dashed: boolean) => `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(width - 1)}" height="${num(height - 1)}" rx="${num(Math.max(0, theme.radii.node - 0.5))}" ${paint("fill", ink.background)} ${paint("stroke", stroke)} stroke-width="1"${dashed ? ` stroke-dasharray="${BORDER_DASH}"` : ""}/>`;
    if (placed.kind === "stub") return `<g data-stub="${esc(placed.id)}">${box(ink.muted, true)}${text(x + 1 + (small ? px(6) : 9), centre, px(small ? 11 : 12), node.label, "mono", ink.muted)}</g>`;
    if (placed.kind === "more") return `<g data-more="${esc(placed.id)}">${box(ink.muted, true)}${text(x + 10, centre, px(12), node.label, "sans", ink.muted)}</g>`;
    const state = card!.state;
    const shut = closed && (state === "done" || state === "cancelled") ? state : null;
    const mark = markOf(state, false, card!.draft === "held");
    const icon = small ? (metrics.smallIcon ?? 11) : (metrics.icon ?? 14);
    // Padding and gap are 9 and 5 px on a node, and rem (they grow with the text) on the small map's.
    const iconX = x + 1 + (small ? px(6) : 9);
    const keyX = iconX + Math.max(small ? 11 : 14, icon) + (small ? px(4) : 5);
    const word = STATE_WORDS[state];
    const showWord = !small && width >= nodeWidth(card!.key, word, false, metrics);
    const keyInk = shut === "cancelled" ? ink.muted : ink.ink;
    const key = `<text x="${num(keyX)}" y="${num(baseline(centre, px(small ? 11 : 12), "mono"))}" ${font("mono")} font-size="${num(px(small ? 11 : 12))}" font-weight="600" ${paint("fill", keyInk)}>${esc(card!.key)}${showWord ? `<tspan dx="5" ${font("sans")} font-size="${num(px(11))}" font-weight="400" ${paint("fill", ink.muted)}>${esc(word)}</tspan>` : ""}</text>`;
    return `<g data-node="${esc(placed.id)}" data-state="${state}">${box(state === "blocked" ? ink.attention : ink.node, false)}${shut === null ? "" : closedEdge(placed, shut)}${glyph(mark.icon, iconX, centre - icon / 2, icon, ink[toneInk(mark.tone)])}${key}</g>`;
  };

  // The map's extent: its bands, nodes and every edge's route.
  const bandHeight = layout.height - PAD / 2;
  const xs = [...layout.nodes.flatMap((node) => [node.x, node.x + node.width]), ...bands.flatMap((band) => [band.x, band.x + band.width]), ...layout.edges.flatMap((edge) => edge.points.map(([x]) => x))];
  const ys = [...layout.nodes.flatMap((node) => [node.y, node.y + node.height]), ...(bands.length > 0 ? [0, bandHeight] : []), ...layout.edges.flatMap((edge) => edge.points.map(([, y]) => y))];
  const map = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  const mapWidth = map.right - map.left;

  // The legend: each state with its count, as a small node, then the kinds of line and mark the map draws.
  const tickets = layout.nodes.filter((node) => node.kind === "ticket").map((placed) => nodes.get(placed.id)!.card!);
  const counts = new Map<string, { state: TicketState; draft: boolean; count: number }>();
  for (const card of tickets) {
    const draft = card.state === "pr_open" && card.draft === "held";
    const id = `${card.state}${draft ? ":draft" : ""}`;
    counts.set(id, { state: card.state, draft, count: (counts.get(id)?.count ?? 0) + 1 });
  }
  const states = [...counts.values()].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || Number(a.draft) - Number(b.draft));
  const legendPx = px(12);
  const chipW = px(22);
  const chipH = px(16);
  type Item = { width: number; draw(x: number, centre: number): string };
  const word = (value: string, x: number, centre: number) => text(x, centre, legendPx, value, "sans", ink.muted);
  const stateItems: Item[] = states.map(({ state, draft, count }) => {
    const label = draft ? "draft PR" : STATE_WORDS[state];
    const labelW = measure(label, legendPx, 400, "sans");
    const countW = measure(String(count), legendPx, 600, "sans");
    return {
      width: chipW + px(6) + labelW + px(5) + countW,
      draw: (x, centre) => {
        const top = centre - chipH / 2;
        const mark = markOf(state, false, draft);
        const shut = closed && (state === "done" || state === "cancelled") ? state : null;
        const chip = { id: "", kind: "ticket" as const, x, y: top, width: chipW, height: chipH, rank: 0 };
        const iconSize = px(11);
        return `<g data-legend-state="${state}${draft ? ":draft" : ""}"><rect x="${num(x + 0.5)}" y="${num(top + 0.5)}" width="${num(chipW - 1)}" height="${num(chipH - 1)}" rx="${num(Math.max(0, theme.radii.chip - 0.5))}" ${paint("fill", ink.background)} ${paint("stroke", state === "blocked" ? ink.attention : ink.node)}/>${shut === null ? "" : closedEdge(chip, shut)}${glyph(mark.icon, x + (chipW - iconSize) / 2 + (shut === null ? 0 : 1.5), centre - iconSize / 2, iconSize, ink[toneInk(mark.tone)])}${word(label, x + chipW + px(6), centre)}${text(x + chipW + px(6) + labelW + px(5), centre, legendPx, String(count), "sans", ink.ink, 600)}</g>`;
      },
    };
  });
  const relationItems: Item[] = [];
  const labelled = (label: string, swatch: number, draw: (x: number, centre: number) => string): Item => ({ width: swatch + px(6) + measure(label, legendPx, 400, "sans"), draw: (x, centre) => `${draw(x, centre)}${word(label, x + swatch + px(6), centre)}` });
  for (const kind of ["work", "merge", "live"] as const)
    if (picture.kinds.has(kind)) relationItems.push(labelled(KIND_WORDS[kind], 22, (x, centre) => `<path data-legend-kind="${kind}" d="M${num(x)} ${num(centre)}H${num(x + 22)}" fill="none" ${paint("stroke", ink.edge)} stroke-width="1.4"${KIND_DASH[kind] === null ? "" : ` stroke-dasharray="${KIND_DASH[kind]}"`}/>`));
  if (layout.bundles.length > 0) relationItems.push(labelled("needs all of", 4, (x, centre) => `<rect x="${num(x)}" y="${num(centre - px(6))}" width="4" height="${num(px(12))}" rx="${num(theme.radii.bar)}" ${paint("fill", ink.edge)}/>`));
  if (layout.nodes.some((node) => node.kind === "stub")) relationItems.push(labelled("outside this map", px(20), (x, centre) => `<rect x="${num(x + 0.5)}" y="${num(centre - px(6) + 0.5)}" width="${num(px(20) - 1)}" height="${num(px(12) - 1)}" rx="${num(Math.max(0, theme.radii.chip - 0.5))}" fill="none" ${paint("stroke", ink.muted)} stroke-dasharray="${BORDER_DASH}"/>`));

  // The card: padding, the header's type, and a width that holds the map, or a header and legend of their own.
  const left = 36;
  const right = 32;
  const titlePx = px(17);
  const scopePx = px(13);
  const whenPx = px(12);
  const keyW = measure(header.key, titlePx, 800, "mono");
  const nameW = measure(header.name, titlePx, 600, "sans");
  const scopeW = measure(header.scope, scopePx, 400, "sans");
  const whenW = measure(header.when, whenPx, 400, "sans");
  const gap = px(14);
  const rowWidth = (items: readonly Item[]) => items.reduce((sum, item) => sum + item.width, 0) + Math.max(0, items.length - 1) * gap;
  const natural = Math.max(keyW + px(10) + nameW + px(24) + whenW, scopeW, rowWidth(stateItems), rowWidth(relationItems));
  const inner = Math.ceil(Math.max(px(480), mapWidth, Math.min(natural, Math.max(mapWidth, px(880)))));
  const width = left + inner + right;

  // The header: the key and name (the name wraps under itself), what the map covers, and the day beside the title.
  let y = 28;
  const titleLine = px(24);
  const nameLines = wrap(header.name, inner - keyW - px(10), (value) => measure(value, titlePx, 600, "sans"), 2);
  const whenOnTitle = keyW + px(10) + measure(nameLines[0] ?? "", titlePx, 600, "sans") + px(24) + whenW <= inner;
  const firstCentre = y + titleLine / 2;
  parts.push(`<g data-header="">`);
  parts.push(text(left, firstCentre, titlePx, header.key, "mono", ink.link, 800));
  nameLines.forEach((line, at) => parts.push(text(left + keyW + px(10), firstCentre + at * titleLine, titlePx, line, "sans", ink.ink, 600)));
  y += nameLines.length * titleLine + px(2);
  const scopeLine = px(20);
  const scopeLines = wrap(header.scope, inner, (value) => measure(value, scopePx, 400, "sans"));
  const lastScope = scopeLines.at(-1) ?? "";
  const whenOnScope = !whenOnTitle && measure(lastScope, scopePx, 400, "sans") + px(24) + whenW <= inner;
  scopeLines.forEach((line, at) => parts.push(text(left, y + scopeLine / 2 + at * scopeLine, scopePx, line, "sans", ink.muted)));
  const anchorEnd = ` text-anchor="end"`;
  if (whenOnTitle) parts.push(text(left + inner, firstCentre, whenPx, header.when, "sans", ink.muted, 400, anchorEnd));
  else if (whenOnScope) parts.push(text(left + inner, y + scopeLine / 2 + (scopeLines.length - 1) * scopeLine, whenPx, header.when, "sans", ink.muted, 400, anchorEnd));
  y += scopeLines.length * scopeLine;
  if (!whenOnTitle && !whenOnScope) {
    parts.push(text(left, y + scopeLine / 2, whenPx, header.when, "sans", ink.muted));
    y += scopeLine;
  }
  parts.push(`</g>`);
  y += px(12);
  parts.push(`<path d="M${left} ${num(y + 0.5)}H${left + inner}" ${paint("stroke", ink.line)} stroke-width="1"/>`);
  y += px(20);

  // The map, moved so its extent starts at the card's left edge and under the header, at whole pixels as on the page.
  const ox = Math.round(left - map.left);
  const oy = Math.round(y - map.top);
  parts.push(`<g data-map="" transform="translate(${ox} ${oy})">`);
  const bandPx = px(12);
  const bandLine = bandPx * 1.375;
  for (const band of bands) {
    const r = Math.max(0, theme.radii.band);
    const edge = band.state === "active" ? { on: ink.primary, off: ink.primarySoft } : { on: ink.selvedge, off: null };
    const innerClip = clip(rounded(band.x + 1, 1, band.width - 2, bandHeight - 2, Math.max(0, r - 1)));
    const numberW = band.number === null ? 0 : measure(String(band.number), bandPx, 800, "sans") + px(6);
    const textX = band.x + 1 + px(12);
    const room = band.width - 2 - px(12) - px(8);
    const title = fit(band.title, room - numberW, (value) => measure(value, bandPx, 600, "sans"));
    const firstLine = 1 + px(6) + bandLine / 2;
    parts.push(
      `<g data-band="${esc(band.id)}">`,
      `<path d="${rounded(band.x + 0.5, 0.5, band.width - 1, bandHeight - 1, Math.max(0, r - 0.5))}" ${paint("fill", ink.band)} ${paint("stroke", ink.line)} stroke-width="1"/>`,
      `<g clip-path="url(#${innerClip})">`,
      edge.off === null ? "" : `<rect x="${num(band.x + 1)}" y="1" width="5" height="${num(bandHeight - 2)}" ${paint("fill", edge.off)}/>`,
      `<path d="${stripes(band.x + 1, 1, 5, bandHeight - 2, 2, 4)}" ${paint("fill", edge.on)}/>`,
      `</g>`,
      band.number === null ? "" : text(textX, firstLine, bandPx, String(band.number), "sans", ink.ink, 800),
      text(textX + numberW, firstLine, bandPx, title, "sans", ink.ink, 600),
      text(textX, firstLine + bandLine, bandPx, fit(band.counts, room, (value) => measure(value, bandPx, 400, "sans")), "sans", ink.muted),
      `</g>`,
    );
  }
  for (const edge of layout.edges) parts.push(`<path data-edge="${esc(edge.id)}" d="${edge.d}" fill="none" ${paint("stroke", ink.edge)} stroke-width="1.4"${KIND_DASH[edge.kind] === null ? "" : ` stroke-dasharray="${KIND_DASH[edge.kind]}"`} stroke-linecap="butt"/>`);
  for (const placed of layout.nodes) parts.push(drawNode(placed, nodes.get(placed.id)!));
  parts.push(`</g>`);
  y += map.bottom - map.top + px(24);

  // The legend, wrapped to the card's width: states first, then the map's marks; Loom's name closes the last row.
  const brandW = px(12) + px(5) + measure("Loom", px(11), 600, "sans");
  const rows: Item[][] = [];
  // A short legend is one row, its two groups set apart by a wider gap; a longer one gives each group rows of its own.
  const apart: Item = { width: px(10), draw: () => "" };
  const together = stateItems.length > 0 && relationItems.length > 0 ? [...stateItems, apart, ...relationItems] : [...stateItems, ...relationItems];
  if (rowWidth(together) + px(24) + brandW <= inner) rows.push(together);
  else for (const group of [stateItems, relationItems]) {
    let row: Item[] = [];
    for (const item of group) {
      if (row.length > 0 && rowWidth([...row, item]) > inner) {
        rows.push(row);
        row = [];
      }
      row.push(item);
    }
    if (row.length > 0) rows.push(row);
  }
  const legendLine = px(18);
  const rowGap = px(8);
  parts.push(`<g data-legend="">`);
  rows.forEach((row, at) => {
    let x = left;
    const centre = y + legendLine / 2;
    for (const item of row) {
      parts.push(item.draw(x, centre));
      x += item.width + gap;
    }
    if (at < rows.length - 1) y += legendLine + rowGap;
  });
  const lastRow = rows.at(-1) ?? [];
  if (rows.length > 0 && rowWidth(lastRow) + px(24) + brandW > inner) y += legendLine + rowGap;
  const brandCentre = y + legendLine / 2;
  const brandX = left + inner - brandW;
  parts.push(
    `<g data-brand="">${glyph(LOOM_GLYPH, brandX, brandCentre - px(6), px(12), ink.muted)}${text(brandX + px(17), brandCentre, px(11), "Loom", "sans", ink.muted, 600)}</g>`,
    `</g>`,
  );
  y += legendLine;
  const height = Math.ceil(y + 24);

  const card = [
    `<rect width="${width}" height="${height}" ${paint("fill", { ...ink.background, a: 1 })}/>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" ${paint("stroke", ink.line)}/>`,
    `<path d="${stripes(1, 1, 5, height - 2, 2, 4)}" ${paint("fill", ink.selvedge)}/>`,
  ];
  const title = `${header.key} ${header.name}: ${header.scope}, ${header.when}`;
  const style = theme.fontFaces === "" ? "" : `<style>${theme.fontFaces}</style>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width * scale)}" height="${num(height * scale)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<defs>${style}${defs.join("")}</defs>`,
    ...card,
    ...parts,
    `</svg>`,
  ].join("");
  return { svg, width, height, tickets: tickets.length };
}

/** What the map covers, in words for its header: the scope, then the tickets it draws. */
export function scopeText(scope: { kind: "whole" } | { kind: "phase"; number: number; of: number; title: string } | { kind: "hops"; focus: string; hops: 1 | 2; total: number }, tickets: ReadonlyArray<{ state: TicketState }>, draft: { version: number } | null = null): string {
  const done = tickets.filter((card) => card.state === "done").length;
  const cancelled = tickets.filter((card) => card.state === "cancelled").length;
  const noun = (n: number) => `${n} ${draft === null ? "" : "proposed "}ticket${n === 1 ? "" : "s"}`;
  const facts: string[] = draft === null ? [] : [`Draft v${draft.version}`];
  if (scope.kind === "whole") facts.push("Whole project", noun(tickets.length));
  else if (scope.kind === "phase") facts.push(`Phase ${scope.number} of ${scope.of}`, scope.title, noun(tickets.length));
  else facts.push(`Around ${scope.focus}`, `${scope.hops} hop${scope.hops === 1 ? "" : "s"} either way`, `${tickets.length} of ${noun(scope.total)}`);
  // A hop map folds done prerequisites into a stub, so it counts only the tickets it draws.
  if (scope.kind === "hops") return facts.join(" · ");
  if (draft === null || done > 0) facts.push(`${done} done`);
  if (cancelled > 0) facts.push(`${cancelled} cancelled`);
  return facts.filter((fact) => fact !== "").join(" · ");
}

/** The day a map shows, with its year, or the moment a rewound map shows. */
export function whenText(at: number, rewound: boolean, locale?: string): string {
  const date = new Date(at);
  const day = date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  return rewound ? `as of ${day}, ${date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` : day;
}

const isoDay = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** "LANE-map-whole-2026-11-11.png", "EDGE-map-phase-2-2026-11-11.svg": the project, the scope and the day shown. */
export function mapFileName(key: string, scope: { kind: "whole" } | { kind: "phase"; number: number } | { kind: "hops"; focus: string }, at: number, ext: "png" | "svg", draft = false): string {
  const part = scope.kind === "whole" ? "whole" : scope.kind === "phase" ? `phase-${scope.number}` : scope.focus;
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe(key) || "loom"}-map-${draft ? "draft-" : ""}${safe(part)}-${isoDay(at)}.${ext}`;
}

/** The browser's canvas limits: 16,384 px a side in Chrome and Safari, and an area well inside what phones allow. */
export const CANVAS_SIDE = 16_384;
export const CANVAS_AREA = 120_000_000;

/** The PNG's scale: `want` (2x) unless that passes a canvas limit, in which case the largest that fits. */
export function pngScale(width: number, height: number, want = 2): { scale: number; reduced: boolean } {
  const most = Math.min(want, CANVAS_SIDE / width, CANVAS_SIDE / height, Math.sqrt(CANVAS_AREA / (width * height)));
  const scale = most >= want ? want : Math.floor(most * 100) / 100;
  return { scale, reduced: scale < want };
}
