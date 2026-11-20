// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { KeeperRow, QuestRow, characterName, keeperStatus, keeperStartedLabel } from "../../../src/ui/kit";
import { questMove } from "../../../src/ui/kit/rows";
import { liveRoom, registry, richRoom } from "../page/scenes";
import type { Room } from "../../../src/shared/contract";

afterEach(cleanup);
type Keeper = Room["keepers"][number];

/** Mount a node inside a real plugin slot, so useBbNavigate records navigation. */
async function mount(node: () => ReactElement) {
  const app = await loadPluginApp(definePluginApp(app => { app.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: node } as never); }));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {});
}

const keeper = richRoom.keepers[0]!;
const live = keeper.boardQuests.find(q => q.phase !== "done" && q.phase !== "stopped")!;
it("N2 uses the shared human time on a scouting move", () => {
  const now = new Date(2026, 10, 19, 21).getTime(), due = new Date(2026, 10, 17, 20, 24).getTime();
  const quest = { ...live, phase: "scout" as const, nextNewsBy: due };
  expect(questMove(quest, [], { keeper: "Wren", member: () => "Member" }, { now }).next).toContain("news overdue since Tue 20:24");
});
const returned = { ...live, id: "ret-1", short: "Returned one", title: "A returned quest", phase: "done" as const, endedAt: Date.now() - 60_000 };
const stopped = { ...live, id: "stop-1", short: "Stopped one", title: "A stopped quest", phase: "stopped" as const, endedAt: Date.now() - 60_000 };

describe("QuestRow", () => {
  it("cuts only the waypoint's title in its move line, never whose move or the verb, and shows the whole phrase on hover", async () => {
    const title = "Write the migration notes for every caller of parseDuration in the monorepo";
    const hire = { ...live, waypoints: live.waypoints.map((w, i) => ({ ...w, state: i === 0 ? "todo" as const : w.state, actor: "agent" as const, ownerMember: null, title: i === 0 ? title : w.title })) };
    const slot = await mount(() => <QuestRow quest={hire} room={{ ...richRoom, asks: [] }} registry={registry} keeper={{ ...keeper, archived: false }} />);
    await slot.findByRole("button", { name: hire.short });
    const mark = slot.container.querySelector(".qrow-m .tv-st")!;
    const name = characterName(registry, keeper.member);
    expect(mark.querySelector(".qrow-mv")!.textContent).toBe(`${name} · hire for\u00a0`);
    expect(mark.querySelector(".qrow-mt")!.textContent).toBe(title);
    expect(mark.getAttribute("title")).toBe(`${name} · hire for ${title}`);
    expect(mark.textContent!.replace(/\u00a0/g, " ")).toBe(`${name} · hire for ${title}`);
  });
  it("opens the quest page from its name, which covers the row", async () => {
    const slot = await mount(() => <QuestRow quest={live} room={richRoom} registry={registry} keeper={keeper} />);
    const name = await slot.findByRole("button", { name: live.short });
    expect(name.title).toBe(`Open the quest page: ${live.title}`);
    expect(slot.container.querySelector(".qrow")?.getAttribute("data-variant")).toMatch(/active|your-move/);
    fireEvent.click(name);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `quest/${live.id}` } });
  });

  it("gives a returned quest one line with the tale and the cellar, and a stopped one no tale", async () => {
    const onArchive = vi.fn();
    const slot = await mount(() => <><QuestRow quest={returned} room={richRoom} registry={registry} keeper={keeper} onArchive={onArchive} /><QuestRow quest={stopped} room={richRoom} registry={registry} keeper={keeper} onArchive={onArchive} /></>);
    const rows = [...slot.container.querySelectorAll(".qrow")];
    expect(rows.map(r => r.getAttribute("data-variant"))).toEqual(["returned", "stopped"]);
    expect(rows[0]!.textContent).toContain("returned");
    fireEvent.click(await slot.findByTitle("Open the tale: A returned quest"));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "tale/ret-1" } });
    expect(rows[1]!.querySelector(".qrow-tale")).toBeNull();
    expect(rows.map(r => r.querySelector("[data-quest-name]")?.getAttribute("title"))).toEqual(["Open the quest record: A returned quest", `Open the quest record: ${stopped.title}`]);
    fireEvent.click(slot.getByRole("button", { name: "Send to the cellar (archive): Stopped one" }));
    expect(onArchive).toHaveBeenCalledWith(stopped);
  });

  it("says the Keeper's thread is archived instead of a next step", async () => {
    const slot = await mount(() => <QuestRow quest={live} room={richRoom} registry={registry} keeper={{ ...keeper, archived: true }} />);
    const row = await slot.findByText((_, e) => e?.classList.contains("qrow") === true);
    expect(row.getAttribute("data-variant")).toBe("archived");
    expect(row.textContent).toContain("Keeper's thread archived");
    expect(row.textContent).not.toContain("archived · ");
  });

  it("marks agent text as content", async () => {
    const slot = await mount(() => <QuestRow quest={live} room={richRoom} registry={registry} keeper={keeper} />);
    expect((await slot.findByRole("button", { name: live.short })).querySelector("[data-content]")?.textContent).toBe(live.short);
  });
});

describe("KeeperRow", () => {
  const twinA: Keeper = { ...keeper, member: { ...keeper.member, threadId: "thr-a" }, threadTitle: "List functions with test counts", threadCreatedAt: new Date(2026, 10, 12, 11, 2).getTime() };
  const twinB: Keeper = { ...twinA, member: { ...keeper.member, threadId: "thr-b" }, threadCreatedAt: new Date(2026, 10, 13, 9, 30).getTime() };

  it("opens the thread from crest, name and title, and names the status in the shared words", async () => {
    const k: Keeper = { ...keeper, threadTitle: "Vault cutover", status: "holding", quietSince: null, archived: false };
    const slot = await mount(() => <KeeperRow keeper={k} room={{ keepers: [k], decidedForYou: [] }} registry={registry} />);
    const open = await slot.findByRole("button", { name: /^Open .*'s thread: Vault cutover$/ });
    expect(slot.container.textContent).toContain(keeperStatus(k).label);
    expect(slot.container.textContent).toContain("Holding while you type");
    fireEvent.click(open);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: k.member.threadId });
    // The narrow layout puts this line under the name, and the state's short word is always rendered for it to show.
    expect(open.querySelector(".krow-l2 .krow-t")?.textContent).toBe("Vault cutover");
    expect(slot.container.querySelector(".krow-sw")?.textContent).toBe(keeperStatus(k).word);
  });

  it("shows thread archived, never Holding, for an archived thread", async () => {
    const k: Keeper = { ...keeper, status: "holding", archived: true };
    const slot = await mount(() => <KeeperRow keeper={k} room={{ keepers: [k], decidedForYou: [] }} registry={registry} />);
    await slot.findByText("Thread archived");
    expect(slot.container.textContent).not.toContain("Holding");
  });

  it("adds the start time only when both the name and the title repeat", () => {
    expect(keeperStartedLabel(twinA, [twinA, twinB], registry, Date.now())).toBe("started 12 Nov");
    expect(keeperStartedLabel(twinA, [twinA, { ...twinB, threadTitle: "Other" }], registry, Date.now())).toBeNull();
    expect(keeperStartedLabel({ ...twinA, threadCreatedAt: null }, [twinA, twinB], registry, Date.now())).toBeNull();
  });

  it("counts only unseen, not undone decisions", async () => {
    const k = liveRoom.keepers[0]!;
    const base = liveRoom.decidedForYou[0]!;
    const decided = [{ ...base, id: "d1", keeperThreadId: k.member.threadId, undone: false, seenAt: null }, { ...base, id: "d2", keeperThreadId: k.member.threadId, undone: false, seenAt: 5 }, { ...base, id: "d3", keeperThreadId: k.member.threadId, undone: true, seenAt: null }];
    const slot = await mount(() => <KeeperRow keeper={k} room={{ keepers: [k], decidedForYou: decided }} registry={registry} />);
    expect((await slot.findByText("1 decided")).closest(".krow-dec")).not.toBeNull();
  });
});


import { useSidebarActorNames } from "../../../src/ui/kit";
describe("useSidebarActorNames", () => {
  function Probe() {
    const names = useSidebarActorNames([]);
    return <p>{[names({ kind: "agent", threadId: "thr_unknown" }), names({ kind: "agent", threadId: "thr_unknown" }, { mid: true }), names({ kind: "user" }, { mid: true }), names(null, { mid: true }), String(names.threadNames.size)].join("|")}</p>;
  }
  it("lowercases only its own fallback words in the middle of a sentence, and exposes the names it knows", async () => {
    const slot = await mount(() => <Probe />);
    expect((await slot.findByText(/Another thread/)).textContent).toBe("Another thread|another thread|you|nobody|0");
  });
});

import { taleFigures } from "../../../src/ui/kit";
describe("taleFigures", () => {
  it("names the time figure by how the quest ended", () => {
    const at = (phase: "done" | "stopped") => taleFigures({ quest: { ...live, phase, createdAt: 1000, endedAt: 1000 + 3_600_000, members: [] }, tale: null, memberCredits: [] }).find(f => f.label.startsWith("pickup"))?.label;
    expect(at("done")).toBe("pickup to return");
    expect(at("stopped")).toBe("pickup to stop");
  });
});
