import { renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { readRemembered } from "../../../src/ui/kit";
import { TavernSidebar } from "../../../src/ui/page/register";
import { SKEL } from "../../../src/ui/page/skeletons";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
const observers: { cb: ResizeObserverCallback; els: Set<Element> }[] = [];
let boardHeight = 200, boardReads = 0;
const savedRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  observers.length = 0; boardHeight = 200; boardReads = 0;
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    private rec: { cb: ResizeObserverCallback; els: Set<Element> };
    constructor(cb: ResizeObserverCallback) { this.rec = { cb, els: new Set() }; observers.push(this.rec); }
    observe(el: Element) { this.rec.els.add(el); }
    unobserve(el: Element) { this.rec.els.delete(el); }
    disconnect() { this.rec.els.clear(); }
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("tv-sboard")) { boardReads++; return { top: 0, bottom: boardHeight, left: 0, right: 200, width: 200, height: boardHeight, x: 0, y: 0 } as DOMRect; }
    return savedRect.call(this);
  };
});
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  Element.prototype.getBoundingClientRect = savedRect;
  vi.unstubAllGlobals();
});

async function sidebar() {
  let calls = 0;
  const room = () => { calls++; return { ...structuredClone(scenes.richRoom), archivedCount: scenes.richRoom.archivedCount + calls } as Room; };
  const slot = renderSlot({ component: TavernSidebar }, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await waitFor(() => { expect(slot.container.querySelector(".sk-sidenav")).toBeNull(); expect(slot.container.querySelector("button.tv-squest")).not.toBeNull(); });
  return slot;
}

describe("the sidebar's remembered quest space", () => {
  it("is measured when the data arrives, and not again when a Keeper tick re-renders the sidebar", async () => {
    const slot = await sidebar();
    expect(readRemembered<number>(SKEL.sideNav)).toBe(200);
    const reads = boardReads;
    const cellar = () => slot.getByRole("button", { name: /^Cellar/ }).textContent;
    const before = cellar();
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    await waitFor(() => expect(cellar()).not.toBe(before));
    expect(boardReads).toBe(reads);
  });

  it("watches only the quest block and measures again when it resizes", async () => {
    const slot = await sidebar();
    const board = slot.container.querySelector("nav.tv-sidebar .tv-sboard")!;
    expect(observers.flatMap(o => [...o.els])).toEqual([board]);
    boardHeight = 260;
    const reads = boardReads;
    act(() => { for (const o of observers) if (o.els.size) o.cb([], {} as ResizeObserver); });
    expect(boardReads).toBe(reads + 1);
    expect(readRemembered<number>(SKEL.sideNav)).toBe(260);
  });
});
