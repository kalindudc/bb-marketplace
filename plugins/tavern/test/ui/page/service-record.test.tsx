import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import type { CharacterServiceRecord } from "../../../src/shared/service-record";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
const LOADED = { timeout: 3000 };
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });

const year = new Date().getFullYear();
const nov = (day: number) => new Date(year, 10, day, 12).getTime();
const blank = (characterId: string, over: Partial<CharacterServiceRecord> = {}): CharacterServiceRecord => ({ characterId, firstEarnedAt: nov(12), lastEarnedAt: nov(14), completeSince: null, backfilledAt: null, recordsTotal: 0, records: [], ...over });
const records: CharacterServiceRecord[] = [
  blank("juno", { maker: { verifiedWaypoints: 14, quests: 9 }, recordsTotal: 9 }),
  // Earned from 12 Nov, before the record began on 15 Nov: the server marks it partial, as it does Wren's.
  blank("vex", { warden: { checks: 11, independentChecks: 9, sameFamilyChecks: 2, caughtDefects: 2, caughtSince: nov(15) }, completeSince: nov(15) }),
  blank("wren", { keeper: { returnedQuests: 10, verifiedReturns: 9, stoppedQuests: 1, verifiedWaypoints: 31 }, completeSince: nov(15), backfilledAt: nov(15) }),
  // Legacy proof with no known dates: counts stand, no date is invented, and the history is labelled partial.
  blank("bram", { firstEarnedAt: null, lastEarnedAt: null, maker: { verifiedWaypoints: 3, quests: 2 }, completeSince: nov(15), backfilledAt: nov(15) }),
  blank("rook", { warden: { checks: 3, independentChecks: 3, sameFamilyChecks: 0, caughtDefects: 1, caughtSince: nov(15) }, completeSince: nov(15) }),
];
// No member of these characters is visible in the room: every thread archived. The record must still read in full.
const emptyRoom: Room = { ...structuredClone(scenes.emptyRoomScene) };

async function open(subPath: string, serviceRecords: CharacterServiceRecord[] | null = records, room: Room = emptyRoom, extra: Record<string, unknown> = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const registry = { ...structuredClone(scenes.registry), ...(serviceRecords ? { serviceRecords } : {}), ...extra };
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(registry), room: () => structuredClone(room) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
const record = async (slot: RenderedSlot) => waitFor(() => { const el = slot.container.querySelector<HTMLElement>("[data-service-record]"); expect(el).not.toBeNull(); return el!; }, LOADED);
const said = (el: Element | null | undefined) => el?.textContent?.replace(/\u00a0/g, " ");
const lines = (el: HTMLElement) => [...el.querySelectorAll("p")].map(said);

describe("the character sheet's service record", () => {
  it("keeps a maker's verified waypoints with every thread archived, and levels from them", async () => {
    const slot = await open("character/juno");
    const el = await record(slot);
    // Complete since it began: no partial line.
    expect(lines(el)).toEqual([`14 verified waypoints across 9 quests, on record since 12 Nov.`]);
    expect(el.querySelector("[data-partial]")).toBeNull();
    expect(slot.container.textContent).not.toMatch(/in visible threads/);
    // 8 earned results a level: 14 verified waypoints is level 2.
    const level = slot.container.querySelector<HTMLElement>("[data-level]")!;
    // Each number once: the level names what is still needed, and the record keeps the count.
    expect([...level.querySelectorAll("p")].map(said)).toEqual(["Level 2 · 2 more verified waypoints for level 3.", "Levels come from waypoints a Warden verified."]);
  });

  it("counts a Warden's checks with independence as recorded, same-family apart, labels its older history partial, and shows no level", async () => {
    const slot = await open("character/vex");
    const el = await record(slot);
    expect(lines(el)).toEqual(["11 checks, 9 independent, 2 same-family, 2 caught a defect before return, on record since 12 Nov.", "History before 15 Nov is partial: it counts only the proof that survived."]);
    // A Warden levels on independent checks, whatever their verdict, and its level never says "verified".
    const level = slot.container.querySelector<HTMLElement>("[data-level]")!;
    expect([...level.querySelectorAll("p")].map(said)).toEqual(["Level 2 · 7 more independent checks for level 3.", "Levels come from independent checks, whatever the verdict."]);
    expect(level.textContent).not.toMatch(/verified/);
    // The kit's crest cuts one notch per level past the first, and its name says the level.
    expect(slot.container.querySelector(".tv-sheet-head [role=img][aria-label$=', level 2']")).not.toBeNull();
  });

  it("says what a Keeper brought back, and labels history from before the record began as partial", async () => {
    const slot = await open("character/wren");
    const el = await record(slot);
    // One line: a Keeper's basis would repeat the level line's unit.
    expect([...slot.container.querySelectorAll("[data-level] p")].map(said)).toEqual(["Level 2 · 7 more quests with verified work for level 3."]);
    expect(lines(el)).toEqual(["Brought back 10 quests (9 with verified work) and 31 verified waypoints, on record since 12 Nov.", "History before 15 Nov is partial: it counts only the proof that survived."]);
  });

  it("drops the brackets when every quest a Keeper brought back had verified work", async () => {
    const el = await record(await open("character/wren", [blank("wren", { keeper: { returnedQuests: 9, verifiedReturns: 9, stoppedQuests: 0, verifiedWaypoints: 31 } })]));
    expect(lines(el)).toEqual(["Brought back 9 quests and 31 verified waypoints, on record since 12 Nov."]);
  });

  it("names each role, with its own date, when a character has records in two roles", async () => {
    const row = (questId: string, role: "keeper" | "maker", endedAt: number | null, verifiedWaypoints: number) => ({ questId, title: questId, short: questId, phase: "done" as const, endedAt, keeperThreadId: null, role, verifiedWaypoints, threadIds: [] });
    const two = blank("wren", { firstEarnedAt: nov(14), keeper: { returnedQuests: 4, verifiedReturns: 4, stoppedQuests: 0, verifiedWaypoints: 5 }, maker: { verifiedWaypoints: 3, quests: 2 },
      recordsTotal: 3, records: [row("q3", "maker", nov(16), 2), row("q2", "maker", nov(15), 1), row("q1", "keeper", nov(14), 5)] });
    const slot = await open("character/wren", [two]);
    expect(lines(await record(slot))).toEqual(["As a Keeper: brought back 4 quests, with 5 verified waypoints, on record since 14 Nov.", "As a maker: 3 verified waypoints across 2 quests, on record since 15 Nov."]);
    // More quests on record than it sends: the earliest may be past the cap, so no date is said for either role.
    const capped = await open("character/wren", [{ ...two, recordsTotal: 30 }]);
    expect(lines(await record(capped))).toEqual(["As a Keeper: brought back 4 quests, with 5 verified waypoints.", "As a maker: 3 verified waypoints across 2 quests."]);
    // The server's own per-role dates are exact past the cap.
    const exact = await open("character/wren", [{ ...two, recordsTotal: 30, keeper: { ...two.keeper!, firstEarnedAt: nov(10) }, maker: { ...two.maker!, firstEarnedAt: nov(11) } }]);
    expect(lines(await record(exact))).toEqual(["As a Keeper: brought back 4 quests, with 5 verified waypoints, on record since 10 Nov.", "As a maker: 3 verified waypoints across 2 quests, on record since 11 Nov."]);
    // An explicit null means a record of that role is undated somewhere, maybe past the cap: no date, never one from the rows sent.
    const unknown = await open("character/wren", [{ ...two, keeper: { ...two.keeper!, firstEarnedAt: null }, maker: { ...two.maker!, firstEarnedAt: nov(11) } }]);
    expect(lines(await record(unknown))).toEqual(["As a Keeper: brought back 4 quests, with 5 verified waypoints.", "As a maker: 3 verified waypoints across 2 quests, on record since 11 Nov."]);
    // One role keeps today's line.
    const one = await open("character/wren", [blank("wren", { keeper: { returnedQuests: 4, verifiedReturns: 4, stoppedQuests: 0, verifiedWaypoints: 5 } })]);
    expect(lines(await record(one))).toEqual(["Brought back 4 quests and 5 verified waypoints, on record since 12 Nov."]);
    // The card stays on the level's own count.
    const cards = await open("characters", [two]);
    expect((await cards.findByTitle("Open Wren's character sheet", {}, LOADED)).querySelector(".tv-cc-line")!.textContent).toBe("4 quests with verified work");
  });

  it("never dates old catches: the catch count stands as recorded, and the coverage boundary is said apart", async () => {
    const el = await record(await open("character/rook"));
    const warden = el.querySelector<HTMLElement>("[data-role=warden]")!;
    expect(warden.textContent).toBe("3 checks, 3 independent, 1 caught a defect before return, on record since 12 Nov.");
    expect(warden.title).toBe("Catches are complete since 15 Nov; before that, a catch counts only where its proof survived.");
    expect(el.textContent).not.toMatch(/catch(es)? since|caught a defect since/);
    expect(el.querySelector("[data-partial]")!.textContent).toBe("History before 15 Nov is partial: it counts only the proof that survived.");
  });

  it("invents no date for legacy proof whose dates are unknown", async () => {
    const el = await record(await open("character/bram"));
    expect(lines(el)).toEqual(["3 verified waypoints across 2 quests.", "History before 15 Nov is partial: it counts only the proof that survived."]);
    expect(el.textContent).not.toMatch(/on record since/);
  });

  it("shows no level, no bar and no zeros for a character with nothing earned yet, in its class's words", async () => {
    for (const [id, words] of [["pip", "No verified waypoints yet"], ["moss", "No quests with verified work yet"]] as const) {
      const slot = await open(`character/${id}`);
      const none = await waitFor(() => { const el = slot.container.querySelector<HTMLElement>("[data-level=none]"); expect(el).not.toBeNull(); return el!; }, LOADED);
      expect(none.textContent).toBe(words);
      expect(slot.container.querySelector(".tv-lvl, .tv-lvl-bar, [data-service-record]")).toBeNull();
      expect(slot.container.querySelector(".tv-sheet-head")!.textContent).not.toMatch(/\b0\b/);
    }
    // A Warden whose checks were all same-family has a record, but no independent check to level on.
    const slot = await open("character/rook", [blank("rook", { warden: { checks: 2, independentChecks: 0, sameFamilyChecks: 2, caughtDefects: 0, caughtSince: null } })]);
    // No zeros: every check same-family reads as one count.
    expect((await record(slot)).textContent).toBe("2 same-family checks, on record since 12 Nov.");
    expect(slot.container.querySelector("[data-level=none]")!.textContent).toBe("No independent checks yet");
  });

  it("keeps the visible-threads count, said as such, when an older server sends no record", async () => {
    const slot = await open("character/juno", null, structuredClone(scenes.richRoom));
    await waitFor(() => expect(slot.container.textContent).toMatch(/verified wins in visible threads/), LOADED);
    expect(slot.container.querySelector("[data-service-record]")).toBeNull();
  });

  it("shows a card's record line, undated, when the count its level uses is 0", async () => {
    const slot = await open("characters", [blank("rook", { warden: { checks: 2, independentChecks: 0, sameFamilyChecks: 2, caughtDefects: 0, caughtSince: null } })]);
    const line = (await slot.findByTitle("Open Rook's character sheet", {}, LOADED)).querySelector<HTMLElement>(".tv-cc-line")!;
    expect(line.textContent).toBe("2 same-family checks");
    expect(line.title).toBe("2 same-family checks, on record since 12 Nov.");
  });

  it("puts the same counts, short, on each character card", async () => {
    const slot = await open("characters");
    const card = async (name: string) => (await slot.findByTitle(`Open ${name}'s character sheet`, {}, LOADED));
    const line = async (name: string) => (await card(name)).querySelector<HTMLElement>(".tv-cc-line")!;
    // Only the count the level uses (a Warden's with its checks), and the whole record in the title.
    expect((await line("Juno")).textContent).toBe("14 verified waypoints");
    expect((await line("Juno")).title).toBe("14 verified waypoints across 9 quests, on record since 12 Nov.");
    expect((await line("Vex")).textContent).toBe("11 checks · 9 independent");
    expect((await line("Wren")).textContent).toBe("9 quests with verified work");
    expect((await line("Wren")).title).toBe("Brought back 10 quests (9 with verified work) and 31 verified waypoints, on record since 12 Nov.");
    expect((await line("Pip")).textContent).toBe("no record yet");
    // Each card's level counts what its class is trusted for; nothing earned, no level and no bar.
    expect((await card("Juno")).querySelector(".tv-lvl")!.getAttribute("aria-label")).toBe("Level 2 · 2 more verified waypoints for level 3.");
    expect((await card("Vex")).querySelector(".tv-lvl")!.getAttribute("aria-label")).toBe("Level 2 · 7 more independent checks for level 3.");
    expect((await card("Wren")).querySelector(".tv-lvl")!.getAttribute("aria-label")).toBe("Level 2 · 7 more quests with verified work for level 3.");
    expect((await card("Pip")).querySelector(".tv-lvl")).toBeNull();
  });
});

describe("with character levels turned off in Settings", () => {
  const off = { levels: false };
  const notched = (slot: RenderedSlot) => [...slot.container.querySelectorAll("svg.tavern-crest")].filter((c) => c.hasAttribute("data-notches") || /, level \d/.test(c.getAttribute("aria-label") ?? ""));

  it("draws no level, no bar, no notch and no level words on a sheet, and keeps the record", async () => {
    const slot = await open("character/vex", records, emptyRoom, off);
    const el = await record(slot);
    expect(lines(el)[0]).toBe("11 checks, 9 independent, 2 same-family, 2 caught a defect before return, on record since 12 Nov.");
    expect(slot.container.querySelector(".tv-lvl, .tv-lvl-none, .tv-lvl-d, [data-level]")).toBeNull();
    expect(notched(slot)).toEqual([]);
    const withoutAuthoredBubbles = slot.container.cloneNode(true) as HTMLElement;
    withoutAuthoredBubbles.querySelector(".tv-bubbles")?.remove();
    expect(withoutAuthoredBubbles.textContent).not.toMatch(/\blevels?\b/i);
  });

  it("says no level on the sheets page or a class page either; the cards keep their record", async () => {
    const list = await open("characters", records, emptyRoom, off);
    await waitFor(() => expect([...list.container.querySelectorAll(".tv-ccard .tv-cc-rec")].some((r) => /\d/.test(r.textContent ?? ""))).toBe(true), LOADED);
    expect(list.container.querySelector(".tv-lvl, .tv-lvl-none, [data-level]")).toBeNull();
    expect(notched(list)).toEqual([]);
    expect(list.container.querySelector(".tv-sline")!.textContent).not.toMatch(/\blevels?\b/i);
    const cls = await open("class/warden", records, emptyRoom, off);
    await waitFor(() => expect(cls.container.querySelector(".tv-classd svg.tavern-crest")).not.toBeNull(), LOADED);
    expect(notched(cls)).toEqual([]);
  });

  it("draws levels when the server sends no flag, as before", async () => {
    const slot = await open("character/vex");
    await record(slot);
    expect(slot.container.querySelector("[data-level]")).not.toBeNull();
    expect(notched(slot).length).toBeGreaterThan(0);
  });
});
