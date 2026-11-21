// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapViewport } from "../../../src/ui/page/mapview";
let noteHeight = 80;
const observers: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("tv-mv-box") ? 600 : 0; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("tv-mv-box") ? 400 : this.classList.contains("tv-mv-note") ? noteHeight : 0; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.length = 0; noteHeight = 80; });
function transform(container: HTMLElement) {
  const raw = container.querySelector<HTMLElement>(".tv-mv-layer")!.style.transform;
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(raw)!;
  return { y: Number(match[2]), k: Number(match[3]) };
}
it("puts the note inside the viewport above the pannable layer and leaves its action clickable", () => {
  const clear = vi.fn();
  const view = render(<MapViewport width={400} height={300} label="Map" note={<p className="tv-map-quiet">Every quest is hidden by your filters.<button onClick={clear}>Clear filters</button></p>}><div>Node</div></MapViewport>);
  const note = view.container.querySelector(".tv-mv-note")!;
  expect(note.parentElement?.classList.contains("tv-mv-box")).toBe(true);
  expect(note.closest(".tv-mv-layer")).toBeNull();
  fireEvent.click(view.getByText("Clear filters"));
  expect(clear).toHaveBeenCalledTimes(1);
  const layer = view.container.querySelector<HTMLElement>(".tv-mv-layer")!;
  const before = layer.style.transform;
  fireEvent.wheel(note, { ctrlKey: true, deltaY: -100, clientX: 100, clientY: 100 });
  expect(layer.style.transform).toBe(before);
  fireEvent.pointerDown(note);
  expect(note.parentElement?.classList.contains("dragging")).toBe(false);
  view.unmount();
});
it("keeps the initial view at natural size and Fits above the measured note", () => {
  const view = render(<MapViewport width={400} height={300} label="Map" note={<p>No active quests.</p>}><div>Node</div></MapViewport>);
  expect(transform(view.container).k).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "Fit the whole map" }));
  const pose = transform(view.container);
  expect(pose.y + 300 * pose.k).toBeLessThanOrEqual(400 - noteHeight - 24);
  view.unmount();
});
it("keeps the Fit floor and top-aligns a map that cannot fit at that floor", () => {
  const view = render(<MapViewport width={400} height={2000} label="Map" note={<p>No active quests.</p>}><div>Node</div></MapViewport>);
  expect(transform(view.container).k).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "Fit the whole map" }));
  expect(transform(view.container)).toEqual({y:12,k:0.25});
  view.unmount();
});
it.each([false,true])("reframes for a resized note only while untouched (touched=%s)", touched => {
  const view = render(<MapViewport width={400} height={100} label="Map" note={<p>No active quests.</p>}><div>Node</div></MapViewport>);
  if(touched) fireEvent.click(view.getByRole("button",{name:"Zoom in"}));
  const before = view.container.querySelector<HTMLElement>(".tv-mv-layer")!.style.transform;
  noteHeight=140;
  act(()=>{for(const observer of observers)observer();});
  const after = view.container.querySelector<HTMLElement>(".tv-mv-layer")!.style.transform;
  if(touched) expect(after).toBe(before);
  else expect(after).not.toBe(before);
  view.unmount();
});
it("does not re-read note height for the same note after unrelated renders", () => {
  const getter = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!.get!);
  const view = render(<MapViewport width={400} height={100} label="Map" note={<p>No active quests.</p>}><div>Node</div></MapViewport>);
  const note = view.container.querySelector(".tv-mv-note");
  const reads = () => getter.mock.contexts.filter(context => context === note).length;
  const before = reads();
  view.rerender(<MapViewport width={400} height={100} label="Map" note={<p>No active quests.</p>} status="Copied"><div>Node</div></MapViewport>);
  const unrelated = reads() - before;
  noteHeight = 140;
  const prior = transform(view.container);
  act(() => { for (const observer of observers) observer(); });
  console.log("L1 map", JSON.stringify({ unrelated, resizeReads: reads() - before - unrelated }));
  expect(unrelated).toBe(0);
  expect(transform(view.container)).not.toEqual(prior);
  view.unmount();
});
it("does not reserve card space when there is no note", () => {
  const view = render(<MapViewport width={400} height={300} label="Map"><div>Node</div></MapViewport>);
  expect(transform(view.container)).toEqual({ y: 50, k: 1 });
  expect(view.container.querySelector(".tv-mv-note")).toBeNull();
  view.unmount();
});
