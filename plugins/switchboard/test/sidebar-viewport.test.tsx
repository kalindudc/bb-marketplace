import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { infoPlacement, useCompactSidebar } from "../src/sidebar-viewport";

it.each([
  [663, 287, false], [664, 288, true], [665, 289, true], [700, 324, true], [1280, 904, true],
])("keeps Info outside the sidebar at viewport width %i or uses compact details", (viewport, available, fitsBeside) => {
  const result = infoPlacement({ left: 20, right: 360, top: 152, bottom: 692 }, viewport, 750);
  expect(result).toEqual({ left: 20, top: 152, width: 340, height: 540,
    besideLeft: 368, besideWidth: available, fitsBeside });
});

function Sidebar() {
  const root = useRef<HTMLDivElement>(null);
  const compact = useCompactSidebar(root, false);
  return <div ref={root}>{compact ? "Compact" : "Wide"}</div>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("uses observed sidebar width without forcing a synchronous mount layout", () => {
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  let deliver!: (entries: { contentRect: { width: number } }[]) => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: typeof deliver) { deliver = callback; }
    observe() {}
    disconnect() {}
  });
  render(<Sidebar />);
  expect(layout).not.toHaveBeenCalled();
  act(() => deliver([{ contentRect: { width: 270 } }]));
  expect(screen.getByText("Compact")).toBeTruthy();
  act(() => deliver([{ contentRect: { width: 340 } }]));
  expect(screen.getByText("Wide")).toBeTruthy();
  expect(layout).not.toHaveBeenCalled();
});
