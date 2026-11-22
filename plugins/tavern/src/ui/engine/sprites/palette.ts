import type { CharacterPalette } from "../../kit/characters";
import type { SeedTraits } from "./traits";

type Rgb = readonly [number, number, number];

const DYES = {
  teal: "#3f756d",
  plum: "#785976",
  violet: "#6b618d",
  blue: "#516e92",
  rose: "#875b5c",
  ink: "#576780",
} as const;

const FABRICS: Record<SeedTraits["secondary"], string> = {
  linen: "#a0947c", "undyed-wool": "#84786b", moss: "#66794f", wine: "#784c59", slate: "#687b87", ochre: "#9a794c",
};

const rgb = (value: string): Rgb | undefined => {
  const h = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (h) return [parseInt(h[1]!, 16), parseInt(h[2]!, 16), parseInt(h[3]!, 16)];
  const channels = /^rgba?\(\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)/.exec(value);
  return channels ? [Number(channels[1]), Number(channels[2]), Number(channels[3])] : undefined;
};
const mix = (a: Rgb, b: Rgb, amount: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * amount), Math.round(a[1] + (b[1] - a[1]) * amount), Math.round(a[2] + (b[2] - a[2]) * amount),
];
const hex = (colour: Rgb) => `#${colour.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
const linear = (c: number) => c <= 10.31475 ? c / 3294.6 : ((c / 255 + 0.055) / 1.055) ** 2.4;
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export const PROP_COLOURS = [
  "#6e4a32", "#bc885e", "#514c4f", "#f7edd4", "#6b9397", "#77583a", "#58412d", "#af9062",
  "#93734d", "#704e2e", "#ba9560", "#a68c64", "#344b49", "#9abdb2", "#548880", "#795c42",
  "#624728", "#bc9554", "#f2e1bb", "#9a443b", "#354e62", "#3c3937", "#626e77", "#b1bbc0",
  "#8d704f", "#ba955e", "#475844", "#889f60", "#aeba81", "#b08656", "#795b45", "#b89468",
  "#654732", "#ab8158", "#88ae6d", "#c0eea6", "#ecffd0", "#5d503b", "#ceb180", "#74634f",
  "#b28b58", "#403631", "#9a7950", "#ed9b41", "#ffdf92", "#775234", "#56483e", "#d6532e",
  "#ff8b46", "#ffd5a0", "#a33d25", "#8d9ca6", "#666d72", "#bcc1bf", "#bbc4fa", "#9c99ec",
  "#eef0ff", "#7562b0",
];

const NIGHT_GROUND: Rgb = [40, 40, 40];
const DAY_GROUND: Rgb = [231, 227, 216];
const NIGHT_EDGE: Rgb = [170, 165, 156];
const LIGHT_CLOTH: Rgb = [190, 185, 171];
const DARK_CLOTH: Rgb = [44, 41, 43];

export function spriteFabric(hue: string, material: SeedTraits["secondary"], palette: CharacterPalette) {
  const background = rgb(palette.background) ?? (palette.dark ? NIGHT_GROUND : DAY_GROUND);
  const page = luminance(background) + 0.05;
  const dark = page < 0.16;
  const toward = dark ? LIGHT_CLOTH : DARK_CLOTH;
  const contrast = (colour: Rgb) => {
    const value = luminance(colour) + 0.05;
    return Math.max(value / page, page / value);
  };
  const visible = (base: Rgb) => {
    if (contrast(base) >= 1.5) return hex(base);
    for (let amount = 0.125; amount < 1; amount += 0.125) {
      const next = mix(base, toward, amount);
      if (contrast(next) >= 1.5) return hex(next);
    }
    return hex(toward);
  };
  const cloth = rgb(Object.hasOwn(DYES, hue) ? DYES[hue as keyof typeof DYES] : DYES.ink)!;
  const secondary = rgb(FABRICS[material])!;
  const rim = dark || palette.dark ? hex(mix(background, NIGHT_EDGE, 0.34)) : null;
  return {
    garment: visible(cloth), secondary: visible(secondary),
    fold: visible(mix(cloth, secondary, 0.33)), leather: visible(rgb("#846543")!),
    rim: rim ?? palette.ink, topRim: rim ?? "transparent",
  };
}
