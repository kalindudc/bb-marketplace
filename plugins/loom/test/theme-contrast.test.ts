// Loom's theme layer against the three themes the user runs: every --loom-* ink and the field line, mixed as CSS mixes
// them (color-mix in oklab, premultiplied), on each surface Loom stacks. The theme values were captured from the running
// bb app on 2026-11-10 (the ux-design catalog's theme-tokens.json); recapture them when bb or a theme changes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markStyle, STATE_COLORS } from "../src/ui/charts";
import { LOOM_THEME_CSS } from "../src/ui/theme";

type Rgba = [number, number, number, number];

const THEMES = {
  "gruve light": { dark: false, tokens: { background: "#e7e3d8", foreground: "#282828", card: "#edeae1", popover: "#edeae1", primary: "#922d00", "muted-foreground": "#453f3b", "subtle-foreground": "#554f48", "surface-recessed": "#26262614", "surface-selected": "#8f2c0029", "state-hover": "#2727271a", attention: "#754f11", warning: "#a53b05", "warning-text": "#9b3300", "destructive-text": "#9d0006", "success-foreground": "#008246", "timeline-accent": "#076678", "border-seam": "#a89f88", success: "#5d5800", destructive: "#ba1613" } },
  "gruve dark": { dark: true, tokens: { background: "#32302f", foreground: "#ebdbb2", card: "#3c3836", popover: "#3c3836", primary: "#fe8019", "muted-foreground": "#ccbfa0", "subtle-foreground": "#b9aa93", "surface-recessed": "#1d202259", "surface-selected": "#ff84191f", "state-hover": "#e6d9b314", attention: "#fabd2f", warning: "#fe8019", "warning-text": "#fda14b", "destructive-text": "#fd9d85", "success-foreground": "#c3c440", "timeline-accent": "#8fb3a5", "border-seam": "#504945", success: "#c3c440", destructive: "#fb7c61" } },
  "gruvbox dark": { dark: true, tokens: { background: "#282828", foreground: "#ebdbb2", card: "#3c3836", popover: "#3c3836", primary: "#83a598", "muted-foreground": "#aba085", "subtle-foreground": "#928a74", "surface-recessed": "#1d202259", "surface-selected": "#84a5941f", "state-hover": "#e6d9b314", attention: "#fabd2f", warning: "#fe8019", "warning-text": "#fe8019", "destructive-text": "#fb4934", "success-foreground": "#b8bb26", "timeline-accent": "#83a598", "border-seam": "#504945", success: "#b8bb26", destructive: "#fb4934" } },
} as const;
type ThemeName = keyof typeof THEMES;

const hex = (value: string): Rgba => {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (match === null) throw new Error(`not a colour: ${value}`);
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1]!.slice(at, at + 2), 16) / 255);
  return [r!, g!, b!, match[2] === undefined ? 1 : parseInt(match[2], 16) / 255];
};
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
const toOklab = ([r, g, b]: Rgba): [number, number, number] => {
  const [lr, lg, lb] = [r, g, b].map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const fromOklab = ([L, A, B]: [number, number, number]): [number, number, number] => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(fromLinear) as [number, number, number];
};
/** color-mix(in oklab, a p%, b q%), premultiplied by alpha as CSS Color 5 interpolates. */
const mix = (a: Rgba, p: number, b: Rgba, q: number): Rgba => {
  const t = p / (p + q);
  const alpha = a[3] * t + b[3] * (1 - t);
  if (alpha === 0) return [0, 0, 0, 0];
  const la = toOklab(a[3] === 0 ? b : a);
  const lb = toOklab(b[3] === 0 ? a : b);
  const lab = la.map((x, i) => (x * a[3] * t + lb[i]! * b[3] * (1 - t)) / alpha) as [number, number, number];
  return [...fromOklab(lab), alpha];
};
const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + bottom[i]! * (1 - top[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
const contrast = (ink: Rgba, surface: Rgba) => {
  const [x, y] = [luminance(over(ink, surface)), luminance(surface)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

/** The --loom-* declarations of the base rule and, on a dark theme, the dark rule over them. */
function loomTokens(dark: boolean): Map<string, string> {
  const css = LOOM_THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start + selector.length + 2, css.indexOf("}", start));
  };
  const tokens = new Map<string, string>();
  const read = (body: string) => {
    for (const match of body.matchAll(/(--loom-[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(match[1]!.slice(2), match[2]!.trim());
  };
  read(block("[data-loom-root]"));
  if (dark) read(block(".dark [data-loom-root], [data-loom-root].dark"));
  return tokens;
}

function resolver(name: ThemeName) {
  const theme = THEMES[name];
  const loom = loomTokens(theme.dark);
  const host = theme.tokens as Record<string, string>;
  const split = (args: string) => {
    let depth = 0;
    for (let at = 0; at < args.length; at += 1) {
      if (args[at] === "(") depth += 1;
      if (args[at] === ")") depth -= 1;
      if (args[at] === "," && depth === 0) return [args.slice(0, at), args.slice(at + 1)];
    }
    throw new Error(`no second colour in ${args}`);
  };
  const colour = (expression: string): Rgba => {
    const value = expression.trim();
    if (value === "transparent") return [0, 0, 0, 0];
    const named = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (named !== null) {
      const token = named[1]!;
      if (loom.has(token)) return colour(loom.get(token)!);
      if (host[token] === undefined) throw new Error(`the test has no value for --${token}`);
      return hex(host[token]);
    }
    const mixed = /^color-mix\(in oklab,\s*([\s\S]+)\)$/.exec(value);
    if (mixed !== null) {
      const [first, second] = split(mixed[1]!).map((part) => /^\s*([\s\S]+?)\s+([\d.]+)%\s*$/.exec(part) ?? [part, part, null]);
      const p = first![2] === null ? null : Number(first![2]);
      const q = second![2] === null ? null : Number(second![2]);
      return mix(colour(first![1]!), p ?? 100 - (q ?? 50), colour(second![1]!), q ?? 100 - (p ?? 50));
    }
    return hex(value);
  };
  const card = colour("var(--loom-card)");
  const lay = (base: Rgba, ...layers: string[]) => layers.reduce((under, layer) => over(colour(layer), under), base);
  // Every surface Loom draws text or a field on, with the tints it stacks.
  const surfaces: Record<string, Rgba> = {
    page: colour("var(--background)"),
    "Loom card": card,
    "bb card or popover": colour("var(--card)"),
    recessed: lay(card, "var(--surface-recessed)"),
    "selected row": lay(card, "var(--surface-selected)"),
    "hover row": lay(card, "var(--state-hover)"),
    "attention tint": lay(card, "var(--loom-att-tint)"),
    "selected on the page": lay(colour("var(--background)"), "var(--surface-selected)"),
    "selected on bb's card": lay(colour("var(--card)"), "var(--surface-selected)"),
    "hover on bb's card": lay(colour("var(--card)"), "var(--state-hover)"),
    "warning notice": lay(card, "color-mix(in oklab, var(--warning) 10%, transparent)"),
    "next step notice": lay(card, "color-mix(in oklab, var(--primary) 5%, transparent)"),
  };
  // The tints Loom lays under text (bg-success/15 on an added line, bg-muted-foreground/15 on a cancelled pill and the
  // rest), on each of the three backgrounds. The avatar and finding-pin tints carry the foreground only, and the bars none.
  const tints: Array<[string, number]> = [["success", 15], ["warning", 10], ["warning", 15], ["destructive-text", 10], ["destructive-text", 15], ["primary", 10], ["timeline-accent", 15], ["muted-foreground", 15], ["destructive", 10], ["destructive", 15]];
  for (const [token, percent] of tints)
    for (const [base, under] of [["Loom card", card], ["bb's card", colour("var(--card)")], ["page", colour("var(--background)")]] as const) surfaces[`${token}/${percent} on ${base}`] = lay(under, `color-mix(in oklab, var(--${token}) ${percent}%, transparent)`);
  return { colour, surfaces };
}

const names = Object.keys(THEMES) as ThemeName[];
const below = (name: ThemeName, ink: string, need: number) => {
  const { colour, surfaces } = resolver(name);
  return Object.entries(surfaces)
    .map(([surface, background]) => ({ surface, ratio: Math.round(contrast(colour(ink), background) * 100) / 100 }))
    .filter((each) => each.ratio < need);
};

describe("Loom's theme layer in gruve light, gruve dark and gruvbox dark", () => {
  it("mixes as the browser does: it reproduces three of the final gate's measurements of the live page", () => {
    const gruvbox = resolver("gruvbox dark");
    const light = resolver("gruve light");
    // The comment field's old border on its popover, and a link on bb's card, as the reviewers measured them.
    expect(contrast(gruvbox.colour("var(--border-seam)"), gruvbox.colour("var(--popover)"))).toBeCloseTo(1.31, 1);
    expect(contrast(light.colour("var(--border-seam)"), light.colour("var(--popover)"))).toBeCloseTo(2.19, 1);
    expect(contrast(gruvbox.colour("var(--primary)"), gruvbox.colour("var(--card)"))).toBeCloseTo(4.31, 1);
  });

  it.each(names)("gives every field a boundary of 3:1 or more on each surface in %s, where bb's seam fell short", (name) => {
    expect(below(name, "var(--loom-field-line)", 3)).toEqual([]);
    expect(below(name, "var(--border-seam)", 3).length).toBeGreaterThan(0);
  });

  it.each(names)("keeps Loom's text inks at 4.5:1 or more on each surface in %s", (name) => {
    for (const ink of ["--loom-link", "--loom-muted", "--loom-warn", "--loom-bad", "--loom-ok", "--loom-run"]) expect(below(name, `var(${ink})`, 4.5), `${ink} in ${name}`).toEqual([]);
  });

  it.each(names)("draws meaningful marks at 3:1 or more on cards, the page and a bar's track in %s", (name) => {
    const { colour, surfaces } = resolver(name);
    const card = colour("var(--loom-card)");
    const track = { "track on Loom's card": over(colour("var(--state-hover)"), card), "track on bb's card": over(colour("var(--state-hover)"), colour("var(--card)")) };
    const under = { page: surfaces.page!, "Loom card": card, "bb card or popover": surfaces["bb card or popover"]!, ...track };
    // The share bars' edges and the first-try ring are drawn in these inks at full strength.
    for (const mark of ["--loom-mark-quiet", "--loom-mark-bad", "--success", "--primary", "--warning", "--timeline-accent"]) {
      const low = Object.entries(under).filter(([, background]) => contrast(colour(`var(${mark})`), background) < 3).map(([surface]) => surface);
      expect(low, `${mark} in ${name}`).toEqual([]);
    }
  });

  it("would have caught the gate's text failures: bb's primary and subtle inks fall short in gruvbox dark", () => {
    expect(below("gruvbox dark", "var(--primary)", 4.5).map((each) => each.surface)).toContain("bb card or popover");
    expect(below("gruvbox dark", "var(--subtle-foreground)", 4.5).map((each) => each.surface)).toContain("selected on the page");
    // The rubric's numbers on an added line, which the gate measured at 4.36:1 with the muted ink mixed at 62%.
    const { colour, surfaces } = resolver("gruvbox dark");
    const before = contrast(colour("color-mix(in oklab, var(--muted-foreground) 62%, var(--foreground))"), surfaces["success/15 on bb's card"]!);
    expect(before).toBeCloseTo(4.36, 1);
  });
});

describe("every Loom field draws the field line", () => {
  // The reviewers found the weak seam on selectors, searches and comment boxes alike, so this reads every field Loom renders.
  it("puts --loom-field-line, directly or through FIELD, on each text input, select and text area", () => {
    const dir = join(__dirname, "../src/ui");
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/<(input|select|textarea)\b/g)) {
        const tag = source.slice(match.index, source.indexOf(match[1] === "select" ? "</select>" : "/>", match.index) + 2);
        if (/type="(checkbox|radio|range|hidden)"/.test(tag)) continue;
        // A bare input inside a bordered label or row takes that box's line, so look a few lines up for it too.
        const around = source.slice(Math.max(0, match.index - 700), match.index) + tag;
        if (!/\bFIELD\b|--loom-field-line/.test(around)) missing.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("Markdown lists in a narrow container", () => {
  // At 200% text in the 328 px side panel, three rem indents left the deepest list item a 12 px column.
  it("indents each level by at most 6% of Loom's container, in Markdown bb renders and in Loom's own content", () => {
    const rule = LOOM_THEME_CSS.split("\n").find((line) => line.includes("padding-left: min(1.25rem, 6cqi)"));
    expect(rule).toBeDefined();
    const selectors = rule!.slice(0, rule!.indexOf("{")).split(",").map((selector) => selector.trim());
    expect(selectors).toEqual(["[data-loom-root] [data-markdown-preview] ul", "[data-loom-root] [data-markdown-preview] ol", "[data-loom-root] [data-content] ul", "[data-loom-root] [data-content] ol"]);
  });
});

describe("share marks", () => {
  // Opacity faded a segment's edge with its fill, so neighbours of one hue met at 1.1 to 2.3:1.
  it("fades a fill by mixing and keeps a full-strength edge of its own ink", () => {
    const style = markStyle(STATE_COLORS.pr_open);
    expect(style.opacity).toBeUndefined();
    expect(style.background).toBe("color-mix(in oklab, var(--success, currentColor) 35%, transparent)");
    expect(style.boxShadow).toBe("inset 0 0 0 1.5px var(--success, currentColor)");
  });

  it("stripes review, which gruve dark colours the same as building", () => {
    expect(String(markStyle(STATE_COLORS.review).background)).toMatch(/^repeating-linear-gradient/);
    expect(String(markStyle(STATE_COLORS.working).background)).toBe("var(--primary, currentColor)");
  });
});
