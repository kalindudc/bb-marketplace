import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import { FinishedRow } from "../../../src/ui/page/archive";
import { taleFigures, type TaleRow } from "../../../src/ui/page/tales";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
type W = BoardQuestDetail["quest"]["waypoints"][number];
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
const LOADED = { timeout: 3000 };

// Smoke 6: the quest's only waypoint was skipped. Mixed: one verified, one skipped, the rest still open.
const skipOnly = (ws: W[]): W[] => ws.slice(0, 1).map((w) => ({ ...w, state: "skipped" }));
const mixed = (ws: W[]): W[] => ws.map((w, i) => ({ ...w, state: i === 0 ? "verified" : i === 1 ? "skipped" : "doing" }));

async function open(subPath: string, rpc: Partial<Handlers>) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
const stoppedReadme = (waypoints: W[]): BoardQuestDetail => {
  const d = structuredClone(scenes.readmeDetail);
  return { ...d, quest: { ...d.quest, waypoints, phase: "stopped", endedAt: d.quest.updatedAt } };
};

describe("a verified count counts only verified waypoints, and names skipped ones apart", () => {
  it("on a cellar row", () => {
    const row = (waypoints: W[]) => {
      const slot = renderSlot({ component: () => <FinishedRow quest={{ ...structuredClone(scenes.readmeDetail.quest), waypoints }} registry={scenes.registry} /> }, {}, { pluginId: "tavern" });
      slots.push(slot);
      return slot.container.querySelector(".tv-wrow-n")!.textContent;
    };
    const ws = scenes.readmeDetail.quest.waypoints;
    expect(row(skipOnly(ws))).toBe("1 skipped");
    expect(row(mixed(ws))).toBe(`1 of ${ws.length} verified\u00a0· 1 skipped`);
    // Every waypoint skipped, more than one: the words say it was all of them.
    expect(row(ws.map((w) => ({ ...w, state: "skipped" as const })))).toBe(`all ${ws.length} skipped`);
  });

  it("in Done and left and the facts line, never 1 of 1 for a skipped waypoint", async () => {
    const done = async (d: BoardQuestDetail) => {
      // Two mounted pages reading one quest id from different fixtures would fight over the shared cache.
      for (const slot of slots.splice(0)) slot.lifecycle.unmount();
      window.localStorage.clear();
      const slot = await open(`quest/${d.quest.id}`, { boardQuest: () => structuredClone(d) });
      const section = await waitFor(() => slot.getByRole("region", { name: "Done and left" }), LOADED);
      const facts = slot.container.querySelector("header .tv-facts")!;
      return { count: facts.querySelector(".num")!.textContent, text: section.textContent!, facts: facts.textContent! };
    };
    const only = await done(stoppedReadme(skipOnly(scenes.readmeDetail.quest.waypoints)));
    expect(only.count).toBe("1 skipped");
    expect(only.text).not.toMatch(/1 of 1 (waypoint )?verified/);
    // A finished quest's header names what was verified, not progress: "path 1 of 1" was smoke 6's misread.
    expect(only.facts).toContain("path 1 skipped");
    expect(only.facts).not.toContain("path 1 of 1");
    const ws = scenes.readmeDetail.quest.waypoints;
    const both = await done(stoppedReadme(mixed(ws)));
    expect(both.count).toBe(`1 of ${ws.length} verified\u00a0· 1 skipped`);
    expect(both.facts).toContain(`path 1 of ${ws.length} verified\u00a0· 1 skipped`);
    const all = await done(stoppedReadme(ws.map((w) => ({ ...w, state: "skipped" as const }))));
    expect(all.facts).toContain(`path all ${ws.length} skipped`);
  });

  it("on the tale's Loot count", async () => {
    const d = structuredClone(scenes.readmeDetail);
    d.quest.waypoints = mixed(d.quest.waypoints);
    const slot = await open(`tale/${d.quest.id}`, { boardQuest: () => structuredClone(d) });
    const loot = await waitFor(() => { const s = [...slot.container.querySelectorAll("section")].find((x) => x.querySelector("h3")?.textContent?.startsWith("Loot")); expect(s).toBeTruthy(); return s!; }, LOADED);
    // The heading says "verified results", so the count leaves the word out, as the tale's "path verified" figure does.
    expect(loot.querySelector(".tv-count")!.textContent).toBe(`1 of ${d.quest.waypoints.length}\u00a0· 1 skipped`);
  });

  it("on the trophy wall, reading the record's skipped count only when the server sends one", () => {
    const row = (waypoints: TaleRow["waypoints"]): TaleRow => ({ questId: "q", title: "Q", short: "Q", endedAt: null, kept: false, available: true, waypoints, checks: null });
    expect(taleFigures(row({ verified: 2, total: 3, skipped: 1 }))).toEqual(["2 of 3 verified\u00a0· 1 skipped"]);
    expect(taleFigures(row({ verified: 0, total: 1, skipped: 1 }))).toEqual(["1 skipped"]);
    expect(taleFigures(row({ verified: 0, total: 3, skipped: 3 }))).toEqual(["all 3 skipped"]);
    expect(taleFigures(row({ verified: 2, total: 3, skipped: 0 }))).toEqual(["2 of 3 verified"]);
    expect(taleFigures(row({ verified: 2, total: 3 }))).toEqual(["2 of 3 verified"]);
  });


  it("on the map's returned label", async () => {
    const room: Room = { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === "sfe" ? { ...q, waypoints: skipOnly(q.waypoints.length ? q.waypoints : scenes.readmeDetail.quest.waypoints) } : q) })) };
    const slot = await open("map", { room: () => structuredClone(room) });
    fireEvent.click(await slot.findByRole("button", { name: /^Show finished quests/ }, LOADED));
    const sub = () => [...slot.container.querySelectorAll(".tv-map *")].map((el) => el.textContent ?? "").find((t) => /^Returned · /.test(t)) ?? "";
    await waitFor(() => expect(sub()).toMatch(/^Returned · 1 skipped · /), LOADED);
  });
});
