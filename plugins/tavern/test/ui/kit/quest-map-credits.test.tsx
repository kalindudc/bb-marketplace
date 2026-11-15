import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type BoardQuestDetail } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "../page/scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

async function talePath(detail: BoardQuestDetail) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: `tale/${detail.quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), boardQuest: () => structuredClone(detail) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await waitFor(() => expect(slot.container.querySelectorAll(".qmap .wp").length).toBeGreaterThan(0));
  return slot.container;
}

describe("the quest map with member credits", () => {
  it("marks each credited waypoint with its maker's crest, not the class the plan proposed", async () => {
    const root = await talePath(scenes.readmeDetail);
    const credited = new Set((scenes.readmeDetail.memberCredits ?? []).flatMap(c => c.madeWaypointIds));
    expect(credited.size).toBeGreaterThan(0);
    const marks = [...root.querySelectorAll(".qmap .wp")];
    expect(marks.filter(m => m.classList.contains("o-member")).length).toBe(credited.size);
    expect(marks.filter(m => m.classList.contains("o-class") || m.classList.contains("o-proposed")).length).toBe(marks.length - credited.size);
  });

  it("falls back to the planned owner when no credits were recorded", async () => {
    const legacy = structuredClone(scenes.readmeDetail);
    delete legacy.memberCredits;
    const root = await talePath(legacy);
    expect([...root.querySelectorAll(".qmap .wp")].some(m => m.classList.contains("o-member") && !scenes.readmeDetail.quest.waypoints.find(w => w.ownerMember))).toBe(false);
  });
});
