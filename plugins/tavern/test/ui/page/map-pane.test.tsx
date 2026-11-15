// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapViewport } from "../../../src/ui/page/mapview";
let paneHeight = 600;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this:HTMLElement) { return this.classList.contains("pane") ? paneHeight : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this:HTMLElement) {
    const top = this.classList.contains("pane") ? 100 : 200;
    const bottom = this.tagName === "FIGURE" ? 600 : 580;
    return {top,bottom,left:0,right:600,width:600,height:bottom-top,x:0,y:top,toJSON(){return this;}} as DOMRect;
  });
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();paneHeight=600;});
function view(height:number, narrow = false) { return render(<div className="pane" style={{overflowY:"auto"}}><div className={`tv-mapgrid ${narrow ? "narrow" : ""}`}><figure><MapViewport width={600} height={height} label="Map"><div>Node</div></MapViewport></figure></div></div>); }
it("uses the same measured pane height for tiny and huge maps, not their content", () => {
  for(const height of [40,10000]) {
    const slot=view(height), box=slot.container.querySelector<HTMLElement>(".tv-mv-box")!;
    expect(box.style.getPropertyValue("--mv-pane")).toBe("464px");
    expect(box.style.getPropertyValue("--mv-need")).toBe("");
    expect(box.style.getPropertyValue("--mv-room")).toBe("");
    slot.unmount();
  }
});
it("uses seventy percent of the pane in a narrow layout", () => {
  const slot = view(10000, true);
  expect(slot.container.querySelector<HTMLElement>(".tv-mv-box")!.style.getPropertyValue("--mv-pane")).toBe("420px");
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
  expect(css).toMatch(/\.tv-mapgrid:not\(\.narrow\) \.tv-mapcard \+ \.tv-maplist\s*\{[^}]*contain: size/);
  expect(css).toMatch(/\.tv-mapgrid\.narrow \.tv-mv-box\s*\{[^}]*height: max\(360px, var\(--mv-pane, 70vh\)\)/);
});
