import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { rpcContract, tags } from "../../../src/shared/contract";
import { TavernPage, TavernSidebar, registerPageSurfaces } from "../../../src/ui/page/register";
import { QuestPage } from "../../../src/ui/page/quest";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { detail, registry, room } from "../../../src/ui/page/fixtures";

it("renames on the quest page, validates inline, retains the draft on refusal and returns focus on save", async () => {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  let quest = detail.quest;
  const board = () => ({ ...room, keepers: room.keepers.map(keeper => ({ ...keeper, boardQuests: [quest] })) });
  const renameBoardQuest = vi.fn((input: unknown) => {
    if (renameBoardQuest.mock.calls.length === 1) throw new Error("Restore this quest from the cellar before renaming it.");
    const { title, short } = rpcContract.renameBoardQuest.input.parse(input);
    quest = { ...quest, title, short };
    return { ok: true as const };
  });
  const page = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    registry: () => registry, room: board, boardQuest: () => ({ ...detail, quest, events: [
      ...detail.events,
      ...(quest === detail.quest ? [] : [{ id: 2, at: 2000, keeperThreadId: quest.keeperThreadId, boardQuestId: quest.id,
        actor: { kind: "user" }, type: "quest.renamed", text: `Renamed “${detail.quest.title}” to “${quest.title}”`,
        data: { from: { title: detail.quest.title, short: detail.quest.short }, to: { title: quest.title, short: quest.short } } }]),
    ] }), renameBoardQuest,
  } });
  try {
    const open = await page.findByRole("button", { name: "Rename quest" });
    fireEvent.click(open);
    const title = page.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    const short = page.getByRole("textbox", { name: "Short name" }) as HTMLInputElement;
    const save = page.getByRole("button", { name: "Save name" });
    expect(title.value).toBe(quest.title);
    expect(short.value).toBe(quest.short);
    expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.change(short, { target: { value: "a".repeat(41) } });
    fireEvent.click(save);
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(short.getAttribute("aria-invalid")).toBe("true");
    expect(page.getByText("Enter a title of 1–200 characters.")).toBeTruthy();
    expect(page.getByText("Enter a short name of 1–40 characters.")).toBeTruthy();
    expect(renameBoardQuest).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "Repair the signal lamp" } });
    fireEvent.change(short, { target: { value: "Signal lamp" } });
    fireEvent.click(save);
    expect((await page.findByRole("alert")).textContent).toContain("Restore this quest");
    expect(title.value).toBe("Repair the signal lamp");
    fireEvent.click(save);
    await waitFor(() => expect(renameBoardQuest).toHaveBeenLastCalledWith({ id: quest.id, title: "Repair the signal lamp", short: "Signal lamp" }));
    await waitFor(() => expect(page.queryByRole("textbox", { name: "Title" })).toBeNull());
    expect(document.activeElement).toBe(open);
    await page.behavior.experimental_invalidateRpc([tags.boardQuest(quest.id), tags.room()]);
    expect(await page.findByRole("heading", { name: quest.title })).toBeTruthy();
    expect(await page.findByRole("option", { name: /^Signal lamp/ })).toBeTruthy();
    expect(await page.findByText("renamed the quest")).toBeTruthy();
    expect(page.getByText(`Renamed “${detail.quest.title}” to “${quest.title}” · Short name: “${detail.quest.short}” to “${quest.short}”`)).toBeTruthy();
  } finally { page.lifecycle.unmount(); }
});

it("renders the quest controls without duplicate React keys", async () => {
  const errors = vi.spyOn(console, "error");
  try {
    const page = renderSlot({ component: QuestPage }, { detail, registry, room }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
      questSpend: () => ({ budgetCents: null, reachedAt: null, usdNanos: null, missing: 0, sources: [] }),
      questAuthority: () => ({ keeperName: "Wren", rows: [], delegations: [], preapprovals: [], review: { used: 0, total: 3 }, spendBudget: null }),
    } });
    try {
      fireEvent.click(await page.findByRole("button", { name: "Rename quest" }));
      expect(await page.findByRole("textbox", { name: "Title" })).toBeTruthy();
      expect((await page.findByText("Quest spend:")).closest("summary")).toBeTruthy();
      expect(errors.mock.calls.filter(([message]) => /encountered two children with the same key/i.test(String(message)))).toEqual([]);
    } finally { page.lifecycle.unmount(); }
  } finally { errors.mockRestore(); }
});

it("renders the current quest name on the sidebar, in the common room, on the map and on a chat card", async () => {
  const quest = { ...detail.quest, title: "Repair the signal lamp", short: "Signal lamp" };
  const board = { ...room, keepers: room.keepers.map(keeper => ({ ...keeper, boardQuests: [quest] })) };
  const page = renderSlot({ component: () => <>
    <TavernSidebar subPath="room" />
    <TavernPage subPath="room" />
    <TavernPage subPath="map" />
    <QuestMapCard detail={{ ...detail, quest }} version={null} />
  </> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => registry, room: () => board } });
  try {
    await waitFor(() => expect(page.container.querySelector(".tv-squest[title='Repair the signal lamp']")?.textContent).toContain(quest.short));
    await waitFor(() => expect(page.container.querySelector(".tv-room [data-quest-name]")?.textContent).toContain(quest.short));
    expect((await page.findByRole("button", { name: /^Focus on Repair the signal lamp/ })).textContent).toBe(quest.short);
    expect(await page.findByRole("article", { name: /^Quest map .*Repair the signal lamp/ })).toBeTruthy();
  } finally { page.lifecycle.unmount(); }
});
