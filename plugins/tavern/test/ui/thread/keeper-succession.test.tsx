import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { KeeperNotice } from "../../../src/ui/page/board";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureLedger, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registry, richRoom } from "../page/scenes";

const succession = { id: "succession-test", finishRequired: false, requestedByKeeper: false, predecessor: "keeper-1", successor: "successor", current: "successor", state: "done" as const, requestedAt: Date.now() - 60000, cutoverAt: Date.now(), reason: "You asked to refresh this Keeper.", problem: null, followupsPending: false };

it("requests refresh from the Keeper card", async () => {
  const refreshKeeper = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = renderSlot({ component: () => <div className="tavern tv-page"><KeeperNotice keeper={richRoom.keepers[0]!} room={richRoom} registry={registry} api={{ hidden: new Set() } as never} lit={false} /></div> }, {}, { rpc: { refreshKeeper } });
  const markup = slot.container.innerHTML;
  fireEvent.click(await slot.findByRole("button", { name: "Refresh Keeper" }));
  expect(refreshKeeper).not.toHaveBeenCalled();
  if (process.env.TAVERN_SUCCESSION_LAYOUT === "1") process.stdout.write(`SUCCESSION_CONFIRM=${JSON.stringify(slot.container.innerHTML)}\n`);
  fireEvent.click(await slot.findByRole("button", { name: "Hand over to a fresh Keeper" }));
  await waitFor(() => expect(refreshKeeper.mock.calls[0]?.[0]).toEqual({ threadId: richRoom.keepers[0]!.member.threadId }));
  if (process.env.TAVERN_SUCCESSION_LAYOUT === "1") process.stdout.write(`SUCCESSION_CARD=${JSON.stringify(markup)}\n`);
  slot.lifecycle.unmount();
});

it("shows one notice and lets the user cancel a Keeper-requested refresh", async () => {
  const cancelKeeperRefresh = vi.fn((_input: unknown) => ({ ok: true }));
  const keeper = { ...richRoom.keepers[0]!, succession: { ...succession, current: richRoom.keepers[0]!.member.threadId, state: "recovering" as const, requestedByKeeper: true } };
  const slot = renderSlot({ component: () => <KeeperNotice keeper={keeper} room={richRoom} registry={registry} api={{ hidden: new Set() } as never} lit={false} /> }, {}, { rpc: { cancelKeeperRefresh } });
  expect(slot.getAllByText("The Keeper requested this refresh.")).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Cancel refresh" }));
  await waitFor(() => expect(cancelKeeperRefresh.mock.calls[0]?.[0]).toEqual({ threadId: keeper.member.threadId, successionId: succession.id }));
  slot.lifecycle.unmount();
});

it("keeps the retired draft intact and links to the live Keeper even when the Tavern row is hidden", async () => {
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, {
    composer: { scope: { kind: "thread", threadId: "keeper-1" }, text: "Do not lose this draft" },
    rpc: { decor: () => ({ ...fixtureDecor, hidden: true, widgetRow: false, succession }), registry: () => fixtureRegistry },
  });
  const link = await slot.findByRole("button", { name: "Open the current Keeper" });
  expect(slot.inspection.composer.inputLocked).toBe(true);
  expect(slot.inspection.composer.text).toBe("Do not lose this draft");
  expect(slot.getByText(/Send now.*already-queued/i)).toBeTruthy();
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "successor" });
  if (process.env.TAVERN_SUCCESSION_LAYOUT === "1") process.stdout.write(`SUCCESSION_COMPOSER=${JSON.stringify(slot.container.innerHTML)}\n`);
  slot.lifecycle.unmount();
});

it("records the handover and its limits in the Ledger", async () => {
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => ({ ...fixtureLedger, boardQuests: [], asks: [], lastReanchorAt: Date.now(), succession }), decor: () => fixtureDecor, registry: () => fixtureRegistry,
  } });
  expect(await slot.findByRole("heading", { name: "Keeper succession" })).toBeTruthy();
  expect(slot.getByText(/other plugins.*do not move/i)).toBeTruthy();
  if (process.env.TAVERN_SUCCESSION_LAYOUT === "1") process.stdout.write(`SUCCESSION_LEDGER=${JSON.stringify(slot.container.innerHTML)}\n`);
  slot.lifecycle.unmount();
});
