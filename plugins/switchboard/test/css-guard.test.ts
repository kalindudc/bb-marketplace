import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const forbidden = /:has\(|has-\[|group-has-/;
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");

describe("theme conformance", () => {
  it("takes surface corners from the theme, keeping only semantic circles and square joins", () => {
    for (const declaration of css.matchAll(/(?:border-radius|--sb-pill-radius):\s*([^;]+);/g)) {
      const corners = declaration[1].replace(/max\(0px, calc\(var\(--radius\) - \d+px\)\)/g, "");
      expect(corners).not.toMatch(/\d+px/);
      expect(declaration[1]).toMatch(/var\(--radius-|^0$|^50%$/);
    }
    for (const name of ["thread-row.tsx", "group-header.tsx", "filter-bar.tsx"]) {
      expect(readFileSync(join(process.cwd(), "src", name), "utf8")).not.toMatch(/rounded-\[\d+px\]|rounded-full/);
    }
  });

  it("derives small corners from the base radius when a theme omits the aliases", () => {
    expect(css).not.toMatch(/var\(--radius-(?:xs|sm)\)/);
    expect(css).toContain("var(--radius-sm, max(0px, calc(var(--radius) - 4px)))");
    expect(css).toContain("var(--radius-xs, max(0px, calc(var(--radius) - 6px)))");
  });

  it("uses theme elevation and fonts for the drag preview and portalled info card", () => {
    for (const name of ["sb-ghost", "sb-info-card"]) {
      const body = css.match(new RegExp(`^\\.${name} \\{([^}]+)\\}`, "m"))?.[1];
      expect(body).toMatch(/box-shadow: var\(--shadow-/);
    }
    expect(css).toMatch(/font-family: var\(--font-sans\)/);
    expect(css).toMatch(/font-family: var\(--font-mono\)/);
  });

  it("uses the destructive foreground rather than white or the page background", () => {
    expect(css).toMatch(/\.sb-drop-pill-bad \{[^}]*color: var\(--destructive-foreground\)/);
    for (const name of ["section-menu.tsx", "bulk-bar.tsx"]) {
      const source = readFileSync(join(process.cwd(), "src", name), "utf8");
      expect(source).not.toContain("text-white");
      expect(source).toContain("text-destructive-foreground");
    }
  });
});

describe("CSS selector guard", () => {
  it("rejects relational selectors and their Tailwind variants", () => {
    for (const sample of [":has(.child)", "has-[.child]", "group-has-[.child]"]) {
      expect(forbidden.test(sample)).toBe(true);
    }
  });
  for (const path of [join(process.cwd(), "app.tsx"), ...sources(join(process.cwd(), "src"))]) {
    it(`${path} uses no expensive relational selector`, () => {
      expect(readFileSync(path, "utf8")).not.toMatch(forbidden);
    });
  }
});
