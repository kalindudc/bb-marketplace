// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { NeedsYouQueue } from "../../../src/ui/page/asks";
import { CommonRoom } from "../../../src/ui/page/room";
import { fixtureDecor, fixtureLedger, fixtureQuest, fixtureRegistry, fixtureAsk, fixtureMember } from "../../../src/ui/thread/fixtures";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { TavernHomepage, useTavernBadge } from "../../../src/ui/page/register";
import { withAttention } from "../attention-fixture";
import { richRoom } from "./scenes";
const note = { id: "note", keeperThreadId: "keeper-1", boardQuestId: "vault", kind: "waiting-on-user" as const, text: "Approve access", action: "Approve access", dueAt: null, condition: null, validUntil: null, sourceMessageId: null, routeId: null, state: "open" as const, createdAt: 1000, updatedAt: 1000, doneAt: null, dueNotifiedAt: null };
const quest = { ...fixtureQuest, checkerHandoffHold: { id: "hold", routeId: "route", sourceMessageId: "msg", sourceText: "Hold", reason: "Review", createdAt: 1000, release: null } };
const ledger = withAttention({ ...fixtureLedger, boardQuests: [quest], notes: [note], rules: [{ id: "rule", scope: "quest" as const, scopeId: "vault", keeperThreadId: "keeper-1", text: "Confirm rule", active: false, source: "keeper-proposed" as const, createdAt: 1000 }] });
const room = { ...richRoom, attention: ledger.attention, notes: [note], asks: [fixtureAsk], keepers: [{ member: fixtureMember, boardQuests: ledger.boardQuests, errands: [], status: "listening" as const }] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("groups live cards in order, then folds stopped Keepers with its server count", () => {
  const attention = ledger.attention!;
  const extra = { ...attention.items.find(item => item.kind === "rule")!, id: "stopped", who: { state: "archived" as const, startedAt: 0, questTitle: "A stopped quest" } };
  const data = { ...room, attention: { ...attention, needYou: 7, counts: { ask: 1, hold: 1, "hand-back": 1, rule: 1, stopped: 3 }, items: [extra, ...attention.items.slice().reverse()] } };
  const slot = renderSlot({ component: NeedsYouQueue }, { room: data, registry: fixtureRegistry });
  expect([...slot.container.querySelectorAll("#tv-needs-you h3")].map(el => el.textContent)).toEqual(["Asks", "Holds", "Handed back to you", "Rules to confirm", "From stopped Keepers"]);
  const fold = slot.getByRole("heading", { name: "From stopped Keepers" }).closest("details")!;
  expect(fold.open).toBe(false);
  expect(fold.querySelector("summary")?.textContent).toContain("3");
  expect(within(fold).getByText(/changes nothing unless it runs again/i)).toBeTruthy();
});

it("keeps a quiet Keeper's ask in the Asks group with the unchanged band count", () => {
  const keeper = { ...room.keepers[0]!, quietSince: 1000, threadTitle: "A distinct Wren thread" };
  const item = { ...ledger.attention!.items.find(item => item.kind === "ask")!, who: { state: "quiet" as const, startedAt: 1000, questTitle: fixtureQuest.title } };
  const attention = { items: [item], needYou: 1, new: 0, heldByYou: 0, counts: { ask: 1, hold: 0, "hand-back": 0, rule: 0, stopped: 0 } };
  const data = { ...room, keepers: [keeper], attention };
  const slot = renderSlot({ component: () => <CommonRoom room={data} registry={fixtureRegistry} /> }, {});
  const ask = within(slot.getByRole("region", { name: "Asks" }));
  expect(ask.getByText("Quiet")).toBeTruthy();
  expect(ask.getByText("Answering wakes Wren.")).toBeTruthy();
  expect(ask.getByRole("button", { name: "Open Wren's thread" }).title).toBe("A distinct Wren thread");
  expect(ask.queryByText(/only if it runs again/)).toBeNull();
  expect(slot.queryByText("From stopped Keepers")).toBeNull();
  expect(within(slot.getByRole("group", { name: "Status" })).getByRole("button", { name: "1 need you" })).toBeTruthy();
});

it("pairs each answer action with its visible effect in reading order", () => {
  const slot = renderSlot({ component: NeedsYouQueue }, { room, registry: fixtureRegistry });
  slot.container.querySelector<HTMLDetailsElement>(".tv-need-answer")!.open = true;
  const form = slot.container.querySelector(".ask-f")!;
  for (const button of form.querySelectorAll("button")) {
    expect(button.nextElementSibling?.id).toBe(button.getAttribute("aria-describedby"));
  }
});

it("shows at most three asks per group before expanding", () => {
  const asks = Array.from({ length: 12 }, (_, index) => ({ ...fixtureAsk, id: `many-${index}` }));
  const many = withAttention({ ...room, notes: [], asks, keepers: [{ ...room.keepers[0]!, boardQuests: [fixtureQuest] }] });
  const slot = renderSlot({ component: NeedsYouQueue }, { room: many, registry: fixtureRegistry });
  expect(slot.container.querySelectorAll("[data-need-card]")).toHaveLength(3);
  fireEvent.click(slot.getByRole("button", { name: "9 more" }));
  expect(slot.container.querySelectorAll("[data-need-card]")).toHaveLength(12);
});
it("every rendered count surface reads the four-item server view", async () => {
  function Surface() { const badge = useTavernBadge(); return <><span data-testid="badge">{badge?.count} need you</span><ThreadWidget threadId="keeper-1" /><LedgerTab threadId="keeper-1" environment={null} /><NeedsYouQueue room={room} registry={fixtureRegistry} /><TavernHomepage projectId={null} /></>; }
  const slot = renderSlot({ component: Surface }, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry, decor: () => ({ ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, attention: ledger.attention } }), ledger: () => ledger, room: () => room } } as any);
  await slot.findByRole("button", { name: "4 need you: open the Ledger" });
  expect(slot.getByTestId("badge").textContent).toBe("4 need you");
  expect(slot.container.querySelector(".lg-now-line")?.textContent).toContain("4 need you");
  expect(within(slot.container.querySelector(".lg-needs") as HTMLElement).getByText("4 need you")).toBeTruthy();
  expect(slot.container.querySelector("#tv-needs-you > header .tv-count")).toBeNull();
  expect(slot.container.querySelector(".qrow-home .tag")?.textContent).toBe("4 need you");
  expect(slot.getByRole("button", { name: "4 need you" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "4 need you: open the Ledger" }));
  expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: expect.objectContaining({ id: "ledger" }), params: { attentionGroup: "need" } } });
});
