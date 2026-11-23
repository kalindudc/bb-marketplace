// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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

beforeEach(() => localStorage.clear());
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
const reason = "The output path does not belong to the test worktree.";
const observation = { threadId: "keeper-1", providerId: "pi", at: 1000, eventId: "v1", seq: 1, ruleId: "write-path", reason, stopped: false, latencyMs: 1, mode: "watch" as const };

it("folds Guardrails without current alerts and remembers reopening the section", async () => {
  const mount = () => renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => ({ ...fixtureLedger, violations: [observation] }), decor: () => fixtureDecor, registry: () => fixtureRegistry,
  } });
  const slot = mount();
  const guard = await slot.findByRole("region", { name: "Guardrails" });
  const header = within(guard).getByText("Guardrails", { selector: "summary span" });
  const fold = header.closest("details")!;
  expect(fold.open).toBe(false);
  fireEvent.click(header);
  expect(fold.open).toBe(true);
  await waitFor(() => expect(JSON.parse(localStorage.getItem("tavern:view:ledger:keeper-1:view") ?? "{}").folds?.guardrails).toBe(true));
  slot.lifecycle.unmount();
  const reopened = await mount().findByRole("region", { name: "Guardrails" });
  expect(reopened.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
});

it("opens Guardrails for a current alert but folds earlier violations separately", async () => {
  const scope = { threadId: "keeper-1", scope: null, error: "Scope delivery failed", armed: false, pendingAskId: null };
  const violations = Array.from({ length: 16 }, (_, i) => ({ ...observation, at: 1000 + i, eventId: `v${i}` }));
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => ({ ...fixtureLedger, scopes: [scope], violations }), decor: () => fixtureDecor, registry: () => fixtureRegistry,
  } });
  const guard = await slot.findByRole("region", { name: "Guardrails" });
  expect(guard.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
  expect((await within(guard).findByRole("alert")).textContent).toBe("Scope delivery failed");
  const history = within(guard).getByText("16 earlier violations").closest("summary")!;
  expect(history.closest("details")?.open).toBe(false);
  fireEvent.click(history);
  expect(history.closest("details")?.open).toBe(true);
  const rows = within(history.parentElement!).getAllByRole("listitem");
  expect(rows).toHaveLength(16);
  const [row] = rows;
  const badge = within(row!).getByText(observation.ruleId);
  const message = within(row!).getByText(reason);
  const time = row!.querySelector("time");
  expect(badge.tagName).toBe("CODE");
  expect(badge.classList.contains("tag")).toBe(true);
  expect(message.contains(badge)).toBe(false);
  expect(time?.dateTime).toBe(new Date(1015).toISOString());
  expect(message.contains(time)).toBe(false);
  fireEvent.click(history);
  expect(history.closest("details")?.open).toBe(false);
});

it.each(["need", "new", "guard"])("opens the Ledger at its %s group", async group => {
  const targets: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: function(this: Element) { targets.push(this.getAttribute("data-attention-group")!); } });
  try {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null, params: { attentionGroup: group } }, { rpc: { ledger: () => withAttention(fixtureLedger), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await waitFor(() => expect(targets).toEqual([group]));
    if (group === "guard") expect(slot.getByRole("region", { name: "Guardrails" }).querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    slot.lifecycle.unmount();
  } finally {
    if (previous) Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});
