// @vitest-environment jsdom
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); });
async function hearth(away: Room["away"]) {
  for (const s of slots.splice(0)) s.lifecycle.unmount();
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const room: Room = { ...structuredClone(scenes.richRoom) }; if (away !== undefined) room.away = away; else delete room.away;
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { name: /The quest board/ });
  return (await slot.findByText((_, el) => el?.matches("[data-slot=hearth]") ?? false));
}
const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
// The hearth's own words; with the replay on, the kit ends them with the flicker and a link to its setting.
const hearthWords = (el: Element) => el.querySelector(".hearth-w")!.textContent!.replace(/\u00a0·$/, "");

describe("the board's hearth at closing time, from the room's away field", () => {
  it("says Out with the Back at time, then 'was due back at' once the server says so", async () => {
    expect(hearthWords(await hearth({ closed: true, until: at(23, 59), dueBack: false, windowId: "w1" }))).toBe("Out · closed until 23:59");
    expect(hearthWords(await hearth({ closed: true, until: at(0, 1), dueBack: true, windowId: "w1" }))).toBe("Out · was due back at 00:01");
    expect(hearthWords(await hearth({ closed: true, until: null, dueBack: false, windowId: "w1" }))).toBe("Out · closed");
  });

  it("shows the Keepers' real state while open or before the room carries the field", async () => {
    expect(hearthWords(await hearth({ closed: false, until: null, dueBack: false, windowId: null }))).toMatch(/^(Lit|Banked) · /);
    expect(hearthWords(await hearth(undefined))).toMatch(/^(Lit|Banked) · /);
  });
});
