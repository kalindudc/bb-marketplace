// @vitest-environment jsdom
import { withAttention } from "../attention-fixture";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { clearThreadState, revealAsk } from "../../../src/ui/thread/state";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { askSchema, checkerHandoffHoldSchema } from "../../../src/shared/schema";
import { fixtureAsk, fixtureDecor, fixtureLedger, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";

afterEach(() => { cleanup(); clearThreadState(); });
const hold = checkerHandoffHoldSchema.parse({ id: "hold-1", routeId: "route-1", sourceMessageId: "msg-1", sourceText: "Don't hand the vault check to a Warden until I've looked", reason: "You asked to look before any Warden checks the cutover", createdAt: Date.now() - 60_000, release: null });
const heldQuest = { ...fixtureQuest, phase: "build" as const, checkerHandoffHold: hold };
const releaseAsk = askSchema.parse({ ...fixtureAsk, id: "release-1", kind: "blocker", question: "Release the checker handoff on Vault?", draft: null, releaseHoldId: hold.id, options: [{ id: "release", label: "Release", detail: "", recommended: true }, { id: "keep-held", label: "Keep it held", detail: "", recommended: false }] });
type View = Partial<NonNullable<typeof fixtureDecor.keeperView>>;
const decorWith = (keeperView: View, hidden = false) => withAttention({ ...fixtureDecor, hidden, keeperView: { ...fixtureDecor.keeperView!, openAsks: [], ...keeperView } });

async function keeperRow(keeperView: View, rpc: Record<string, unknown> = {}) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
  return renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { decor: () => decorWith(keeperView), registry: () => fixtureRegistry, ...rpc } });
}
const released = (via: "banner" | "page", askId: string | null = null) => ({ checkerHandoffHold: { ...hold, release: { at: Date.now(), via, askId } } });

describe("the checker-handoff hold in the Keeper's widget row", () => {
  it("counts the hold on the asks chip, and draws it in the panel with its reason, its source and one release control", async () => {
    const slot = await keeperRow({ boardQuests: [heldQuest] });
    const chip = await slot.findByRole("button", { name: /1 need you: open the Ledger/ });
    expect(chip.textContent).toMatch(/1\s*need you/);
    expect(chip.hasAttribute("data-ask")).toBe(true);
    act(() => revealAsk("keeper-1", `hold:${hold.id}`));
    const panel = await slot.findByRole("region", { name: "Asks waiting for you" });
    // The only item opens by itself, as a single ask does.
    const row = within(panel).getByRole("button", { name: /Checker handoff/, expanded: true });
    expect(row.textContent).toContain(hold.reason);
    expect(row.textContent).toContain("Vault");
    expect(row.closest("[data-ask]")).not.toBeNull();
    expect(panel.textContent).toContain("No Warden is hired or re-tasked on this quest until you release it.");
    expect(panel.textContent).toContain(`from your message: “${hold.sourceText}”`);
    expect(within(panel).getAllByRole("button", { name: "Release checker handoff" })).toHaveLength(1);
    // Never animated: nothing in the hold carries a motion class.
    expect(panel.querySelector("[class*='mo-']")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("releases it from the banner and shows the server's receipt in words, which stays after the hold clears", async () => {
    const slot = await keeperRow({ boardQuests: [heldQuest] }, { releaseCheckerHandoff: () => released("banner") });
    act(() => revealAsk("keeper-1", `hold:${hold.id}`));
    fireEvent.click(await slot.findByRole("button", { name: "Release checker handoff" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((c: { method: string }) => c.method === "releaseCheckerHandoff")).toMatchObject({ input: { boardQuestId: "vault", holdId: "hold-1", via: "banner" } }));
    const receipt = await slot.findByRole("status", { name: /Checker handoff released: Vault/ });
    expect(receipt.textContent).toMatch(/^Checker handoff releasedat \S.*, from the ask banner\. The Keeper can hand the work to a Warden now\.$/);
    expect(receipt.querySelector("b")!.textContent).toBe("Checker handoff released");
    expect(slot.queryByRole("button", { name: "Release checker handoff" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("says a refusal in words and keeps the control", async () => {
    const slot = await keeperRow({ boardQuests: [heldQuest] }, { releaseCheckerHandoff: () => { throw new Error("This checker-handoff hold is no longer current; read the quest again"); } });
    act(() => revealAsk("keeper-1", `hold:${hold.id}`));
    fireEvent.click(await slot.findByRole("button", { name: "Release checker handoff" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toMatch(/^Couldn’t release it: .*no longer current; read the quest again$/);
    expect(slot.getByRole("button", { name: "Release checker handoff" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("counts the hold once when the Keeper's release ask stands for it, and names that ask a checker handoff", async () => {
    const slot = await keeperRow({ boardQuests: [heldQuest], openAsks: [releaseAsk] });
    act(() => revealAsk("keeper-1", releaseAsk.id));
    const panel = await slot.findByRole("region", { name: "Asks waiting for you" });
    expect(within(panel).getByRole("button", { name: /Checker handoff/ }).textContent).toContain(releaseAsk.question);
    expect(within(panel).queryByRole("button", { name: "Release checker handoff" })).toBeNull();
    expect(panel.textContent).not.toContain("Blocker");
    slot.lifecycle.unmount();
  });

  it("draws nothing for a released hold, or on a quest that takes no more work", async () => {
    for (const quest of [{ ...heldQuest, checkerHandoffHold: released("page").checkerHandoffHold }, { ...heldQuest, phase: "stopping" as const }, { ...heldQuest, phase: "done" as const }]) {
      const slot = await keeperRow({ boardQuests: [quest] });
      await slot.findByRole("button", { name: /Open the Keeper’s ledger/ });
      expect(slot.queryByRole("button", { name: /need you/ })).toBeNull();
      slot.lifecycle.unmount();
    }
  });

  it("holds the row's motion still while a hold waits, as it does for an ask", async () => {
    const slot = await keeperRow({ boardQuests: [heldQuest], status: "busy" });
    await slot.findByRole("button", { name: /1 need you/ });
    const motion = (window as unknown as { __tavernMotion?: { held: string[] } }).__tavernMotion;
    expect(motion?.held).toContain("thread:keeper-1");
    expect(slot.container.querySelector(".mo-pulse")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("counts the hold on the composer's crest while the row is hidden", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const action = app.composerCustomizations.find(c => c.id === "tavern-thread")!.actions![0]!;
    const toggle = renderSlot(action, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { decor: () => decorWith({ boardQuests: [heldQuest] }, true), registry: () => fixtureRegistry } });
    const button = await toggle.findByRole("button", { name: "Show Tavern · 1 need you" });
    expect(button.textContent).toContain("1");
    toggle.lifecycle.unmount();
  });
});

describe("the checker-handoff hold in the Ledger", () => {
  it("lists it under Needs you with its own count, and points to the row above the composer to release it", async () => {
    const ledger = { ...fixtureLedger, asks: [], boardQuests: [heldQuest] };
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => withAttention(ledger), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const needs = await slot.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("1 need you")).toBeTruthy();
    const row = within(needs).getByRole("button", { name: /Checker handoff on hold/ });
    expect(row.getAttribute("title")).toContain("release it in the Tavern row above the composer");
    expect(row.textContent).toContain("Vault");
    expect(slot.container.querySelector(".lg-now-line")!.textContent).toContain("1 need you");
    slot.lifecycle.unmount();
  });
});
