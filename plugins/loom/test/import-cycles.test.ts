import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");
const IMPORT = /^(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+"(\.[^"]+)"/gm;

/** The relative imports of each file that bring values, not types alone, by the file they resolve to. */
function valueImports(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const resolveIn = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((file) => sources.has(file)) ?? null;
  };
  return new Map(
    [...sources].map(([file, text]) => {
      const deps = [...text.matchAll(IMPORT)].flatMap((match) => {
        if (match[1] !== undefined) return [];
        const names = match[2]?.split(",").map((name) => name.trim()).filter((name) => name !== "");
        if (names !== undefined && names.every((name) => name.startsWith("type "))) return [];
        const target = resolveIn(file, match[3]!);
        return target === null ? [] : [target];
      });
      return [file, [...new Set(deps)]];
    }),
  );
}

/** The groups of two or more files that import each other's values, directly or around a loop (Tarjan's algorithm). */
function cycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (file: string) => {
    index.set(file, next);
    low.set(file, next);
    next += 1;
    stack.push(file);
    onStack.add(file);
    for (const dep of graph.get(file) ?? []) {
      if (!index.has(dep)) {
        visit(dep);
        low.set(file, Math.min(low.get(file)!, low.get(dep)!));
      } else if (onStack.has(dep)) low.set(file, Math.min(low.get(file)!, index.get(dep)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== file);
    if (group.length > 1) found.push(group.sort());
  };
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return found;
}

function engineSources(dir: string, into = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "ui") engineSources(path, into);
    } else if (/\.tsx?$/u.test(name)) into.set(path, readFileSync(path, "utf8"));
  }
  return into;
}

describe("value imports between Loom's engine files", () => {
  it("form no cycle, so each file can be read, tested and loaded on its own", () => {
    const found = cycles(valueImports(engineSources(SRC))).map((group) => group.map((file) => relative(SRC, file)));
    expect(found).toEqual([]);
  });

  it("finds a cycle through value imports and ignores one through types alone", () => {
    const at = (name: string) => join(SRC, `${name}.ts`);
    const sources = new Map([
      [at("a"), 'import { b } from "./b";\nimport type { D } from "./d";'],
      [at("b"), 'import {\n  type X,\n  c,\n} from "./c";'],
      [at("c"), 'export { a } from "./a";'],
      [at("d"), 'import { type A } from "./a";'],
    ]);
    expect(cycles(valueImports(sources))).toEqual([[at("a"), at("b"), at("c")]]);
  });
});
