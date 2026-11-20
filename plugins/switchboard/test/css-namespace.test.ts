import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// bb loads every plugin's stylesheet into the whole window and scopes only Tailwind utilities, so a plain class
// rule from another plugin reaches Switchboard's rows, and Switchboard's reach theirs. Shopify Browser's bare
// `.sb-stale { position: absolute; inset: 0 }` once stacked every faded row on top of its section.
const PREFIX = "switchboard-";
const HOST_CLASSES = new Set(["light", "dark"]);

const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

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
    expect(all.length).toBeGreaterThan(100);
  });

  it("names every class it styles with the plugin id", () => {
    const foreign = all.flatMap((selector) => [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((match) => match[1]!))
      .filter((name) => !name.startsWith(PREFIX) && !HOST_CLASSES.has(name));
    expect([...new Set(foreign)]).toEqual([]);
  });

  it("anchors every rule on its own class or attribute, so none reaches another plugin's elements", () => {
    const unanchored = all.filter((selector) => !selector.includes(`.${PREFIX}`) && !selector.includes(`[data-${PREFIX}`) &&
      !/^(?::root|\.light|\.dark)$/.test(selector));
    expect(unanchored).toEqual([]);
  });

  it("defines only its own custom properties and keyframes", () => {
    const properties = [...css.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((match) => match[1]!);
    expect(properties.length).toBeGreaterThan(0);
    expect([...new Set(properties.filter((name) => !name.startsWith(`--${PREFIX}`)))]).toEqual([]);
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!);
    expect(keyframes.length).toBeGreaterThan(0);
    expect(keyframes.filter((name) => !name.startsWith(PREFIX))).toEqual([]);
  });

  it("leaves no short sb- names in its sources", () => {
    for (const path of [...sources(join(process.cwd(), "src")), join(process.cwd(), "app.tsx")]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/(?<![\w-])(?:--|data-)?sb-|dataset\.sb[A-Z]/);
    }
  });
});
