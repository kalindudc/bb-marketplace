import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { AttentionItem } from "../../../src/shared/attention";
import { rpcContract, type Room } from "../../../src/shared/contract";
import { TavernPage, TavernSidebar } from "../../../src/ui/page/register";
import { registry, richRoom, audit } from "./scenes";

const plan = { ...richRoom.asks[0]!, id: "plan", boardQuestId: audit.id, state: "open" as const, kind: "greenlight" as const };
const attentionItem = (id: string, kind: AttentionItem["kind"], action: string): AttentionItem => ({ id, kind, action, questId: audit.id, keeperThreadId: audit.keeperThreadId, title: id, since: 1, seen: false });
const review = attentionItem("handoff", "hold", "Review");
const withQuestAttention = (needYou: number) => richRoom.keepers.map(keeper => ({ ...keeper, boardQuests: keeper.boardQuests.map(q => q.id === audit.id ? { ...q, attention: { items: [], needYou, new: 1, heldByYou: 0 } } : q) }));
const room: Room = { ...richRoom, keepers: withQuestAttention(2), asks: [plan], attention: { items: [attentionItem("plan", "ask", "Answer"), review, attentionItem("new-summary", "summary", "Open")], needYou: 2, new: 1, heldByYou: 0 }, away: { closed: true, dueBack: true, until: 1, windowId: "away" } };

function mount(data: Room, initial = "room", Component = TavernSidebar) {
  let go!: (path: string) => void;
  function Surface() {
    const [path, setPath] = useState(initial);
    go = setPath;
    return <Component subPath={path} />;
  }
  const slot = renderSlot({ component: Surface }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { room: () => data, registry: () => registry } });
  return { ...slot, go: (path: string) => act(() => go(path)) };
}

afterEach(() => { cleanup(); localStorage.clear(); });

it("counts a plan and review in both the room and quest, and gives each quest its own Keeper target", async () => {
  const slot = mount(room, `quest/${audit.id}/ask/plan`);
  const home = await slot.findByRole("button", { name: /Common room.*2 need you/ });
  expect(home.textContent).toContain("1 plan · 1 review");
  expect(home.hasAttribute("aria-current")).toBe(false);
  const quest = slot.getByRole("button", { name: name => name.startsWith(audit.title) && name.endsWith("2 need you") });
  expect(quest.getAttribute("aria-current")).toBe("page");
  expect(quest.nextElementSibling?.getAttribute("aria-label")).toBe("Wren, Keeper: open thread");
  expect(slot.getAllByRole("button", { name: "Wren, Keeper: open thread" })).toHaveLength(2);
  fireEvent.click(quest.nextElementSibling!);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: audit.keeperThreadId });
  expect(slot.container.querySelector("[title]:not(.tv-skeeper-name), svg > title")).toBeNull();
});

it("opens the lead Keeper's thread from the side quest's conversation shortcut", async () => {
  const root = richRoom.keepers.find(k => k.member.threadId === audit.keeperThreadId)!;
  const child = { ...audit, leadChain: { seat: { parentQuestId: "parent", parentTitle: "Restore the harbor bell",
    parentKeeperThreadId: "lead", limits: { members: 1, rangers: 0, depth: 1 }, parentDecisions: [], authority: [] }, children: [] } };
  const lead = { ...root, member: { ...root.member, threadId: "lead", displayName: "Thistlewick of Lantern Hall" }, boardQuests: [] };
  const keepers = [...room.keepers.map(k => ({ ...k, boardQuests: k.boardQuests.map(q => q.id === child.id ? child : q) })), lead];
  const slot = mount({ ...room, keepers });
  const shortcut = await slot.findByRole("button", { name: "Thistlewick of Lantern Hall, lead Keeper: open thread" });
  expect(within(shortcut).getByText("Thistlewick of Lantern Hall").getAttribute("title")).toBe("Thistlewick of Lantern Hall");
  fireEvent.click(shortcut);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "lead" });
});

it.each([false, true])("shows a review-only quest badge when room details are clipped: %s", async clipped => {
  const slot = mount({ ...room, keepers: withQuestAttention(1), asks: [], attention: { items: clipped ? [] : [review], needYou: 1, new: 0, heldByYou: 0 } });
  await slot.findByRole("button", { name: /Common room.*1 needs you/ });
  const quest = slot.getByRole("button", { name: name => name.startsWith(audit.title) && name.endsWith("1 needs you") });
  expect(quest.querySelector(".tv-squest-n")?.textContent).toBe("1");
  expect(quest.parentElement?.hasAttribute("data-attention")).toBe(true);
  const unrelated = within(slot.getByRole("navigation", { name: "Tavern navigation" })).getAllByRole("button").filter(button => button.classList.contains("tv-sactive") && button !== quest);
  expect(unrelated.length).toBeGreaterThan(0);
  expect(unrelated.every(button => !button.querySelector(".tv-squest-n"))).toBe(true);
});

it("keeps only the authoritative total when attention is incomplete", async () => {
  const slot = mount({ ...room, attention: { ...room.attention!, items: [attentionItem("plan", "ask", "Answer")] } });
  const home = await slot.findByRole("button", { name: /Common room.*2 need you/ });
  expect(home.textContent).not.toMatch(/plan|review/);
  expect(home.getAttribute("aria-current")).toBe("page");
});

it("puts Closing time first, and marks Away until the room is open again", async () => {
  const slot = mount(room, "closing");
  await slot.findByText("1 plan · 1 review");
  const places = within(slot.getByRole("group", { name: "The tavern" }));
  const closing = places.getAllByRole("button")[0]!;
  expect(closing.textContent).toMatch(/Closing time.*Away/);
  expect(closing.getAttribute("aria-current")).toBe("page");
  slot.lifecycle.unmount();
  const open = mount({ ...room, away: { closed: false, dueBack: false, until: null, windowId: null } });
  await open.findByText("1 plan · 1 review");
  expect(open.getByRole("button", { name: "Closing time" }).textContent).not.toContain("Away");
});

it("opens More places for a deep route, and preserves keyboard disclosure on the current page", async () => {
  const slot = mount(room);
  const more = await slot.findByRole("button", { name: /^More places/ });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: /While closed/ })).toBeNull();
  slot.go("class/keeper");
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByRole("button", { name: /^Classes/ }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("false");
  slot.go("machines/sample");
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByRole("button", { name: "Where work runs" }).getAttribute("aria-current")).toBe("page");
});

it("keeps answer search in navigation and Classes current for its Overrides page", async () => {
  const slot = mount(room, "classes/overrides");
  const answers = await slot.findByRole("button", { name: "Search answers" });
  expect(slot.getByRole("button", { name: /^Classes/ }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(answers);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "answers" } });
  slot.go("answers");
  expect(answers.getAttribute("aria-current")).toBe("page");
});

it("shows room state in the collapsed phone picker and closes and moves focus on selection", async () => {
  const slot = mount(room, "map", TavernPage);
  const nav = await slot.findByRole("navigation", { name: "Tavern pages" });
  const picker = await within(nav).findByRole("button", { name: /Tavern pages.*The map.*2 need you.*Away/ });
  expect(picker.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(picker);
  expect(picker.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(nav).getByRole("button", { name: /Closing time.*Away/ }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "closing" } });
  slot.go("closing");
  expect(picker.getAttribute("aria-expanded")).toBe("false");
  expect(nav.contains(document.activeElement)).toBe(false);
  expect(document.activeElement?.contains(slot.getByRole("heading", { name: /^Closing time/ }))).toBe(true);
});
