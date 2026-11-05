import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = /^\s*import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gm;

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  return null;
}

function appFiles(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const [, typeOnly, , specifier] of readFileSync(entry, "utf8").matchAll(IMPORT)) {
    if (typeOnly || !(specifier!.startsWith(".") || specifier!.startsWith("@/"))) continue;
    const file = resolveLocal(entry, specifier!);
    if (file !== null) appFiles(file, seen);
  }
  return seen;
}

describe("the frontend bundle", () => {
  // A git install leaves dev dependencies out, and bb's frontend build supplies only @get-bb/plugin-sdk/app.
  it("never imports a value from the SDK's root entry", () => {
    const offenders = [...appFiles(join(root, "app.tsx"))].flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(IMPORT)]
        .filter(([, typeOnly, names, specifier]) => specifier === "@get-bb/plugin-sdk" && !typeOnly && !/^\{\s*type\s[^,]*\}$/.test(names!))
        .map(() => file.slice(root.length + 1)),
    );
    expect(offenders).toEqual([]);
  });
});
