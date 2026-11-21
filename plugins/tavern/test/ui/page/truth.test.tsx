import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import { endedCounts, eventContext, keeperStatus, moveAfterPhase, namedDetail, pathProgress, phaseWord, questMove } from "../../../src/ui/page/model";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

async function open(subPath: string, room: Room, detail?: BoardQuestDetail) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), boardQuest: () => structuredClone(detail ?? scenes.richDetails.vault!) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}

/** Wren's thread archived, with nothing on the board, beside Moss at work. */
const archivedRoom: Room = { ...scenes.richRoom, keepers: [{ ...scenes.richRoom.keepers[0]!, boardQuests: [], errands: [], archived: true, status: "listening" }, scenes.richRoom.keepers[1]!], asks: scenes.richRoom.asks.filter((a) => a.keeperThreadId !== "thr-wren") };

describe("a Keeper's status words", () => {
  it("says busy, holding, idle or quiet from the Keeper's own state, never working", () => {
    expect(keeperStatus({ status: "busy", quietSince: null })).toMatchObject({ word: "busy", label: "Busy" });
    expect(keeperStatus({ status: "holding", quietSince: null })).toMatchObject({ word: "holding", label: "Holding while you type" });
    expect(keeperStatus({ status: "listening", quietSince: null })).toMatchObject({ word: "idle", label: "Idle" });
    expect(keeperStatus({ status: "busy", quietSince: 1 })).toMatchObject({ word: "quiet", label: "Quiet" });
  });
  it("puts an archived thread ahead of every other word", () => {
    for (const status of ["listening", "busy", "holding"] as const) {
      expect(keeperStatus({ status, quietSince: null, archived: true })).toMatchObject({ word: "thread archived", label: "Thread archived", tone: "archived" });
      expect(keeperStatus({ status, quietSince: 5, archived: true }).word).toBe("thread archived");
    }
  });
});

describe("a quest whose Keeper's thread is archived", () => {
  const names = { keeper: "Wren", member: () => "Juno" };
  const active = scenes.richRoom.keepers[0]!.boardQuests.find((q) => q.phase !== "done" && q.phase !== "stopped")!;
  it("claims no next step, and an ended quest keeps its ending", () => {
    expect(questMove(active, [], names, { keeperArchived: true })).toEqual({ tone: "archived", who: "Keeper's thread archived", next: "" });
    expect(questMove(active, [], names).tone).not.toBe("archived");
    expect(questMove({ ...active, phase: "stopped" }, [], names, { keeperArchived: true }).who).toBe("Stopped");
    expect(questMove({ ...active, phase: "done" }, [], names, { keeperArchived: true }).who).toBe("Returned");
  });
  it("reads as archived in Keeper gone, with the pause mark and the phase and path left as they are", async () => {
    const room: Room = { ...scenes.richRoom, keepers: [{ ...scenes.richRoom.keepers[0]!, archived: true }, scenes.richRoom.keepers[1]!], asks: [] };
    const slot = await open("room", room);
    const fold = await slot.findByRole("button", { name: /^Needs a Keeper \d+$/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("article", { name: /^Wren\b.*Keeper$/ })).toBeNull();
    fireEvent.click(fold);
    const group = fold.closest("section")!;
    const rows = [...group.querySelectorAll(".qrow-live")];
    const openQuests = room.keepers[0]!.boardQuests.filter(q => !q.endedAt && !q.archivedAt);
    expect(rows.map(row => row.getAttribute("data-quest")).sort()).toEqual(openQuests.map(q => q.id).sort());
    for (const row of rows) {
      const quest = openQuests.find(q => q.id === row.getAttribute("data-quest"))!;
      const path = pathProgress(quest);
      const move = row.querySelector(".qrow-m .tv-st")!;
      expect(move.textContent).toBe("Keeper's thread archived");
      expect(move.classList.contains("tv-st-archived")).toBe(true);
      expect(row.textContent).not.toMatch(/quest map next|scouting|· ·/);
      expect(move.querySelector(".tv-g-pause")).toBeTruthy();
      expect(row.querySelector(".tv-ph-w")!.textContent).toBe(phaseWord(quest.phase));
      expect(row.querySelector(".qrow-path")!.textContent).toBe(path ? `${path.done} of ${path.total}` : "no map yet");
      expect(row.closest(".lit")).toBeNull();
    }
    expect(within(group).getAllByRole("button", { name: /^Open Wren\x27s thread/ })).toHaveLength(rows.length);
  });
});

describe("the common room tells the truth about each Keeper", () => {
  it("folds an archived Keeper with no quest into one line, and its row says thread archived with no invitation to type", async () => {
    const slot = await open("room", archivedRoom);
    await slot.findByRole("article", { name: /^Moss\b.*Keeper$/ });
    expect(slot.queryByRole("article", { name: /^Wren\b.*Keeper$/ })).toBeNull();
    const fold = slot.getByRole("button", { name: "Keepers without a quest 1" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    const rows = fold.closest("section")!.querySelectorAll<HTMLElement>(".rm-idle .krow");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.dataset.status).toBe("archived");
    expect(within(row).getByRole("button", { name: /^Open Wren\x27s thread/ })).toBeTruthy();
    expect(row.querySelector(".krow-sl")!.textContent).toBe("Thread archived");
    expect(row.textContent).not.toMatch(/Idle|Listening|thin goal/);
    expect(row.querySelector(".tv-voice")).toBeNull();
  });
  it("words every Keeper's notice with the shared helper, and no mini rows repeat them", async () => {
    const slot = await open("room", { ...archivedRoom, asks: [] });
    const moss = await slot.findByRole("article", { name: /^Moss\b.*Keeper$/ });
    expect(moss.querySelector(".rm-nh-s .tv-st")!.textContent).toBe("Busy");
    expect(slot.container.querySelector(".tv-kmini, .tv-kminis")).toBeNull();
    expect(slot.container.textContent).not.toMatch(/\bworking\b/);
  });
});

const vault = scenes.richDetails.vault!;

describe("ended quests are counted by how they ended", () => {
  const at = vault.quest.updatedAt;
  const ended = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...vault.quest, id: `r${i}`, short: `R ${i}`, title: `Returned ${i}`, phase: "done" as const, endedAt: at - i })),
    ...Array.from({ length: 5 }, (_, i) => ({ ...vault.quest, id: `s${i}`, short: `S ${i}`, title: `Stopped ${i}`, phase: "stopped" as const, endedAt: at - 10 - i })),
  ];
  const room: Room = { ...scenes.richRoom, keepers: [{ ...scenes.richRoom.keepers[0]!, boardQuests: ended }, { ...scenes.richRoom.keepers[1]!, boardQuests: scenes.richRoom.keepers[1]!.boardQuests.filter((q) => q.phase !== "done" && q.phase !== "stopped") }] };
  it("words them apart", () => {
    expect(endedCounts(ended)).toMatchObject({ returned: 4, stopped: 5, words: "4 returned · 5 stopped", heading: "Returned and stopped" });
    expect(endedCounts(ended.slice(0, 4)).words).toBe("4 returned");
    expect(endedCounts(ended.slice(4)).heading).toBe("Stopped");
  });
  it("never calls a stopped quest returned on the Returned page", async () => {
    const slot = await open("returned", room);
    const hero = await slot.findByRole("heading", { level: 1, name: /returned/ });
    expect(hero.textContent).toBe("4returned");
    expect(slot.container.querySelector(".tv-returned .tv-facts")!.textContent).toMatch(/5 stopped/);
  });
});

describe("While closed", () => {
  it("does not repeat the phase word beside the phase mark", () => {
    expect(moveAfterPhase("done", "Returned")).toBeNull();
    expect(moveAfterPhase("done", "Returned · the tale is told")).toBe("the tale is told");
    expect(moveAfterPhase("build", "Juno · building the change")).toBe("Juno · building the change");
  });
});

describe("event details never show raw ids", () => {
  const room = scenes.richRoom;
  const ctx = eventContext(room, scenes.registry);
  const quest = room.keepers[0]!.boardQuests[0]!;
  const member = quest.members[0]!;
  it("names thread, quest and waypoint ids, and keeps text without ids as it is", () => {
    const real = { ...ctx, members: new Map([["thr_juno42abc", { ...member, threadId: "thr_juno42abc" }]]), questShort: (id: string) => id === "quest_c4151d86-1feb" ? quest.short : null };
    const named = namedDetail("Verified maker thr_juno42abc for board quest quest_c4151d86-1feb, waypoint w1.", quest.id, real)!;
    expect(named).not.toMatch(/thr_|quest_|\bw1\b/);
    expect(named).toContain(quest.short);
    expect(named).toContain(quest.waypoints.find((w) => w.id === "w1")!.title);
    const plain = "A long plain detail. It has two sentences and no ids at all, so it stays whole.";
    expect(namedDetail(plain, quest.id, ctx)).toBe(plain);
  });
  it("drops the detail, keeping the head, when an id has no name", () => {
    expect(namedDetail("Blocked git push for thr_nobody99 on quest_c4151d86-1feb.", quest.id, ctx)).toBeNull();
  });
});
