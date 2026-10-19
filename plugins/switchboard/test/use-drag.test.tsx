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
  return <div data-testid="scroller" style={{ overflowY: "auto" }}><div ref={rootRef}>
    <button onPointerDown={(event) => drag.onRowPointerDown(event, "a")}
      onClick={() => { if (!drag.consumeClick()) setClicks((count) => count + 1); }}>A</button>
    <output data-testid="clicks">{clicks}</output>
    <button onPointerDown={(event) => drag.onSectionPointerDown(event, "s")}>Section</button>
    <output data-testid="view">{drag.view ? JSON.stringify({ subject: drag.view.subject, target: drag.view.target, plan: drag.view.plan }) : "idle"}</output>
    {drag.view && <div ref={drag.ghostRef} data-testid="ghost" />}
    <div data-sb-row="" data-thread-id="b" data-depth="0" data-last-child="false" data-open-children="false" data-testid="row">B</div>
    <div data-sb-row="" data-thread-id="b" data-depth="0" data-last-child="false" data-open-children="false" data-collapsed="true" data-testid="collapsed">Collapsed</div>
    <div data-sb-section="other" data-sb-drop="section:other" data-testid="section">Other</div>
  </div></div>;
}
function pointer(type: "pointerMove" | "pointerUp", x: number, y: number) {
  fireEvent[type](window, { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, button: 0 });
}
function start(button = 0, pointerType = "mouse", altKey = false) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "A" }), { pointerId: 1, pointerType, button,
    clientX: 40, clientY: 100, altKey });
}
const view = () => screen.getByTestId("view").textContent;
const clickRow = () => fireEvent.click(screen.getByRole("button", { name: "A" }));
const clicks = () => screen.getByTestId("clicks").textContent;
function mount() {
  render(<Harness />);
  target = screen.getByTestId("row");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); target = null; enabled = true; });

describe("pointer drag", () => {
  it("starts after five pixels in any direction, sideways included", () => {
    mount();
    start(); pointer("pointerMove", 43, 103);
    expect(view()).toBe("idle");
    pointer("pointerMove", 44, 103);
    expect(view()).toContain('"kind":"threads"');
    fireEvent.keyDown(window, { key: "Escape" }); pointer("pointerUp", 44, 103);
    start(); pointer("pointerMove", 46, 100);
    expect(view()).toContain('"kind":"threads"');
    pointer("pointerMove", 46, 120); pointer("pointerUp", 46, 120);
    expect(onDropThreads).toHaveBeenCalledTimes(1);
  });

  it("ignores touch, modifiers and other buttons", () => {
    mount();
    start(0, "touch"); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    start(0, "mouse", true); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    start(2); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    expect(onDropThreads).not.toHaveBeenCalled();
  });

  it("swallows only the click its own release fires", () => {
    mount();
    start(); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    expect(onDropThreads).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(view()).toBe("idle");
    clickRow();
    expect(clicks()).toBe("0");
    clickRow();
    expect(clicks()).toBe("1");
  });

  it("keeps the next click when the release fired no click on a row", () => {
    vi.useFakeTimers();
    mount();
    start(); pointer("pointerMove", 40, 120); pointer("pointerUp", 40, 120);
    act(() => { vi.advanceTimersByTime(0); });
    clickRow();
    expect(clicks()).toBe("1");
  });

  it("yields to bb's split drag when the host sends Escape, and still swallows the release click", () => {
    mount();
    start(); pointer("pointerMove", 40, 120);
    expect(view()).toContain('"kind":"threads"');
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); });
    expect(view()).toBe("idle");
    pointer("pointerMove", 40, 130);
    expect(view()).toBe("idle");
    pointer("pointerUp", 40, 130);
    expect(onDropThreads).not.toHaveBeenCalled();
    clickRow();
    expect(clicks()).toBe("0");
    clickRow();
    expect(clicks()).toBe("1");
  });

  it("puts the ghost at the cursor on the frame that first shows it", () => {
    mount();
    start(); pointer("pointerMove", 40, 120);
    expect(screen.getByTestId("ghost").style.transform).toContain("translate3d(52px, 136px");
  });

  it("auto-scrolls the sidebar only while the pointer is over it", () => {
    mount();
    vi.spyOn(screen.getByTestId("scroller"), "getBoundingClientRect").mockReturnValue({ ...rect, left: 0, right: 240, top: 0, bottom: 300 });
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    start(); pointer("pointerMove", 40, 150);
    expect(frame).not.toHaveBeenCalled();
    pointer("pointerMove", 400, 290);
    expect(frame).not.toHaveBeenCalled();
    pointer("pointerMove", 40, 290);
    expect(frame).toHaveBeenCalledTimes(1);
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

  it("keeps scrolling near an edge without pointer moves, faster nearer the edge, and retargets as rows pass", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ ...rect, top: 0, bottom: 400, height: 400, left: 0, right: 240, width: 240 });
    let scrollTop = 500;
    Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(1000, value)); } });
    target = screen.getByTestId("row");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    const scrolledOver = (ms: number) => { const before = scrollTop; act(() => { vi.advanceTimersByTime(ms); }); return scrollTop - before; };

    start(); pointer("pointerMove", 40, 380);
    const shallow = scrolledOver(480);
    expect(shallow).toBeGreaterThan(0);
    expect(Math.abs(scrolledOver(480) - shallow)).toBeLessThanOrEqual(1);
    pointer("pointerMove", 40, 399);
    expect(scrolledOver(480)).toBeGreaterThan(shallow);

    target = screen.getByTestId("collapsed");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    scrolledOver(532);
    expect(onExpand).toHaveBeenCalledWith("thread:b");

    pointer("pointerMove", 40, 10);
    expect(scrolledOver(160)).toBeLessThan(0);
    pointer("pointerMove", 260, 10);
    expect(scrolledOver(160)).toBe(0);
    pointer("pointerMove", 40, 200);
    expect(scrolledOver(160)).toBe(0);
    pointer("pointerMove", 40, 399);
    scrollTop = 1000;
    expect(scrolledOver(160)).toBe(0);
    pointer("pointerUp", 40, 399);
    act(() => { vi.advanceTimersByTime(0); });
    expect(vi.getTimerCount()).toBe(0);
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
