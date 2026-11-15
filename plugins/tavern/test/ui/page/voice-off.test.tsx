import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
const LOADED = { timeout: 3000 };

const at = new Date(new Date().getFullYear(), 10, 12, 9).getTime();
const reportVoices = [{ characterId: "wren", voices: [{ reportId: "r1", line: "Clear skies over the vault.", at, threadId: "thr-juno", questId: "vault" }] }];
async function open(subPath: string, voice: "full" | "light" | "off" | undefined, rpc: Partial<Handlers> = {}, room: Room = scenes.richRoom) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const base = structuredClone(scenes.registry);
  // The first night's host is a Keeper character: give the fixture's Keeper class Wren.
  base.classes = base.classes.map((c) => c.id === "keeper" ? { ...c, characters: [...new Set([...c.characters, "wren"])] } : c);
  const registry = { ...base, characterReportVoices: reportVoices, ...(voice ? { voice } : {}) };
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(registry), room: () => structuredClone(room), voiceCheck: () => ({ characterId: "wren", history: [] }), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
const ready = (slot: RenderedSlot, sel: string) => waitFor(() => expect([...slot.container.querySelectorAll(sel)].some((e) => !e.closest(".sk"))).toBe(true), LOADED);

describe("with Character voice off in Settings, the page hides stored voice lines and keeps the data", () => {
  it("drops Said in a report from the sheet, keeps the character's own lines to edit, and says voice is off", async () => {
    const off = await open("character/wren", "off");
    await ready(off, ".tv-sheet-head h1");
    await waitFor(() => expect(off.container.querySelector(".tv-voiceed")).not.toBeNull(), LOADED);
    expect(off.queryByRole("region", { name: "Said in a report" })).toBeNull();
    expect(off.container.querySelectorAll(".tv-voiceed .tv-preview dd").length).toBeGreaterThan(0);
    expect(off.container.querySelector("[data-voice-off]")!.textContent).toBe("Character voice is off in Settings: agents write plainly, and these lines aren't used.");
    for (const voice of ["full", "light", undefined] as const) {
      const on = await open("character/wren", voice);
      await on.findByRole("region", { name: "Said in a report" }, LOADED);
      expect(on.container.querySelector("[data-voice-off]")).toBeNull();
    }
  });

  it("drops the row line from the sheets cards", async () => {
    const off = await open("characters", "off");
    await ready(off, ".tv-ccard");
    expect(off.container.querySelector(".tv-ccard .tv-cc-v")).toBeNull();
    const light = await open("characters", "light");
    await ready(light, ".tv-ccard");
    expect(light.container.querySelector(".tv-ccard .tv-cc-v")).not.toBeNull();
  });

  it("drops the voice line from the tale's credits", async () => {
    const d = structuredClone(scenes.readmeDetail);
    const lark = d.reports.filter((r) => r.memberThreadId === "thr_z5k6x43jc2").sort((a, b) => b.createdAt - a.createdAt)[0]!;
    lark.voice = "Early bird: every row link lands.";
    const tale = (voice: "off" | "full") => open(`tale/${d.quest.id}`, voice, { boardQuest: () => structuredClone(d) as BoardQuestDetail });
    const on = await tale("full");
    await waitFor(() => expect(on.container.querySelector(".tv-credit-v")).not.toBeNull(), LOADED);
    const off = await tale("off");
    await waitFor(() => expect(off.container.querySelectorAll(".tv-credit").length).toBe(d.quest.members.length), LOADED);
    expect(off.container.querySelector(".tv-credit-v")).toBeNull();
  });

  it("drops the voice line from a report shown in place on the quest page", async () => {
    const d = structuredClone(scenes.readmeDetail);
    for (const r of d.reports) r.voice = "Early bird: every row link lands.";
    const shown = async (voice: "off" | "full") => {
      // The fold remembers it was opened; each render starts folded.
      window.localStorage.clear();
      const slot = await open(`quest/${d.quest.id}`, voice, { boardQuest: () => structuredClone(d) as BoardQuestDetail });
      fireEvent.click(await slot.findByRole("button", { name: /^Reports\b/, expanded: false }, LOADED));
      const view = await waitFor(() => slot.container.querySelector<HTMLButtonElement>(".tv-items > .tv-item button.lnk-btn")!, LOADED);
      fireEvent.click(view);
      return waitFor(() => { const rv = slot.container.querySelector(".tv-items .tv-item-x .rv"); expect(rv).not.toBeNull(); return rv!; }, LOADED);
    };
    expect((await shown("full")).querySelector(".rv-voice")).not.toBeNull();
    expect((await shown("off")).querySelector(".rv-voice")).toBeNull();
  });

  it("drops the host's line from the first-night room", async () => {
    const on = await open("", "full", {}, scenes.emptyRoomScene);
    // The registry, which names the host, can land after the room: wait for the host's line itself.
    await waitFor(() => expect(on.container.querySelector(".tv-first-voice")).not.toBeNull(), LOADED);
    const off = await open("", "off", {}, scenes.emptyRoomScene);
    await waitFor(() => expect(off.container.querySelector(".tv-first-night .tv-start-cards, .tv-first-night [class*=start]")).not.toBeNull(), LOADED);
    expect(off.container.querySelector(".tv-first-voice")).toBeNull();
  });
});
