// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureDetail, fixtureLedger, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { QuestPage } from "../../../src/ui/page/quest";
import { KeeperNotice } from "../../../src/ui/page/board";
import { CommonRoom, StatusLine } from "../../../src/ui/page/room";
import { withAttention } from "../attention-fixture";
import { richRoom } from "./scenes";
const hold = { id: "hold", routeId: "route", sourceMessageId: "msg", sourceText: "Hold checking", reason: "Review first", createdAt: 1, release: null };
const note = { id: "note", keeperThreadId: "keeper-1", boardQuestId: "vault", kind: "waiting-on-user" as const, text: "External access", action: "Approve access", validUntil: 1, state: "open" as const, createdAt: 2, updatedAt: 2, sourceMessageId: null, routeId: null, condition: null, dueAt: null, doneAt: null, dueNotifiedAt: null };
const data = withAttention({ ...fixtureLedger, boardQuests: [{ ...fixtureQuest, phase: "held" as const, held: { from: "build" as const, since: 1 }, checkerHandoffHold: hold }], notes: [note], rules: [{ id: "rule", scope: "keeper" as const, scopeId: "keeper-1", text: "Confirm rule", source: "keeper-proposed" as const, active: false, createdAt: 3 }] });
afterEach(cleanup);
it("every counted kind has a visible control, including a checker hold inside Held by you", async () => {
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => data, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
  const needs = await slot.findByRole("region", { name: "Needs you" });
  const held = slot.getByRole("region", { name: "Held by you" });
  const controls = { ask: within(needs).getByRole("button", { name: /Send Luc the link/ }), hold: within(held).getByRole("button", { name: "Release checker handoff" }), rule: within(needs).getByRole("button", { name: /Confirm the rule/ }), "hand-back": within(needs).getByRole("button", { name: "Done" }), held: within(held).getByRole("button", { name: "Resume" }) };
  for (const item of data.attention!.items) expect(controls[item.kind as keyof typeof controls]).toBeTruthy();
  expect(slot.getByText("expired, Done to clear")).toBeTruthy();
});
it("a typed release ask without the legacy field renders once", async () => {
  const ledger = withAttention({ ...data, asks: [{ ...data.asks[0]!, id: "release", question: "Release checking", effect: { type: "release-hold" as const, holdId: hold.id } }] });
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ledger, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
  const needs = await slot.findByRole("region", { name: "Needs you" });
  expect(within(needs).getAllByRole("button", { name: /Release checking/ })).toHaveLength(1);
  expect(slot.queryByRole("button", { name: "Release checker handoff" })).toBeNull();
});
it("Show older loads the next closed-ask page without hiding open items", async () => {
  const closed = { ...fixtureLedger.asks[0]!, id: "closed", state: "answered" as const };
  const ledger = withAttention({ ...fixtureLedger, asks: [...fixtureLedger.asks, closed], asksNextCursor: "50" });
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ledger, decor: () => fixtureDecor, registry: () => fixtureRegistry, askHistory: () => ({ asks: [{ ...closed, id: "older", question: "An older closed ask" }], nextCursor: null }) } });
  const summary = await slot.findByText("Past asks");
  fireEvent.click(summary);
  fireEvent.click(slot.getByRole("button", { name: "Show older" }));
  expect(await slot.findByText("An older closed ask")).toBeTruthy();
  expect(slot.getByRole("region", { name: "Needs you" })).toBeTruthy();
});
it("By whose move, Keeper calls, oldest and calm use totals rather than preview lengths", async () => {
  const attention = { ...data.attention!, new: 1000, decided: 1000, oldest: 2 };
  const keeper = { ...richRoom.keepers[0]!, boardQuests: data.boardQuests, attention: { ...attention, items: [] } };
  const room = { ...richRoom, attention, keepers: [keeper], decidedForYou: [], asks: [] };
  const detail = { ...fixtureDetail, attention, quest: { ...data.boardQuests[0]!, phase: "build" as const } };
  const api = { hidden: new Set<string>(), shown: new Set<string>(), pending: false, receipt: null, error: null, archive: async () => {}, restore: async () => {}, undo: () => {}, clear: () => {} };
  function Surface() { return <><QuestPage detail={detail} registry={fixtureRegistry} /><KeeperNotice keeper={keeper} room={room} registry={fixtureRegistry} api={api} lit={false} /><StatusLine room={room} registry={fixtureRegistry} /><CommonRoom room={room} registry={fixtureRegistry} /></>; }
  const slot = renderSlot({ component: Surface }, {}, { rpc: { registry: () => fixtureRegistry, room: () => room } });
  expect(slot.container.querySelector(".rm-notice .tv-decided-tag")?.textContent).toContain("1000 decided");
  expect(slot.container.querySelector(".rm-oldest")?.getAttribute("title")).toBe(new Date(2).toLocaleString());
  expect(slot.container.querySelector(".rm-calm")).toBeNull();
  const move = slot.getByRole("heading", { name: "By whose move" }).closest("section")!;
  expect(move.querySelector(".tv-count")?.textContent).toBe(`${attention.needYou} need you`);
});
