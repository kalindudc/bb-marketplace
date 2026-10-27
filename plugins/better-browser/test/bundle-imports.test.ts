// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(__dirname, "..");
const EXTENSIONS = [".ts", ".tsx"];

// Every file the app entry reaches through value imports, as bb's frontend build follows them.
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      const base = resolve(dirname(file), match[1]!);
      const found = [base, ...EXTENSIONS.map((extension) => base + extension)].find((candidate) => existsSync(candidate) && !candidate.endsWith("/"));
      if (found !== undefined && EXTENSIONS.some((extension) => found.endsWith(extension))) visit(found);
    }
  };
  visit(entry);
  return [...seen];
}

describe("the frontend bundle", () => {
  it("takes no value from the SDK's root package or a Node module", () => {
    const files = reachable(join(root, "app.tsx"));
    expect(files.some((file) => file.endsWith("src/ui/toolbar.tsx"))).toBe(true);
    const offenders = files.filter((file) => /^\s*import\s+(?!type\b)[^;]*from\s+"(@get-bb\/plugin-sdk|node:[a-z]+)"/m.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([]);
  });
});
