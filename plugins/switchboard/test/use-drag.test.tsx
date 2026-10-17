import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { useRef, useState } from "react";
import { EMPTY_LAYOUT } from "../src/layout";
import { densityMetrics } from "../src/metrics";
import { buildGroups } from "../src/tree";
import { indexGroups } from "../src/drop-plan";
import { EMPTY_SELECTION } from "../src/selection";
import { useDrag } from "../src/use-drag";
import { sidebarSection, sidebarThread } from "./fixtures";

const index = indexGroups(buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Section")], threads: [
  sidebarThread({ id: "a", displayTitle: "A", sectionId: "s", createdAt: 3 }),
  sidebarThread({ id: "b", displayTitle: "B", sectionId: "s", createdAt: 2 }),
] }));
const rect = { left: 10, top: 100, width: 220, height: 40, right: 230, bottom: 140, x: 10, y: 100, toJSON: () => ({}) };
const onDropThreads = vi.fn(), onDropSection = vi.fn(), onExpand = vi.fn();
let target: Element | null = null;
let enabled = true;
function Harness() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [clicks, setClicks] = useState(0);
  const drag = useDrag({ index, selection: EMPTY_SELECTION, metrics: densityMetrics("default"), enabled, rootRef,
    sectionIds: ["s", "other"], hitTest: () => target, onDropThreads, onDropSection, onExpand });
  return <div ref={rootRef}>
    <button onPointerDown={(event) => drag.onRowPointerDown(event, "a")}
      onClick={() => { if (!drag.consumeClick()) setClicks((count) => count + 1); }}>A</button>
    <output data-testid="clicks">{clicks}</output>
    <button onPointerDown={(event) => drag.onSectionPointerDown(event, "s")}>Section</button>
    <output data-testid="view">{drag.view ? JSON.stringify({ subject: drag.view.subject, target: drag.view.target, plan: drag.view.plan }) : "idle"}</output>
    <div data-sb-row="" data-thread-id="b" data-depth="0" data-last-child="false" data-open-children="false" data-testid="row">B</div>
    <div data-sb-row="" data-thread-id="b" data-depth="0" data-last-child="false" data-open-children="false" data-collapsed="true" data-testid="collapsed">Collapsed</div>
    <div data-sb-section="other" data-sb-drop="section:other" data-testid="section">Other</div>
  </div>;
}
function pointer(type: "pointerMove" | "pointerUp", x: number, y: number) {
  fireEvent[type](window, { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, button: 0 });
}
function start(button = 0, pointerType = "mouse", altKey = false) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "A" }), { pointerId: 1, pointerType, button,
    clientX: 40, clientY: 100, altKey });
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); target = null; enabled = true; });

describe("pointer drag", () => {
  it("yields a sideways move to bb's split and ignores touch and modifiers", () => {
    target = screen.queryByTestId("row");
    render(<Harness />);
    target = screen.getByTestId("row");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    start(); pointer("pointerMove", 50, 101); pointer("pointerUp", 50, 101);
    expect(screen.getByTestId("view").textContent).toBe("idle");
    expect(onDropThreads).not.toHaveBeenCalled();
    start(0, "touch"); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    start(0, "mouse", true); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    start(2); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    expect(onDropThreads).not.toHaveBeenCalled();
  });

  it("starts after six vertical pixels, cancels on Escape and swallows the next click after drop", () => {
    render(<Harness />);
    target = screen.getByTestId("row");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    start(); pointer("pointerMove", 40, 106);
    expect(screen.getByTestId("view").textContent).toContain('"kind":"threads"');
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("view").textContent).toBe("idle");
    start(); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    expect(onDropThreads).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(screen.getByTestId("view").textContent).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(screen.getByTestId("clicks").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(screen.getByTestId("clicks").textContent).toBe("1");
  });

  it("expands a collapsed row after a 500 ms hover", () => {
    vi.useFakeTimers();
    render(<Harness />);
    target = screen.getByTestId("collapsed");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    start(); pointer("pointerMove", 40, 120);
    act(() => { vi.advanceTimersByTime(499); });
    expect(onExpand).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onExpand).toHaveBeenCalledWith("thread:b");
  });

  it("reorders section headers and is disabled when filtering", () => {
    render(<Harness />);
    target = screen.getByTestId("section");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Section" }), { pointerId: 1, pointerType: "mouse", button: 0, clientX: 40, clientY: 100 });
    pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    expect(onDropSection).toHaveBeenCalledWith(["other", "s"]);
    enabled = false;
    cleanup();
    render(<Harness />);
    target = screen.getByTestId("section");
    onDropSection.mockClear();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Section" }), { pointerId: 1, pointerType: "mouse", button: 0, clientX: 40, clientY: 100 });
    pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    expect(onDropSection).not.toHaveBeenCalled();
  });
});
