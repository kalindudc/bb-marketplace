import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A selector list cut by another rule (an edit landing inside ":is(") silently drops the whole rule, such as the 44 px phone targets.
describe("the page's stylesheets", () => {
  const files = readdirSync("src/ui/page").filter((f) => f.endsWith(".css"));
  it.each(files)("%s closes every :is( and :where( list before its rule's braces", (file) => {
    const css = readFileSync(`src/ui/page/${file}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.match(/:(?:is|where)\([^)]*[{}]/g) ?? []).toEqual([]);
  });
  it("uses the shared responsive sizes for the room's status-line jumps", () => {
    const css = readFileSync("src/ui/page/page.css", "utf8");
    expect(css).toMatch(/button\.tv-hero\s*\{[^{}]*min-height: var\(--tavern-control-standard\);/);
    expect(css).toMatch(/\.rm-jump\s*\{[^{}]*min-height: var\(--tavern-control-compact\);/);
  });
});
