// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { clearThreadState } from "../../../src/ui/thread/state";
import { fixtureDecor, fixtureRegistry, fixtureAsk, fixtureMember } from "../../../src/ui/thread/fixtures";
import { withAttention } from "../attention-fixture";
import type { ThreadDecor } from "../../../src/shared/contract";

afterEach(() => { cleanup(); clearThreadState(); });

const memberId = "fixture-member";
const keeperId = fixtureMember.threadId;
const ask = { ...fixtureAsk, kind: "decision" as const, question: "Use the northern survey?", draft: null, options: [{ id: "north", label: "Use the northern survey", detail: "", recommended: true }] };
const memberDecor: ThreadDecor = {
  ...fixtureDecor, threadId: memberId, ambientMotion: "off", voice: "off",
  member: { ...fixtureMember, threadId: memberId, role: "member", keeperThreadId: keeperId, state: "working" },
  keeper: fixtureMember, keeperView: null,
};
const regionName = "Asks waiting for you";

function mount(blocked = false) {
  let pending = !blocked;
  const answerAsk = vi.fn(() => { pending = false; return { ok: true }; });
  const setHidden = vi.fn(() => ({ ok: true }));
  const slot = renderSlot({ component: () => <>
    <ThreadWidget threadId={memberId} />
    <ThreadWidget threadId={keeperId} />
  </> }, {}, { rpc: { registry: () => fixtureRegistry, answerAsk, setHidden, decor: input => {
    const { threadId } = input as { threadId: string };
    if (threadId === keeperId) return withAttention({ ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, openAsks: pending ? [ask] : [] } });
    return { ...memberDecor, memberAsks: pending ? [ask] : [], ...(blocked ? {
      moodSignals: { released: false, archived: false, handBack: false, report: { status: "needs-decision", createdAt: 1000 }, verdict: null },
      violations: [{ threadId, providerId: "fixture", at: 1000, eventId: "fixture-block", seq: 1, ruleId: "read-only", reason: "The path is out of scope", stopped: true, latencyMs: 1, mode: "enforce" }],
    } : {}) };
  } } });
  return {
    slot, answerAsk, setHidden,
    member: () => within(slot.container.querySelector(".v-member")!),
    keeper: () => within(slot.container.querySelector(".v-keeper")!),
    refresh: () => act(async () => { await slot.experimental_invalidateRpc([`tavern:thread:${memberId}`, `tavern:thread:${keeperId}`]); }),
  };
}

it("opens the same answer form in a member thread and clears the ask from both threads after answering", async () => {
  const widget = mount();
  await widget.slot.findByRole("button", { name: /Member: show/ });
  expect(widget.slot.container.querySelector(".twalk-need")?.textContent).toBe("!");
  const chip = widget.member().getByRole("button", { name: "1 need you" });
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(widget.keeper().getByRole("button", { name: "1 need you" })).toBeTruthy();
  fireEvent.click(chip);
  const panel = widget.member().getByRole("region", { name: regionName });
  fireEvent.click(within(panel).getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(widget.answerAsk).toHaveBeenCalledWith({ askId: ask.id, optionId: "north", note: null, via: "banner" }));
  await widget.refresh();
  await within(panel).findByRole("status", { name: /Ask answered:/ });
  expect(widget.member().queryByRole("button", { name: /need you/ })).toBeNull();
  expect(widget.keeper().queryByRole("button", { name: /need you/ })).toBeNull();
  expect(widget.slot.container.querySelector(".twalk-need")).toBeNull();
});

it("opens the member's ask from the character badge and can reveal that exact ask in the Keeper's widget", async () => {
  const widget = mount();
  const badge = await widget.slot.findByText("!", { selector: ".twalk-need" });
  fireEvent.click(badge);
  const region = widget.member().getByRole("region", { name: regionName });
  expect(within(region).getByRole("button", { name: "Send answer" })).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Open in Keeper" }));
  await waitFor(() => expect(widget.slot.inspection.navigateCalls).toHaveLength(1));
  const keeperPanel = widget.keeper().getByRole("region", { name: regionName });
  expect(within(keeperPanel).getByRole("button", { name: /Use the northern survey/, expanded: true })).toBeTruthy();
  expect(widget.answerAsk).not.toHaveBeenCalled();
});

it("keeps a Keeper-owned block in scope details without a need-you chip or character badge", async () => {
  const widget = mount(true);
  await widget.slot.findByRole("button", { name: /Member, 1 scope alert:/ });
  expect(widget.member().queryByRole("button", { name: /need you/ })).toBeNull();
  expect(widget.slot.container.querySelector(".twalk-need")).toBeNull();
});
