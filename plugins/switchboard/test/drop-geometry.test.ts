import { describe, expect, it } from "vitest";
import { resolveHeaderEdge, resolveRowInstruction, type RowGeometry } from "../src/drop-geometry";
import { densityMetrics } from "../src/metrics";

const row = (overrides: Partial<RowGeometry> = {}): RowGeometry => ({
  x: 60, y: 100, rect: { left: 10, top: 100, height: 40 },
  depth: 0, isLastChild: false, hasOpenChildren: false,
  base: densityMetrics("default").base, indent: densityMetrics("default").indent, ...overrides,
});

describe("drop geometry", () => {
  it("uses the top quarter for above and the bottom quarter for below", () => {
    expect(resolveRowInstruction(row({ y: 109 }))).toEqual({ kind: "above" });
    expect(resolveRowInstruction(row({ y: 110 }))).toEqual({ kind: "child" });
    expect(resolveRowInstruction(row({ y: 130 }))).toEqual({ kind: "child" });
    expect(resolveRowInstruction(row({ y: 131 }))).toEqual({ kind: "below" });
  });

  it("treats an expanded parent's lower area as a child drop", () => {
    expect(resolveRowInstruction(row({ y: 139, hasOpenChildren: true }))).toEqual({ kind: "child" });
    expect(resolveRowInstruction(row({ y: 101, hasOpenChildren: true }))).toEqual({ kind: "above" });
  });

  it("outdents only a last child from its lower edge and clamps levels", () => {
    for (const depth of [1, 2, 3]) {
      const content = 10 + densityMetrics("default").base + depth * densityMetrics("default").indent;
      expect(resolveRowInstruction(row({ x: content - 7, y: 139, depth, isLastChild: true })))
        .toEqual({ kind: "out", level: Math.max(0, depth - 1) });
      expect(resolveRowInstruction(row({ x: -100, y: 139, depth, isLastChild: true })))
        .toEqual({ kind: "out", level: 0 });
      expect(resolveRowInstruction(row({ x: content - 6, y: 139, depth, isLastChild: true })))
        .toEqual({ kind: "below" });
      expect(resolveRowInstruction(row({ x: -100, y: 139, depth, isLastChild: false })))
        .toEqual({ kind: "below" });
    }
    expect(resolveRowInstruction(row({ x: -100, y: 139, isLastChild: true }))).toEqual({ kind: "below" });
  });

  it("uses compact indentation for outdenting instead of the comfortable width", () => {
    const compact = densityMetrics("compact");
    expect(resolveRowInstruction(row({ ...compact, depth: 2, x: 10 + compact.base + 2 * compact.indent - 7,
      y: 139, isLastChild: true }))).toEqual({ kind: "out", level: 1 });
  });

  it("splits section headers at the midpoint", () => {
    expect(resolveHeaderEdge(19, { top: 10, height: 20 })).toBe("above");
    expect(resolveHeaderEdge(20, { top: 10, height: 20 })).toBe("below");
  });
});
