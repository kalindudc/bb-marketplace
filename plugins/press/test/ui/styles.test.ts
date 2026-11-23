import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// bb loads every plugin's stylesheet into the whole window, so a bare `.pp-x` or `button` rule would
// style other plugins and bb itself.
const css = readFileSync(join(import.meta.dirname, "../../src/ui/press.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function selectors(source: string): string[] {
  const result: string[] = [];
  for (const match of source.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1]!.trim();
    if (prelude.startsWith("@") || /^(?:from|to|\d+%)$/.test(prelude)) continue;
    let depth = 0;
    let start = 0;
    for (let index = 0; index <= prelude.length; index++) {
      const char = prelude[index];
      if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if ((char === "," && depth === 0) || index === prelude.length) {
        result.push(prelude.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  return result;
}

describe("press.css", () => {
  it("starts every rule at a Press root", () => {
    const all = selectors(css);
    expect(all.length).toBeGreaterThan(100);
    // The one rule that reaches into bb's markup hides the native circle only beside Press's own chip.
    const allowed = /^(?:\.press-(?:panel|chip|chat)\b|:is\(\.press-panel, \.press-chat\) |\[data-follow-up-composer-footer\] :has\(> \[data-press-chip\] > \.press-footer-chip\))/;
    expect(all.filter((selector) => !allowed.test(selector))).toEqual([]);
  });

  it("prefixes keyframes and never types a colour", () => {
    expect([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]).filter((name) => !name!.startsWith("press-"))).toEqual([]);
    expect(css.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
    expect(css.match(/\b(?:rgb|hsl)a?\(/gi)).toBeNull();
  });

  it("never redefines a bb token in terms of itself", () => {
    const cycles = [...css.matchAll(/(--[\w-]+)\s*:[^;]*var\(\1\b/g)].map((match) => match[1]);
    expect(cycles).toEqual([]);
  });
});
