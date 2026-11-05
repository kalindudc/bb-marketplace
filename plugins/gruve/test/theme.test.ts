import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accentColours } from "../src/appearance";
import { LIGHT_PALETTES } from "../src/palettes";
import { DEFAULT_APPEARANCE, LIGHT_MODES, SETTING_DESCRIPTORS, type Accent, type LightMode } from "../src/settings";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const css = readFileSync(join(root, "themes/gruve.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no "${selector} {" block in gruve.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const tokens: Record<string, string> = {};
  for (const [, name, value] of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const light = block(":root,\n.light");
const dark = { ...light, ...block(".dark") };

/** Light mode as a setting paints it: the theme's light block with the palette and its yellow on top. */
const paper = (mode: LightMode): Record<string, string> => ({
  ...light,
  ...LIGHT_PALETTES[mode].tokens,
  "--primary": LIGHT_PALETTES[mode].accents.yellow,
});
const LIGHT_PAPERS = LIGHT_MODES.map((mode) => [`light (${mode})`, paper(mode)] as const);

function hex(tokens: Record<string, string>, name: string): string {
  let value = tokens[name];
  for (let depth = 0; value?.startsWith("var(") && depth < 4; depth++) value = tokens[value.slice(4, -1)];
  if (!/^#[0-9a-f]{6}$/i.test(value ?? "")) throw new Error(`${name} is "${tokens[name]}", not a #rrggbb colour`);
  return value;
}

function luminance(colour: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function over(colour: string, surface: string, alpha: number): string {
  const channel = (c: string, i: number) => parseInt(c.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(channel(colour, i) * alpha + channel(surface, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

// bb paints --warning and --destructive as text too (text-warning, text-destructive), not only as fills.
const TEXT = [
  "--ink", "--muted-foreground", "--readback-foreground", "--subtle-foreground", "--primary", "--file-accent",
  "--destructive", "--destructive-text", "--warning", "--warning-text", "--success", "--diff-added",
  "--diff-removed", "--pr-merged",
];
const SURFACES = ["--canvas", "--card", "--popover", "--sidebar"];
// Hovered rows, chips and badges sit on these fills.
const FILLS = ["--muted", "--secondary", "--accent", "--sidebar-accent"];
const ON_FILLS = ["--ink", "--muted-foreground", "--readback-foreground", "--subtle-foreground", "--primary"];
// The terminal paints on --sidebar and command output on --canvas. ANSI 0 is the black a terminal
// treats as its background, so it is exempt.
const ANSI = Array.from({ length: 15 }, (_, i) => `--ansi-${i + 1}`);

describe.each([...LIGHT_PAPERS, ["dark", dark] as const])("%s mode", (_mode, tokens) => {
  it.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface])))(
    "%s on %s clears 4.5:1",
    (text, surface) => {
      expect(contrast(hex(tokens, text), hex(tokens, surface))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    ["--primary-foreground", "--primary"],
    ["--destructive-foreground", "--destructive"],
    ...ON_FILLS.flatMap((text) => FILLS.map((fill) => [text, fill])),
    ...ANSI.flatMap((colour) => [[colour, "--sidebar"], [colour, "--canvas"]]),
  ])("%s on %s clears 4.5:1", (text, fill) => {
    expect(contrast(hex(tokens, text), hex(tokens, fill))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Array.from({ length: 16 }, (_, i) => i))("ANSI %i keeps 4.5:1 for the text drawn on it", (i) => {
    expect(contrast(hex(tokens, `--ansi-bg-fg-${i}`), hex(tokens, `--ansi-${i}`))).toBeGreaterThanOrEqual(4.5);
  });

  // bb's status badges and Theme Preview paint the text on a 15% wash of the status colour.
  it.each([
    ["--success", "--success"],
    ["--warning-text", "--warning"],
    ["--attention", "--attention"],
    ["--destructive-text", "--destructive"],
    ["--pr-merged", "--pr-merged"],
  ])("%s on a 15 percent wash of %s clears 4.5:1", (text, wash) => {
    for (const surface of ["--card", "--canvas"]) {
      expect(contrast(hex(tokens, text), over(hex(tokens, wash), hex(tokens, surface), 0.15))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("orders the text tiers muted, readback, subtle from strongest to weakest", () => {
    const onCanvas = (name: string) => contrast(hex(tokens, name), hex(tokens, "--canvas"));
    expect(onCanvas("--muted-foreground")).toBeGreaterThan(onCanvas("--readback-foreground"));
    expect(onCanvas("--readback-foreground")).toBeGreaterThan(onCanvas("--subtle-foreground"));
  });
});

// With square corners and no shadows, borders and the card step are the only separation between layers.
// Floors keep cards, buttons, chips and selected rows distinct from the page; in dark mode a ceiling also
// keeps lines from going harsh, while light mode's lines need more weight to show on paper.
type Floor = [string, string, number];

// Every paper but classic, which keeps 0.2.0's faint lines for whoever preferred them.
const FIRM_LIGHT: Floor[] = [
  ["--card", "--canvas", 1.06],
  ["--border-seam", "--canvas", 1.9],
  ["--border-seam", "--card", 2.0],
  ["--border-hairline", "--canvas", 1.8],
  ["--border", "--canvas", 2.0],
  ["--border", "--card", 2.1],
  ["--sidebar-border", "--sidebar", 1.7],
  ["--secondary", "--card", 1.25],
  ["--muted", "--canvas", 1.2],
  ["--sidebar-accent", "--sidebar", 1.2],
  // WCAG asks 3:1 of the outline that marks a form control.
  ["--input", "--canvas", 3.0],
];

describe.each<[string, Record<string, string>, Floor[]]>([
  ["dark", dark, [
    ["--card", "--canvas", 1.12],
    ["--border-seam", "--canvas", 1.45],
    ["--border-seam", "--card", 1.3],
    ["--border", "--canvas", 1.6],
    ["--border", "--card", 1.45],
    ["--secondary", "--card", 1.08],
  ]],
  ...(["bright", "soft", "dim"] as const).map((mode): [string, Record<string, string>, Floor[]] => [`light (${mode})`, paper(mode), FIRM_LIGHT]),
])("%s mode layers", (_mode, tokens, floors) => {
  it.each(floors)("%s stands apart from %s by at least %s:1", (a, b, floor) => {
    expect(contrast(hex(tokens, a), hex(tokens, b))).toBeGreaterThanOrEqual(floor);
  });
});

// A light theme glares when its big surfaces sit near white, so the default paper and the dimmer one
// keep the page and the cards on it dimmed.
describe.each(["soft", "dim"] as const)("light mode glare (%s)", (mode) => {
  it.each([["--canvas", 0.8], ["--card", 0.85], ["--popover", 0.85], ["--sidebar", 0.8]])(
    "%s stays at or under %s relative luminance",
    (surface, ceiling) => {
      expect(luminance(hex(paper(mode), surface))).toBeLessThanOrEqual(ceiling);
    },
  );
});

// The setting swaps in a whole palette, so each one must cover every colour the theme's light block
// sets; a colour it missed would keep the default paper's value and mix two palettes.
describe("light palettes", () => {
  const SHARED = new Set(["--primary", "--primary-foreground", "--destructive-foreground", "--attention-foreground", "--file-accent"]);
  const colours = Object.keys(light).filter(
    (name) => !SHARED.has(name) && !/^--(ansi-bg-fg-|font-|gruve-|radius|shadow|pill-shadow)/u.test(name),
  );

  it.each(LIGHT_MODES)("%s sets every colour of the theme's light block", (mode) => {
    expect(Object.keys(LIGHT_PALETTES[mode].tokens).sort()).toEqual([...colours].sort());
  });

  it("repeats the theme's own light block as the default paper", () => {
    expect(LIGHT_PALETTES[DEFAULT_APPEARANCE.lightMode].tokens).toEqual(Object.fromEntries(colours.map((name) => [name, light[name]])));
    expect(LIGHT_PALETTES[DEFAULT_APPEARANCE.lightMode].accents.yellow).toBe(light["--primary"]);
  });

  it("keeps the classic paper as Gruve 0.2.0 shipped it", () => {
    expect(LIGHT_PALETTES.classic.tokens["--canvas"]).toBe("#f4f1e8");
    expect(LIGHT_PALETTES.classic.tokens["--card"]).toBe("#faf8f1");
    expect(LIGHT_PALETTES.classic.tokens["--border"]).toBe("#d3ccba");
    expect(LIGHT_PALETTES.classic.accents.yellow).toBe("#7d520b");
  });

  it.each(["--canvas", "--card", "--sidebar"])("dims %s from the two bright papers to soft, then to dim", (surface) => {
    const brightness = (mode: LightMode) => luminance(hex(paper(mode), surface));
    expect(brightness("soft")).toBeLessThan(Math.min(brightness("classic"), brightness("bright")));
    expect(brightness("dim")).toBeLessThan(brightness("soft"));
  });
});

describe("dark mode lines", () => {
  it.each(["--border", "--border-seam", "--border-hairline", "--input"])("%s stays under 2.2:1 on the canvas", (line) => {
    expect(contrast(hex(dark, line), hex(dark, "--canvas"))).toBeLessThan(2.2);
  });
});

describe("theme", () => {
  it("keeps dark body text under 12:1 so it does not bloom on dark screens", () => {
    expect(contrast(hex(dark, "--ink"), hex(dark, "--canvas"))).toBeLessThan(12);
  });

  it("is declared in the manifest and points at a file that exists", () => {
    const [theme] = manifest.bb.themes;
    expect(theme.id).toBe("gruve");
    expect(existsSync(join(root, theme.css))).toBe(true);
  });

  // The settings rewrite three tokens; the theme has to draw from them, or the
  // choices would change nothing.
  it("squares corners through one variable the settings can rewrite", () => {
    expect(light["--gruve-corner"]).toBe("0px");
    expect(light["--radius"]).toBe("var(--gruve-corner)");
    expect(css).toMatch(/\) \{\s*border-radius: var\(--gruve-corner\);/u);
  });

  it("draws the composer prompt from variables the settings can rewrite", () => {
    expect(light["--gruve-prompt"]).toBe('"❯"');
    expect(light["--gruve-prompt-indent"]).toBe("2.125rem");
    expect(css).toContain("content: var(--gruve-prompt);");
    expect(css).toContain("padding-left: var(--gruve-prompt-indent);");
  });

  // The appearance code finds the active theme by this token, so it must stay in
  // the sheet and keep meaning something.
  it("names itself with the token the settings look for", () => {
    expect(css).toContain("--gruve-prompt");
  });

  const selectors = (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+(?=\{)/g) ?? []).map((s) => s.trim());

  it("never targets another plugin's classes", () => {
    expect(selectors.join("\n")).not.toMatch(/\.sb-/);
  });

  // bb fills this group with ink and forces its buttons transparent, so without its own rule the send
  // button shows dark in light mode and light in dark mode.
  it("outlines the send group in the accent instead of bb's ink fill", () => {
    const group = css.match(/\[data-bb-plugin="bb--composer"\] \[data-promptbox-send-menu\] \{([^}]*)\}/u)?.[1] ?? "";
    expect(group).toContain("background: transparent;");
    expect(group).toContain("color: var(--primary);");
  });

  it("styles only the bundled composer, so a replacement composer plugin is left alone", () => {
    const composer = selectors.filter((s) => /promptbox|ProseMirror/.test(s));
    expect(composer.length).toBeGreaterThan(0);
    for (const selector of composer) expect(selector).toMatch(/^\[data-bb-plugin="bb--composer"\] /);
  });
});

// The accent is a setting, so each choice has to keep the promise the theme makes:
// it is drawn as text and as a fill.
describe.each([
  ...LIGHT_MODES.map((lightMode) => ["light", lightMode, paper(lightMode)] as const),
  ["dark", DEFAULT_APPEARANCE.lightMode, dark] as const,
])("%s mode accents on the %s paper", (mode, lightMode, tokens) => {
  const accents = SETTING_DESCRIPTORS.accent.options as Accent[];

  it.each(accents)("%s is readable as text on every surface", (accent) => {
    const [primary] = accentColours(accent, mode, lightMode);
    for (const surface of SURFACES) expect(contrast(primary, hex(tokens, surface))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(accents)("%s carries text on its own fill", (accent) => {
    const [primary, onPrimary] = accentColours(accent, mode, lightMode);
    expect(contrast(onPrimary, primary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each([["light", light], ["dark", dark]] as const)("%s mode default accent", (mode, tokens) => {
  it("ships gruvbox yellow as the theme's own accent", () => {
    const [primary, onPrimary] = accentColours(DEFAULT_APPEARANCE.accent, mode);
    expect(hex(tokens, "--primary")).toBe(primary);
    expect(hex(tokens, "--primary-foreground")).toBe(onPrimary);
  });
});
