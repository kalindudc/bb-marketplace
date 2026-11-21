import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { QuestSpend } from "../../../src/ui/page/quest-spend";
import { NeedsYouQueue } from "../../../src/ui/page/asks";
import { AskCard } from "../../../src/ui/kit/ask-card";
import * as scenes from "./scenes";

it("keeps uncapped spend compact and names the unapproved plan without asking for it again", async () => {
  const slot = renderSlot({ component: QuestSpend }, { id: "quest", editable: true }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    questSpend: () => ({ budgetCents: null, reachedAt: null, proposal: { cents: 150, planVersion: 2 }, usdNanos: 0, missing: 0, sources: [] }),
  } });
  try {
    await slot.findByText("Proposed in plan v2: $1.50, not set");
    if (process.env.TAVERN_SPEND_HARNESS === "1") process.stdout.write(`SPEND_UNCAPPED=${JSON.stringify(slot.container.innerHTML)}\n`);
    const summary = slot.getAllByText("Set budget").map(el => el.closest("summary")).find(Boolean);
    expect(summary?.closest("details")?.open).toBe(false);
    expect(summary?.closest("details")?.textContent).toContain("Other usage");
  } finally { slot.lifecycle.unmount(); }
});

it("explains partial measured spend and raises the cap without resuming the quest", async () => {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const detail = scenes.readmeDetail;
  const quest = { ...detail.quest, phase: "build" as const };
  const setSpendBudget = vi.fn(() => ({ ok: true as const }));
  const page = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    registry: () => scenes.registry, room: () => scenes.richRoom, boardQuest: () => ({ ...detail, quest }), setSpendBudget,
    questSpend: () => ({ budgetCents: 300, reachedAt: 1790000000000, usdNanos: 3_100_000_000, missing: 1, sources: [{ name: "Guarded local session", readAt: 1790000000000 }] }),
  } });
  try {
    await page.findByRole("heading", { name: "Quest spend" });
    if (process.env.TAVERN_SPEND_HARNESS === "1") process.stdout.write(`SPEND_HARNESS=${JSON.stringify(page.container.innerHTML)}\n`);
    expect(page.getByText(/\$3\.10 recorded/)).toBeTruthy();
    expect(page.getByText(/1 session has missing usage/)).toBeTruthy();
    expect(page.getByText(/already admitted can take spend past the cap/)).toBeTruthy();
    fireEvent.change(page.getByRole("spinbutton", { name: "Budget in USD" }), { target: { value: "5.70" } });
    fireEvent.click(page.getByRole("button", { name: "Raise budget" }));
    await waitFor(() => expect(setSpendBudget).toHaveBeenCalledWith({ id: quest.id, budgetCents: 570 }));
    expect(page.getByRole("button", { name: "Remove budget" })).toBeTruthy();
  } finally { page.lifecycle.unmount(); }
});

it("presents the concise hold in Needs you and the exact proposed change in greenlight", async () => {
  const ask = scenes.richAsks.find(ask => ask.kind === "greenlight")!;
  const title = "The quest reached its $3.00 spend budget. New hires and briefs wait until you raise or remove it.";
  const slot = renderSlot({ component: () => <>
    <div data-case="needs"><NeedsYouQueue registry={scenes.registry} room={{ ...scenes.richRoom, attention: {
      counts: { ask: 0, hold: 1, rule: 0, "hand-back": 0, stopped: 0 }, needYou: 1, new: 0, heldByYou: 0,
      items: [{ kind: "hold", id: `spend:${ask.boardQuestId}`, title, keeperThreadId: ask.keeperThreadId, questId: ask.boardQuestId, action: "Open quest", since: ask.createdAt, seen: false }],
    } }} /></div>
    <div data-case="greenlight"><AskCard ask={ask} via="page" /></div>
  </> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    registry: () => scenes.registry,
    questAuthority: () => ({ keeperName: "Moss", rows: [], delegations: [], preapprovals: [], review: { used: 2, total: 3 }, spendBudget: null, spendProposal: 150 }),
  } });
  try {
    expect(await slot.findByRole("heading", { name: "Holds" })).toBeTruthy();
    expect(await slot.findByText(title)).toBeTruthy();
    expect(await slot.findByText("Approving this plan yourself sets the budget to $1.50.")).toBeTruthy();
    if (process.env.TAVERN_SPEND_HARNESS === "1") process.stdout.write(`SPEND_SURFACES=${JSON.stringify(slot.container.innerHTML)}\n`);
  } finally { slot.lifecycle.unmount(); }
});
