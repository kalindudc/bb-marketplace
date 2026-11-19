import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../../../src/shared/contract";
import { QuestRow, characterName } from "../../../src/ui/kit";
import { TavernHomepage } from "../../../src/ui/page/register";
import { Board } from "../../../src/ui/page/board";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureLedger, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { richRoom, registry, rollout, vault, audit } from "./scenes";

afterEach(cleanup);
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const greenlight = { ...rollout, updatedAt: 100 };
const quiet = { ...vault, updatedAt: 300 };
const room = { ...richRoom, asks: richRoom.asks.filter(a => a.boardQuestId === greenlight.id), keepers: richRoom.keepers.map(k => ({ ...k, boardQuests: k.member.threadId === greenlight.keeperThreadId ? [greenlight] : [quiet, { ...audit, updatedAt: 200 }] })) };
async function homepage(data = room) {
  const plugin = await loadPluginApp(definePluginApp(app => app.slots.homepageSection({ id: "home", title: "Home", component: TavernHomepage })));
  return renderSlot(plugin.homepageSections[0]!, { projectId: null }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(registry), room: () => structuredClone(data) } as Partial<Handlers> as Handlers });
}
const keeper = richRoom.keepers[0]!;
const mount = (component: () => React.ReactElement) => renderSlot({ component }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract });

describe("homepage quest rows", () => {
  it("shows the free hands count for each Keeper", async () => {
    const data = { ...room, keepers: room.keepers.map(k => ({ ...k, freeHands: 2 })) };
    const slot = mount(() => <Board room={data} registry={registry} api={{ hidden: new Set(), shown: new Set(), pending: false, receipt: null, error: null, archive: async () => {}, restore: async () => {}, undo: () => {}, clear: () => {} }} />);
    expect(await slot.findAllByText("2 free hands")).toHaveLength(room.keepers.length);
  });
  it("gives narrow Keeper labels the free space beside their tag and phase", () => {
    const css = readFileSync("src/ui/kit/components.css", "utf8");
    expect(css).not.toContain(".tavern.qrow-home .qrow-k { max-width: 10ch; }");
    expect(css).toMatch(/\.tavern\.qrow-home \.qrow-l2 \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  });
  it("uses kit rows, removes the old unstyled row, and opens the quest page", async () => {
    const slot = await homepage();
    const name = (await slot.findByText(greenlight.short)).closest("button")!;
    expect(slot.container.querySelectorAll('[data-part="QuestRow"]')).toHaveLength(3);
    expect(slot.container.querySelector(".tv-qrow")).toBeNull();
    fireEvent.click(name);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `quest/${greenlight.id}` } });
  });
  it("counts an open greenlight and sorts attention first, then newest first", async () => {
    const slot = await homepage();
    await slot.findByText(greenlight.short);
    const rows = [...slot.container.querySelectorAll('[data-part="QuestRow"]')];
    expect(rows.map(r => r.getAttribute("data-quest"))).toEqual([greenlight.id, quiet.id, audit.id]);
    expect(rows[0]!.querySelector(".tag")?.textContent).toBe("1 needs you");
    expect(rows[0]!.hasAttribute("data-ask")).toBe(true);
    expect(slot.getByRole("button", { name: "1 need you" })).toBeTruthy();
  });
  it("counts holds once, including when an open release ask represents the hold", async () => {
    const held = { ...quiet, checkerHandoffHold: { id: "hold-1", routeId: "route-1", sourceMessageId: "msg-1", createdAt: 100, release: null, sourceText: "Let me read the drafts first", reason: "Read the drafts before checking" } };
    const data = { ...room, keepers: room.keepers.map(k => ({ ...k, boardQuests: k.boardQuests.map(q => q.id === held.id ? held : q) })) };
    const releaseAsk = { ...data.asks[0]!, id: "release", boardQuestId: held.id, keeperThreadId: held.keeperThreadId, releaseHoldId: "hold-1" };
    for (const asks of [data.asks, [...data.asks, releaseAsk]]) {
      const slot = await homepage({ ...data, asks });
      await slot.findByText(held.short);
      const rows = [...slot.container.querySelectorAll('[data-part="QuestRow"]')];
      expect(rows.map(r => r.getAttribute("data-quest"))).toEqual([held.id, greenlight.id, audit.id]);
      expect(rows[0]!.querySelector(".tag")?.textContent).toBe("1 needs you");
      expect(rows[0]!.hasAttribute("data-ask")).toBe(true);
      expect(slot.getByRole("button", { name: "2 need you" })).toBeTruthy();
      slot.lifecycle.unmount();
    }
  });
  it("marks blocker asks as attention without changing their move wording", async () => {
    const slot = await homepage({ ...room, asks: [{ ...room.asks[0]!, kind: "blocker" }] });
    await slot.findByText(greenlight.short);
    const row = slot.container.querySelector('[data-quest="rollout"]')!;
    expect(row.classList.contains("t-bad")).toBe(true);
    expect(row.hasAttribute("data-ask")).toBe(false);
    expect(row.querySelector(".tag")?.textContent).toBe("1 needs you");
    expect(row.querySelector(".qrow-m")?.textContent).toBe("You · blocked");
  });
  it("uses singular and plural needs-you tags for open asks on one quest", async () => {
    for (const count of [1, 2]) {
      const slot = await homepage({ ...room, asks: Array.from({ length: count }, (_, i) => ({ ...room.asks[0]!, id: `ask-${i}` })) });
      await slot.findByText(greenlight.short);
      expect(slot.container.querySelector('[data-quest="rollout"] .tag')?.textContent).toBe(`${count} ${count === 1 ? "needs" : "need"} you`);
      slot.lifecycle.unmount();
    }
  });
  it("uses the room's move edge for a user-owned next waypoint without an ask or hold", () => {
    const quest = { ...quiet, waypoints: [{ ...quiet.waypoints[0]!, state: "todo" as const, actor: "user" as const, title: "Approve the final cutover" }] };
    const slot = mount(() => <><QuestRow quest={quest} room={{ asks: [] }} registry={registry} keeper={keeper} showKeeper /><QuestRow quest={quest} room={{ asks: [] }} registry={registry} keeper={keeper} /></>);
    const rows = [...slot.container.querySelectorAll('[data-part="QuestRow"]')];
    expect(rows[0]!.classList.contains("t-you")).toBe(true);
    expect(rows.map(row => [row.getAttribute("data-variant"), row.hasAttribute("data-ask")])).toEqual([["your-move", true], ["your-move", true]]);
    expect(rows.map(row => row.querySelector(".qrow-m")?.textContent)).toEqual(["You ·\u00a0Approve the final cutover", "You ·\u00a0Approve the final cutover"]);
    expect(rows[0]!.querySelector(".tag")).toBeNull();
  });
  it("shows the Keeper only when requested", () => {
    const slot = mount(() => <><QuestRow quest={quiet} room={room} registry={registry} keeper={keeper} showKeeper /><QuestRow quest={quiet} room={room} registry={registry} keeper={keeper} /></>);
    const rows = slot.container.querySelectorAll('[data-part="QuestRow"]');
    expect(rows[0]!.querySelector(".qrow-k")?.textContent).toBe(characterName(registry, keeper.member));
    expect(rows[0]!.querySelector(".qrow-k svg")?.getAttribute("width")).toBe("12");
    expect(rows[1]!.querySelector(".qrow-k")).toBeNull();
  });
  it("leaves the room and Ledger rows unchanged without showKeeper", async () => {
    const board = mount(() => <Board room={room} registry={registry} api={{ hidden: new Set(), shown: new Set(), pending: false, receipt: null, error: null, archive: async () => {}, restore: async () => {}, undo: () => {}, clear: () => {} }} />);
    const rows = [...board.container.querySelectorAll('[data-part="QuestRow"]')];
    expect(rows).toHaveLength(3);
    expect(rows.map(row => { const copy = row.cloneNode(true) as HTMLElement; copy.querySelectorAll("time").forEach(t => t.remove()); return copy.outerHTML; })).toMatchSnapshot("room rows before homepage change");
    expect(board.container.querySelector(".qrow-k, .qrow .tag")).toBeNull();
    const ledger = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => fixtureLedger, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await ledger.findByRole("button", { name: fixtureLedger.boardQuests[0]!.title });
    await waitFor(() => expect(ledger.container.querySelector(".lg-qh .sk-l")).toBeNull());
    expect(ledger.container.querySelector('[data-part="QuestRow"]')).toBeNull();
    expect([...ledger.container.querySelectorAll(".lg-qh")].map(row => row.outerHTML)).toMatchSnapshot("loaded Ledger rows");
    expect(ledger.container.querySelector(".qrow-k")).toBeNull();
  });
});
