// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { SDK_CONTRACTS } from "./sdk-contract";

const root = fileURLToPath(new URL("../../", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}
it("keeps every production SDK call in the audited request inventory", () => {
  const calls = new Set<string>(), unresolved: string[] = [];
  for (const path of [...files(join(root, "src/server")), join(root, "src/scope/watch.ts"), join(root, "server.ts")]) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const parts: string[] = [];
        let expression = node.expression;
        while (ts.isPropertyAccessExpression(expression)) { parts.unshift(expression.name.text); expression = expression.expression; }
        const sdk = parts.indexOf("sdk");
        if (sdk >= 0) calls.add(parts.slice(sdk + 1).join("."));
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "sdk") {
        let parent: ts.Node = node;
        while (ts.isPropertyAccessExpression(parent.parent)) parent = parent.parent;
        if (!ts.isCallExpression(parent.parent)) unresolved.push(`${relative(root, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(unresolved, "SDK aliases need an explicit audit before bypassing the call inventory").toEqual([]);
  expect([...calls].sort()).toEqual(Object.keys(SDK_CONTRACTS).sort());
});
