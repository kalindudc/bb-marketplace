import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Every stylesheet under src/ui, so a forever-loop, a property that lays out, or a dimming flame can't come back unmeasured.
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : []);
}
const files = cssFiles(join(process.cwd(), "src/ui"));
const css = files.map(f => readFileSync(f, "utf8")).join("\n");
const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map(m => ({ name: m[1]!, body: m[2]! }));
const components = readFileSync(join(process.cwd(), "src/ui/kit/components.css"), "utf8");
const pageCss = readFileSync(join(process.cwd(), "src/ui/page/page.css"), "utf8");

/** Latest end of a page deal at any party size: its stagger must be capped, as in `animation-delay: min(calc(var(--i) * 90ms), 450ms)`. */
function endAtAnySize(rule: string): number {
  const dur = Number(/animation:\s*[\w-]+\s+([\d.]+)s/.exec(rule)![1]) * 1000;
  const cap = /animation-delay:\s*min\(calc\(var\(--i(?:,\s*0)?\)\s*\*\s*\d+ms\),\s*(\d+)ms\)/.exec(rule);
  return cap ? dur + Number(cap[1]) : Infinity;
}

/** End time at the fifth member (index 4) of a rule like `animation: x .4s ...; animation-delay: calc(200ms + min(var(--i), 6) * 100ms)`. */
function endAtFifth(rule: string): number {
  const dur = Number(/animation:\s*[\w-]+\s+([\d.]+)s/.exec(rule)![1]) * 1000;
  const d = /animation-delay:\s*calc\((?:(\d+)ms\s*\+\s*)?min\(var\(--i\),\s*(\d+)\)\s*\*\s*(\d+)ms\)/.exec(rule);
  if (!d) return dur;
  const [, base = "0", cap, step] = d;
  return Number(base) + Math.min(4, Number(cap)) * Number(step) + dur;
}

describe("Tavern's stylesheets", () => {
  it("gives the band a layout, not a motion class on its count or facts", () => {
    const band = pageCss.split("\n").filter(line => line.includes(".tv-hearth-band"));
    expect(band.some(line => line.includes("display: grid"))).toBe(true);
    for (const rule of band.filter(line => /\.tv-(hero|facts)/.test(line))) expect(rule).not.toMatch(/animation:|transition:|\.mo-/);
  });
  it("loop nothing forever", () => {
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\binfinite\b/);
  });

  it("animate only transform and opacity", () => {
    expect(keyframes.length).toBeGreaterThan(5);
    for (const k of keyframes) for (const decl of k.body.matchAll(/([\w-]+)\s*:/g)) expect(["transform", "opacity"], `${k.name}: ${decl[1]}`).toContain(decl[1]);
  });

  it("never dim a burning or banked flame: the flicker and the flare animate no opacity", () => {
    const flame = keyframes.filter(k => k.name === "tavern-hearth-flick" || k.name === "tavern-hearth-flare");
    expect(flame).toHaveLength(2);
    for (const k of flame) expect(k.body, k.name).not.toMatch(/opacity/);
  });

  it("end each moment within 1,200 ms at five members, and play it only under its moment class", () => {
    const rules = components.split("\n").filter(l => /\.mo-(seal|deal|tale)\b/.test(l) && /animation:/.test(l));
    expect(rules.length).toBe(5);
    for (const r of rules) expect(endAtFifth(r), r).toBeLessThanOrEqual(1200);
    for (const name of ["tavern-stamp", "tavern-card", "tavern-deal", "tavern-rise"]) {
      const users = components.split("\n").filter(l => new RegExp(`animation:\\s*${name}\\b`).test(l));
      for (const l of users) expect(l, `${name} outside a moment class`).toMatch(/\.mo-(seal|deal|tale)\b/);
    }
  });

  it("end the page's deals at any party size: the tale's credits by 1,200 ms, only in its moment, the first-night ring by 1,000 ms", () => {
    const rule = (sel: string) => pageCss.split("\n").find(l => l.includes(sel) && /animation:/.test(l));
    expect(rule(".tv-page .tv-credit {"), "a credit card moves only in the tale's moment").toBeUndefined();
    expect(pageCss).not.toMatch(/\.tv-page \.tv-credit\s*\{[^}]*animation/);
    expect(endAtAnySize(rule(".tv-credits.mo-tale > .tv-credit")!)).toBeLessThanOrEqual(1200);
    expect(endAtAnySize(rule(".tv-hearth > span")!)).toBeLessThanOrEqual(1000);
  });
});
