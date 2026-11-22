// @vitest-environment jsdom
import { withAttention } from "../attention-fixture";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { clearThreadState, revealAsk } from "../../../src/ui/thread/state";
import { fixtureDecor, fixtureRegistry, fixtureAsk, fixtureLedger, fixtureQuest } from "../../../src/ui/thread/fixtures";

import { decisionSchema } from "../../../src/shared/schema";
import type { Attention, AttentionItem } from "../../../src/shared/attention";

afterEach(() => { cleanup(); clearThreadState(); });
function row(threadId = "keeper-1", asks = [fixtureAsk]) {
  return renderSlot({ component: ThreadWidget }, { threadId }, { rpc: { decor: () => withAttention({ ...fixtureDecor, threadId, keeperView: { ...fixtureDecor.keeperView!, openAsks: asks } }), registry: () => fixtureRegistry } });
}
it("keeps the panel closed when switching threads and opens again on a new request", async () => {
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  const first = row();
  fireEvent.click(await first.findByRole("button", { name: "Close" }));
  first.lifecycle.unmount();
  const other = row("keeper-2");
  await other.findByRole("button", { name: /1 need you/ });
  expect(other.queryByRole("button", { name: "Close" })).toBeNull();
  other.lifecycle.unmount();
  const back = row();
  const chip = await back.findByRole("button", { name: /1 need you/ });
  await waitFor(() => expect(chip.getAttribute("aria-expanded")).toBe("false"));
  expect(back.queryByRole("button", { name: "Close" })).toBeNull();
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  expect(await back.findByRole("button", { name: "Close" })).toBeTruthy();
  back.lifecycle.unmount();
});
it.each(["Fold", "Close", "Escape"])("%s closes the one-ask panel opened from the Ledger and returns focus to the banner", async action => {
  const threadId = "keeper-1";
  const slot = renderSlot({ component: () => <>
    <ThreadWidget threadId={threadId} />
    <LedgerTab threadId={threadId} environment={null} />
  </> }, {}, { rpc: { decor: () => withAttention(fixtureDecor), ledger: () => withAttention(fixtureLedger), registry: () => fixtureRegistry } });
  const chip = await slot.findByRole("button", { name: /1 need you/ });
  fireEvent.click(slot.getByRole("button", { name: /Open the Keeper’s ledger/ }));
  expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: expect.objectContaining({ id: "ledger" }) } });
  fireEvent.click(await slot.findByRole("button", { name: /Send Luc the link.*Answer/ }));
  const fold = await slot.findByRole("button", { name: /Send Luc the link.*Fold/ });
  expect(slot.getByRole("region", { name: "Asks waiting for you" })).toBeTruthy();
  if (action === "Fold") fireEvent.click(fold);
  else if (action === "Close") fireEvent.click(slot.getByRole("button", { name: "Close" }));
  else fireEvent.keyDown(fold, { key: "Escape" });
  expect(slot.queryByRole("region", { name: "Asks waiting for you" })).toBeNull();
  expect(document.activeElement).toBe(chip);
  fireEvent.click(slot.getByRole("button", { name: /Send Luc the link.*Answer/ }));
  expect(await slot.findByRole("button", { name: /Send Luc the link.*Fold/ })).toBeTruthy();
  slot.lifecycle.unmount();
});
it("keeps a multi-ask list open and its answer folded across remounts", async () => {
  const asks = [fixtureAsk, { ...fixtureAsk, id: "second", question: "A second ask?" }];
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  const first = row("keeper-1", asks);
  const askRow = await first.findByRole("button", { name: /Send Luc the link.*Hide answer/ });
  fireEvent.click(askRow);
  expect(askRow.getAttribute("aria-expanded")).toBe("false");
  first.lifecycle.unmount();
  const back = row("keeper-1", asks);
  const restored = await back.findByRole("button", { name: /Send Luc the link.*Answer/ });
  expect(restored.getAttribute("aria-expanded")).toBe("false");
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  await waitFor(() => expect(restored.getAttribute("aria-expanded")).toBe("true"));
  back.lifecycle.unmount();
});
const summary: AttentionItem = { id: "summary-1", kind: "summary", questId: fixtureQuest.id, keeperThreadId: "keeper-1", title: "The survey report", action: "Open", since: 1000, seen: false };
const decision = decisionSchema.parse({ id: "decision-1", keeperThreadId: "keeper-1", boardQuestId: fixtureQuest.id, text: "Moved the handoff", why: "The first waypoint is ready", source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: 1000 });

function allSections({ needs = true, news = true } = {}) {
  const asks = needs ? [fixtureAsk, { ...fixtureAsk, id: "second", question: "A second ask?" }] : [];
  const base = withAttention({ ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, openAsks: asks } });
  const attention: Attention = { ...base.keeperView!.attention!, ...(news ? { new: 2, summaries: 1, decided: 1, items: [...base.keeperView!.attention!.items, summary] } : {}) };
  const decor = { ...base, keeperView: { ...base.keeperView!, attention, decidedForYou: news ? [decision] : [] } };
  const markSummariesSeen = vi.fn(() => ({}));
  const markDecisionsSeen = vi.fn(() => ({ ids: [decision.id], undoToken: null }));
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry, markSummariesSeen, markDecisionsSeen } });
  return { slot, markSummariesSeen, markDecisionsSeen };
}

it.each([
  [/2 need you/, "Asks waiting for you"],
  [/2 new/, "New for you"],
  [`Show ${fixtureQuest.title}`, "Board quests"],
] as const)("toggles %s inline without opening a panel or navigating", async (label, region) => {
  const { slot } = allSections();
  const chip = await slot.findByRole("button", { name: label });
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(chip);
  const section = slot.getByRole("region", { name: region });
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(chip.getAttribute("aria-controls")).toBe(section.id);
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
  expect(slot.inspection.navigateCalls).toEqual([]);
  if (region === "Asks waiting for you") {
    expect(within(section).getByRole("button", { name: /Send Luc the link/, expanded: true })).toBeTruthy();
    expect(within(section).getByRole("button", { name: /A second ask/, expanded: false })).toBeTruthy();
  }
  if (region === "Board quests") {
    expect(within(section).getByText(fixtureQuest.waypoints[0]!.title)).toBeTruthy();
    expect(within(section).getByRole("button", { name: /Open the quest page for/ })).toBeTruthy();
  }
  fireEvent.click(chip);
  expect(slot.queryByRole("region", { name: region })).toBeNull();
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(chip);
});

it.each([
  [{ needs: true, news: true }, "Asks waiting for you"],
  [{ needs: false, news: true }, "New for you"],
  [{ needs: false, news: false }, "Board quests"],
] as const)("expands %j in urgency order and folds with the same chevron", async (options, region) => {
  const { slot } = allSections(options);
  const expand = await slot.findByRole("button", { name: "Expand Tavern widget" });
  fireEvent.click(expand);
  expect(slot.getByRole("region", { name: region })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Fold Tavern widget" })).toBe(expand);
  fireEvent.click(expand);
  expect(slot.queryByRole("region", { name: region })).toBeNull();
  expect(document.activeElement).toBe(expand);
});

it("offers the Ledger’s explicit acknowledgements for unseen summaries and calls", async () => {
  const { slot, markSummariesSeen, markDecisionsSeen } = allSections();
  fireEvent.click(await slot.findByRole("button", { name: /2 new/ }));
  expect(markSummariesSeen).not.toHaveBeenCalled();
  expect(markDecisionsSeen).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "OK: The survey report" }));
  await waitFor(() => expect(markSummariesSeen).toHaveBeenCalledWith({ boardQuestId: fixtureQuest.id, ids: [summary.id] }));
  fireEvent.click(slot.getByRole("button", { name: "Mark seen: Moved the handoff" }));
  await waitFor(() => expect(markDecisionsSeen).toHaveBeenCalledWith({ ids: [decision.id] }));
});

it.each([[/2 new/, "New for you"], [`Show ${fixtureQuest.title}`, "Board quests"]] as const)("Escape from %s returns focus to its opener", async (label, region) => {
  const { slot } = allSections();
  const chip = await slot.findByRole("button", { name: label });
  fireEvent.click(chip);
  const close = within(slot.getByRole("region", { name: region })).getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(slot.queryByRole("region", { name: region })).toBeNull();
  expect(document.activeElement).toBe(chip);
});
it("shows the ask's full question, wrapped, once its row is expanded", async () => {
  const slot = row();
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  // The expanded panel prints the question in full, wrapped, so the truncated row never hides it.
  const full = await slot.findByText(fixtureAsk.question, { selector: ".tw-aq-open" });
  expect(full.tagName).toBe("P");
  // The row keeps the question to one line: it is the compact control, not the readable copy.
  expect(slot.container.querySelector(".tw-ask-row .tw-aq")!.textContent).toBe(fixtureAsk.question);
  expect(readFileSync("src/ui/kit/components.css", "utf8")).toMatch(/\.tavern \.tw-aq \{[^}]*white-space: nowrap/);
  // The panel stays headless, so the row's own kind word stands (a checker handoff is not relabelled "Blocker").
  expect(slot.container.querySelector(".tw-ask.open .ask-q")).toBeNull();
  slot.lifecycle.unmount();
});
it("still reveals an ask from the chat pointer and folds back to the need-you chip", async () => {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const directive = app.messageDirectives.find(item => item.id === "tavern-ask")!;
  const widget = row();
  const pointer = renderSlot(directive, { attributes: { id: fixtureAsk.id }, source: "ask", message: { id: "m1", threadId: "keeper-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: { ledger: () => fixtureLedger, setHidden: () => ({ ok: true }) } });
  fireEvent.click(await pointer.findByRole("button", { name: "Answer below" }));
  const section = await widget.findByRole("region", { name: "Asks waiting for you" });
  expect(within(section).getByRole("button", { name: /Send Luc the link.*Fold/ })).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(widget.getByRole("button", { name: "1 need you" }));
});

it("does not open for an arriving ask", async () => {
  let asks: typeof fixtureAsk[] = [];
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => withAttention({ ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, openAsks: asks } }), registry: () => fixtureRegistry } });
  await slot.findByRole("button", { name: /Open the Keeper’s ledger/ });
  expect(slot.queryByRole("button", { name: /ask needs you/ })).toBeNull();
  asks = [fixtureAsk];
  await act(async () => { await slot.experimental_invalidateRpc(["tavern:thread:keeper-1"]); });
  const chip = await slot.findByRole("button", { name: /1 need you/ });
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: "Close" })).toBeNull();
  slot.lifecycle.unmount();
});
