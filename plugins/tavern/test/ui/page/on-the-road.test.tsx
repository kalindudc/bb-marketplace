import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { onTheRoad } from "../../../src/ui/kit";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());

async function room(data: Room) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(data) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { name: /The quest board/ });
  return slot;
}
const road = (slot: RenderedSlot) => within(slot.getByRole("group", { name: "Status" })).getByRole("button", { name: /on the road/ }).textContent;

describe("the status line's on the road", () => {
  it("counts members on the road, never quests", async () => {
    const slot = await room(scenes.richRoom);
    expect(road(slot)).toBe(`${onTheRoad(scenes.richRoom)} on the road`);
  });

  it("reads 0 for smoke 5: one quest in check, its maker done and nobody working", async () => {
    const base = scenes.richRoom.keepers[0]!;
    const quest = { ...base.boardQuests[0]!, phase: "check" as const, members: base.boardQuests[0]!.members.slice(0, 1).map((m) => ({ ...m, state: "idle" as const, engagement: "resting" as const })) };
    const slot = await room({ ...scenes.richRoom, keepers: [{ ...base, errands: [], boardQuests: [quest] }] });
    expect(road(slot)).toBe("0 on the road");
  });
});
