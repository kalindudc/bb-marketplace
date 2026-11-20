// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { graphFor, mapPicture } from "../../../src/ui/page/model";
import { PanelStateProvider } from "../../../src/ui/page/panel-state";
import { TheMap } from "../../../src/ui/page/connections";
import { fixtureQuest, fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { richRoom } from "./scenes";
const member = { ...fixtureMember, threadId: "past-member", role: "member" as const, displayName: "Wren II", state: "idle" as const, engagement: "resting" as const };
const quest = { ...fixtureQuest, id: "past", phase: "done" as const, archivedAt: 10, endedAt: 20, members: [member] };
const keeper = { ...richRoom.keepers[0]!, archived: true, member: { ...fixtureMember, threadId: "past-keeper" }, boardQuests: [quest], errands: [] };
const room = { ...richRoom, keepers: [keeper], asks: [], solos: [] };
const history = { keepers: [{ threadId: "past-keeper", total: 8, quests: Array.from({ length: 5 }, (_, i) => ({ ...quest, id: `past-${i}`, keeperThreadId: "past-keeper", members: [{ ...member, threadId: `past-member-${i}` }] })) }] };
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("hides archived Keepers by default and draws bounded cellar history, parties and a more leaf when shown", () => {
  expect(graphFor(room, fixtureRegistry).nodes).toHaveLength(0);
  const graph = graphFor(room, fixtureRegistry, { hidden: new Set(), returned: false, archived: true, history });
  expect(graph.nodes.filter(n => n.kind === "returned")).toHaveLength(5);
  const picture = mapPicture(graph, null);
  expect(picture.nodes.filter(n => n.kind === "member")).toHaveLength(5);
  expect(picture.edges.filter(e => e.to.startsWith("member:")).every(e => e.quiet)).toBe(true);
  expect(graph.nodes.find(n => n.label === "+3 more")?.subPath).toBe("archive");
});
it("shows only a quiet Keeper loading state until history arrives", async () => {
  let finish!: (value: typeof history) => void;
  const pending = new Promise<typeof history>(resolve => { finish = resolve; });
  const slot = renderSlot({ component: () => <TheMap room={room} registry={fixtureRegistry} /> }, {}, { rpc: { mapHistory: () => pending } });
  fireEvent.click(slot.getByRole("button", { name: "Show archived Keepers (1)" }));
  expect(slot.container.querySelector(".tv-mappic")?.textContent).toContain("Loading history");
  expect(slot.container.querySelector(".k-returned")).toBeNull();
  finish(history);
  await waitFor(() => expect(slot.container.querySelector(".k-returned")).not.toBeNull());
  expect(slot.container.querySelector(".tv-mappic")?.textContent).not.toContain("Loading history");
  slot.lifecycle.unmount();
});
it("keeps each historical party distinct when a thread appears in more than one quest", () => {
  const repeated = { keepers: [{ threadId: "past-keeper", total: 2, quests: [{ ...quest, id: "one" }, { ...quest, id: "two" }] }] };
  const picture = mapPicture(graphFor(room, fixtureRegistry, { hidden: new Set(), returned: true, archived: true, history: repeated }), null);
  const members = picture.nodes.filter(n => n.kind === "member");
  expect(members).toHaveLength(2);
  expect(new Set(members.map(n => n.id)).size).toBe(2);
});
it("draws a live Keeper's returned party only while returned work is shown, excluding its cellar quest", () => {
  const live = { ...room, keepers: [{ ...keeper, archived: false, boardQuests: [{ ...quest, archivedAt: null }, { ...quest, id: "cellar" }] }] };
  const graph = graphFor(live, fixtureRegistry);
  expect(graph.nodes.some(n => n.questId === "cellar")).toBe(false);
  expect(mapPicture(graph, null).nodes.some(n => n.kind === "member")).toBe(true);
  expect(graphFor(live, fixtureRegistry, { hidden: new Set(), returned: false }).nodes.some(n => n.kind === "member")).toBe(false);
});
it("fetches history only when toggled, remembers the choice and opens the more leaf in the cellar", async () => {
  const handler = vi.fn(() => history);
  const mount = () => renderSlot({ component: () => <PanelStateProvider value="tavern:map-test"><TheMap room={room} registry={fixtureRegistry} /></PanelStateProvider> }, {}, { rpc: { mapHistory: handler } });
  const slot = mount();
  expect(handler).not.toHaveBeenCalled();
  expect(slot.container.querySelector('[data-node="keeper:past-keeper"]')).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Show archived Keepers (1)" }));
  await waitFor(() => expect(slot.container.querySelector('[data-node="member:past-0:past-member-0"]')).not.toBeNull());
  expect(handler).toHaveBeenCalledTimes(1);
  fireEvent.click(slot.getByRole("button", { name: /\+3 more/ }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "archive" } });
  slot.lifecycle.unmount();
  const back = mount();
  expect(back.getByRole("button", { name: "Show archived Keepers (1)" }).getAttribute("aria-pressed")).toBe("true");
  back.lifecycle.unmount();
});
