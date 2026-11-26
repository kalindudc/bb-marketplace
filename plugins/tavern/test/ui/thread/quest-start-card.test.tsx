import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import { AskCard } from "../../../src/ui/kit/ask-card";
import type { Ask } from "../../../src/shared/schema";
import { ClassBanner } from "../../../src/ui/thread/composer";
import { fixtureGreenlight } from "../../../src/ui/thread/fixtures";

const goal = "Publish the site\nKeep the previous version available.";
const ask: Ask = { ...fixtureGreenlight, kind: "decision", question: "Where should this goal go?", proceedAt: null,
  effect: { type: "quest-start", sourceMessageId: "goal", routeId: "route", parentQuestId: "parent", projectId: "p-target", goal },
  options: [
    { id: "side-quest", label: "Side quest under Takeover", detail: "Keep talking here.", recommended: false },
    { id: "new-keeper", label: "New Keeper thread", detail: "Opens a draft. Nothing is sent.", recommended: false },
  ],
};
const open = { method: "toCompose", options: { projectId: "p-target", focusPrompt: true, initialPrompt: goal } };

it("opens the same-project draft only after the explicit New Keeper answer, without submitting", async () => {
  const answerAsk = vi.fn(() => ({ ok: true })), onFold = vi.fn();
  const slot = renderSlot({ component: AskCard }, { ask, onFold }, { rpc: { answerAsk }, composer: { scope: { kind: "thread", threadId: "lead" }, text: "A reply stays here" } });
  try {
    expect(slot.getByText(/Keep the previous version available/)).toBeTruthy();
    if (process.env.TAVERN_LAYOUT_HARNESS === "1") process.stdout.write(`CHOICE_LAYOUT=${JSON.stringify(slot.container.innerHTML)}\n`);
    fireEvent.click(slot.getByRole("button", { name: "Not now" }));
    expect(onFold).toHaveBeenCalledOnce();
    expect(answerAsk).not.toHaveBeenCalled();
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("radio", { name: /New Keeper thread/ }));
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await slot.findByRole("button", { name: "Open Keeper draft" });
    expect(answerAsk).toHaveBeenCalledOnce();
    expect(slot.inspection.navigateCalls).toEqual([open]);
    fireEvent.click(slot.getByRole("button", { name: "Open Keeper draft" }));
    expect(slot.inspection.navigateCalls).toEqual([open, open]);
    expect(answerAsk).toHaveBeenCalledOnce();
    expect(slot.inspection.composer.text).toBe("A reply stays here");
    expect(slot.inspection.composer.submits).toEqual([]);
  } finally { slot.lifecycle.unmount(); }
});

it("tags only the prefilled project draft as Keeper when the composer opens", async () => {
  const answered: Ask = { ...ask, state: "answered", answer: { optionId: "new-keeper", by: "user", via: "page", at: 1, note: null } };
  const source = renderSlot({ component: AskCard }, { ask: answered });
  const slots = [source];
  try {
    fireEvent.click(source.getByRole("button", { name: "Open Keeper draft" }));
    const unrelated = renderSlot({ component: ClassBanner }, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p-target" }, text: "Unrelated unsent notes" } });
    const target = renderSlot({ component: ClassBanner }, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p-target" }, text: goal } });
    slots.push(unrelated, target);
    await waitFor(() => expect(target.inspection.composer.text).toBe(`Keeper ${goal}`));
    expect(unrelated.inspection.composer.text).toBe("Unrelated unsent notes");
    expect(target.inspection.composer.submits).toEqual([]);
  } finally { for (const slot of slots) slot.lifecycle.unmount(); }
});

it("records Side quest without opening another composer", async () => {
  const answerAsk = vi.fn(() => ({ ok: true }));
  const slot = renderSlot({ component: AskCard }, { ask }, { rpc: { answerAsk } });
  try {
    fireEvent.click(slot.getByRole("radio", { name: /Side quest under Takeover/ }));
    fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await slot.findByRole("status", { name: `Ask answered: ${ask.question}` });
    expect(answerAsk).toHaveBeenCalledOnce();
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.inspection.composer.submits).toEqual([]);
  } finally { slot.lifecycle.unmount(); }
});
