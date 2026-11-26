import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot, withAttention } from "../attention-fixture";
import { waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { SKELETON_DELAY_MS, readRemembered, rememberCount, writeRemembered } from "../../../src/ui/kit";
import { TavernSidebar, registerPageSurfaces } from "../../../src/ui/page/register";
import { SKEL } from "../../../src/ui/page/skeletons";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

/** An RPC answer released by hand, so the loading state can be looked at before and after the kit's delay. */
function gate<T>() {
  let release!: (v: T) => void, fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { release = res; fail = rej; });
  return { handler: () => promise, release, fail };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const region = (slot: RenderedSlot) => slot.container.querySelector<HTMLElement>(".sk-region");

/** The state each skeleton region had when it was first inserted, so "held before the delay" holds however slow the machine is. */
const firstStates = new WeakMap<Element, string | undefined>();
const watch = new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) for (const el of [n, ...n.querySelectorAll(".sk-region")]) if (el.classList.contains("sk-region") && !firstStates.has(el)) firstStates.set(el, (el as HTMLElement).dataset.skeleton); });
watch.observe(document.body, { childList: true, subtree: true });
async function page(subPath: string, rpc: Partial<Handlers>) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), boardQuest: () => structuredClone(scenes.richDetails.vault!), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
/** Held and hidden before the delay, then shown, busy, named, and holding no text or focus of its own. */
async function expectTiming(slot: RenderedSlot, label: string) {
  await waitFor(() => expect(region(slot)).not.toBeNull());
  await Promise.resolve();
  expect(firstStates.get(region(slot)!) ?? region(slot)!.dataset.skeleton).toBe("held");
  expect(region(slot)!.getAttribute("aria-busy")).toBe("true");
  await sleep(SKELETON_DELAY_MS + 40);
  await waitFor(() => expect(region(slot)!.dataset.skeleton).toBe("shown"));
  expect(region(slot)!.querySelector("[role=status]")!.textContent).toBe(`Loading ${label}`);
  const shapes = region(slot)!.querySelector(".sk")!;
  expect(shapes.getAttribute("aria-hidden")).toBe("true");
  expect(shapes.textContent).toBe("");
  expect(shapes.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
  return shapes;
}

describe("the common room's skeleton", () => {
  it("shows nothing before 150 ms, then the room's layout with the notices and rows last seen here, then swaps to the room", async () => {
    rememberCount(SKEL.notices, 3); rememberCount(SKEL.decided, 4); rememberCount(SKEL.asks, 2);
    const room = gate<Room>();
    const slot = await page("room", { room: room.handler });
    const shapes = await expectTiming(slot, "the common room");
    expect(shapes.querySelectorAll(".rm-board .rm-notice")).toHaveLength(3);
    expect(shapes.querySelectorAll(".decided .di")).toHaveLength(4);
    expect(shapes.querySelectorAll(".tv-queue .sk-askrow")).toHaveLength(2);
    expect(shapes.querySelector(".rm-a-grid > .rm-a-rail")).toBeTruthy();
    room.release(structuredClone(scenes.richRoom));
    await waitFor(() => expect(region(slot)).toBeNull());
    expect(slot.getByRole("group", { name: "Status" })).toBeTruthy();
  });
  it("remembers what the room showed, for the next load on this device", async () => {
    const slot = await page("room", {});
    await slot.findByRole("group", { name: "Status" });
    await waitFor(() => expect(readRemembered<number>(SKEL.notices)).toBeGreaterThan(0));
  });
  it("gives way to today's error line with Retry when the room cannot load", async () => {
    const room = gate<Room>();
    const slot = await page("room", { room: room.handler });
    await waitFor(() => expect(region(slot)).not.toBeNull());
    room.fail(new Error("server down"));
    await slot.findByText(/server down/, undefined, { timeout: 5000 });
    expect(region(slot)).toBeNull();
    expect(slot.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
  it("never mounts over a room already on screen when it refreshes", async () => {
    let calls = 0;
    const later = gate<Room>();
    const slot = await page("room", { room: () => (++calls === 1 ? structuredClone(scenes.richRoom) : later.handler()) });
    await slot.findByRole("group", { name: "Status" });
    const seen: boolean[] = [];
    const watch = new MutationObserver(() => seen.push(!!region(slot)));
    watch.observe(slot.container, { childList: true, subtree: true });
    void slot.experimental_invalidateRpc(null);
    await sleep(SKELETON_DELAY_MS + 60);
    later.release(structuredClone(scenes.richRoom));
    await sleep(50);
    watch.disconnect();
    expect(seen.includes(true)).toBe(false);
    expect(region(slot)).toBeNull();
  });
});

describe("the quest route's skeleton", () => {
  it("before the room loads, draws the record's shape for a quest this device last saw ended", async () => {
    rememberCount(SKEL.finished("vault"), 1);
    const slot = await page("quest/vault", { room: gate<Room>().handler, registry: gate<typeof scenes.registry>().handler });
    const shapes = await expectTiming(slot, "the quest");
    expect(shapes.querySelector(".tv-record")).toBeTruthy();
  });
  it("draws the record's shape for a quest the room says has ended, and the live page's otherwise", async () => {
    const done = { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map((k, i) => i ? k : { ...k, boardQuests: k.boardQuests.map((q) => q.id === "vault" ? { ...q, phase: "stopped" as const } : q) }) };
    const detail = gate<typeof scenes.richDetails.vault>();
    const slot = await page("quest/vault", { room: () => structuredClone(done), boardQuest: detail.handler });
    const shapes = await expectTiming(slot, "the quest");
    expect(shapes.querySelector(".tv-record .tv-rec-story")).toBeTruthy();
    const live = await page("quest/vault", { boardQuest: gate<typeof scenes.richDetails.vault>().handler });
    const liveShapes = await expectTiming(live, "the quest");
    expect(liveShapes.querySelector(".tv-ghead")).toBeTruthy();
    expect(liveShapes.querySelector(".tv-record")).toBeNull();
  });
});

describe("the remembered shape", () => {
  const box = (w: number, h: number) => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
  it("holds each block of a record at the height it last had at this width, and leaves out a note the surface didn't have", async () => {
    writeRemembered(SKEL.shape("tale:readme"), [{ w: 800, h: { "/tv-sline": 40, "/tv-tale": 832.4, "/tv-tale/tv-tale-lead": 123.8, "/tv-tale/tv-credits-w": 203.5 } }]);
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => box(806, 0));
    try {
      const slot = await page("tale/readme", { boardQuest: gate<typeof scenes.richDetails.vault>().handler });
      await waitFor(() => expect(region(slot)).not.toBeNull());
      const tale = region(slot)!.querySelector<HTMLElement>(".sk .tv-tale")!;
      expect(tale.style.height).toBe("832.4px");
      expect(tale.querySelector<HTMLElement>(".tv-tale-lead")!.style.height).toBe("123.8px");
      expect(tale.querySelector<HTMLElement>(".tv-credits-w")!.style.height).toBe("203.5px");
      expect(tale.querySelector<HTMLElement>("[data-sk-optional]")!.style.display).toBe("none");
    } finally { rect.mockRestore(); }
  });
  it("draws its own shapes at a width it has not seen", async () => {
    writeRemembered(SKEL.shape("tale:readme"), [{ w: 1200, h: { "/tv-tale": 832.4 } }]);
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => box(800, 0));
    try {
      const slot = await page("tale/readme", { boardQuest: gate<typeof scenes.richDetails.vault>().handler });
      await waitFor(() => expect(region(slot)).not.toBeNull());
      expect(region(slot)!.querySelector<HTMLElement>(".sk .tv-tale")!.style.height).toBe("");
    } finally { rect.mockRestore(); }
  });
});

describe("the other reads", () => {
  it("draws the sidebar's quests while the room loads, and no 'Loading Tavern…' line", async () => {
    const slot = renderSlot({ component: TavernSidebar }, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: gate<Room>().handler } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await waitFor(() => expect(region(slot)).not.toBeNull());
    expect(slot.container.textContent).not.toContain("Loading Tavern");
    expect(slot.getByText("The tavern")).toBeTruthy();
  });
  it("gives the character sheets their page's shape while the registry loads", async () => {
    const slot = await page("characters", { registry: gate<typeof scenes.registry>().handler });
    const shapes = await expectTiming(slot, "the character sheets");
    expect(shapes.querySelector(".tv-sheets .tv-chars")).toBeTruthy();
  });
});

describe("nothing grows after the first paint", () => {
  it("opens the oldest ask in a wide window on the first render, not in an effect after it", async () => {
    const media = vi.fn((query: string) => ({ matches: query === "(min-width: 1200px)", addEventListener() {}, removeEventListener() {} }));
    const was = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: media });
    try {
      const { NeedsYouQueue } = await import("../../../src/ui/page/asks");
      // A layout effect runs at the first commit, before any passive effect, so it sees what the first paint will show.
      let atFirstCommit: boolean | undefined;
      const Probe = () => { useLayoutEffect(() => { atFirstCommit = document.querySelector<HTMLDetailsElement>("[data-need-card=ask] .tv-need-answer")?.open; }, []); return null; };
      const slot = renderSlot({ component: () => <><NeedsYouQueue room={withAttention(scenes.richRoom)} registry={scenes.registry} /><Probe /></> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract });
      slots.push(slot);
      expect(atFirstCommit).toBe(true);
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: was }); }
  });
});

describe("the sidebar's held quests", () => {
  it.each([[120], [200], [400]])("draws only the rows its held box of %i px holds, so none reaches 'The tavern' below", async (gap) => {
    writeRemembered(SKEL.sideNav, gap);
    const slot = renderSlot({ component: TavernSidebar }, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: gate<Room>().handler } as Partial<Handlers> as Handlers });
    slots.push(slot);
    const box = await waitFor(() => { const b = slot.container.querySelector<HTMLElement>(".sk-sidenav"); expect(b).not.toBeNull(); return b!; });
    const held = parseFloat(box.style.height);
    expect(held).toBe(gap);
    // Each skeleton row stands 42 px with its gap, under a 36 px heading row.
    const rows = box.querySelectorAll(".tv-squest").length;
    expect(rows).toBeGreaterThan(0);
    expect(36 + rows * 42).toBeLessThanOrEqual(held);
  });
});
