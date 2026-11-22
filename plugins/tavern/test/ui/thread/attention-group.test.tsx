// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureLedger, fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { withAttention } from "../attention-fixture";
it("handles decor resolving to a member after the Ledger has rendered its loading state", async () => {
  let resolve!: (value: typeof fixtureDecor) => void;
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => withAttention(fixtureLedger), decor: () => new Promise(r => { resolve = r; }), registry: () => fixtureRegistry,
  } });
  await slot.findByLabelText("What the Keeper knows now");
  resolve({ ...fixtureDecor, member: { ...fixtureDecor.member!, role: "member" }, keeperView: null });
  expect(await slot.findByText("The ledger belongs to Keeper threads.")).toBeTruthy();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps both guard details in the Ledger", async () => {
  const scope = { threadId: "keeper-1", scope: null, error: null, armed: true, pendingAskId: null, clusterGuard: "not-prevented" as const, sendGuard: "armed" as const };
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => ({ ...fixtureLedger, scopes: [scope] }), decor: () => ({ ...fixtureDecor, scope }), registry: () => fixtureRegistry,
  } });
  const guard = await slot.findByRole("region", { name: "Guardrails" });
  expect(within(guard).getByText("cluster writes not prevented")).toBeTruthy();
  expect(within(guard).getByText("Listed sends are prevented")).toBeTruthy();
});
it.each(["need", "new", "guard"])("opens the Ledger at its %s group", async group => {
  const targets: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: function(this: Element) { targets.push(this.getAttribute("data-attention-group")!); } });
  try {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null, params: { attentionGroup: group } }, { rpc: { ledger: () => withAttention(fixtureLedger), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await waitFor(() => expect(targets).toEqual([group]));
    slot.lifecycle.unmount();
  } finally {
    if (previous) Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});
