import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
const LOADED = { timeout: 3000 };

async function open(subPath: string, room: Room, rpc: Partial<Handlers> = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
const boardReady = (slot: RenderedSlot) => waitFor(() => expect(slot.container.querySelector("[data-room] [data-slot=hearth] .hearth-w")).not.toBeNull(), LOADED);

describe("the board's hearth replay", () => {
  it("replays while work runs, with its words ending in a link to the setting, unless the setting is off", async () => {
    const on = await open("room", scenes.richRoom);
    await boardReady(on);
    const link = on.container.querySelector<HTMLAnchorElement>("[data-slot=hearth] .hearth-set")!;
    expect(link.getAttribute("href")).toBe("/settings/plugins/tavern");
    const off = await open("room", { ...scenes.richRoom, hearthFlicker: false });
    await boardReady(off);
    expect(off.container.querySelector("[data-slot=hearth] .hearth-x")).toBeNull();
    // An older server sends no flag: on, as the setting defaults.
    const older = await open("room", { ...scenes.richRoom, hearthFlicker: true });
    await boardReady(older);
    expect(older.container.querySelector("[data-slot=hearth] .hearth-set")).not.toBeNull();
  });
});

describe("failures and blockers outside asks are marked, so the replay gives way to them", () => {
  const withFailed = (room: Room): Room => {
    const r = structuredClone(room);
    const k = r.keepers.find((x) => x.boardQuests.some((q) => q.id === "vault"))!;
    const q = k.boardQuests.find((x) => x.id === "vault")!;
    q.members = q.members.map((m, i) => i === 0 ? { ...m, state: "failed" as const } : m);
    return r;
  };

  it("marks the status line's and the notice's failed count, and nothing on a room with no failure", async () => {
    const calm = await open("room", { ...structuredClone(scenes.richRoom), keepers: scenes.richRoom.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => ({ ...q, members: q.members.map((m) => m.state === "failed" ? { ...m, state: "waiting" as const } : m) })) })) });
    await boardReady(calm);
    expect(calm.container.querySelector("[data-room] [data-stuck]")).toBeNull();
    const failed = await open("room", withFailed(scenes.richRoom));
    await boardReady(failed);
    expect(failed.container.querySelector(".rm-sline [data-stuck]")?.textContent).toMatch(/failed/);
    expect(failed.container.querySelector(".rm-notice [data-stuck]")?.textContent).toMatch(/failed/);
  });

  it("marks a blocked waypoint on the quest page", async () => {
    const live = scenes.richDetails.vault!;
    const detail: BoardQuestDetail = { ...structuredClone(live), quest: { ...structuredClone(live.quest), waypoints: live.quest.waypoints.map((w) => w.actor === "agent" && (w.state === "doing" || w.state === "todo") ? { ...w, state: "blocked" as const } : w) } };
    const slot = await open("quest/vault", scenes.richRoom, { boardQuest: () => structuredClone(detail) });
    await slot.findByRole("heading", { level: 1, name: live.quest.title }, LOADED);
    await waitFor(() => expect(slot.container.querySelector(".tv-item.bad[data-stuck]")).not.toBeNull(), LOADED);
  });

  it("marks a room refresh failure shown over the last loaded board", async () => {
    let fail = false;
    const slot = await open("room", scenes.richRoom, { room: () => { if (fail) throw new Error("socket closed"); return structuredClone(scenes.richRoom); } });
    await boardReady(slot);
    fail = true;
    await slot.experimental_invalidateRpc(null);
    await waitFor(() => expect(slot.container.querySelector(".tv-problem[data-stuck]")?.textContent).toMatch(/Room refresh failed/), LOADED);
  });
});
