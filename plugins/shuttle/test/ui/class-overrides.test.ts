// @vitest-environment node
// Tailwind orders its utilities in the stylesheet, not by their order in className, so a class appended to a shared
// style such as BUTTON loses whenever the style already sets that property and sorts later: `${BUTTON} bg-state-active`
// keeps BUTTON's transparent background. Shared styles therefore come in variants (BUTTON_ON, BUTTON_DANGER, ...) and
// call sites only add properties the style leaves alone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UI = fileURLToPath(new URL("../../src/ui", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/u.test(name) ? [path] : [];
  });
}

const SIZES = new Set(["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"]);
const SIDES: Record<string, string[]> = { "": ["t", "r", "b", "l"], x: ["r", "l"], y: ["t", "b"], t: ["t"], r: ["r"], b: ["b"], l: ["l"] };

/** The CSS properties a utility sets, as a few coarse names; empty for utilities this check does not need to know. */
export function propertiesOf(utility: string): string[] {
  const at = utility.lastIndexOf(":");
  const variant = at < 0 ? "" : utility.slice(0, at + 1);
  const name = utility.slice(at + 1).replace(/^!|!$/gu, "").replace(/^-/u, "");
  const tag = (props: string[]) => props.map((prop) => `${variant}${prop}`);
  let match: RegExpExecArray | null;
  if ((match = /^text-(.+)$/u.exec(name))) {
    const value = match[1]!;
    if (SIZES.has(value) || /^\[\d/u.test(value)) return tag(["font-size"]);
    if (["left", "center", "right", "justify", "start", "end", "wrap", "nowrap", "balance", "pretty", "ellipsis", "clip"].includes(value)) return [];
    return tag(["color"]);
  }
  if ((match = /^bg-(.+)$/u.exec(name))) return /^(gradient|linear|radial|none|clip|origin|cover|contain|repeat|fixed)/u.test(match[1]!) ? [] : tag(["background-color"]);
  if ((match = /^border(?:-([trblxy]))?(?:-(.+))?$/u.exec(name))) {
    const [, side = "", value] = match;
    const sides = SIDES[side] ?? [];
    if (value === undefined || /^(\d+|\[\d.*\])$/u.test(value)) return tag(sides.map((s) => `border-${s}-width`));
    if (["solid", "dashed", "dotted", "double", "none", "hidden"].includes(value)) return tag(["border-style"]);
    return tag(sides.map((s) => `border-${s}-color`));
  }
  if ((match = /^size-(.+)$/u.exec(name))) return tag(["width", "height"]);
  if ((match = /^(min-|max-)?([hw])-(.+)$/u.exec(name))) return tag([`${match[1] ?? ""}${match[2] === "h" ? "height" : "width"}`]);
  if ((match = /^([pm])([trblxy]?)-(.+)$/u.exec(name))) {
    const box = match[1] === "p" ? "padding" : "margin";
    return tag((SIDES[match[2]!] ?? []).map((s) => `${box}-${s}`));
  }
  if (/^rounded(-|$)/u.test(name)) return tag(["border-radius"]);
  if (/^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/u.test(name)) return tag(["font-weight"]);
  if (/^opacity-/u.test(name)) return tag(["opacity"]);
  return [];
}

type Styles = Map<string, Map<string, string[]>>;

/** Every `const NAME = "..."` or `` `${OTHER} ...` `` class string in the UI, by name and then by the file that defines it. */
function sharedStyles(sources: Map<string, string>): Styles {
  const styles: Styles = new Map();
  const define = (name: string, path: string, utilities: string[]) => {
    if (!styles.has(name)) styles.set(name, new Map());
    styles.get(name)!.set(path, utilities);
  };
  // Only strings of classes: a constant such as a path or a URL is not a style.
  const classes = (value: string) => value.split(/\s+/u).filter(Boolean);
  const isStyle = (utilities: string[]) => utilities.some((utility) => propertiesOf(utility).length > 0 || /^(flex|grid|inline-flex|block|hidden|truncate|relative|absolute|sticky)$/u.test(utility));
  for (const [path, text] of sources) {
    for (const match of text.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = "([^"]*)";/gmu)) {
      if (isStyle(classes(match[2]!))) define(match[1]!, path, classes(match[2]!));
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const [path, text] of sources) {
      for (const match of text.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = `([^`]*)`;/gmu)) {
        const parts = match[2]!.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (_, name: string) => (lookup(styles, name, path)[0] ?? []).join(" "));
        if (!parts.includes("${")) define(match[1]!, path, parts.split(/\s+/u).filter(Boolean));
      }
    }
  }
  return styles;
}

/** A name as one file sees it: its own definition, or else every other file's, since the import is not resolved. */
function lookup(styles: Styles, name: string, path: string): string[][] {
  const defs = styles.get(name);
  if (!defs) return [];
  const own = defs.get(path);
  return own ? [own] : [...defs.values()];
}

/**
 * Class strings that put a shared style first and add classes after it: `${BUTTON} ...`, with any `${a ? "x" : "y"}`, and
 * the shared styles built from another one the same way. A class passed in through a variable cannot be checked, so a
 * template that adds one to a shared style is reported too.
 */
export function overrides(sources: Map<string, string>): string[] {
  const styles = sharedStyles(sources);
  const found: string[] = [];
  for (const [path, text] of sources) {
    for (const match of text.matchAll(/`([^`]*)`/gu)) {
      const template = match[1]!;
      const bases = [...template.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/gu)].map((m) => m[1]!).filter((name) => styles.has(name));
      if (bases.length === 0) continue;
      const line = text.slice(0, match.index).split("\n").length;
      for (const expr of [...template.matchAll(/\$\{([^}]*)\}/gu)].map((m) => m[1]!.trim())) {
        // A ternary's condition is not classes; each of its answers must be a string or a shared style.
        const answers = expr.includes("?") ? expr.slice(expr.indexOf("?") + 1).split(":").map((part) => part.trim()) : [expr];
        for (const answer of answers) {
          if (styles.has(answer) || /^"[^"]*"$/u.test(answer)) continue;
          found.push(`${relative(UI, path)}:${line}: ${bases.join(", ")} + \${${expr}} adds classes this test cannot read`);
          break;
        }
      }
      const literal = template.replace(/\$\{[^}]*\}/gu, " ").split(/\s+/u);
      const chosen = [...template.matchAll(/\$\{([^}]*)\}/gu)].flatMap((m) => [...m[1]!.matchAll(/"([^"]*)"/gu)].flatMap((s) => s[1]!.split(/\s+/u)));
      const added = [...literal, ...chosen].filter(Boolean);
      for (const base of bases.flatMap((name) => lookup(styles, name, path).map((utilities) => [name, utilities] as const))) {
        const [name, utilities] = base;
        const set = new Map(utilities.flatMap((utility) => propertiesOf(utility).map((prop) => [prop, utility] as const)));
        for (const utility of added) {
          for (const prop of propertiesOf(utility)) {
            const clash = set.get(prop);
            if (clash !== undefined && clash !== utility) found.push(`${relative(UI, path)}:${line}: ${name} + ${utility} fights ${clash} (${prop})`);
          }
        }
      }
    }
  }
  return [...new Set(found)];
}

describe("class strings built on a shared style", () => {
  it("knows which properties a utility sets", () => {
    expect(propertiesOf("bg-state-active")).toEqual(["background-color"]);
    expect(propertiesOf("hover:bg-foreground/90")).toEqual(["hover:background-color"]);
    expect(propertiesOf("text-xs")).toEqual(["font-size"]);
    expect(propertiesOf("text-[13px]")).toEqual(["font-size"]);
    expect(propertiesOf("text-destructive-text")).toEqual(["color"]);
    expect(propertiesOf("border")).toEqual(["border-t-width", "border-r-width", "border-b-width", "border-l-width"]);
    expect(propertiesOf("border-destructive/40")).toEqual(["border-t-color", "border-r-color", "border-b-color", "border-l-color"]);
    expect(propertiesOf("border-l-foreground")).toEqual(["border-l-color"]);
    expect(propertiesOf("py-1")).toEqual(["padding-t", "padding-b"]);
    expect(propertiesOf("-mx-4")).toEqual(["margin-r", "margin-l"]);
    expect(propertiesOf("size-5")).toEqual(["width", "height"]);
    expect(propertiesOf("truncate")).toEqual([]);
  });

  it("finds a class that fights its style", () => {
    const sample = new Map([["a.tsx", 'export const BUTTON = "h-7 border border-input bg-transparent px-2.5";\nconst x = `${BUTTON} bg-state-active w-full`;\nconst y = `${BUTTON} ${on ? "border-destructive/40" : ""}`;']]);
    expect(overrides(sample)).toEqual([
      "../../a.tsx:2: BUTTON + bg-state-active fights bg-transparent (background-color)",
      "../../a.tsx:3: BUTTON + border-destructive/40 fights border-input (border-t-color)",
      "../../a.tsx:3: BUTTON + border-destructive/40 fights border-input (border-r-color)",
      "../../a.tsx:3: BUTTON + border-destructive/40 fights border-input (border-b-color)",
      "../../a.tsx:3: BUTTON + border-destructive/40 fights border-input (border-l-color)",
    ].map((entry) => entry.replace("../../a.tsx", relative(UI, "a.tsx"))));
  });

  it("checks a shared style built from another, and a class passed in through a variable", () => {
    const sample = new Map([["a.tsx", 'export const BUTTON = "h-7 bg-transparent";\nexport const BUTTON_ON = `${BUTTON} bg-state-active`;\nconst x = `${BUTTON} ${extra}`;\nconst y = `${BUTTON} ${on ? extra : \"w-full\"}`;\nconst z = `${BUTTON} ${on ? \"w-full\" : \"\"}`;']]);
    const here = relative(UI, "a.tsx");
    expect(overrides(sample)).toEqual([
      `${here}:2: BUTTON + bg-state-active fights bg-transparent (background-color)`,
      `${here}:3: BUTTON + \${extra} adds classes this test cannot read`,
      `${here}:4: BUTTON + \${on ? extra : "w-full"} adds classes this test cannot read`,
    ]);
  });

  it("never adds a class that sets what its shared style already sets", () => {
    const sources = new Map(files(UI).map((path) => [path, readFileSync(path, "utf8")] as const));
    expect(overrides(sources)).toEqual([]);
  });
});
