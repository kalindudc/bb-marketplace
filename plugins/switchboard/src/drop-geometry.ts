export type RowInstruction = { kind: "above" } | { kind: "below" } | { kind: "child" } | { kind: "out"; level: number };
export interface RowGeometry {
  x: number;
  y: number;
  rect: { left: number; top: number; height: number };
  depth: number;
  base: number;
  indent: number;
  isLastChild: boolean;
  hasOpenChildren: boolean;
}

export function resolveRowInstruction({ x, y, rect, depth, base, indent, isLastChild, hasOpenChildren }: RowGeometry): RowInstruction {
  const ratio = (y - rect.top) / rect.height;
  if (ratio < 0.25) return { kind: "above" };
  if (hasOpenChildren) return { kind: "child" };
  if (ratio > 0.75) {
    if (depth > 0 && isLastChild && x < rect.left + base + depth * indent - 6) {
      const level = Math.max(0, Math.min(depth - 1, Math.floor((x - rect.left - base + 7) / indent)));
      return { kind: "out", level };
    }
    return { kind: "below" };
  }
  return { kind: "child" };
}

export function resolveHeaderEdge(y: number, rect: { top: number; height: number }): "above" | "below" {
  return y < rect.top + rect.height / 2 ? "above" : "below";
}
