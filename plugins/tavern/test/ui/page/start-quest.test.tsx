import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { START_CAP, startRows } from "../../../src/ui/page/start-quest";
import { takeArmedClass } from "../../../src/ui/kit/remember";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const NOW = Date.now();

/** n active Keepers, the most recent last, names repeating, plus one archived Keeper that was active a moment ago. */
function roomWith(n: number): Room {
  const base = scenes.richRoom.keepers[0]!;
  const keeper = (i: number, archived = false) => ({ ...base, boardQuests: i === 0 ? base.boardQuests : [], errands: [], archived, status: (["busy", "listening", "holding"] as const)[i % 3], quietSince: null, threadTitle: `Thread ${i}`, threadCreatedAt: NOW - i * 86_400_000, member: { ...base.member, threadId: `thr-k${i}${archived ? "a" : ""}`, characterId: i % 2 ? "moss" : "wren", lastActiveAt: NOW - (archived ? 1 : (n - i) * 60_000) } });
  return { ...scenes.richRoom, keepers: [...Array.from({ length: n }, (_, i) => keeper(i)), keeper(99, true)] };
}

async function menuButton(slot: RenderedSlot) {
  await waitFor(() => expect(slot.getByRole("button", { name: /Start a quest/ }).getAttribute("aria-haspopup")).toBe("menu"), { timeout: 5000 });
  return slot.getByRole("button", { name: /Start a quest/ });
}

async function header(room: Room, subPath = "") {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot({ component: plugin.navPanels[0]!.headerContent! }, { subPath }, {
    pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room) } as Partial<Handlers> as Handlers,
    composer: { text: "", scope: { kind: "new-thread", projectId: "p1" } }, context: { projectId: "p1", threadId: null },
  });
  slots.push(slot);
  return slot;
}

describe("the Start a quest rows", () => {
  it("lists active Keepers only, most recently active first, at most eight, with the thread title only where names repeat", () => {
    const { rows, more } = startRows(roomWith(10), scenes.registry);
    expect(rows).toHaveLength(START_CAP);
    expect(more).toBe(2);
    expect(rows.map((r) => r.threadId)).toEqual(["thr-k9", "thr-k8", "thr-k7", "thr-k6", "thr-k5", "thr-k4", "thr-k3", "thr-k2"]);
    expect(rows.some((r) => r.threadId.endsWith("a"))).toBe(false);
    expect(rows.every((r) => r.second?.startsWith("Thread "))).toBe(true);
    const single = startRows(roomWith(2), scenes.registry).rows;
    expect(single.map((r) => r.second)).toEqual([null, null]);
    expect(single.find((r) => r.threadId === "thr-k0")!.quest).not.toBe("no quest");
    expect(single.find((r) => r.threadId === "thr-k1")!.quest).toBe("no quest");
  });
});

describe("the header's Start a quest menu", () => {
  it("is an outlined menu button, and the header has no filled button or pin", async () => {
    const slot = await header(roomWith(3));
    const button = await menuButton(slot);
    expect(button.classList.contains("btn")).toBe(true);
    expect(slot.container.querySelector(".btn.pri")).toBeNull();
    expect(slot.container.textContent).not.toMatch(/Pin a quest/);
  });
  it("arms the Keeper's thread, then opens it, and sends nothing", async () => {
    const slot = await header(roomWith(3));
    const button = await menuButton(slot);
    fireEvent.click(button);
    const menu = await slot.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual([
      "Wren (Thread 2): no quest, holding", "Moss: no quest, idle", expect.stringMatching(/^Wren \(Thread 0\): .+, busy$/), "All Keepers", "New Keeper…",
    ]);
    expect(items[0]!.title).toBe("Opens Wren's thread, ready to start a quest");
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    fireEvent.click(items[1]!);
    const armed = JSON.parse(window.localStorage.getItem("tavern:armed-quest:v1")!);
    expect(armed.threadId).toBe("thr-k1");
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr-k1" }]);
    expect(slot.inspection.composer.submits).toHaveLength(0);
    expect(slot.inspection.composer.text).toBe("");
  });
  it("goes straight to a new Keeper when every Keeper's thread is archived", async () => {
    const slot = await header({ ...roomWith(0) });
    const button = await slot.findByRole("button", { name: /Start a quest: new Keeper/ });
    expect(button.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "p1", focusPrompt: true } }));
    expect(window.localStorage.getItem("tavern:armed-quest:v1")).toBeNull();
  });
  it("opens the common room from All Keepers and returns focus to the button on Escape", async () => {
    const slot = await header(roomWith(9));
    const button = await menuButton(slot);
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = await slot.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "All Keepers, 1 more" })).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "All Keepers, 1 more" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "room" } });
  });
});

describe("the menu's two links (live bug: both looked dead)", () => {
  async function roomPage(room: Room) {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await slot.findByRole("heading", { name: /The quest board/ });
    return slot;
  }
  it("New Keeper opens bb's composer at once, with the Keeper pill, and never sets pickers from the page", async () => {
    const slot = await header(roomWith(2));
    fireEvent.click(await menuButton(slot));
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "New Keeper…" }));
    // Synchronously: a page surface's setSelection rejects in bb, so nothing may stand between the click and the navigation.
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "p1", focusPrompt: true } });
    expect(slot.inspection.composer.selections).toEqual([]);
    expect(takeArmedClass("keeper")).toBe(true);
    await waitFor(() => expect(slot.inspection.composer.text).toMatch(/^Keeper /));
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("All Keepers on the common room jumps to the board and puts focus on its heading", async () => {
    const room = roomWith(2);
    await roomPage(room);
    const slot = await header(room, "room");
    fireEvent.click(await menuButton(slot));
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "All Keepers" }));
    expect(slot.inspection.navigateCalls.filter((c) => c.method === "toPluginPanel")).toEqual([]);
    await waitFor(() => expect(document.activeElement?.id).toBe("rm-board-h"));
  });
  it("All Keepers elsewhere opens the common room and lands on the board", async () => {
    const room = roomWith(2);
    const slot = await header(room, "map");
    fireEvent.click(await menuButton(slot));
    fireEvent.click(within(await slot.findByRole("menu")).getByRole("menuitem", { name: "All Keepers" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "room" } });
    await roomPage(room);
    await waitFor(() => expect(document.activeElement?.id).toBe("rm-board-h"));
  });
  it("the first night's class cards open the composer first, with the class pill, and set no pickers", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.emptyRoomScene) } as Partial<Handlers> as Handlers, composer: { text: "", scope: { kind: "new-thread", projectId: "p1" } } });
    slots.push(slot);
    const keeper = scenes.registry.classes.find((c) => c.id === "keeper")!;
    const card = await waitFor(() => { const b = [...slot.container.querySelectorAll<HTMLButtonElement>(".tv-start-cards button")].find((x) => x.textContent?.includes(keeper.label)); expect(b).toBeTruthy(); return b!; });
    fireEvent.click(card);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "p1", focusPrompt: true } });
    expect(slot.inspection.composer.selections).toEqual([]);
    await waitFor(() => expect(slot.inspection.composer.text).toMatch(new RegExp(`^${keeper.label} `)));
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("the homepage's class cards keep setting the class's pickers where a composer exists, and show a refusal", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const home = plugin.homepageSections[0]!;
    const slot = renderSlot(home as never, {} as never, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.emptyRoomScene) } as Partial<Handlers> as Handlers, composer: { text: "", scope: { kind: "new-thread", projectId: "p1" } } });
    slots.push(slot);
    const keeper = scenes.registry.classes.find((c) => c.id === "keeper")!;
    const card = await waitFor(() => { const b = [...slot.container.querySelectorAll<HTMLButtonElement>(".tv-start-cards button")].find((x) => x.textContent?.includes(keeper.label)); expect(b).toBeTruthy(); return b!; });
    fireEvent.click(card);
    await waitFor(() => expect(slot.inspection.composer.selections.length).toBe(1));
    expect(slot.inspection.navigateCalls.filter((c) => c.method === "toCompose")).toEqual([]);
    expect(slot.inspection.composer.text).toMatch(new RegExp(`^${keeper.label} `));
  });

});

