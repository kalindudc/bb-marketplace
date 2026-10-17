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
