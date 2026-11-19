// @vitest-environment jsdom
import { withAttention } from "../attention-fixture";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { clearThreadState, revealAsk } from "../../../src/ui/thread/state";
import { fixtureDecor, fixtureRegistry, fixtureAsk } from "../../../src/ui/thread/fixtures";

afterEach(() => { cleanup(); clearThreadState(); });
function row(threadId = "keeper-1", asks = [fixtureAsk]) {
  return renderSlot({ component: ThreadWidget }, { threadId }, { rpc: { decor: () => withAttention({ ...fixtureDecor, threadId, keeperView: { ...fixtureDecor.keeperView!, openAsks: asks } }), registry: () => fixtureRegistry } });
}
it("consumes a reveal once: close, switch threads, and remount stays closed", async () => {
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
  await waitFor(() => expect(chip.getAttribute("aria-expanded")).toBeNull());
  expect(back.queryByRole("button", { name: "Close" })).toBeNull();
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  expect(await back.findByRole("button", { name: "Close" })).toBeTruthy();
  back.lifecycle.unmount();
});
it("does not replay a handled reveal into the inner ask on remount", async () => {
  const asks = [fixtureAsk, { ...fixtureAsk, id: "second", question: "A second ask?" }];
  act(() => revealAsk("keeper-1", fixtureAsk.id));
  const first = row("keeper-1", asks);
  const askRow = await first.findByRole("button", { name: /Send Luc the link.*Fold/ });
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
it("the need-you chip opens the Ledger rather than counting a private ask panel", async () => {
  const slot = row();
  fireEvent.click(await slot.findByRole("button", { name: /1 need you/ }));
  expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: expect.objectContaining({ id: "ledger" }), params: { attentionGroup: "need" } } });
  slot.lifecycle.unmount();
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
it("does not open for an arriving ask", async () => {
  let asks: typeof fixtureAsk[] = [];
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => withAttention({ ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, openAsks: asks } }), registry: () => fixtureRegistry } });
  await slot.findByRole("button", { name: /Open the Keeper’s ledger/ });
  expect(slot.queryByRole("button", { name: /ask needs you/ })).toBeNull();
  asks = [fixtureAsk];
  await act(async () => { await slot.experimental_invalidateRpc(["tavern:thread:keeper-1"]); });
  const chip = await slot.findByRole("button", { name: /1 need you/ });
  expect(chip.getAttribute("aria-expanded")).toBeNull();
  expect(slot.queryByRole("button", { name: "Close" })).toBeNull();
  slot.lifecycle.unmount();
});
