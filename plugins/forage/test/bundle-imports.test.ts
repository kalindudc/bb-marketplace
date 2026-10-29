// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(__dirname, "..");

// Every file the app entry reaches through value imports, as bb's frontend build follows them.
function reachable(entry: string): string[] {
 const seen = new Set<string>();
 const visit = (file: string) => {
  if (seen.has(file)) return;
  seen.add(file);
  for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gmu)) {
   const found = resolve(dirname(file), match[1]!);
   if (existsSync(found) && /\.tsx?$/u.test(found)) visit(found);
  }
 };
 visit(entry);
 return [...seen];
}

describe("the frontend bundle", () => {
 it("takes no value from the SDK's root package or from server-only modules", () => {
  const files = reachable(join(root, "app.tsx")).map((file) => file.slice(root.length + 1));
  expect(files).toContain("src/ui/research.tsx");
  const sdkRoot = files.filter((file) => /^\s*import\s+(?!type\b)[^;]*from\s+"@get-bb\/plugin-sdk"/mu.test(readFileSync(join(root, file), "utf8")));
  expect(sdkRoot).toEqual([]);
  const serverOnly = files.filter((file) => /^src\/(research\/(activity|queries|find|rpc)|sources\/repository|operations|crawl)/u.test(file));
  expect(serverOnly).toEqual([]);
 });
});
