import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
import { act, waitFor } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import type { AwayControl, AwayDigest } from "../../../src/shared/away-rpc";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

// Each surface is wrapped in a counter before register.tsx memoizes it, so a count is one render of that surface.
const renders = vi.hoisted(() => new Map<string, number>());
const counted = vi.hoisted(() => (name: string, Inner: ComponentType<object>) => function Counted(props: object) {
  renders.set(name, (renders.get(name) ?? 0) + 1);
  return createElement(Inner, props);
});
vi.mock("../../../src/ui/page/room", async (load) => { const m = await load<typeof import("../../../src/ui/page/room")>(); return { ...m, CommonRoom: counted("CommonRoom", m.CommonRoom as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/connections", async (load) => { const m = await load<typeof import("../../../src/ui/page/connections")>(); return { ...m, TheMap: counted("TheMap", m.TheMap as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/quest", async (load) => { const m = await load<typeof import("../../../src/ui/page/quest")>(); return { ...m, ReturnedList: counted("ReturnedList", m.ReturnedList as ComponentType<object>), QuestPage: counted("QuestPage", m.QuestPage as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/tale", async (load) => { const m = await load<typeof import("../../../src/ui/page/tale")>(); return { ...m, TalePage: counted("TalePage", m.TalePage as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/sheets", async (load) => { const m = await load<typeof import("../../../src/ui/page/sheets")>(); return { ...m, CharacterSheets: counted("CharacterSheets", m.CharacterSheets as ComponentType<object>), ClassesList: counted("ClassesList", m.ClassesList as ComponentType<object>), ClassDetail: counted("ClassDetail", m.ClassDetail as ComponentType<object>), CharacterSheetEditor: counted("CharacterSheetEditor", m.CharacterSheetEditor as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/machines", async (load) => { const m = await load<typeof import("../../../src/ui/page/machines")>(); return { ...m, MachinesPage: counted("MachinesPage", m.MachinesPage as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/insights", async (load) => { const m = await load<typeof import("../../../src/ui/page/insights")>(); return { ...m, InsightsPage: counted("InsightsPage", m.InsightsPage as ComponentType<object>) }; });
vi.mock("../../../src/ui/page/closing", async (load) => { const m = await load<typeof import("../../../src/ui/page/closing")>(); return { ...m, ClosingTimeSheet: counted("ClosingTimeSheet", m.ClosingTimeSheet as ComponentType<object>), ClosedDigest: counted("ClosedDigest", m.ClosedDigest as ComponentType<object>) }; });

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
const LOADED = { timeout: 4000 };
beforeEach(() => { renders.clear(); window.localStorage.clear(); });
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); vi.useRealTimers(); });

type Window = NonNullable<AwayControl["window"]>;
const windowFor = (room: Room, closedAt: number): Window => ({ id: "w1", version: 1, closedAt, until: room.away?.until ?? null, note: null, quests: [], allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false }, stopList: ["merge", "deploy", "production", "sends-as-you", "delete"], eventFloor: 0, eventCeiling: null, returnedAt: null, returnCause: null } as Window);
// The away reads answer, so no error and no retry re-renders a surface while the test waits on the clock.
const awayFor = (room: Room, closedAt: number): AwayControl => ({ revision: 1, window: room.away?.closed ? windowFor(room, closedAt) : null, status: room.away ?? { closed: false, until: null, dueBack: false, windowId: null }, watchedCount: 0, heldCount: 0, pendingStops: [], resumeRequired: [] });
const digestFor = (room: Room, closedAt: number): AwayDigest => ({ window: windowFor(room, closedAt), totalEvents: 0, nextCursor: null, events: [], totalAsks: 0, nextAskCursor: null, asks: [], quests: [] } as unknown as AwayDigest);

async function open(subPath: string, current: () => Room, closedAt = Date.now() - 60_000) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  let calls = 0, awayCalls = 0;
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    registry: () => structuredClone(scenes.registry),
    // A fresh object on every call, as the server sends: only deep equality can keep the page's room the same.
    room: () => { calls++; return structuredClone(current()); },
    boardQuest: ({ id }: { id: string }) => structuredClone(scenes.richDetails[id] ?? scenes.richDetails.vault!),
    classExecutions: () => ({ classes: [] }),
    away: () => { awayCalls++; return awayFor(current(), closedAt); },
    awayDigest: () => digestFor(current(), closedAt),
  } as Partial<Handlers> as Handlers });
  slots.push(slot);
  const refetch = async () => {
    const before = calls;
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    await waitFor(() => expect(calls).toBeGreaterThan(before), LOADED);
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  };
  return { slot, refetch, calls: () => calls, awayCalls: () => awayCalls };
}

describe("the page surfaces skip an unchanged room refetch", () => {
  const cases: [string, string, string][] = [
    ["the common room", "", "CommonRoom"],
    ["the map", "map", "TheMap"],
    ["returned quests", "returned", "ReturnedList"],
    ["the character sheets", "characters", "CharacterSheets"],
    ["Closing time", "closing", "ClosingTimeSheet"],
    ["the digest", "digest", "ClosedDigest"],
    ["a quest page", "quest/vault", "QuestPage"],
    ["a tale", "tale/vault", "TalePage"],
    ["the classes", "classes", "ClassesList"],
    ["a class", "class/keeper", "ClassDetail"],
    ["a character sheet", "character/wren", "CharacterSheetEditor"],
    ["where work runs", "machines", "MachinesPage"],
    ["insights", "insights", "InsightsPage"],
  ];
  // Surfaces that never read the room stay put even when it changes.
  const roomless = new Set(["ClassesList", "ClassDetail", "MachinesPage", "InsightsPage"]);
  for (const [label, subPath, surface] of cases) {
    it(`renders ${label} again only when the room changes`, async () => {
      let room = scenes.richRoom;
      const { refetch } = await open(subPath, () => room);
      await waitFor(() => expect(renders.get(surface) ?? 0).toBeGreaterThan(0), LOADED);
      await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
      const settled = renders.get(surface)!;
      // The same room, fetched again: the shell re-renders for the fetch's start and end, the surface not at all.
      await refetch();
      await refetch();
      expect(renders.get(surface)).toBe(settled);
      // A changed room: the page's surfaces that read it render again.
      room = { ...scenes.richRoom, review: { ...scenes.richRoom.review, waiting: scenes.richRoom.review.waiting + 1 } };
      await refetch();
      if (roomless.has(surface)) expect(renders.get(surface)).toBe(settled);
      else expect(renders.get(surface)!).toBeGreaterThan(settled);
    });
  }
});

describe("texts that read the clock keep time on their own", () => {
  const T = new Date(2026, 10, 14, 23, 50, 0).getTime();
  const tomorrowAt = (h: number, m: number) => { const d = new Date(T); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d.getTime(); };
  // Only setInterval and the clock are fake, so the page's queries and waitFor keep real timeouts.
  const fake = () => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); vi.setSystemTime(T); };
  const minute = (n = 1) => act(() => { vi.advanceTimersByTime(n * 60_000); });

  it("updates the oldest ask's wait after a minute, with no refetch", async () => {
    fake();
    const oldest = { ...scenes.richRoom.asks[0]!, state: "open" as const, createdAt: T - 12 * 60_000 };
    const room = { ...scenes.richRoom, asks: [oldest, ...scenes.richRoom.asks.slice(1).map((a) => ({ ...a, createdAt: T - 5 * 60_000 }))] };
    const { slot, calls } = await open("", () => room);
    const text = async () => (await slot.findByText(/^oldest/, { selector: ".rm-oldest" }, LOADED)).textContent;
    expect(await text()).toBe("oldest 12m");
    const fetched = calls();
    await minute();
    expect(await text()).toBe("oldest 13m");
    // The queue row's own age moves with it.
    expect(slot.container.querySelector(`[data-ask] .tv-askrow-a time`)!.textContent).toBe("13m");
    expect(calls()).toBe(fetched);
  });

  it("updates the status line's and the board hearth's Closing time words at midnight, with no refetch", async () => {
    fake();
    vi.setSystemTime(new Date(2026, 10, 14, 23, 59, 30));
    const room: Room = { ...scenes.richRoom, away: { closed: true, until: tomorrowAt(8, 0), dueBack: false, windowId: "w1" } };
    const { slot, calls } = await open("", () => room);
    const jump = () => slot.container.querySelector<HTMLElement>(".rm-closed")!.textContent!;
    // The hearth's own words; with the replay on, the kit ends them with the flicker and a link to its setting.
    const hearth = () => slot.container.querySelector<HTMLElement>("[data-slot=hearth] .hearth-w")!.textContent!.replace(/\u00a0·$/, "");
    await waitFor(() => expect(jump()).toMatch(/until Sun 08:00/), LOADED);
    expect(hearth()).toBe("Out · closed until Sun 08:00");
    const fetched = calls();
    await minute();
    expect(jump()).toMatch(/until 08:00/);
    expect(jump()).not.toMatch(/Sun/);
    expect(hearth()).toBe("Out · closed until 08:00");
    expect(calls()).toBe(fetched);
  });

  it("updates a returned quest's age on the map after a minute, with no refetch", async () => {
    fake();
    const room: Room = { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === "sfe" ? { ...q, endedAt: T - 12 * 60_000, updatedAt: T - 12 * 60_000 } : q) })) };
    const { slot, calls } = await open("map", () => room);
    const sub = () => [...slot.container.querySelectorAll(".tv-map *")].map((el) => el.textContent ?? "").find((t) => /^Returned · .*ago$/.test(t)) ?? "";
    await waitFor(() => expect(sub()).toMatch(/ · 12m ago$/), LOADED);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    const fetched = calls();
    await minute();
    expect(sub()).toMatch(/ · 13m ago$/);
    expect(calls()).toBe(fetched);
  });

  it("updates Closing time's words at midnight, with no refetch", async () => {
    fake();
    vi.setSystemTime(new Date(2026, 10, 14, 23, 59, 30));
    const room: Room = { ...scenes.richRoom, away: { closed: true, until: tomorrowAt(8, 0), dueBack: false, windowId: "w1" } };
    const { slot, calls } = await open("closing", () => room);
    const mark = () => slot.container.querySelector<HTMLElement>(".tv-sheet-head .tv-facts")!.textContent!;
    await waitFor(() => expect(mark()).toMatch(/until Sun 08:00/), LOADED);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    const fetched = calls();
    await minute();
    expect(mark()).toMatch(/until 08:00/);
    expect(mark()).not.toMatch(/Sun/);
    expect(calls()).toBe(fetched);
  });

  it("updates the digest's clocks at midnight, with no refetch", async () => {
    fake();
    vi.setSystemTime(new Date(2026, 10, 14, 23, 59, 30));
    const room: Room = { ...scenes.richRoom, away: { closed: true, until: tomorrowAt(8, 0), dueBack: false, windowId: "w1" } };
    const { slot, calls } = await open("digest", () => room, new Date(2026, 10, 14, 23, 0).getTime());
    const facts = () => slot.container.querySelector<HTMLElement>(".tv-digest .tv-facts")?.textContent ?? "";
    await waitFor(() => expect(facts()).toMatch(/^closed 23:00back at Sun 08:00/), LOADED);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    const fetched = calls();
    await minute();
    // Past midnight the close was yesterday and the Back at time is today.
    expect(facts()).toMatch(/^closed Sat 23:00back at 08:00/);
    expect(calls()).toBe(fetched);
  });
});

describe("the room fetches the full Closing time state only when it has something to show", () => {
  const openRoom = (away: Partial<NonNullable<Room["away"]>>) => () => ({ ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: "w-old", ...away } }) as Room;

  it("never fetches it for an open room with an old window that needs no follow-up, signal after signal", async () => {
    const page = await open("room", openRoom({ followUp: false }));
    await page.slot.findAllByText(/need you/, {}, LOADED);
    for (let i = 0; i < 3; i++) await page.refetch();
    expect(page.awayCalls()).toBe(0);
  });

  it("fetches it while closed, and while a window still has stops or resumes to follow up", async () => {
    for (const away of [{ closed: true, until: Date.now() + 3_600_000, followUp: false }, { followUp: true }]) {
      const page = await open("room", openRoom(away));
      await waitFor(() => expect(page.awayCalls()).toBeGreaterThan(0), LOADED);
    }
  });

  it("keeps the old rule for an older server that sends no follow-up flag: any recorded window", async () => {
    const page = await open("room", openRoom({}));
    await waitFor(() => expect(page.awayCalls()).toBeGreaterThan(0), LOADED);
  });
});
