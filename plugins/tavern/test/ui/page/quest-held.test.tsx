import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { rpcContract, type BoardQuestSummary, type BoardQuestDetail, type Room, type ThreadDecor } from "../../../src/shared/contract";
import { QuestRow as BoardRow } from "../../../src/ui/kit/rows";
import { graphFor } from "../../../src/ui/page/model";
import { registerPageSurfaces, TavernHomepage } from "../../../src/ui/page/register";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { clearThreadState } from "../../../src/ui/thread/state";
import { registerRpc } from "../../../src/server/rpc";
import { setup } from "../../server/runtime-fixture";
import { planInput, seedQuest } from "../../server/support";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); cleanup(); clearThreadState(); });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
let quest: BoardQuestSummary, heldDetail: BoardQuestDetail, room: Room, decor: ThreadDecor;
let askId: string;
beforeAll(async () => {
  const f = setup({}, process.cwd()); registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Held work", "Held work");
  f.k.plan("lead", planInput(q.id));
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  askId = f.k.ask("lead", { effect: {type:"decision"}, kind: "production", boardQuestId: q.id, question: "Deploy this change?", why: "Production needs approval", meanwhile: "Wait", holds: [], options: [{ id: "yes", label: "Deploy", detail: "Approve", recommended: true }] }).id;
  f.k.setQuestHeld(q.id, true, { kind: "user" });
  heldDetail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
  room = await f.harness.invokeRpc("room", {}) as Room;
  decor = await f.harness.invokeRpc("decor", { threadId: "lead" }) as ThreadDecor;
  quest = heldDetail.quest;
});
const assertHeld = (text: string | null | undefined) => { expect(text).toContain(quest.move.text.replace(/ · Resume$/, "")); expect(text).not.toMatch(/hire for|hire now|form the party/i); };

it("the server's held fixture retains its production ask and counts only that ask", () => {
  expect(heldDetail.asks.find(a => a.id === askId)?.state).toBe("open");
  expect(room.asks.some(a => a.id === askId)).toBe(true);
  expect(decor.keeperView?.openAsks.some(a => a.id === askId)).toBe(true);
  expect(quest.openAsks).toBe(1);
});
it("the board row, new-thread row and map use the server's held move, not a hire suggestion", async () => {
  const keeper = room.keepers.find(k => k.member.threadId === "lead")!;
  const board = renderSlot({ component: BoardRow }, { quest, room, registry: scenes.registry, keeper }, {});
  const plugin = await loadPluginApp(definePluginApp(app => app.slots.homepageSection({ id: "home", title: "Home", component: TavernHomepage })));
  const homepage = renderSlot(plugin.homepageSections[0]!, { projectId: null }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => scenes.registry, room: () => room } });
  slots.push(board, homepage);
  await waitFor(() => expect(homepage.container.querySelector('[data-part="QuestRow"]')).not.toBeNull());
  assertHeld(board.container.textContent); assertHeld(homepage.container.querySelector('[data-part="QuestRow"]')?.textContent);
  assertHeld(graphFor(room, scenes.registry).nodes.find(node => node.questId === quest.id && node.kind === "quest")?.detail);
});
it("the widget explains the server's held move on hover and in the quest section, and keeps its production ask counted", async () => {
  const widget = renderSlot({ component: ThreadWidget }, { threadId: "lead" }, { rpc: { decor: () => decor, registry: () => scenes.registry } }); slots.push(widget);
  const chip = await widget.findByRole("button", { name: `Show ${quest.title}` });
  assertHeld(chip.title);
  expect(chip.textContent).not.toContain(quest.move.text);
  fireEvent.click(chip);
  assertHeld(widget.getByRole("region", { name: "Board quests" }).textContent);
  expect(widget.getByRole("button", { name: "1 need you" })).toBeTruthy();
});
it.each([false, true])("offers a review allowance only when the review budget is reached: %s", async reached => {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const currentRoom = { ...room, review: { ...room.review, waiting: reached ? room.review.budget : 0 } };
  const page = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => scenes.registry, room: () => currentRoom, boardQuest: () => heldDetail } }); slots.push(page);
  await page.findByRole("heading", { level: 1, name: quest.title });
  expect(page.queryByRole("button", { name: "Allow one more review" }) !== null).toBe(reached);
});
it("the full held page retains the production ask, suggests no new hire and Resume calls the user RPC", async () => {
  const resume = vi.fn(() => { const resumed = { ...quest, phase: "build" as const }; delete resumed.held; return resumed; });
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const page = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${quest.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => scenes.registry, room: () => room, boardQuest: () => heldDetail, resumeBoardQuest: resume } }); slots.push(page);
  await page.findByRole("heading", { level: 1, name: quest.title }, { timeout: 3000 });
  assertHeld(page.container.querySelector(".tv-ghead")?.textContent);
  expect(page.container.textContent).toContain("Deploy this change?");
  expect(page.getAllByRole("button").map(b => b.textContent).join("\n")).not.toMatch(/hire now|hire for|^Form the party/im);
  fireEvent.click(page.getByRole("button", { name: /^Resume$/ })); await waitFor(() => expect(resume).toHaveBeenCalled());
});
