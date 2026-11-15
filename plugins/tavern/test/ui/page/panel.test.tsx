import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const KEY = "tavern:panel-state:v1";
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? "null") as { path: string; scroll: Record<string, number>; ui: Record<string, unknown> } | null;
const store = (state: { path?: string; scroll?: Record<string, number>; ui?: Record<string, unknown> }) => window.localStorage.setItem(KEY, JSON.stringify({ v: 1, path: "", scroll: {}, ui: {}, ...state }));
const base = (room: Room = scenes.richRoom): Partial<Handlers> => ({
  room: () => structuredClone(room), registry: () => structuredClone(scenes.registry), boardQuest: ({ id }) => structuredClone(scenes.richDetails[id] ?? scenes.richDetails["vault"]!),
});
async function page(subPath: string, rpc: Partial<Handlers> = {}, room?: Room) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { ...base(room), ...rpc } as Handlers });
  slots.push(slot); return slot;
}
const panelMoves = (slot: RenderedSlot) => slot.inspection.navigateCalls.filter((c) => c.method === "toPluginPanel");

describe("the panel remembers where you were", () => {
  it("reopens the last page when bb opens the panel at its root, replacing the history entry", async () => {
    const first = await page("map");
    await first.findByRole("group", { name: "Focus on a quest" });
    expect(stored()?.path).toBe("map");
    first.lifecycle.unmount();
    const again = await page("");
    await waitFor(() => expect(panelMoves(again)).toEqual([{ method: "toPluginPanel", path: "tavern", options: { subPath: "map", replace: true } }]));
    expect(again.getByRole("status").textContent).toContain("Opening where you left off");
  });

  it("lets an explicit link win over the remembered page", async () => {
    store({ path: "map" });
    const slot = await page("quest/vault");
    await slot.findAllByText(/Vault cutover/);
    expect(panelMoves(slot)).toEqual([]);
    await waitFor(() => expect(stored()?.path).toBe("quest/vault"));
  });

  it("falls back to the common room, with no error, when the remembered quest went to the cellar or is gone", async () => {
    for (const [path, room] of [["quest/gone", scenes.richRoom], ["quest/audit", { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === "audit" ? { ...q, archivedAt: scenes.min(5) } : q) })) }], ["character/nobody", scenes.richRoom]] as const) {
      window.localStorage.clear();
      store({ path });
      const slot = await page("", {}, room);
      await slot.findByRole("group", { name: "Filter events" });
      expect(panelMoves(slot)).toEqual([]);
      expect(slot.queryByRole("alert")).toBeNull();
      expect(stored()?.path).toBe("room");
      slot.lifecycle.unmount();
    }
  });

  it("brings back the filters and folds you left, and ignores a stored value that no longer fits", async () => {
    const first = await page("");
    const filter = await first.findByRole("group", { name: "Filter events" });
    fireEvent.click(within(filter).getByRole("button", { name: /^Asks/ }));
    expect(within(filter).getByRole("button", { name: /^Asks/ }).getAttribute("aria-pressed")).toBe("true");
    first.lifecycle.unmount();
    const again = await page("room");
    const restored = await again.findByRole("group", { name: "Filter events" });
    expect(within(restored).getByRole("button", { name: /^Asks/ }).getAttribute("aria-pressed")).toBe("true");
    again.lifecycle.unmount();
    store({ path: "room", ui: { "room.events.filter": "no-such-filter" } });
    const stale = await page("room");
    const reset = await stale.findByRole("group", { name: "Filter events" });
    expect(within(reset).getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves each page's scroll position and puts it back", async () => {
    const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get(this: HTMLElement & { _st?: number }) { return this._st ?? 0; }, set(this: HTMLElement & { _st?: number }, v: number) { this._st = v; } });
    try {
      store({ path: "map", scroll: { map: 320 } });
      const slot = await page("map");
      await slot.findByRole("group", { name: "Focus on a quest" });
      const main = slot.container.querySelector<HTMLElement & { _st?: number }>(".tv-page-root")!;
      await waitFor(() => expect(main._st).toBe(320));
      main._st = 540;
      fireEvent.scroll(main);
      await waitFor(() => expect(stored()?.scroll.map).toBe(540));
    } finally {
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      if (own) Object.defineProperty(Element.prototype, "scrollTop", own);
    }
  });
});

describe("Decided for you: OK and Mark all seen", () => {
  it("marks one decision seen, undoes it by token, and marks the rest by the ids on screen", async () => {
    const seen = vi.fn((input: { ids: string[] } | { all: true; keeperThreadId?: string; throughId?: string | null }) => ({ ok: true as const, ids: "ids" in input ? input.ids : [], undoToken: "tok-1" }));
    const unseen = vi.fn((_input: { undoToken: string }) => ({ ok: true as const, ids: ["d1"] }));
    const slot = await page("room", { markDecisionsSeen: seen, markDecisionsUnseen: unseen });
    fireEvent.click(await slot.findByRole("button", { name: "Mark seen: vault-saturn ships in the first PR" }));
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ ids: ["d1"] }));
    const receipt = (await slot.findByText(/Marked 1 seen/)).closest("p")!;
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(receipt).getByRole("button", { name: /^Undo/ }));
    await waitFor(() => expect(unseen).toHaveBeenCalledWith({ undoToken: "tok-1" }));
    fireEvent.click(await slot.findByRole("button", { name: /^Mark all seen/ }));
    const ids = scenes.richRoom.decidedForYou.map((d) => d.id);
    await waitFor(() => expect(seen).toHaveBeenLastCalledWith({ ids }));
  });

  it("marks through the room's watermark, for every Keeper, when the list is cut off", async () => {
    const clipped = { ...scenes.richRoom, decidedCount: 140, decidedThroughId: "d3" };
    const seen = vi.fn((_input: unknown) => ({ ok: true as const, ids: ["d1", "d2", "d3"], undoToken: "tok-2" }));
    const slot = await page("room", { markDecisionsSeen: seen as never }, clipped);
    expect((await slot.findByLabelText("140 decisions")).textContent).toBe("140");
    fireEvent.click(slot.getByRole("button", { name: /^Mark all seen/ }));
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ all: true, throughId: "d3" }));
  });
});

describe("the quest page's decision history", () => {
  it("pages older decisions in place through decisionHistory", async () => {
    const detail = structuredClone(scenes.richDetails["vault"]!);
    detail.decisionsNextCursor = "c1";
    detail.decisionsTotal = detail.decisions.length + 1;
    const older = { ...detail.decisions[0]!, id: "d-old", text: "Keep the old cookie name for a week", createdAt: scenes.min(900) };
    const history = vi.fn((_input: { keeperThreadId: string; boardQuestId?: string; cursor?: string | null; limit?: number }) => ({ decisions: [older], nextCursor: null, total: detail.decisionsTotal! }));
    const slot = await page("quest/vault", { boardQuest: () => structuredClone(detail), decisionHistory: history });
    fireEvent.click(await slot.findByRole("button", { name: "Show older decisions" }));
    expect(await slot.findByText("Keep the old cookie name for a week")).toBeTruthy();
    expect(history).toHaveBeenCalledWith({ keeperThreadId: "thr-wren", boardQuestId: "vault", cursor: "c1", limit: 100 });
    expect(slot.queryByRole("button", { name: "Show older decisions" })).toBeNull();
  });
});

describe("the map: Returned, the Quests picker and Clear filters", () => {
  const shared = (): Room => {
    const room = structuredClone(scenes.richRoom);
    const audit = room.keepers[0]!.boardQuests.find((q) => q.id === "audit")!;
    audit.members = [...audit.members, { ...scenes.juno, boardQuestId: "audit" }];
    return room;
  };
  const node = (slot: RenderedSlot, id: string) => slot.container.querySelector(`[data-node="${id}"]`);

  it("draws returned quests by default, hides them with Returned off, and never draws the cellar", async () => {
    const slot = await page("map");
    await slot.findByRole("group", { name: "Focus on a quest" });
    expect(node(slot, "returned:sfe")).toBeTruthy();
    const toggle = within(slot.getByRole("group", { name: "Returned quests on the map" })).getByRole("button", { name: /^Returned/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(node(slot, "returned:sfe")).toBeNull();
    expect(slot.getByText("3 of 4 quests · 1 hidden")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
    expect(node(slot, "returned:sfe")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Clear filters" })).toBeNull();
    slot.lifecycle.unmount();
    const cellared = { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === "sfe" ? { ...q, archivedAt: scenes.min(2) } : q) })) };
    const later = await page("map", {}, cellared);
    await later.findByRole("group", { name: "Focus on a quest" });
    expect(node(later, "returned:sfe")).toBeNull();
  });

  it("leaves out an unchecked quest and the members only on it, keeps shared members, and shows it again on focus", async () => {
    const slot = await page("map", {}, shared());
    fireEvent.click(await slot.findByRole("button", { name: /^Quests/ }));
    const picker = slot.getByRole("group", { name: "Quests the map draws" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: /shopifycloud.com audit/ }));
    expect(slot.getByText("3 of 4 quests · 1 hidden")).toBeTruthy();
    expect(slot.queryByRole("button", { name: /^Open Lark's thread/ })).toBeNull();
    expect(slot.getByRole("button", { name: /^Open Juno's thread/ })).toBeTruthy();
    expect(node(slot, "quest:audit")).toBeNull();
    fireEvent.click(within(slot.getByRole("group", { name: "Focus on a quest" })).getByRole("button", { name: /^Focus on shopifycloud.com audit/ }));
    expect((within(picker).getByRole("checkbox", { name: /shopifycloud.com audit/ }) as HTMLInputElement).checked).toBe(true);
    expect(node(slot, "quest:audit")).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: "Only this one: Vault cutover" }));
    expect(slot.getByText("1 of 4 quests · 3 hidden")).toBeTruthy();
    expect(node(slot, "quest:audit")).toBeNull();
    expect(node(slot, "returned:sfe")).toBeNull();
  });

  it("remembers the choice, shows new quests by default and drops quests that left", async () => {
    store({ path: "map", ui: { "map.hidden": ["audit", "gone"], "map.picker": true } });
    const slot = await page("map");
    const picker = await slot.findByRole("group", { name: "Quests the map draws" });
    expect((within(picker).getByRole("checkbox", { name: /shopifycloud.com audit/ }) as HTMLInputElement).checked).toBe(false);
    expect((within(picker).getByRole("checkbox", { name: /Rollout batching/ }) as HTMLInputElement).checked).toBe(true);
    expect(slot.getByText("3 of 4 quests · 1 hidden")).toBeTruthy();
  });

  it("exports what is on screen and says so in the title", async () => {
    store({ path: "map", ui: { "map.hidden": ["audit"] } });
    const slot = await page("map");
    await slot.findByRole("group", { name: "Focus on a quest" });
    fireEvent.click(slot.getByRole("button", { name: "Export" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Copy as text outline (Markdown)" }));
    await slot.findByText("Copied the map as a Markdown outline");
    const write = slot.inspection.experimental_clipboardWrites.at(-1)!;
    expect(write.text).toMatch(/^# Tavern · the map · Vault cutover · showing 3 of 4 quests/);
    expect(write.text).not.toMatch(/shopifycloud\.com audit/);
  });
});
