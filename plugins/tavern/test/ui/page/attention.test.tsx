// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { NeedsYouQueue } from "../../../src/ui/page/asks";
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
it("every rendered count surface reads the four-item server view", async () => {
  function Surface() { const badge = useTavernBadge(); return <><span data-testid="badge">{badge?.count} need you</span><ThreadWidget threadId="keeper-1" /><LedgerTab threadId="keeper-1" environment={null} /><NeedsYouQueue room={room} registry={fixtureRegistry} /><TavernHomepage projectId={null} /></>; }
  const slot = renderSlot({ component: Surface }, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry, decor: () => ({ ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, attention: ledger.attention } }), ledger: () => ledger, room: () => room } } as any);
  await slot.findByRole("button", { name: "4 need you: open the Ledger" });
  expect(slot.getByTestId("badge").textContent).toBe("4 need you");
  expect(slot.container.querySelector(".lg-now-line")?.textContent).toContain("4 need you");
  expect(within(slot.container.querySelector(".lg-needs") as HTMLElement).getByText("4 need you")).toBeTruthy();
  expect(slot.container.querySelector("#tv-needs-you .tv-count")?.textContent).toContain("4 need you");
  expect(slot.container.querySelector(".qrow-home .tag")?.textContent).toBe("4 need you");
  expect(slot.getByRole("button", { name: "4 need you" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "4 need you: open the Ledger" }));
  expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: expect.objectContaining({ id: "ledger" }), params: { attentionGroup: "need" } } });
});
