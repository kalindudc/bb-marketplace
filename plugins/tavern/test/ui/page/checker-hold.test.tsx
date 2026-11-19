import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import type { Ask, CheckerHandoffHold, TavernEvent } from "../../../src/shared/schema";
import { clockTime } from "../../../src/ui/kit";
import { releaseWords } from "../../../src/ui/kit";
import { badgeLabel } from "../../../src/ui/page/model";
import { TavernSidebar, registerPageSurfaces, useTavernBadge } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
const LOADED = { timeout: 3000 };

const live = scenes.richDetails.vault!;
const heldAt = scenes.min(12);
const hold = (over: Partial<CheckerHandoffHold> = {}): CheckerHandoffHold => ({
  id: "hold-1", routeId: "route-1", sourceMessageId: "msg-1", createdAt: heldAt, release: null,
  sourceText: "Don't hand the vault cutover to a checker until I've looked at the drafts myself.",
  reason: "You want to read the private drafts before any Warden checks them.", ...over,
});
// With no hold the key is absent, as the server sends it: an undefined value is not JSON.
const withHold = (h: CheckerHandoffHold | undefined, extra: Partial<BoardQuestDetail> = {}): BoardQuestDetail => ({ ...structuredClone(live), ...extra, quest: { ...structuredClone(live.quest), ...(h ? { checkerHandoffHold: h } : {}) } });
const withQuest = (room: Room, quest: BoardQuestDetail["quest"]): Room => ({ ...room, keepers: room.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === quest.id ? quest : q) })) });

async function questPage(detail: BoardQuestDetail, rpc: Partial<Handlers> = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const room = withQuest(scenes.richRoom, detail.quest);
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${detail.quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), boardQuest: () => structuredClone(detail), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { level: 1, name: detail.quest.title }, LOADED);
  return slot;
}
const row = (slot: RenderedSlot) => slot.container.querySelector<HTMLElement>("[data-checker-hold]");
const releaseButton = (slot: RenderedSlot) => row(slot)?.querySelector<HTMLButtonElement>("button.tv-hold-release") ?? null;

describe("a checker-handoff hold on the quest page", () => {
  it("shows an active hold as one calm row in By whose move: what it holds, why, when and from your words, with one release control", async () => {
    const slot = await questPage(withHold(hold()));
    const el = await waitFor(() => { expect(row(slot)).not.toBeNull(); return row(slot)!; }, LOADED);
    expect(el.closest("section")!.querySelector("h2, h3")!.textContent).toContain("By whose move");
    expect(el.querySelector(".tv-hold-h")!.textContent).toBe("Checker handoff on hold");
    expect(el.textContent).toContain("No Warden is hired or re-tasked on this quest until you release it.");
    expect(el.textContent).toContain("You want to read the private drafts before any Warden checks them.");
    expect(el.querySelector(".tv-hold-src")!.textContent).toContain(`Held at ${clockTime(heldAt)}, from your message:`);
    expect(el.querySelector(".tv-hold-src")!.textContent).toContain("“Don't hand the vault cutover to a checker until I've looked at the drafts myself.”");
    expect(releaseButton(slot)!.textContent).toBe("Release checker handoff");
    // Calm: no glow and no motion class on the row.
    expect(el.closest(".lit")).toBeNull();
    expect(el.className).not.toMatch(/mo-|pulse|arrive/);
  });

  it("counts the active hold among the section's open moves", async () => {
    const without = await questPage(withHold(undefined));
    const count = (slot: RenderedSlot) => Number([...slot.container.querySelectorAll("section")].find((s) => s.querySelector("h2, h3")?.textContent?.includes("By whose move"))!.querySelector(".tv-count, .num")!.textContent!.match(/\d+/)![0]);
    const base = count(without);
    const held = await questPage(withHold(hold()));
    await waitFor(() => expect(row(held)).not.toBeNull(), LOADED);
    expect(count(held)).toBe(base + 1);
  });

  it("releases through the server and shows its answer as the receipt; nothing changes before the answer", async () => {
    const calls: unknown[] = [];
    let answer: (v: { checkerHandoffHold: CheckerHandoffHold }) => void = () => {};
    const slot = await questPage(withHold(hold()), { releaseCheckerHandoff: (input: unknown) => { calls.push(input); return new Promise((r) => { answer = r; }); } } as Partial<Handlers>);
    await waitFor(() => expect(releaseButton(slot)).not.toBeNull(), LOADED);
    fireEvent.click(releaseButton(slot)!);
    await waitFor(() => expect(calls).toEqual([{ boardQuestId: live.quest.id, holdId: "hold-1", via: "page" }]));
    expect(row(slot)!.querySelector("[role=status]")).toBeNull();
    expect(releaseButton(slot)!.disabled).toBe(true);
    const at = scenes.min(0);
    answer({ checkerHandoffHold: hold({ release: { at, via: "page", askId: null } }) });
    await waitFor(() => expect(row(slot)!.querySelector("[role=status]")?.textContent).toBe(`Checker handoff released at ${clockTime(at)}, from the Tavern page. The Keeper can hand the work to a Warden now.`), LOADED);
    expect(releaseButton(slot)).toBeNull();
  });

  it("draws a new hold that arrives after a release, with its control back, instead of the old receipt", async () => {
    let current = withHold(hold());
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${live.quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
      rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(withQuest(scenes.richRoom, current.quest)), boardQuest: () => structuredClone(current),
        releaseCheckerHandoff: () => { current = withHold(hold({ release: { at: scenes.min(0), via: "page", askId: null } })); return { checkerHandoffHold: current.quest.checkerHandoffHold! }; } } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await waitFor(() => expect(releaseButton(slot)).not.toBeNull(), LOADED);
    fireEvent.click(releaseButton(slot)!);
    await waitFor(() => expect(row(slot)!.querySelector("[role=status]")).not.toBeNull(), LOADED);
    // The user writes again and the Keeper routes a fresh hold, with a new id, while the page stays open.
    current = withHold(hold({ id: "hold-2", reason: "You asked to check the DNS plan yourself first." }));
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    await waitFor(() => expect(row(slot)?.textContent).toContain("You asked to check the DNS plan yourself first."), LOADED);
    expect(releaseButton(slot)).not.toBeNull();
    expect(row(slot)!.querySelector("[role=status]")).toBeNull();
  });

  it("says a refusal in words, such as a hold that is no longer current, and keeps the control", async () => {
    const slot = await questPage(withHold(hold()), { releaseCheckerHandoff: () => { throw new Error("This checker-handoff hold is no longer current; read the quest again"); } } as Partial<Handlers>);
    await waitFor(() => expect(releaseButton(slot)).not.toBeNull(), LOADED);
    fireEvent.click(releaseButton(slot)!);
    await waitFor(() => expect(row(slot)!.querySelector("[role=alert]")?.textContent).toMatch(/^Couldn’t release it: .*no longer current; read the quest again/), LOADED);
    expect(releaseButton(slot)!.disabled).toBe(false);
  });

  it("draws no hold and counts none on a stopping quest: the hold is active only while the quest takes work", async () => {
    const d = withHold(hold());
    const stopping = { ...d, quest: { ...d.quest, phase: "stopping" as const, stoppingSince: scenes.min(2), stopUnconfirmed: 1 } };
    const slot = await questPage(stopping);
    await waitFor(() => expect(slot.container.querySelector(".tv-stopping")).not.toBeNull(), LOADED);
    expect(row(slot)).toBeNull();
  });

  it("counts a hold and the Keeper's ask to release it once in By whose move", async () => {
    const byWhose = (slot: RenderedSlot) => Number([...slot.container.querySelectorAll("section")].find((x) => x.querySelector("h2, h3")?.textContent?.includes("By whose move"))!.querySelector(".tv-count, .num")!.textContent!.match(/\d+/)![0]);
    const ask = { ...structuredClone(live.asks.find((a) => a.state === "open") ?? live.asks[0]!), id: "ask-hold", state: "open", releaseHoldId: "hold-1", boardQuestId: live.quest.id } as Ask;
    const asked = await questPage(withHold(hold(), { asks: [...live.asks, ask] }));
    await waitFor(() => expect(row(asked)).not.toBeNull(), LOADED);
    const plain = await questPage(withHold(undefined, { asks: [...live.asks, ask] }));
    const section = (slot: RenderedSlot) => waitFor(() => expect([...slot.container.querySelectorAll("section")].some((x) => x.querySelector("h2, h3")?.textContent?.includes("By whose move"))).toBe(true), LOADED);
    await section(plain);
    // The same asks with no hold: the hold adds nothing, because its ask already counts.
    expect(byWhose(asked)).toBe(byWhose(plain));
  });

  it("names the Keeper's ask about the hold, when there is one, without claiming how answering it ends", async () => {
    const ask = { ...structuredClone(live.asks.find((a) => a.state === "open") ?? live.asks[0]!), id: "ask-hold", state: "open", releaseHoldId: "hold-1", boardQuestId: live.quest.id } as Ask;
    const slot = await questPage(withHold(hold(), { asks: [...live.asks, ask] }));
    const el = await waitFor(() => { expect(row(slot)).not.toBeNull(); return row(slot)!; }, LOADED);
    expect(el.textContent).toContain("The Keeper also asked you about it, below.");
  });

  it("draws nothing for a hold already released before this visit; the history says when and how", async () => {
    const events: TavernEvent[] = [
      { id: 901, at: scenes.min(30), keeperThreadId: live.quest.keeperThreadId, boardQuestId: live.quest.id, actor: { kind: "agent", threadId: live.quest.keeperThreadId }, type: "checker-handoff.held", text: `Checker handoff held for ${live.quest.title}`, data: { holdId: "hold-1", routeId: "route-1" } },
      { id: 902, at: scenes.min(5), keeperThreadId: live.quest.keeperThreadId, boardQuestId: live.quest.id, actor: { kind: "user" }, type: "checker-handoff.released", text: `You released the checker handoff for ${live.quest.title}`, data: { holdId: "hold-1", askId: null, via: "phone" } },
    ];
    const slot = await questPage(withHold(hold({ release: { at: scenes.min(5), via: "phone", askId: null } }), { events }));
    await slot.findByText("released the checker handoff", { exact: false }, LOADED);
    expect(row(slot)).toBeNull();
    expect(slot.container.textContent).toContain("from your phone");
    expect(slot.container.textContent).toContain("held the checker handoff for your release");
  });

  it("words the badge so its verb follows the total and its noun the asks", () => {
    expect(badgeLabel(1, 0)).toBe("1 open Tavern ask needs your answer");
    expect(badgeLabel(2, 0)).toBe("2 open Tavern asks need your answer");
    expect(badgeLabel(0, 1)).toBe("1 checker handoff to release needs you");
    expect(badgeLabel(0, 2)).toBe("2 checker handoffs to release need you");
    expect(badgeLabel(1, 1)).toBe("1 open Tavern ask and 1 checker handoff to release need you");
  });

  it("words every release path", () => {
    expect(["banner", "page", "phone", "chat", "cli"].map((via) => releaseWords({ at: 0, via: via as never, askId: null }))).toEqual(["from the ask banner", "from the Tavern page", "from your phone", "in chat", "from the command line"]);
    expect(releaseWords({ at: 0, via: "phone", askId: "ask-1" })).toBe("by answering the Keeper's ask, from your phone");
  });
});

describe("a checker-handoff hold in the common room", () => {
  const roomWith = (h: CheckerHandoffHold | undefined, asks: Ask[] = scenes.richRoom.asks) => ({ ...withQuest(scenes.richRoom, withHold(h).quest), asks } as Room);
  async function commonRoom(room: Room, rpc: Partial<Handlers> = {}) {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
      rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), ...rpc } as Partial<Handlers> as Handlers });
    slots.push(slot);
    // Past the skeleton: the real room has its board.
    await waitFor(() => expect(slot.container.querySelector("[data-room] [data-sec=board]")).not.toBeNull(), LOADED);
    return slot;
  }
  const needYou = (slot: RenderedSlot) => Number(slot.container.querySelector("[data-room] .rm-sline .tv-hero b")!.textContent);
  const sideCount = (slot: RenderedSlot) => Number(slot.container.querySelector(".tv-snav-c")?.textContent?.match(/\d+/)?.[0] ?? 0);
  const openAsks = scenes.richRoom.asks.filter((a) => a.state === "open").length;

  it("counts an active hold in need you, on the status line and in the sidebar, and lists it in the queue with its release control", async () => {
    const room = roomWith(hold());
    const slot = await commonRoom(room);
    expect(needYou(slot)).toBe(openAsks + 1);
    // The sidebar is its own slot beside the page.
    const side = renderSlot({ component: TavernSidebar }, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room) } as Partial<Handlers> as Handlers });
    slots.push(side);
    await waitFor(() => expect(sideCount(side)).toBe(openAsks + 1), LOADED);
    const queue = slot.container.querySelector<HTMLElement>("#tv-needs-you")!;
    const row = queue.querySelector<HTMLElement>("[data-checker-hold]")!;
    expect(row.querySelector("button.tv-hold-release")!.textContent).toBe("Release checker handoff");
    // The quest is named once, as a quiet link to its page.
    expect(row.querySelector<HTMLButtonElement>("button.tv-hold-quest")!.textContent).toBe(live.quest.short);
    expect(queue.querySelector(".tv-count")!.textContent).toBe(`${openAsks + 1} need you, oldest first`);
  });

  it("counts the hold in bb's canonical Tavern attention badge too", async () => {
    const Badge = () => { const b = useTavernBadge(); return <span data-badge>{b ? `${b.count}|${b.label}` : "none"}</span>; };
    const room = roomWith(hold());
    const slot = renderSlot({ component: Badge }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { room: () => structuredClone(room) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await waitFor(() => expect(slot.container.querySelector("[data-badge]")!.textContent).toBe(`${openAsks + 1}|${openAsks + 1} need you`), LOADED);
  });

  it("counts a hold the Keeper also asked about once, as its ask, and lists only the ask", async () => {
    const ask = { ...structuredClone(scenes.richRoom.asks.find((a) => a.state === "open")!), id: "ask-hold", releaseHoldId: "hold-1", boardQuestId: live.quest.id } as Ask;
    const slot = await commonRoom(roomWith(hold(), [...scenes.richRoom.asks, ask]));
    expect(needYou(slot)).toBe(openAsks + 1);
    expect(slot.container.querySelector("#tv-needs-you [data-checker-hold]")).toBeNull();
  });

  it("doesn't count a released hold or a stopping quest's hold, and says Nothing needs you only when nothing does", async () => {
    const released = await commonRoom(roomWith(hold({ release: { at: scenes.min(1), via: "page", askId: null } })));
    expect(needYou(released)).toBe(openAsks);
    const quiet = { ...roomWith(hold()), asks: [], decidedForYou: [] } as Room;
    const held = await commonRoom(quiet);
    expect(needYou(held)).toBe(1);
    expect(held.container.querySelector(".rm-calm")).toBeNull();
    const stoppingRoom = { ...quiet, keepers: quiet.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === live.quest.id ? { ...q, phase: "stopping" as const, stoppingSince: scenes.min(2), stopUnconfirmed: 1 } : q) })) } as Room;
    const stopping = await commonRoom(stoppingRoom);
    expect(needYou(stopping)).toBe(0);
  });
});
