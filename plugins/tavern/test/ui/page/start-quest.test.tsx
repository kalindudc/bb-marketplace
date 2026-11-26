import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

it("opens a fresh Keeper composer even when Keepers already have quests", async () => {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot({ component: plugin.navPanels[0]!.headerContent! }, { subPath: "room" }, {
    pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom) } as Partial<PluginRpcTestHandlers<typeof rpcContract>> as PluginRpcTestHandlers<typeof rpcContract>,
    composer: { text: "", scope: { kind: "new-thread", projectId: "p1" } }, context: { projectId: "p1", threadId: null },
  });
  try {
    const button = slot.getByRole("button", { name: /Start a quest/ });
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    expect(slot.container.querySelector(".btn.pri")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toCompose", options: { projectId: "p1", focusPrompt: true } }]));
    expect(slot.inspection.composer.text).toBe("Keeper ");
    expect(slot.inspection.composer.selections).toEqual([]);
    expect(slot.inspection.composer.submits).toEqual([]);
  } finally { slot.lifecycle.unmount(); }
});

it.each(["page", "homepage"] as const)("preserves class-card selection on the %s", async surface => {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot((surface === "page" ? plugin.navPanels[0] : plugin.homepageSections[0])! as never, { subPath: "" } as never, {
    pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.emptyRoomScene) } as Partial<PluginRpcTestHandlers<typeof rpcContract>> as PluginRpcTestHandlers<typeof rpcContract>,
    composer: { text: "", scope: { kind: "new-thread", projectId: "p1" } },
  });
  try {
    const card = await waitFor(() => {
      const button = [...slot.container.querySelectorAll<HTMLButtonElement>(".tv-start-cards button")].find(b => b.textContent?.includes("Keeper"));
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.click(card);
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Keeper "));
    if (surface === "page") {
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "p1", focusPrompt: true } });
      expect(slot.inspection.composer.selections).toEqual([]);
    } else {
      await waitFor(() => expect(slot.inspection.composer.selections).toHaveLength(1));
      expect(slot.inspection.navigateCalls.filter(c => c.method === "toCompose")).toEqual([]);
    }
  } finally { slot.lifecycle.unmount(); }
});
