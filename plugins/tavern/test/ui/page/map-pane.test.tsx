// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapViewport } from "../../../src/ui/page/mapview";
let paneHeight = 600;
let above = 0;
const observers = new Map<ResizeObserverCallback, Set<Element>>();
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) { observers.set(callback, this.targets); }
    observe(el: Element) { this.targets.add(el); }
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this:HTMLElement) { return this.classList.contains("pane") ? paneHeight : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this:HTMLElement) {
    const top = this.classList.contains("pane") ? 100 : 200 + above;
    const bottom = (this.tagName === "FIGURE" ? 600 : 580) + above;
    return {top,bottom,left:0,right:600,width:600,height:bottom-top,x:0,y:top,toJSON(){return this;}} as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.clear(); paneHeight = 600; above = 0; });
function view(height: number) { return render(<div className="pane" style={{ overflowY: "auto" }}><div className="chrome">Quests on the board</div><div className="tv-mapgrid"><figure><MapViewport width={600} height={height} label="Map"><div>Node</div></MapViewport></figure></div></div>); }
it("uses the same measured pane height for tiny and huge maps, not their content", () => {
  for(const height of [40,10000]) {
    const slot=view(height), box=slot.container.querySelector<HTMLElement>(".tv-mv-box")!;
    expect(box.style.getPropertyValue("--mv-pane")).toBe("464px");
    expect(box.style.getPropertyValue("--mv-need")).toBe("");
    expect(box.style.getPropertyValue("--mv-room")).toBe("");
    slot.unmount();
  }
});
it("reflows when the preceding controls grow and shrink without changing the pane or grid size", async () => {
  const slot = view(40);
  const box = slot.getByRole("group", { name: /^Map\./ });
  const chrome = slot.getByText("Quests on the board");
  const reflow = (extra: number) => {
    above = extra;
    for (const [resize, targets] of observers) if (targets.has(chrome)) resize([], {} as ResizeObserver);
  };
  expect(box.style.getPropertyValue("--mv-pane")).toBe("464px");
  reflow(80);
  await waitFor(() => expect(box.style.getPropertyValue("--mv-pane")).toBe("384px"));
  reflow(0);
  await waitFor(() => expect(box.style.getPropertyValue("--mv-pane")).toBe("464px"));
  slot.unmount();
});
it("remeasures when the pane resizes", async () => {
  const slot = view(40);
  paneHeight = 800;
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(slot.container.querySelector<HTMLElement>(".tv-mv-box")!.style.getPropertyValue("--mv-pane")).toBe("664px"));
  slot.unmount();
});
it("keeps a short pane measured so CSS applies the readable minimum", () => {
  paneHeight=300; const slot=view(40);
  expect(slot.container.querySelector<HTMLElement>(".tv-mv-box")!.style.getPropertyValue("--mv-pane")).toBe("164px");
  slot.unmount();
  const css=readFileSync("src/ui/page/page.css","utf8");
  expect(css).toMatch(/height: max\(360px, var\(--mv-pane/);
  expect(css).toMatch(/@container tv-map \(min-width: 940px\)\s*\{[^}]*\.tv-mapgrid\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 300px\)/);
  expect(css).toMatch(/\.tv-mapgrid > \.tv-maplist\s*\{[^}]*contain: size/);
});
