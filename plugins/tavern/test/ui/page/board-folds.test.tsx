import { useState } from "react";
import { act, fireEvent, within, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Board } from "../../../src/ui/page/board";
import { MobileQuestOptions, QuestNav } from "../../../src/ui/page/nav";
import { CommonRoom } from "../../../src/ui/page/room";
import { StopKeeperGone } from "../../../src/ui/page/stop-all";
import { useArchive } from "../../../src/ui/page/archive";
import { audit, registry, richRoom, sfe, vault } from "./scenes";

const gone = { ...audit, id: "gone", title: "Keeper gone quest", short: "Keeper gone quest" };
const returned = { ...sfe, id: "returned", title: "Returned quest", short: "Returned quest" };
const stopped = { ...sfe, id: "stopped", title: "Stopped quest", short: "Stopped quest", phase: "stopped" as const };
const room = { ...richRoom, asks: [], keepers: [{ ...richRoom.keepers[0]!, boardQuests: [vault, returned] }, { ...richRoom.keepers[1]!, archived: true, boardQuests: [gone, stopped] }] };
const mount = (rpc = {}) => renderSlot({ component: () => <Board room={room} registry={registry} api={useArchive()} /> }, {}, { rpc });
afterEach(() => { cleanup(); localStorage.clear(); });

it("has only live notices and puts gone, returned and stopped quests in separate folds", () => {
  const slot = mount();
  expect(slot.queryByRole("article", { name: /Moss.*Keeper/ })).toBeNull();
  expect(slot.queryByRole("button", { name: returned.short })).toBeNull();
  expect(slot.queryByRole("button", { name: stopped.short })).toBeNull();
  expect(slot.queryByRole("button", { name: gone.short })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Returned and stopped.*2/ }));
  const returnedFold = slot.container.querySelector<HTMLElement>("[data-board-fold=returned]")!;
  expect(within(returnedFold).getByRole("button", { name: returned.short })).toBeTruthy();
  expect(within(returnedFold).getByRole("button", { name: stopped.short })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /Needs a Keeper.*1/ }));
  const goneFold = slot.container.querySelector<HTMLElement>("[data-board-fold=gone]")!;
  expect(within(goneFold).getByText(/Unarchive the Keeper’s thread to bring its quests back/)).toBeTruthy();
  expect(within(goneFold).getByRole("button", { name: gone.short })).toBeTruthy();
});

it("agrees with the sidebar and phone picker about what is active, without merging Keepers who share a character", () => {
  const main = room.keepers[0]!;
  const second = { ...main, member: { ...main.member, threadId: "second", displayName: "Wren II" },
    boardQuests: [{ ...vault, id: "second-quest", keeperThreadId: "second", title: "Second quest", short: "Second quest" }] };
  const data = { ...room, keepers: [main, second, room.keepers[1]!] };
  const slot = renderSlot({ component: () => <><nav aria-label="Sidebar"><QuestNav room={data} registry={registry} route={{ kind: "room" }} /></nav>
    <select aria-label="Phone quests"><MobileQuestOptions room={data} /></select><CommonRoom room={data} registry={registry} /></> }, {}, {});
  const nav = within(slot.getByRole("navigation", { name: "Sidebar" }));
  expect(nav.getByText("2 active")).toBeTruthy();
  expect(nav.queryByRole("button", { name: /Keeper gone quest/ })).toBeNull();
  expect(nav.getByRole("button", { name: /^Wren, Keeper/ })).toBeTruthy();
  expect(nav.getByRole("button", { name: /^Wren II, Keeper/ })).toBeTruthy();
  expect(slot.container.querySelectorAll(".tv-sgroup")).toHaveLength(2);
  expect(within(slot.getByRole("combobox", { name: "Phone quests" })).queryByRole("option", { name: /Keeper gone quest/ })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Needs a Keeper.*1/ }));
  expect(within(slot.container.querySelector<HTMLElement>("[data-board-fold=gone]")!).getByRole("button", { name: gone.short })).toBeTruthy();
});

it("sends all and only the returned fold's quests to the cellar", async () => {
  const archive = vi.fn().mockResolvedValue({ ok: true, changed: 2, notes: [], pendingArchives: [] });
  const slot = mount({ archiveBoardQuests: archive });
  fireEvent.click(slot.getByRole("button", { name: /Returned and stopped.*2/ }));
  fireEvent.click(slot.getByRole("button", { name: "Send all 2 to the cellar" }));
  await waitFor(() => expect(archive).toHaveBeenCalledOnce());
  expect(archive.mock.calls[0]?.[0]).toMatchObject({ archived: true, ids: expect.arrayContaining([returned.id, stopped.id]) });
  expect(archive.mock.calls[0]?.[0].ids).toHaveLength(2);
});

it("confirms the scope in place and keeps a receipt naming the quests", async () => {
  const stop = vi.fn().mockResolvedValue({ id: "receipt", at: 1, surface: "client (unattested)", entries: [{ questId: gone.id, title: gone.title, state: "cellared" }] });
  const slot = mount({ stopKeeperGoneQuests: stop });
  fireEvent.click(slot.getByRole("button", { name: /Needs a Keeper.*1/ }));
  fireEvent.click(slot.getByRole("button", { name: "Stop and send to the cellar" }));
  expect(stop).not.toHaveBeenCalled();
  const confirm = slot.getByRole("dialog", { name: "Stop and send to the cellar" });
  expect(confirm.textContent).toMatch(/1 quest.*recorded as stopped/i);
  fireEvent.click(within(confirm).getByRole("button", { name: "Stop 1 quest" }));
  const receipt = await slot.findByRole("status", { name: "Stop and cellar receipt" });
  expect(receipt.textContent).toContain(gone.title);
  expect(receipt.textContent).toContain("You asked to stop these quests and send them to the cellar.");
  expect(stop).toHaveBeenCalledWith({ ids: [gone.id] });
});

it("closes a refused scope, restores focus and confirms the current IDs on reopen", async () => {
  const stop = vi.fn().mockRejectedValueOnce(new Error("The “Needs a Keeper” list changed."));
  let changeIds!: (next: string[]) => void;
  function Surface() {
    const [ids, setIds] = useState(["old"]);
    changeIds = setIds;
    return <StopKeeperGone ids={ids} onReceipt={() => {}} />;
  }
  const slot = renderSlot({ component: Surface }, {}, { rpc: { stopKeeperGoneQuests: stop } });
  const trigger = slot.getByRole("button", { name: "Stop and send to the cellar" });
  fireEvent.click(trigger);
  fireEvent.click(slot.getByRole("button", { name: "Stop 1 quest" }));
  expect((await slot.findByRole("alert")).textContent).toContain("The “Needs a Keeper” list changed.");
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  act(() => changeIds(["new-1", "new-2"]));
  fireEvent.click(trigger);
  fireEvent.click(slot.getByRole("button", { name: "Stop 2 quests" }));
  await waitFor(() => expect(stop).toHaveBeenLastCalledWith({ ids: ["new-1", "new-2"] }));
});

it("after loading, shows only the pending row's retry jump and still lets you stop the ready quest", async () => {
  const pending = { ...gone, id: "already-stopping", title: "Already stopping", short: "Already stopping", phase: "stopping" as const, cellarOnStop: "prior-receipt" };
  const data = { ...room, keepers: [room.keepers[0]!, { ...room.keepers[1]!, boardQuests: [pending, gone] }] };
  const stop = vi.fn().mockResolvedValue({ id: "receipt", at: 1, surface: "client", entries: [{ questId: gone.id, title: gone.title, state: "cellared" }] });
  const slot = renderSlot({ component: CommonRoom }, { room: data, registry }, { rpc: { stopKeeperGoneQuests: stop } });
  fireEvent.click(slot.getByRole("button", { name: /Needs a Keeper.*2/ }));
  const pendingRow = slot.getByRole("button", { name: pending.short }).closest(".rm-fold-quest") as HTMLElement;
  const readyRow = slot.getByRole("button", { name: gone.short }).closest(".rm-fold-quest") as HTMLElement;
  expect(within(readyRow).queryByText(/waiting for Tavern/i)).toBeNull();
  fireEvent.click(within(pendingRow).getByRole("button", { name: "See stop status" }));
  expect(document.activeElement?.closest("#tv-away-notes")).toBeTruthy();
  fireEvent.click(within(document.activeElement!.closest("#tv-away-notes") as HTMLElement).getByRole("button", { name: `Open stop retry for ${pending.title}` }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `quest/${pending.id}` } });
  fireEvent.click(slot.getByRole("button", { name: "Stop and send to the cellar" }));
  fireEvent.click(slot.getByRole("button", { name: "Stop 1 quest" }));
  await waitFor(() => expect(stop).toHaveBeenCalledWith({ ids: [gone.id] }));
});
