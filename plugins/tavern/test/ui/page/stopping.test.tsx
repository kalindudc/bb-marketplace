import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import type { Member } from "../../../src/shared/schema";
import { clockTime } from "../../../src/ui/kit";
import { closePlan } from "../../../src/ui/page/away";
import { finishedQuests } from "../../../src/ui/page/archive";
import { activeQuests, workingQuests } from "../../../src/ui/page/model";
import { stoppingWords } from "../../../src/ui/page/quest";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
const LOADED = { timeout: 3000 };

const since = scenes.min(4), tried = scenes.min(0.5);
const pending = (m: Member, over: Partial<Member> = {}): Member => ({ ...m, engagement: "stopping", lastStopAttemptAt: tried, stopError: null, ...over });
const live = scenes.richDetails.vault!;
const stoppingDetail: BoardQuestDetail = {
  ...live,
  quest: { ...live.quest, phase: "stopping", stoppingSince: since, stopUnconfirmed: 2, updatedAt: since, members: live.quest.members.map((m) => m.threadId === "thr-juno" ? pending(m, { stopError: "thread is busy" }) : m.threadId === "thr-pip" ? pending(m, { lastStopAttemptAt: null }) : { ...m, state: "idle" as const, engagement: "stopped" as const }) },
};
const withQuest = (room: Room, quest: BoardQuestDetail["quest"]): Room => ({ ...room, keepers: room.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === quest.id ? quest : q) })) });

async function questPage(detail: BoardQuestDetail, rpc: Partial<Handlers> = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const room = withQuest(scenes.richRoom, detail.quest);
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${detail.quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), boardQuest: () => structuredClone(detail), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { level: 1, name: detail.quest.title }, LOADED);
  return slot;
}

describe("a stopping quest's page", () => {
  it("says how many stops wait on a confirmation, since when, and names each member still running, with no Stop button", async () => {
    const slot = await questPage(stoppingDetail);
    const section = slot.getByRole("region", { name: "2 stops not confirmed" });
    expect(stoppingWords(2)).toBe("Stopping · 2 not confirmed; Tavern retries");
    // The header carries the stopping words and since when, once; the section lists who.
    const facts = slot.container.querySelector(".tv-ghead .tv-facts")!.textContent!;
    expect(facts).toContain(`since ${clockTime(since)}`);
    expect(section.textContent).not.toContain("Stopping ·");
    const list = within(section).getByRole("list", { name: "Members whose stop isn’t confirmed" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain(`last tried ${clockTime(tried)}`);
    expect(rows[0]!.textContent).toContain("thread is busy");
    expect(rows[1]!.textContent).toContain("not tried yet");
    expect(slot.queryByRole("button", { name: "Stop quest" })).toBeNull();
    // The header's state says the same, not the live quest's "your move".
    expect(slot.container.querySelector(".tv-ghead .tv-facts")!.textContent).toContain(stoppingWords(2));
  });

  it("lists a cancelled hire that never got a thread as an unconfirmed hire, with its class, and counts it", async () => {
    const detail: BoardQuestDetail = { ...stoppingDetail, quest: { ...stoppingDetail.quest, stopUnconfirmed: 3, stopPendingHires: [{ token: "hire-1", classId: "warden", title: "Check the staging cutover" }] } };
    const slot = await questPage(detail);
    const section = slot.getByRole("region", { name: "3 stops not confirmed" });
    const hires = within(section).getByRole("list", { name: "Hires whose stop isn’t confirmed" });
    const row = within(hires).getByRole("listitem");
    expect(row.textContent).toContain("Unconfirmed hire: Check the staging cutover");
    expect(row.textContent).toContain(scenes.registry.classes.find((c) => c.id === "warden")!.label);
    expect(row.textContent).not.toContain("hire-1");
    expect(within(row).queryByRole("button")).toBeNull();
  });
  it("retries at once with Retry now, and says what the retry found", async () => {
    const stop = vi.fn((_input: { id: string; reason?: string | null }) => ({ phase: "stopping" as const, unconfirmed: 1 }));
    const slot = await questPage(stoppingDetail, { stopBoardQuest: stop });
    fireEvent.click(slot.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(stop.mock.calls[0]![0]).toEqual({ id: "vault", reason: null });
    await slot.findByRole("region", { name: "1 stop not confirmed" }, LOADED);
    expect(slot.container.querySelector(".tv-ghead .tv-facts")!.textContent).toContain(stoppingWords(1));
    expect(slot.getByRole("status").textContent).toMatch(/^Tried again at \d\d:\d\d: 1 stop not confirmed\.$/);
  });

  it("shows a stop the server couldn't confirm straight away as stopping, before the page's data catches up", async () => {
    const stop = vi.fn((_input: { id: string; reason?: string | null }) => ({ phase: "stopping" as const, unconfirmed: 2 }));
    const slot = await questPage(live, { stopBoardQuest: stop });
    fireEvent.click(slot.getByRole("button", { name: "Stop quest" }));
    fireEvent.click(slot.getByRole("button", { name: "Yes, stop this quest" }));
    await slot.findByRole("region", { name: "2 stops not confirmed" }, LOADED);
    expect(slot.queryByRole("button", { name: "Stop quest" })).toBeNull();
    expect(slot.getByRole("button", { name: "Retry now" })).toBeTruthy();
  });

  it("says Stopped when every stop was confirmed at once", async () => {
    const stop = vi.fn((_input: { id: string; reason?: string | null }) => ({ phase: "stopped" as const, unconfirmed: 0 }));
    const slot = await questPage(live, { stopBoardQuest: stop });
    fireEvent.click(slot.getByRole("button", { name: "Stop quest" }));
    fireEvent.click(slot.getByRole("button", { name: "Yes, stop this quest" }));
    await waitFor(() => expect(slot.container.querySelector(".tv-gacts")!.textContent).toContain("Stopped"), LOADED);
    expect(slot.queryByRole("region", { name: /not confirmed/ })).toBeNull();
  });

  it("shows the server's refusal in words", async () => {
    const stop = vi.fn(() => { throw new Error("This quest has already returned"); });
    const slot = await questPage(stoppingDetail, { stopBoardQuest: stop as never });
    fireEvent.click(slot.getByRole("button", { name: "Retry now" }));
    const alert = await slot.findByText("Could not stop: This quest has already returned", {}, LOADED);
    expect(alert.getAttribute("role")).toBe("alert");
    // The section stays, so Retry now is still there to try again.
    expect(slot.getByRole("button", { name: "Retry now" })).toBeTruthy();
  });
});

describe("a stopping quest elsewhere", () => {
  const room = withQuest(scenes.richRoom, stoppingDetail.quest);
  it("stays live (the board, the sidebar) and never reaches Returned or the cellar", () => {
    expect(activeQuests(room).map((q) => q.id)).toContain("vault");
    expect(finishedQuests(room).map((q) => q.id)).not.toContain("vault");
    expect(workingQuests(room).map((q) => q.id)).not.toContain("vault");
  });
  it("takes no Closing time choice, and the confirm says its stops keep retrying", () => {
    const plan = closePlan(room, { watchedCount: 0, watchedByQuest: [] }, { choices: {}, allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false } });
    expect(plan.quests.map((q) => q.id)).not.toContain("vault");
    expect(plan.stopping).toBe("1 quest is still stopping; Tavern keeps retrying while you’re away.");
    expect(plan.nothingRunning).toBe(false);
  });
});
