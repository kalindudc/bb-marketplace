import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

describe.each([["light", light], ["dark", dark]] as const)("%s mode", (_mode, tokens) => {
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
// Floors keep cards, buttons and chips distinct from the page; the ceiling keeps lines from going harsh.
describe("dark mode layers", () => {
  const step = (a: string, b: string) => contrast(hex(dark, a), hex(dark, b));

  it.each([
    ["--card", "--canvas", 1.12],
    ["--border-seam", "--canvas", 1.45],
    ["--border-seam", "--card", 1.3],
    ["--border", "--canvas", 1.6],
    ["--border", "--card", 1.45],
    ["--secondary", "--card", 1.08],
  ])("%s stands %s apart from %s by at least %s:1", (a, b, floor) => {
    expect(step(a, b)).toBeGreaterThanOrEqual(floor);
  });

  it.each(["--border", "--border-seam", "--border-hairline", "--input"])("%s stays under 2.2:1 on the canvas", (line) => {
    expect(step(line, "--canvas")).toBeLessThan(2.2);
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

  const selectors = (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+(?=\{)/g) ?? []).map((s) => s.trim());

  it("never targets another plugin's classes", () => {
    expect(selectors.join("\n")).not.toMatch(/\.sb-/);
  });

  it("styles only the bundled composer, so a replacement composer plugin is left alone", () => {
    const composer = selectors.filter((s) => /promptbox|ProseMirror/.test(s));
    expect(composer.length).toBeGreaterThan(0);
    for (const selector of composer) expect(selector).toMatch(/^\[data-bb-plugin="bb--composer"\] /);
  });
});
