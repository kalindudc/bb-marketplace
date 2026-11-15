// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Optical centring trims a label's box to its cap height and lets the glyphs overflow (`overflow: clip visible`). On clamped text that
// beats the clamp's `overflow: hidden`, and the third and later lines spill over the next row (the room's Decided list, f7bd7eca). So a
// clamp is always written on `.clamp` (or the Clamp part's `.ct`), and the trim never touches either. jsdom can't evaluate `:has()` or
// `@supports (text-box)`, so this holds the rule on the stylesheets themselves.
const css = readdirSync("src/ui/kit").filter(f => f.endsWith(".css")).map(f => ({ file: f, text: readFileSync(`src/ui/kit/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
const rules = css.flatMap(({ file, text }) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ file, selector: m[1]!.trim(), body: m[2]! })));
/** Splits at `at` (commas, or combinators) outside any parentheses. */
function topLevel(text: string, at: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && at.test(ch)) { parts.push(cur); cur = ""; } else cur += ch;
  }
  return [...parts, cur].map(x => x.trim()).filter(Boolean);
}
/** The last compound of each selector in a list: what the rule styles. */
const subjects = (selector: string) => topLevel(selector, /,/).map(s => topLevel(s, /[\s>+~]/).at(-1) ?? "");

describe("line clamps and optical centring", () => {
  it("writes every kit line clamp on .clamp or .ct", () => {
    const clamps = rules.filter(r => /-webkit-line-clamp:\s*\d/.test(r.body));
    expect(clamps.length).toBeGreaterThan(0);
    for (const r of clamps) for (const s of subjects(r.selector)) expect(s, `${r.file}: ${r.selector}`).toMatch(/\.(clamp|ct)\b/);
  });

  it("never trims .clamp or .ct text", () => {
    const trims = rules.filter(r => /text-box:\s*trim/.test(r.body));
    expect(trims.length).toBeGreaterThan(0);
    for (const r of trims) {
      for (const s of subjects(r.selector)) {
        // A rule that trims any span or b in a control must exclude both; a rule naming its own targets must not name a clamp.
        if (/:is\([^)]*\b(span|b)\b/.test(s)) expect(s, r.selector).toMatch(/:not\([^)]*\.ct\b[^)]*\.clamp\b|:not\([^)]*\.clamp\b[^)]*\.ct\b/);
        else expect(s, r.selector).not.toMatch(/\.(clamp|ct)\b/);
      }
    }
  });
});
