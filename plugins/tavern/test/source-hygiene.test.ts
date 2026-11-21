// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps source and skills independent of named machine command groups and private URL hosts", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const allowed = new Set(["example.com", "github.com", "json-schema.org", "www.w3.org"]);
  const violations: string[] = [];
  for (const [tree, extensions] of [["src", /\.(?:ts|tsx|md|css)$/], ["skills", /\.md$/]] as const) {
    for (const entry of readdirSync(join(root, tree), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !extensions.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      const source = readFileSync(path, "utf8");
      const file = relative(root, path);
      for (const match of source.matchAll(/\b[a-z][a-z0-9-]*-machines\b/gi)) violations.push(`${file}: ${match[0]}`);
      for (const [url] of source.matchAll(/https?:\/\/[a-z0-9%\[][^\s"'`<>\\})]*/gi)) {
        const host = new URL(url).hostname.replace(/\.$/, "");
        if (!allowed.has(host)) violations.push(`${file}: ${host}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
