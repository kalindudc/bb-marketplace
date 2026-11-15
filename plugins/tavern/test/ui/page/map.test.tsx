import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roomSchema, rpcContract } from "../../../src/shared/contract";
import { keeperStatus } from "../../../src/ui/kit";
import { fitColumns, waitingWords } from "../../../src/ui/page/connections";
import { detail, room as fixtureRoom } from "../../../src/ui/page/fixtures";
import { graphFor } from "../../../src/ui/page/model";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import liveRoomJson from "./live-room-archived.json";
import { registry } from "./scenes";

// The user's room on 14 November: nine Keepers, eight of them in archived threads, every one with status "listening".
const live = roomSchema.parse(liveRoomJson);
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); vi.unstubAllGlobals(); });
// jsdom has no ResizeObserver; tests that give the map window a size need one that does nothing.
const sizedWindow = () => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
beforeEach(() => { window.localStorage.clear(); sizedWindow(); });
async function map(data: typeof live = live) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "map" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { room: () => structuredClone(data), registry: () => structuredClone(registry), archivedBoardQuests: () => ({ boardQuests: [], nextCursor: null, total: 0 }) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { name: "Everyone on the map" });
  return slot;
}
const list = (slot: RenderedSlot) => slot.getByRole("region", { name: /Everyone on the map/ });

describe("The map's Keepers", () => {
  it("gives every Keeper node the room's status word, so archived threads never read as listening", () => {
    const nodes = graphFor(live, registry).nodes.filter((n) => n.kind === "keeper");
    expect(nodes.map((n) => n.detail)).toEqual(live.keepers.map((k) => keeperStatus(k).word));
    expect(nodes.filter((n) => n.detail === "thread archived")).toHaveLength(8);
  });

  it("names nodes with the shared member name: a member with no character shows its class, never an id or a blank", () => {
    const room = structuredClone(fixtureRoom) as typeof live;
    const quest = room.keepers[0]!.boardQuests.find((q) => q.members.length)!;
    const member = quest.members[0]!;
    (member as { characterId: string | null }).characterId = null;
    (member as { displayName?: string | null }).displayName = null;
    const known = room.keepers[0]!.member;
    const nodes = graphFor(room, registry).nodes;
    const unnamed = nodes.find((n) => n.id === `member:${member.threadId}`)!;
    expect(unnamed.label).toBe(registry.classes.find((c) => c.id === member.classId)!.label);
    const keeper = nodes.find((n) => n.id === `keeper:${known.threadId}`)!;
    expect(keeper.label).toBe(registry.characters.find((c) => c.id === known.characterId)?.name ?? known.characterId);
    expect(nodes.every((n) => n.label && n.label !== "null")).toBe(true);
  });

  it("draws archived Keepers in the picture as thread archived", async () => {
    const slot = await map();
    const picture = slot.container.querySelector(".tv-mappic") as HTMLElement;
    expect(within(picture).getAllByText("Thread archived")).toHaveLength(8);
    const word = keeperStatus(live.keepers[0]!).word;
    expect(within(picture).getAllByText(word.charAt(0).toUpperCase() + word.slice(1))).toHaveLength(1);
  });

  it("lists a Keeper with the kit's mark and word, and counts its live and ended quests", async () => {
    const slot = await map();
    const row = within(list(slot)).getByRole("button", { name: /^Open Wren's thread\. Wren · no live quest · 2 returned\./ });
    expect(row.querySelector(".tv-st")!.className).toContain(`tv-st-${keeperStatus(live.keepers[0]!).tone}`);
    expect(row.querySelector(".tv-mrow-t > span")!.textContent).toMatch(new RegExp(`^${keeperStatus(live.keepers[0]!).word} · `));
    expect(list(slot).textContent).not.toMatch(/0 quests/);
    expect(list(slot).querySelectorAll(".tv-st-keeper")).toHaveLength(0);
  });

  it("explains a Keeper's state on hover with the kit's words, as KeeperRow does", async () => {
    const slot = await map();
    const row = within(list(slot)).getByRole("button", { name: /^Open Wren's thread\. Wren · no live quest · 2 returned\./ });
    const s = keeperStatus(live.keepers[0]!);
    expect(row.querySelector(".tv-st")!.getAttribute("title")).toBe(`${s.label}: ${s.hint}`);
  });

  it("folds archived Keepers behind one remembered line that opens in place", async () => {
    const slot = await map();
    const fold = within(list(slot)).getByRole("button", { name: "8 archived Keepers" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(within(list(slot)).queryByText(/thread archived/)).toBeNull();
    fireEvent.click(fold);
    await waitFor(() => expect(within(list(slot)).getAllByText(/^thread archived · /)).toHaveLength(8));
    const archived = list(slot).querySelectorAll(".tv-st-archived");
    expect(archived).toHaveLength(8);
    expect(within(list(slot)).getByRole("button", { name: /^Open Moss's thread\. Moss · no live quest · 1 stopped\./ })).toBeTruthy();
    slots.splice(0).forEach((s) => s.lifecycle.unmount());
    const again = await map();
    expect(within(list(again)).getByRole("button", { name: "8 archived Keepers" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("names Keepers that share a name by their thread title, then by start time when the titles repeat too", async () => {
    const slot = await map();
    fireEvent.click(within(list(slot)).getByRole("button", { name: "8 archived Keepers" }));
    const wren = within(list(slot)).getByRole("button", { name: /^Open Wren's thread\. Wren · no live quest · 2 returned\./ });
    expect(wren.querySelector(".tv-mrow-t > span")!.textContent).toBe(`${keeperStatus(live.keepers[0]!).word} · Find plugins missing from README table · Keeper (lead)`);
    const twins = within(list(slot)).getAllByRole("button", { name: /thread archived · started .+ · List functions with test counts · Keeper/ });
    expect(twins).toHaveLength(2);
    const moss = within(list(slot)).getByRole("button", { name: /^Open Moss's thread/ });
    expect(moss.textContent).not.toContain("List exported functions");
  });
});

describe("The map's layout", () => {
  it("narrows the columns to fit a phone's window when that keeps them readable, and pans otherwise", () => {
    const natural = [162, 198, 238, 174];
    expect(fitColumns(natural, [0, 1], 730)).toEqual(natural);
    const phone = fitColumns(natural, [0, 1], 340);
    expect(12 * 2 + phone[0]! + phone[1]! + 36).toBeLessThanOrEqual(340);
    expect(Math.min(phone[0]!, phone[1]!)).toBeGreaterThanOrEqual(120);
    expect(fitColumns(natural, [0, 1, 2, 3], 340)).toEqual(natural);
    // A big map in a wide window keeps its natural widths and pans, as before.
    expect(fitColumns(natural, [0, 1, 2, 3], 706)).toEqual(natural);
  });

  it("lets a squeezed node's state wrap to a second line instead of cutting it", async () => {
    // A phone's map window: 364 px, where the user's two columns are squeezed to fit.
    sizedWindow();
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("tv-mv-box") ? 364 : 0; });
    try {
      const slot = await map();
      const picture = slot.container.querySelector(".tv-mappic") as HTMLElement;
      await waitFor(() => expect(picture.querySelectorAll(".tv-mn.tall")).toHaveLength(picture.querySelectorAll(".tv-mn").length));
      const nodes = [...picture.querySelectorAll<HTMLElement>(".tv-mn.k-keeper")];
      expect(nodes.filter((n) => n.querySelector(".tv-mn-t > span")!.textContent === "Thread archived")).toHaveLength(8);
      const tops = nodes.map((n) => parseFloat(n.style.top)).sort((a, b) => a - b), height = parseFloat(nodes[0]!.style.height);
      expect(tops.slice(1).every((t, i) => t - tops[i]! >= height + 12)).toBe(true);
    } finally { width.mockRestore(); }
  });

  it("never opens below 100%, so text is drawn at its own size, even when the map almost fits", async () => {
    // The user's room in a 1400 x 1200 window: the picture is 904 px tall in an 863 px window, which used to open at 93%.
    const size = (dim: "clientWidth" | "clientHeight", px: number) => vi.spyOn(HTMLElement.prototype, dim, "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("tv-mv-box") ? px : 0; });
    sizedWindow();
    const spies = [size("clientWidth", 730), size("clientHeight", 863)];
    try {
      const slot = await map();
      const view = await slot.findByRole("toolbar", { name: "Map view" });
      await waitFor(() => expect(within(view).getByRole("button", { name: /^Zoom \d+%/ }).textContent).toBe("100%"));
    } finally { for (const s of spies) s.mockRestore(); }
  });

  it("puts the empty-board note above the window, never over the picture", async () => {
    const slot = await map();
    const note = slot.getByText("No active quests.").closest(".tv-mv-note")!;
    expect(note.closest(".tv-mv-box")).toBeNull();
  });
});

describe("The map's header with many quests", () => {
  it("counts who the quests wait on once each, you first", () => {
    expect(waitingWords(12, ["Luc", "#vault-releases", "Luc", "SRE on call", "Luc", "#vault-releases"])).toBe("you 12 · Luc 3 · #vault-releases 2 · SRE on call");
    expect(waitingWords(0, ["Luc"])).toBe("Luc");
    expect(waitingWords(0, [])).toBe("");
  });

  it("shows a few quests to focus on and the rest in a menu, so the map stays on the first screen", async () => {
    const many = structuredClone(fixtureRoom);
    many.keepers[0]!.boardQuests = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(detail.quest), id: i === 0 ? "vault" : `q${i}`, short: `Quest ${i + 1}`, title: `Quest number ${i + 1}` }));
    const slot = await map(many as typeof live);
    const group = await slot.findByRole("group", { name: "Focus on a quest" });
    expect(within(group).getAllByRole("button").length).toBeLessThanOrEqual(6);
    const more = within(group).getByRole("combobox", { name: "Focus on another quest" }) as HTMLSelectElement;
    expect([...more.options].filter((o) => o.value)).toHaveLength(12 - within(group).getAllByRole("button").length);
    fireEvent.change(more, { target: { value: "q10" } });
    await waitFor(() => expect(within(group).getByRole("button", { name: /^Focus on Quest number 11/ }).getAttribute("aria-pressed")).toBe("true"));
  });
});
