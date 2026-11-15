// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { decisionSchema } from "../../../src/shared/schema";
import { fixtureDecor, fixtureQuest } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);
async function keeperRow(keeperView: Partial<NonNullable<typeof fixtureDecor.keeperView>>) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
  const decor = { ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, ...keeperView } };
  return renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { decor: () => decor } });
}
it("shows no asks or decided chip at zero, and puts holding words in the row's free space, never beside a control", async () => {
  const slot = await keeperRow({ status: "holding", openAsks: [], decidedForYou: [] });
  const words = await slot.findByText((_, e) => e?.classList.contains("tw-sw") === true && e.textContent === "holding while you type");
  expect(words.parentElement?.classList.contains("tw-free")).toBe(true);
  expect(slot.queryByRole("button", { name: /need you|No asks/ })).toBeNull();
  expect(slot.queryByRole("button", { name: /decided for you/i })).toBeNull();
  expect(slot.container.textContent).not.toMatch(/0\s*need you/);
  slot.lifecycle.unmount();
});
it("still shows the asks chip with its count when an ask waits", async () => {
  const slot = await keeperRow({ status: "holding" });
  const chip = await slot.findByRole("button", { name: /1 ask needs you/ });
  expect(chip.textContent).toContain("need you");
  slot.lifecycle.unmount();
});
it("draws the user's desktop state, holding with two long board quests, no asks and one decision, without the words inside any control", async () => {
  const decision = decisionSchema.parse({ id: "d1", keeperThreadId: "keeper-1", boardQuestId: "readme", text: "Checked plugins in name order", why: "Keeps the README diff reviewable", source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: 1000 });
  const quests = [{ ...fixtureQuest, id: "readme", title: "README missing plugins", short: "README missing plugins" }, { ...fixtureQuest, id: "ts-lines", title: "TypeScript lines per plugin", short: "TypeScript lines per plugin" }];
  const slot = await keeperRow({ status: "holding", boardQuests: quests, openAsks: [], decidedForYou: [decision] });
  const words = await slot.findByText((_, e) => e?.classList.contains("tw-sw") === true);
  expect(words.closest("button, .tw-quests, .tw-id")).toBeNull();
  expect(words.parentElement?.classList.contains("tw-free")).toBe(true);
  expect(slot.getAllByRole("button", { name: /Open the quest page for/ })).toHaveLength(2);
  expect((await slot.findByRole("button", { name: /decided for you/i })).textContent).toMatch(/1\s*decided/);
  expect(slot.queryByRole("button", { name: /need you|No asks/ })).toBeNull();
  slot.lifecycle.unmount();
});
it("counts the uncapped decidedCount on the widget row, not the clipped list", async () => {
  const slot = await keeperRow({ status: "listening", openAsks: [], decidedForYou: [decisionSchema.parse({ id: "d1", keeperThreadId: "keeper-1", boardQuestId: null, text: "Picked staging first", why: "Reversible", source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: 1000 })], decidedCount: 12 });
  expect((await slot.findByRole("button", { name: /12 decided for you/ })).textContent).toMatch(/12\s*decided/);
  slot.lifecycle.unmount();
});
