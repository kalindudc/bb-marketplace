// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { finishedWord } from "../../../src/ui/page/connections";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); });
async function map(room: Room) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "map" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { room: () => structuredClone(room), registry: () => structuredClone(scenes.registry), boardQuest: ({ id }) => structuredClone(scenes.richDetails[id] ?? scenes.richDetails["vault"]!) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("button", { name: /^Quests/ });
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
const words = (slot: RenderedSlot) => ({
  toggle: within(slot.getByRole("group", { name: /quests on the map$/ })).getByRole("button").textContent!.replace(/\d+$/, ""),
  group: slot.getByRole("group", { name: /quests on the map$/ }).getAttribute("aria-label"),
});

describe("the map's finished group", () => {
  it("names the group by what it holds", () => {
    expect(finishedWord(["done", "done"])).toBe("Returned");
    expect(finishedWord(["stopped"])).toBe("Stopped");
    expect(finishedWord(["done", "stopped", "done"])).toBe("Finished");
  });

  it("says Finished for returned and stopped quests together, and keeps each node's own phase", async () => {
    const slot = await map(withFinished("stopped", 2));
    expect(words(slot)).toEqual({ toggle: "Finished", group: "Finished quests on the map" });
    expect(slot.container.querySelector('[data-node="returned:stopped-0"]')?.textContent).toMatch(/Stopped/);
    expect(slot.container.querySelector('[data-node="returned:sfe"]')?.textContent).toMatch(/Returned/);
  });

  it("says Returned or Stopped when the group holds only that kind", async () => {
    expect(words(await map(scenes.richRoom)).toggle).toBe("Returned");
    slots.splice(0).forEach((s) => s.lifecycle.unmount());
    expect(words(await map(withFinished("stopped", 1, true))).toggle).toBe("Stopped");
  });
});
