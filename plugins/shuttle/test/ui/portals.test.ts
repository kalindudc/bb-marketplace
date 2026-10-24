// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/u.test(entry.name) ? [join(dir, entry.name)] : []));

// bb applies a plugin's CSS only under [data-bb-plugin=<id>]. A portal to document.body that does not
// carry usePortalScope() keeps only the classes bb's own stylesheet happens to have, which is how the
// reviewer picker's avatars lost their size. Every portal in the UI has to spread the scope.
describe("portals", () => {
  it("carry Shuttle's CSS scope", () => {
    const offenders: string[] = [];
    for (const file of [...files(join(__dirname, "../../src/ui")), join(__dirname, "../../app.tsx")]) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<(?:\w+\.)?(?:Content|SubContent)\b(?![^>]*\{\.\.\.scope\})/gu)) {
        if (/Popover|DropdownMenu|Select|Tooltip|HoverCard|ContextMenu|Menubar/u.test(match[0])) offenders.push(`${file}: ${match[0]}`);
      }
      for (const match of source.matchAll(/createPortal\(\s*<\w+(?![^>]*\{\.\.\.scope\})/gu)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
