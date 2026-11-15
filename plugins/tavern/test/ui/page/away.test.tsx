import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import type { AwayStatus } from "../../../src/shared/away";
import { closedWords, roomAway } from "../../../src/ui/page/model";
import { hearthWords } from "../../../src/ui/kit/hearth";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { StatusLine } from "../../../src/ui/page/room";
import { ClosingTimeSheet } from "../../../src/ui/page/closing";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

const at = (h: number, m: number, dayOffset = 0) => { const d = new Date(2026, 10, 16, h, m); d.setDate(d.getDate() + dayOffset); return d.getTime(); };
const now = at(6, 30);
const away = (o: Partial<AwayStatus>): AwayStatus => ({ closed: true, until: at(8, 0), dueBack: false, windowId: "w1", ...o });

describe("Closing time's words on the status line", () => {
  it("says nothing while open, or before the room carries the field", () => {
    expect(closedWords(null, now)).toBeNull();
    expect(closedWords(away({ closed: false, until: null }), now)).toBeNull();
    expect(roomAway(scenes.richRoom)).toBeNull();
  });
  it("switches at the Back at time, in the hearth's own words: closed until it, then the hearth's due-back words once the server says it has passed", () => {
    expect(closedWords(away({ dueBack: false }), now)).toBe("Closed until 08:00");
    const hearth = hearthWords([], { away: away({ dueBack: true }), now: at(8, 1) });
    expect(hearth.detail).toMatch(/due back.* 08:00$/);
    expect(closedWords(away({ dueBack: true }), at(8, 1))).toBe(`Closed · ${hearth.detail}`);
    expect(hearthWords([], { away: away({ dueBack: false }), now }).detail).toBe("closed until 08:00");
  });
  it("reads 'Closed' with no end time, and puts the day in front when it isn't today", () => {
    expect(closedWords(away({ until: null }), now)).toBe("Closed");
    const monday = at(8, 0, 1);
    expect(closedWords(away({ until: monday }), now)).toBe(`Closed until ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(monday).getDay()]} 08:00`);
  });
});

describe("Closing time on the page", () => {
  async function open(subPath: string, room: Room) {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    return slot;
  }
  const closedRoom = { ...scenes.richRoom, away: away({ until: Date.now() + 90 * 60_000 }) } as Room;
  it("shows no Closing time words while the room has no away field", async () => {
    const slot = await open("room", scenes.richRoom);
    const status = await slot.findByRole("group", { name: "Status" });
    expect(status.textContent).not.toMatch(/Closed/);
  });
  it("names the state on the status line, as a link to the Closing time page, and in the Closing time header", async () => {
    // Rendered directly: the room RPC drops away until Tim adds it to the room schema, which is the "nothing until it arrives" case above.
    const status = renderSlot({ component: () => <StatusLine room={closedRoom} /> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract });
    slots.push(status);
    const link = status.container.querySelector<HTMLButtonElement>(".rm-closed")!;
    expect(link.textContent).toMatch(/^Closed until (\w{3} )?\d\d:\d\d$/);
    fireEvent.click(link);
    expect(status.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "closing" } });
    const sheet = renderSlot({ component: () => <ClosingTimeSheet room={{ ...closedRoom, away: away({ until: Date.now() - 60_000, dueBack: true }) } as Room} registry={scenes.registry} /> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract });
    slots.push(sheet);
    expect(sheet.container.querySelector(".tv-sheet-head .tv-facts")!.textContent).toMatch(/^Closed · [a-z ]*due back[a-z ]* (\w{3} )?\d\d:\d\d/);
  });
});
