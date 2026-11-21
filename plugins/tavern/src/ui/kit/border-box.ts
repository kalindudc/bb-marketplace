import { useCallback } from "react";

export function useBorderBoxWidth<T extends HTMLElement>(onWidth: (width: number) => void) {
  return useCallback((node: T | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.borderBoxSize[0]?.inlineSize;
      if (width !== undefined) onWidth(width);
    });
    observer.observe(node, { box: "border-box" });
    return () => observer.disconnect();
  }, [onWidth]);
}
