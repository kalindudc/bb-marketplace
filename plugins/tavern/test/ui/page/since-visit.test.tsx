import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import type { Room } from "../../../src/shared/contract";
import { CommonRoom } from "../../../src/ui/page/room";
import { QuestPage } from "../../../src/ui/page/quest";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureLedger, fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { min, registry, richRoom, richDetails } from "./scenes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const item = { questId: "vault", keeperThreadId: "thr-wren", since: min(8), action: "Open", seen: false };
const summary = { ...item, id: "summary-result", kind: "summary" as const, title: "Watch ended without alerts" };
const change = { ...item, id: "quest-change:9", kind: "quest-changed" as const, title: "Vault cutover", phaseChange: { from: "greenlight" as const, to: "build" as const } };
const sinceVisit: NonNullable<Room["sinceVisit"]> = {
  summaries: 1, decided: 1, changedQuests: 2, quests: [{ id: "vault", title: "Vault cutover", summaries: [summary], change }, { id: "audit", title: "Edge resiliency watch", summaries: [], change: { ...change, id: "quest-change:13", questId: "audit", phaseChange: { from: "build", to: "held" } } }],
};
const room = { ...richRoom, sinceVisit };

it("groups summary links and phase facts by quest, with one exact acknowledgement", async () => {
  const markVisitSeen = vi.fn(() => ({ ok: true }));
  const slot = renderSlot({ component: CommonRoom }, { room, registry }, { rpc: { markVisitSeen } });
  const block = await slot.findByRole("region", { name: "Since your last visit" });
  expect(block.previousElementSibling?.querySelector(".tv-hearth-band")).toBeTruthy();
  expect(slot.container.querySelector(".tv-since")).toBeNull();
  const region = within(block);
  expect(region.getByText("Greenlight to Build")).toBeTruthy();
  expect(region.getByRole("button", { name: "Watch ended without alerts" })).toBeTruthy();
  const calls = region.getByRole("button", { name: "1 call decided for you" });
  fireEvent.click(calls);
  expect(document.activeElement?.closest("#rm-decided")).toBeTruthy();
  expect(region.queryByRole("button", { name: /OK:/i })).toBeNull();
  fireEvent.click(region.getByRole("button", { name: "Mark all seen" }));
  await waitFor(() => expect(markVisitSeen).toHaveBeenCalledWith({ summaryIds: [summary.id], changeIds: [change.id, "quest-change:13"] }));
});

it("folds the visit into one count line on a narrow room with work needing you, and expands in place", () => {
  vi.stubGlobal("matchMedia", vi.fn(query => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} })));
  const attention = { items: [], new: 2, decided: 1, needYou: 1, heldByYou: 0 };
  const slot = renderSlot({ component: CommonRoom }, { room: { ...room, attention }, registry });
  const summary = slot.getByText("Since your last visit: 1 summary, 2 quests changed");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  expect(details.previousElementSibling?.querySelector(".tv-hearth-band")).toBeTruthy();
  fireEvent.click(summary.closest("summary")!);
  expect(details.open).toBe(true);
  expect(within(details).getByRole("button", { name: "Watch ended without alerts" })).toBeTruthy();
});

it("keeps the full visit visible on a narrow room when nothing needs you", () => {
  vi.stubGlobal("matchMedia", vi.fn(query => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} })));
  const slot = renderSlot({ component: CommonRoom }, { room, registry });
  const visit = slot.getByRole("region", { name: "Since your last visit" });
  expect(visit.closest("details")).toBeNull();
  expect(within(visit).getByRole("button", { name: "Watch ended without alerts" })).toBeTruthy();
});

it("acknowledges the exact phase change on opening the quest", async () => {
  const markVisitSeen = vi.fn(() => ({ ok: true }));
  renderSlot({ component: QuestPage }, { detail: { ...richDetails.vault!, visitChangeId: change.id }, registry, room }, { rpc: { markVisitSeen } });
  await waitFor(() => expect(markVisitSeen).toHaveBeenCalledWith({ summaryIds: [], changeIds: [change.id] }));
});

it("does not show a visit block when all three lists have been seen", () => {
  const slot = renderSlot({ component: CommonRoom }, { room: { ...room, sinceVisit: { summaries: 0, decided: 0, changedQuests: 0, quests: [] } }, registry });
  expect(slot.queryByRole("region", { name: "Since your last visit" })).toBeNull();
  expect(slot.container.querySelector(".rm-sline")?.nextElementSibling?.id).toBe("tv-away-notes");
});

it.each([[0, 0, "0 new (0 summaries, 0 unseen calls)"], [2, 1, "3 new (2 summaries, 1 unseen call)"]])("labels the Ledger's %i summaries and %i calls separately", async (summaries, decided, words) => {
  const attention = { items: [], new: summaries + decided, summaries, decided, needYou: 0, heldByYou: 0 };
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { registry: () => fixtureRegistry, decor: () => fixtureDecor, ledger: () => ({ ...fixtureLedger, attention }) } });
  expect((await slot.findByLabelText("What the Keeper knows now")).textContent).toContain(words);
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the visit block from the room fixture", async () => {
  const slot = renderSlot({ component: CommonRoom }, { room, registry });
  const section = await slot.findByRole("region", { name: "Since your last visit" });
  process.stdout.write("SB2_VISIT=" + JSON.stringify({ visit: section.outerHTML }) + "\n");
  slot.lifecycle.unmount();
});
