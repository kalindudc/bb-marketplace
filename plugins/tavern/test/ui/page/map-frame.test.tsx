// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
let size = { w: 1400, h: 350 };
beforeEach(() => {
  window.localStorage.clear();
  // jsdom lays nothing out: give the map's window a size, as Pedro measured it (about 350 px tall).
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("tv-mv-box") ? size.w : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.classList.contains("tv-mv-box") ? size.h : 0; } });
});
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight; });

/**
 * The live room's shape: many Keepers, and the chosen past quest on the last of them, so the map stays taller than its window
 * after "Only this one" leaves every Keeper drawn. Its Keeper has twelve finished quests; the oldest, "isZeroDuration", sits lowest.
 */
function longRoom(): Room {
  const room = structuredClone(scenes.richRoom);
  const idle = room.keepers[0]!;
  const extra = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(idle), member: { ...idle.member, threadId: `thr_idle${i}` }, boardQuests: [], errands: [], openAsks: [] }));
  room.keepers = [...extra, ...room.keepers];
  const k = room.keepers.at(-1)!;
  const tpl = room.keepers.flatMap((x) => x.boardQuests).find((q) => q.id === "sfe")!;
  k.boardQuests.push(...Array.from({ length: 12 }, (_, i) => ({ ...tpl, id: `old-${i}`, keeperThreadId: k.member.threadId, short: i === 11 ? "isZeroDuration" : `Old quest ${i}`, phase: i % 3 ? "done" as const : "stopped" as const, endedAt: scenes.min(60 + i * 10), updatedAt: scenes.min(60 + i * 10) })));
  return room;
}
async function map() {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "map" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { room: () => longRoom(), registry: () => structuredClone(scenes.registry), boardQuest: ({ id }) => structuredClone(scenes.richDetails[id] ?? scenes.richDetails["vault"]!) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("button", { name: /^Quests/ });
  return slot;
}
/** Where a node sits in the map's window, from the layer's transform and the node's place on the layer. */
function inWindow(slot: RenderedSlot, sel: string) {
  const layer = slot.container.querySelector<HTMLElement>(".tv-mv-layer")!;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(layer.style.transform)!;
  const [tx, ty, k] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const n = slot.container.querySelector<HTMLElement>(sel)!;
  const [x, y, w, h] = ["left", "top", "width", "height"].map((p) => parseFloat(n.style.getPropertyValue(p)));
  const box = { left: tx + x! * k, top: ty + y! * k, right: tx + (x! + w!) * k, bottom: ty + (y! + h!) * k };
  return { k, inside: box.left >= 0 && box.top >= 0 && box.right <= size.w && box.bottom <= size.h, box };
}

describe("Only this one on the map", () => {
  for (const w of [1400, 720, 390]) it(`frames the chosen quest and its Keeper in the window at 100% (${w} px)`, async () => {
    size = { w, h: 350 };
    const slot = await map();
    const keeper = `[data-node="keeper:${scenes.richRoom.keepers.at(-1)!.member.threadId}"]`;
    expect(slot.container.querySelector(keeper), "the Keeper's node").not.toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^Show finished quests/ }));
    expect(inWindow(slot, '[data-node="returned:old-11"]').inside, "out of view before").toBe(false);
    fireEvent.click(slot.getByRole("button", { name: /^Quests/ }));
    fireEvent.click(within(slot.getByRole("group", { name: "Quests the map draws" })).getByRole("button", { name: "Only this one: isZeroDuration" }));
    await waitFor(() => expect(inWindow(slot, '[data-node="returned:old-11"]').inside).toBe(true));
    const quest = inWindow(slot, '[data-node="returned:old-11"]'), lead = inWindow(slot, keeper);
    expect(quest.k).toBeGreaterThanOrEqual(1);
    expect(lead.inside, JSON.stringify(lead.box)).toBe(true);
  });

  it("lets go of the frame when another quest is focused, and frames that one", async () => {
    size = { w: 1400, h: 350 };
    const slot = await map();
    fireEvent.click(slot.getByRole("button", { name: /^Quests/ }));
    fireEvent.click(within(slot.getByRole("group", { name: "Quests the map draws" })).getByRole("button", { name: "Only this one: isZeroDuration" }));
    await waitFor(() => expect(inWindow(slot, '[data-node="returned:old-11"]').inside).toBe(true));
    fireEvent.click(within(slot.getByRole("group", { name: "Focus on a quest" })).getByRole("button", { name: /^Focus on shopifycloud.com audit/ }));
    await waitFor(() => expect(inWindow(slot, '[data-node="quest:audit"]').inside).toBe(true));
    expect(inWindow(slot, '[data-node="quest:audit"]').k).toBeGreaterThanOrEqual(1);
  });
});
