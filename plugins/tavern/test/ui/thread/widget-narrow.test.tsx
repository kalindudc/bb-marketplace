// @vitest-environment jsdom
import { withAttention } from "../attention-fixture";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { decisionSchema } from "../../../src/shared/schema";
import { fixtureDecor, fixtureQuest } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);
async function keeperRow(keeperView: Partial<NonNullable<typeof fixtureDecor.keeperView>>, stop = false) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
  const decor = { ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, ...keeperView } };
  return renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { decor: () => withAttention(decor), resumeKeeper: () => ({ ok: true }), stopAllStatus: () => ({ state: stop ? "stopped" : "running", since: stop ? 1_000 : null, by: null, receipt: null }) } });
}
it("shows no asks or new chip at zero", async () => {
  const slot = await keeperRow({ status: "holding", openAsks: [], decidedForYou: [] });
  await slot.findByRole("button", { name: "Expand Tavern widget" });
  expect(slot.queryByRole("button", { name: /need you|No asks/ })).toBeNull();
  expect(slot.queryByRole("button", { name: /\d+ new/ })).toBeNull();
  expect(slot.container.textContent).not.toMatch(/0\s*need you/);
  slot.lifecycle.unmount();
});
it("names the current journal state in the widget's quest drawer", async () => {
  const quest = { ...fixtureQuest, waypoints: fixtureQuest.waypoints.map(w => ({ ...w, state: "reported" as const })) };
  const slot = await keeperRow({ boardQuests: [quest] });
  try {
    fireEvent.click(await slot.findByRole("button", { name: `Show ${quest.title}` }));
    expect(await slot.findAllByText("Waiting for a check")).toHaveLength(quest.waypoints.length);
  } finally { slot.lifecycle.unmount(); }
});
it("still shows the asks chip with its count when an ask waits", async () => {
  const slot = await keeperRow({ status: "holding" });
  const chip = await slot.findByRole("button", { name: /1 need you/ });
  expect(chip.textContent).toContain("need you");
  slot.lifecycle.unmount();
});
it("shows two long board quests, no asks and one decision from the same row", async () => {
  const decision = decisionSchema.parse({ id: "d1", keeperThreadId: "keeper-1", boardQuestId: "readme", text: "Checked plugins in name order", why: "Keeps the README diff reviewable", source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: 1000 });
  const quests = [{ ...fixtureQuest, id: "readme", title: "README missing plugins", short: "README missing plugins" }, { ...fixtureQuest, id: "ts-lines", title: "TypeScript lines per plugin", short: "TypeScript lines per plugin" }];
  const slot = await keeperRow({ status: "holding", boardQuests: quests, openAsks: [], decidedForYou: [decision] });
  expect(await slot.findByRole("button", { name: "Show README missing plugins and 1 other quest" })).toBeTruthy();
  expect((await slot.findByRole("button", { name: "1 new" })).textContent).toMatch(/1\s*new/);
  expect(slot.queryByRole("button", { name: /need you|No asks/ })).toBeNull();
  slot.lifecycle.unmount();
});
it.each([
  ["Quiet", { quietSince: 1_000 }, false],
  ["Working", { status: "busy" }, false],
  ["Holding", { status: "holding" }, false],
  ["Stopped", { quietSince: 1_000 }, true],
] as const)("shows %s without a second line of state detail", async (word, pose, stop) => {
  const slot = await keeperRow(pose, stop);
  const state = await slot.findByText(word, { selector: ".tw-state" });
  const banner = state.closest(".tw-row")!;
  const identity = state.closest(".tw-id")!;
  expect(identity.getAttribute("title")).toContain(word);
  if (word === "Quiet" || word === "Stopped") expect(identity.getAttribute("title")).toContain("since");
  expect(banner.querySelector("time")).toBeNull();
  expect(slot.container.querySelector(".tw-row + .tquiet")).toBeNull();
  const resume = slot.queryByRole("button", { name: "Resume this Keeper" });
  expect(resume?.closest(".tw-row") ?? null).toBe(word === "Quiet" ? banner : null);
  if (resume) {
    fireEvent.click(resume);
    await waitFor(() => expect(slot.inspection.rpcCalls.find(call => call.method === "resumeKeeper")?.input).toEqual({ threadId: "keeper-1" }));
  }
});

it("counts the uncapped decidedCount on the widget row, not the clipped list", async () => {
  const slot = await keeperRow({ status: "listening", openAsks: [], decidedForYou: [decisionSchema.parse({ id: "d1", keeperThreadId: "keeper-1", boardQuestId: null, text: "Picked staging first", why: "Reversible", source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: 1000 })], attention: { items: [], needYou: 0, new: 12, heldByYou: 0 } });
  expect((await slot.findByRole("button", { name: /12 new/ })).textContent).toMatch(/12\s*new/);
  slot.lifecycle.unmount();
});
