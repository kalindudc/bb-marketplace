// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { finishedWord } from "../../../src/ui/page/connections";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); });
async function map(room: Room, cellar: Handlers["archivedBoardQuests"] = () => ({ boardQuests: [], nextCursor: null, total: 0 })) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "map" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { room: () => structuredClone(room), registry: () => structuredClone(scenes.registry), archivedBoardQuests: cellar, boardQuest: ({ id }) => structuredClone(scenes.richDetails[id] ?? scenes.richDetails["vault"]!) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { name: "The map (connections)" });
  return slot;
}
/** The rich room with its returned quest `sfe` copied as `n` more finished quests in the given phase. */
function withFinished(phase: "done" | "stopped", n = 1, replaceSfe = false): Room {
  const room = structuredClone(scenes.richRoom);
  for (const k of room.keepers) {
    const sfe = k.boardQuests.find((q) => q.id === "sfe");
    if (!sfe) continue;
    k.boardQuests.push(...Array.from({ length: n }, (_, i) => ({ ...sfe, id: `${phase}-${i}`, short: `${phase} ${i}`, phase })));
    if (replaceSfe) k.boardQuests = k.boardQuests.filter((q) => q.id !== "sfe");
  }
  return room;
}
const toggleOf = (slot: RenderedSlot) => slot.getByRole("button", { name: /^Show finished quests/ });

describe("the map's finished group", () => {
  it("names the group by what it holds", () => {
    expect(finishedWord(["done", "done"])).toBe("Returned");
    expect(finishedWord(["stopped"])).toBe("Stopped");
    expect(finishedWord(["done", "stopped", "done"])).toBe("Finished");
  });

  it("draws the map without work in progress and reveals both board history and the cellar on demand", async () => {
    const room = withFinished("stopped");
    const finished = room.keepers.flatMap(k => k.boardQuests).filter(q => q.phase === "done" || q.phase === "stopped");
    room.keepers = room.keepers.map((k, index) => ({ ...k, archived: index > 0, boardQuests: finished.filter(q => q.keeperThreadId === k.member.threadId) }));
    room.asks = []; room.solos = [];
    const old = { ...finished[0]!, id: "cellared", archivedAt: 200 };
    const slot = await map({ ...room, archivedCount: 1 }, () => ({ boardQuests: [old], nextCursor: null, total: 1 }));
    expect(slot.getByText("No active quests.")).toBeTruthy();
    expect(slot.container.querySelector(".tv-mapcard")).not.toBeNull();
    expect(slot.container.querySelectorAll(".tv-mappic .k-keeper")).toHaveLength(1);
    const toggle = slot.getByRole("button", { name: /Show finished quests.*1 returned.*1 stopped.*1 archived/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(slot.container.querySelector(".k-returned")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await slot.findByText(/^Archived · Returned/);
    expect(slot.container.querySelector('[data-node="returned:sfe"]')).not.toBeNull();
    expect(slot.container.querySelector('[data-node="returned:stopped-0"]')).not.toBeNull();
    expect(slot.container.querySelector('[data-node="returned:cellared"]')).not.toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^Quests on the board/ }));
    fireEvent.click(slot.getByRole("button", { name: `Only this one: ${scenes.sfe.short}` }));
    expect(slot.container.querySelector('[data-node="returned:sfe"]')).not.toBeNull();
    expect(slot.container.querySelector('[data-node="returned:cellared"]')).toBeNull();
  });

  it("loads one cellar page at a time even when the Keeper is not on the board", async () => {
    const old = { ...scenes.sfe, keeperThreadId: "no-room-keeper", archivedAt: 200 };
    const cellar = vi.fn(({ cursor }: { cursor?: string | null }) => ({
      boardQuests: [{ ...old, id: cursor ? "older" : "newer", short: cursor ? "An older archived quest" : "A newer archived quest" }],
      nextCursor: cursor ? null : "next", total: 2,
    }));
    const slot = await map({ ...scenes.richRoom, keepers: [], asks: [], solos: [], archivedCount: 2 }, cellar);
    expect(cellar).not.toHaveBeenCalled();
    fireEvent.click(toggleOf(slot));
    await slot.findByText("A newer archived quest");
    fireEvent.click(slot.getByRole("button", { name: "Older archived quests" }));
    await slot.findByText("An older archived quest");
    expect(slot.queryByText("A newer archived quest")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Newer archived quests" }));
    await slot.findByText("A newer archived quest");
    expect(cellar).toHaveBeenCalledWith({ cursor: "next", limit: 30 });
  });

  it("still draws an empty map when every Keeper is archived and the toggles are off", async () => {
    const room = { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map(k => ({ ...k, archived: true, boardQuests: [] })), asks: [], solos: [] };
    const slot = await map(room);
    expect(slot.getByText("No active quests.")).toBeTruthy();
    expect(slot.getByText("No active quests.").closest(".tv-mv-box")?.hasAttribute("data-empty-map")).toBe(true);
    expect(slot.container.querySelector(".tv-mappic .k-keeper")).toBeNull();
  });

  it("says Finished for returned and stopped quests together, and keeps each node's own phase", async () => {
    const slot = await map(withFinished("stopped", 2));
    expect(toggleOf(slot).textContent).toContain("1 returned · 2 stopped · 0 archived");
    fireEvent.click(toggleOf(slot));
    expect(slot.container.querySelector('[data-node="returned:stopped-0"]')?.textContent).toMatch(/Stopped/);
    expect(slot.container.querySelector('[data-node="returned:sfe"]')?.textContent).toMatch(/Returned/);
  });

  it("gives separate counts even when only one kind of finished quest exists", async () => {
    expect(toggleOf(await map(scenes.richRoom)).textContent).toContain("1 returned · 0 stopped · 0 archived");
    slots.splice(0).forEach((s) => s.lifecycle.unmount());
    expect(toggleOf(await map(withFinished("stopped", 1, true))).textContent).toContain("0 returned · 1 stopped · 0 archived");
  });
});
