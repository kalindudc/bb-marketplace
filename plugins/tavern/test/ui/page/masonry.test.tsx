import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { fitMasonry } from "../../../src/ui/page/board";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
const LOADED = { timeout: 3000 };

/** A ResizeObserver that records what it watches and fires only when the test says a size changed, as the browser does after layout. */
const observers: { cb: ResizeObserverCallback; els: Set<Element> }[] = [];
const savedRect = Element.prototype.getBoundingClientRect;
let heights = new Map<Element, number>();
let reads = 0;
beforeEach(() => {
  observers.length = 0; heights = new Map(); reads = 0;
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    private rec: { cb: ResizeObserverCallback; els: Set<Element> };
    constructor(cb: ResizeObserverCallback) { this.rec = { cb, els: new Set() }; observers.push(this.rec); }
    observe(el: Element) { this.rec.els.add(el); }
    unobserve(el: Element) { this.rec.els.delete(el); }
    disconnect() { this.rec.els.clear(); }
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.parentElement?.matches(".rm-board:not(.sk-board)")) { reads++; const h = heights.get(this) ?? 100; return { top: 0, bottom: h, left: 0, right: 400, width: 400, height: h, x: 0, y: 0 } as DOMRect; }
    return savedRect.call(this);
  };
});
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  Element.prototype.getBoundingClientRect = savedRect;
  vi.unstubAllGlobals();
});
const boardObserver = () => observers.find((o) => [...o.els].some((el) => el.parentElement?.matches(".rm-board:not(.sk-board)")))!;
const fire = () => act(() => { const o = boardObserver(); o.cb([...o.els].map((target) => ({ target }) as ResizeObserverEntry), {} as ResizeObserver); });

describe("the notice masonry", () => {
  it("reads every height before it writes any span, and writes only spans that changed", () => {
    const log: string[] = [];
    const els = [80, 150, 42].map((h, i) => {
      const el = document.createElement("div");
      let value = "";
      Object.defineProperty(el.style, "gridRowEnd", { get: () => value, set: (v: string) => { log.push(`write ${i}`); value = v; }, configurable: true });
      return { el, h };
    });
    fitMasonry(els.map((e) => e.el), (el) => { const e = els.find((x) => x.el === el)!; log.push(`read ${els.indexOf(e)}`); return e.h; });
    expect(log).toEqual(["read 0", "read 1", "read 2", "write 0", "write 1", "write 2"]);
    // The same formula as before: (height + the 18 px gap) in 4 px rows, rounded up.
    expect(els.map((e) => e.el.style.gridRowEnd)).toEqual(["span 25", "span 42", "span 15"]);
    log.length = 0;
    fitMasonry(els.map((e) => e.el), (el) => els.find((x) => x.el === el)!.h);
    expect(log).toEqual([]);
  });

  it("measures nothing when the room re-renders, and refits from the observer when a notice resizes", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    let tick = 0;
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => ({ ...structuredClone(scenes.richRoom), review: { ...scenes.richRoom.review, waiting: tick++ % 3 } }) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    const board = await waitFor(() => { const b = slot.container.querySelector<HTMLElement>(".rm-board:not(.sk-board)"); expect(b?.children.length).toBeGreaterThan(0); return b!; }, LOADED);
    // Every child is watched; nothing is measured until the observer reports sizes.
    expect(boardObserver().els.size).toBe(board.children.length);
    expect(reads).toBe(0);
    fire();
    const first = [...board.children].map((el) => (el as HTMLElement).style.gridRowEnd);
    expect(first.every((s) => s === "span 30")).toBe(true);
    // A Keeper tick re-renders the room: no reads, no writes.
    const before = reads;
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    expect(reads).toBe(before);
    // The first notice grows: the observer fires and only its span changes.
    const notice = board.children[0]!;
    heights.set(notice, 222);
    fire();
    expect((notice as HTMLElement).style.gridRowEnd).toBe("span 60");
    expect([...board.children].slice(1).map((el) => (el as HTMLElement).style.gridRowEnd)).toEqual(first.slice(1));
  });
});
