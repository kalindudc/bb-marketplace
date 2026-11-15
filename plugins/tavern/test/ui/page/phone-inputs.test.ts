import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The body of the stylesheet's phone and touch block: `@media (pointer: coarse), (max-width: 560px) { ... }`. */
function phoneBlock(file: string): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  const start = css.indexOf("@media (pointer: coarse), (max-width: 560px) {");
  expect(start, file).toBeGreaterThanOrEqual(0);
  let depth = 0, i = css.indexOf("{", start);
  for (let j = i; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) return css.slice(i + 1, j); }
  throw new Error("unclosed block");
}

describe("bb's phone input rule on the Machines page", () => {
  it("draws every editable field at 16 px or more on phones and touch screens", () => {
    const block = phoneBlock("src/ui/page/machines.css");
    const rule = /\.mx :is\(input, select, textarea\)\s*\{\s*font-size:\s*(\d+)px/.exec(block);
    expect(rule, "a phone rule for every input, select and textarea under .mx").not.toBeNull();
    expect(Number(rule![1])).toBeGreaterThanOrEqual(16);
  });
});
