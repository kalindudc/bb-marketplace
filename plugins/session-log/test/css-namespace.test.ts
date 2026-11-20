import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// bb loads every plugin's stylesheet into the whole window and scopes only Tailwind utilities, so a short class
// name such as `sl-hidden` can be styled by another plugin's rule, and Session Log's rules can reach theirs.
const PREFIX = "session-log-";

const css = readFileSync(join(process.cwd(), "src/session-log.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function selectors(source: string): string[] {
  const result: string[] = [];
  for (const match of source.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1]!.trim();
    if (prelude.startsWith("@") || /^(?:from|to|\d+%)$/.test(prelude)) continue;
    let depth = 0, start = 0;
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

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("stylesheet namespace", () => {
  const all = selectors(css);

  it("reads the stylesheet's selectors", () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it("names every class, highlight and custom property with the plugin id", () => {
    const classes = all.flatMap((selector) => [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((match) => match[1]!));
    expect(classes.filter((name) => !name.startsWith(PREFIX))).toEqual([]);
    const highlights = [...css.matchAll(/::highlight\(([\w-]+)\)/g)].map((match) => match[1]!);
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.filter((name) => !name.startsWith(PREFIX))).toEqual([]);
    const properties = [...css.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((match) => match[1]!);
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.filter((name) => !name.startsWith(`--${PREFIX}`))).toEqual([]);
  });

  it("anchors every rule on its own class, attribute or highlight, so none reaches another plugin's elements", () => {
    expect(all.filter((selector) => !selector.includes(`.${PREFIX}`) && !selector.includes(`[data-${PREFIX}`) &&
      !selector.includes(`::highlight(${PREFIX}`))).toEqual([]);
  });

  it("leaves no short sl- names in its sources", () => {
    for (const path of [...sources(join(process.cwd(), "src")), join(process.cwd(), "app.tsx")]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/(?<![\w-])(?:--|data-)?sl-|dataset\.sl[A-Z]/);
    }
  });
});
