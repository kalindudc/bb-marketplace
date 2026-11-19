import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot, withAttention } from "../attention-fixture";
import { act, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

// Beena's live measurement: every Keeper tick rebuilt the status line's jump buttons, so keyboard focus fell to the page body.
describe("the status line under Keeper ticks", () => {
  async function room() {
    let data: Room = structuredClone(scenes.richRoom);
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
      rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(data) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await slot.findByRole("heading", { name: /The quest board/ });
    const line = () => slot.getByRole("group", { name: "Status" });
    return { slot, line, set: (next: Room) => { data = next; } };
  }

  it("keeps focus on a jump button when a tick brings the same room", async () => {
    const r = await room();
    const jump = within(r.line()).getByRole("button", { name: /on the road/ });
    act(() => jump.focus());
    await act(async () => { await r.slot.experimental_invalidateRpc(null); });
    await waitFor(() => expect(within(r.line()).getByRole("button", { name: /on the road/ })).toBe(jump));
    expect(document.activeElement).toBe(jump);
  });

  it("keeps focus on a jump button when a tick changes the room", async () => {
    const r = await room();
    const jump = within(r.line()).getByRole("button", { name: /on the road/ });
    act(() => jump.focus());
    const changed = structuredClone(scenes.richRoom);
    changed.decidedCount = (changed.decidedCount ?? changed.decidedForYou.filter((d) => !d.undone).length) + 3;
    const next = withAttention(changed);
    next.attention = { ...next.attention!, new: changed.decidedCount, decided: changed.decidedCount };
    r.set(next);
    await act(async () => { await r.slot.experimental_invalidateRpc(null); });
    await waitFor(() => expect(r.line().textContent).toContain(`${changed.decidedCount} decided`));
    expect(document.activeElement).toBe(jump);
  });
});
