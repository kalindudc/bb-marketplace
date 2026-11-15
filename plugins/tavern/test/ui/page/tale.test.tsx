import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import { inlineCode, leftNothing, mapAside, reportBlocks, taleHeadline } from "../../../src/ui/page/model";
import { reachedLevel, reachedWords } from "../../../src/ui/kit";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const ID = scenes.readmeDetail.quest.id;
async function tale(detail: BoardQuestDetail = scenes.readmeDetail, room: Room = scenes.richRoom, panelAccepts = false, extra: Record<string, unknown> = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: `tale/${ID}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => ({ ...structuredClone(scenes.registry), ...structuredClone(extra) }), room: () => structuredClone(room), boardQuest: () => structuredClone(detail) } as Partial<Handlers> as Handlers, ...(panelAccepts ? { experimental_panel: { openTab: () => true } } : {}) });
  slots.push(slot); return slot;
}

describe("the tale's reading helpers", () => {
  it("takes a member's headline, else the first clean sentence after a leading verdict", () => {
    expect(taleHeadline({ headline: "All three lists match the file.", outcome: "VERIFIED w1. Long text." })).toBe("All three lists match the file.");
    expect(taleHeadline({ outcome: "VERIFIED w1. I derived all three lists and each matches /tmp/tavern-smoke/missing-plugins.md exactly. (1) Missing from the table: None." })).toBe("I derived all three lists and each matches /tmp/tavern-smoke/missing-plugins.md exactly.");
    expect(taleHeadline({ outcome: "Entry 02 verified. The repo is clean and the table has 17 rows." })).toBe("The repo is clean and the table has 17 rows.");
    expect(taleHeadline({ outcome: "No plugins/* folder is missing from the README.md plugin table. The result list is empty." })).toBe("No plugins/* folder is missing from the README.md plugin table.");
    expect(taleHeadline({ outcome: "(1) a (2) b" })).toBeNull();
    expect(taleHeadline({ outcome: "VERIFIED w1." })).toBeNull();
  });
  it("gives the quest map a ready estimate only while the quest is active, never with a doubled approximation", () => {
    const plan = { ...scenes.readmeDetail.quest.plan!, eta: "About 5 more minutes" };
    expect(mapAside({ phase: "build", plan })).toBe("ready ≈ 5 more minutes");
    expect(mapAside({ phase: "build", plan: { ...plan, eta: "~5 minutes" } })).toBe("ready ≈ 5 minutes");
    expect(mapAside({ phase: "stopped", plan })).toBe("as it was when stopped");
    expect(mapAside({ phase: "done", plan })).toBe("as it returned");
    expect(mapAside({ phase: "build", plan: { ...plan, eta: null } })).toBe("columns are order, not a promised time");
  });
  it("turns numbered items into a list and a trailing command into a code block", () => {
    expect(reportBlocks("Three lists. (1) 17 folders exist. (2) The table has 17 rows. (3) No folder lacks a row. Command used: comm -23 <(ls) <(grep x)")).toEqual([
      { kind: "p", text: "Three lists." },
      { kind: "list", items: ["17 folders exist.", "The table has 17 rows.", "No folder lacks a row."] },
      { kind: "code", text: "comm -23 <(ls) <(grep x)" },
    ]);
    expect(reportBlocks("Plain text (with a 2) aside.")).toEqual([{ kind: "p", text: "Plain text (with a 2) aside." }]);
    expect(inlineCode("Wrote /tmp/x/missing.md and ran `git status`.")).toEqual([{ code: false, text: "Wrote " }, { code: true, text: "/tmp/x/missing.md" }, { code: false, text: " and ran " }, { code: true, text: "git status" }, { code: false, text: "." }]);
    expect([leftNothing("Nothing"), leftNothing(" none. "), leftNothing(null), leftNothing("Nothing for this quest. Side note: …")]).toEqual([true, true, true, false]);
  });
});

describe("the tale page", () => {
  it("shows delivery, next actions, figures and the folded record in order without a recursive directive", async () => {
    const detail = structuredClone(scenes.readmeDetail);
    detail.tale!.delivery = { text: `## Delivered answer\n\nRead the report.\n\n::tavern-tale{quest="${ID}"}`, capturedAt: 1, threadId: detail.quest.keeperThreadId, truncated: true };
    detail.tale!.next = ["Read the report", "Apply the recommendation"];
    const slot = await tale(detail);
    const heading = await slot.findByText("What the Keeper brought back");
    expect(slot.container.querySelector(".tv-tale-delivery")?.textContent).toContain("Delivered answer");
    expect(slot.container.textContent).not.toContain("::tavern-tale");
    const next = slot.getByText("What to do now");
    expect(heading.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.getByText("Apply the recommendation").closest("ol")).toBeTruthy();
    expect(slot.getByText("The Keeper's record").closest("details")?.open).toBe(false);
    expect(within(slot.container.querySelector(".tv-tale-delivery") as HTMLElement).getByRole("button", { name: "Open thread" }).textContent).toContain("The rest is in the Keeper's thread ›");
  });
  it("distinguishes an empty next list from an older tale and splits the fallback", async () => {
    const detail = structuredClone(scenes.readmeDetail);
    detail.tale!.outcome = "Answer. (1) Read this. (2) Then do that.";
    detail.tale!.next = [];
    const slot = await tale(detail);
    expect(await slot.findByText("Nothing for you to do")).toBeTruthy();
    expect(slot.getByText("Read this.").closest("ol")).toBeTruthy();
    const older = await tale();
    await older.findByText("Done when");
    expect(within(older.container).queryByText("What to do now")).toBeNull();
  });
  it("opens a done cellar quest at its explicit tale route even when the room omits it", async () => {
    const detail = structuredClone(scenes.readmeDetail);
    detail.quest.phase = "done"; detail.quest.archivedAt = 123;
    const room = structuredClone(scenes.richRoom);
    for (const keeper of room.keepers) keeper.boardQuests = keeper.boardQuests.filter(q => q.id !== detail.quest.id);
    const slot = await tale(detail, room);
    expect(await slot.findByText("Done when")).toBeTruthy();
    expect(slot.container.querySelector(".tv-tale-page")).not.toBeNull();
    expect(slot.inspection.rpcCalls.some(call => call.method === "boardQuest")).toBe(true);
  });
  it("leads with the Keeper's tale, then figures, the path, what is left and one card per member", async () => {
    const slot = await tale();
    const card = (await slot.findByRole("region", { name: /^List plugins/ })) as HTMLElement;
    expect(within(card).getByText(/holds three verified lists/)).toBeTruthy();
    expect(within(card).getByText(/Side note from lark/)).toBeTruthy();
    const cards = card.querySelectorAll(".tv-credit");
    expect(cards.length).toBe(3);
    const text = (i: number) => cards[i]!.textContent ?? "";
    expect(text(0)).toContain("Lark"); expect(text(0)).toContain("made w1"); expect(text(0)).toContain("No table row links to a missing folder.");
    expect(text(1)).toContain("made w2 · verified w2");
    expect(text(2)).toContain("verified w1");
    expect(card.textContent).not.toMatch(/0 verified waypoints|level 1 from 0/);
    expect(card.querySelector(".tv-lvl")).toBeNull();
    expect([...cards].map((c) => c.textContent).join(" ")).not.toContain("A Warden");
  });

  it("opens a member's reports in the side panel from a quiet link at the card's foot", async () => {
    const slot = await tale(scenes.readmeDetail, scenes.richRoom, true);
    const view = await slot.findByRole("button", { name: "View 3 reports" });
    expect(slot.getByRole("button", { name: "View report" })).toBeTruthy();
    expect(view.classList.contains("lnk-btn")).toBe(true);
    expect(view.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(view);
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: { id: "member-reports", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" }, params: { questId: scenes.readmeDetail.quest.id, memberThreadId: "thr_z5k6x43jc2" }, title: `Lark’s reports · ${scenes.readmeDetail.quest.short}` } });
    expect(slot.container.querySelector(".tv-credit.open")).toBeNull();
    expect(slot.queryByRole("dialog")).toBeNull();
  });
  it("shows the reports under the card when bb declines the panel, with lists and commands readable", async () => {
    const slot = await tale();
    fireEvent.click(await slot.findByRole("button", { name: "View 3 reports" }));
    const open = slot.container.querySelector(".tv-credit.open")!;
    expect(open.querySelectorAll(".rv-rep").length).toBe(3);
    expect(open.querySelector(".rv-list li")).toBeTruthy();
    expect(open.querySelector("pre.rv-code")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Hide the reports" }));
    expect(slot.container.querySelector(".tv-credit.open")).toBeNull();
  });

  it("says when nothing is left, lists skipped waypoints, and copes with a quest the Keeper never wrapped", async () => {
    const nothing = { ...structuredClone(scenes.readmeDetail), tale: { ...scenes.readmeDetail.tale!, left: "Nothing", skipped: [] } };
    const a = await tale(nothing);
    expect(await a.findByText("Nothing left for you.")).toBeTruthy();
    a.lifecycle.unmount();
    const skipped = { ...structuredClone(scenes.readmeDetail), tale: { ...scenes.readmeDetail.tale!, left: null, skipped: [{ waypointId: "w2", reason: "Covered by w1's own check" }] } };
    const b = await tale(skipped);
    const w1 = scenes.readmeDetail.quest.waypoints.find((w) => w.id === "w1")!.title;
    expect(await b.findByText(`Covered by ${w1}'s own check`)).toBeTruthy();
    expect(b.queryByText("Nothing left for you.")).toBeNull();
    b.lifecycle.unmount();
    const unwrapped: BoardQuestDetail = { ...structuredClone(scenes.readmeDetail), tale: null };
    delete unwrapped.memberCredits;
    const c = await tale(unwrapped);
    expect(await c.findByText(/The Keeper wrote no tale for this quest/)).toBeTruthy();
    expect(c.container.querySelectorAll(".tv-credit").length).toBe(3);
    expect(c.container.querySelector(".tv-leftfor")).toBeNull();
  });

  it("folds each loot waypoint's evidence, keeps its title, verifier and done-when in view, and remembers the fold", async () => {
    const first = await tale();
    const loot = (await first.findByRole("heading", { name: "Loot (verified results)" })).closest("section")!;
    expect(loot.querySelector(".evidence-list")).toBeNull();
    const rows = loot.querySelectorAll(".tv-loot > li");
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain("Write the three-section missing-plugins.md");
    expect(rows[0]!.textContent).toContain("Rook verified");
    expect(rows[1]!.textContent).toContain("Vex verified");
    expect(loot.querySelector(".tv-loot-dw")?.textContent).toMatch(/re-derives the three lists/);
    const fold = within(rows[0] as HTMLElement).getByRole("button", { name: /^\d+ evidence/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(rows[0]!.querySelector(".evidence-list")).toBeTruthy();
    expect(rows[1]!.querySelector(".evidence-list")).toBeNull();
    first.lifecycle.unmount();
    const again = await tale();
    const loot2 = (await again.findByRole("heading", { name: "Loot (verified results)" })).closest("section")!;
    expect(loot2.querySelectorAll(".tv-loot > li")[0]!.querySelector(".evidence-list")).toBeTruthy();
  });

  it("draws the Done when card's thread link as a plain link when the Keeper's thread is archived", async () => {
    const keeperId = scenes.readmeDetail.quest.keeperThreadId;
    const base = scenes.richRoom.keepers[0]!;
    const live = await tale(scenes.readmeDetail, { ...scenes.richRoom, keepers: [{ ...base, member: { ...base.member, threadId: keeperId } }] });
    expect((await live.findByRole("button", { name: /Open .*thread/, description: undefined })).closest(".tv-first-links")).toBeTruthy();
    expect(live.container.querySelector(".tv-tsec-foot .btn")).toBeTruthy();
    live.lifecycle.unmount(); slots.splice(slots.indexOf(live), 1);
    const archived = await tale(scenes.readmeDetail, { ...scenes.richRoom, keepers: [{ ...base, archived: true, member: { ...base.member, threadId: keeperId } }] });
    await archived.findByText("Done when");
    await waitFor(() => expect(archived.container.querySelector(".tv-tsec-foot .lnk-btn")).toBeTruthy());
    expect(archived.container.querySelector(".tv-tsec-foot .btn")).toBeNull();
  });
  it("names every id in a headline from the quest's own data, and drops a headline whose id has no name", async () => {
    const detail = structuredClone(scenes.readmeDetail);
    const vex = detail.reports.find((r) => r.memberThreadId === "thr_f8kheswkzk" && r.status === "done")!;
    vex.outcome = `Verified maker thr_z5k6x43jc2 entry [00] for board quest ${detail.quest.id}, waypoint w1.`;
    const rook = detail.reports.find((r) => r.memberThreadId === "thr_feyk5p4jv9")!;
    rook.outcome = "Verified maker thr_nobody123 entry [00], and it holds.";
    const slot = await tale(detail);
    const card = async (name: string) => (await slot.findByText(name, { selector: ".tv-credit-n b" })).closest(".tv-credit")!;
    const lark = (await card("Lark")).querySelector(".tv-credit-n b")!.textContent;
    expect((await card("Vex")).querySelector(".tv-credit-hl")?.textContent).toBe(`Verified maker ${lark} entry [00] for board quest ${detail.quest.short}, waypoint Write the three-section missing-plugins.md.`);
    const rookCard = await card("Rook");
    expect(rookCard.querySelector(".tv-credit-hl")).toBeNull();
    expect(rookCard.querySelector(".tv-credit-role")?.textContent).toBeTruthy();
    expect(slot.container.querySelector(".tv-credits")!.className).toContain("n-3");
    expect([...slot.container.querySelectorAll(".tv-credit")].every((c) => c.classList.contains("nested"))).toBe(true);
    expect(slot.container.querySelector(".tv-leftfor")!.classList.contains("nested")).toBe(true);
  });
  it("prefers a report's own headline and shows a level only when the character's lasting record earned one", async () => {
    const detail = structuredClone(scenes.readmeDetail);
    const lark = detail.reports.filter((r) => r.memberThreadId === "thr_z5k6x43jc2").sort((a, b) => b.createdAt - a.createdAt)[0]!;
    lark.headline = "Every plugin folder is in the README table.";
    // One rule with the sheets: a Ranger levels on its verified waypoints in the record, 9 of them for level 2.
    const serviceRecords = [{ characterId: "lark", firstEarnedAt: 1, lastEarnedAt: 1, completeSince: null, backfilledAt: null, maker: { verifiedWaypoints: 9, quests: 3 }, recordsTotal: 0, records: [] }];
    const slot = await tale(detail, scenes.richRoom, false, { serviceRecords });
    expect(await slot.findByText("Every plugin folder is in the README table.")).toBeTruthy();
    expect(slot.container.querySelectorAll(".tv-lvl").length).toBe(1);
    expect(slot.container.querySelector(".tv-lvl")!.textContent).toBe("level 2");
  });
  const levelOf = (m: BoardQuestDetail["quest"]["members"][number] | undefined, before: number | null, after: number | null, historyComplete?: boolean) =>
    ({ characterId: m!.characterId!, role: (m!.classId === "warden" ? "warden" : m!.classId === "keeper" ? "keeper" : "maker") as "maker" | "warden" | "keeper", before, after, ...(historyComplete === undefined ? {} : { historyComplete }) });
  const creditsOf = async (levels: ReturnType<typeof levelOf>[] | null) => {
    const d = scenes.readmeDetail;
    const slot = await tale({ ...d, tale: { ...d.tale!, levels } } as BoardQuestDetail);
    await waitFor(() => expect(slot.container.querySelectorAll(".tv-credit").length).toBe(d.quest.members.length), { timeout: 3000 });
    return [...slot.container.querySelectorAll<HTMLElement>(".tv-credit-lvl")].map((p) => p.textContent);
  };
  it("says a level once, still, from the server's snapshot, from level 2 up and only when it rose; never that the quest earned it unless history was complete", async () => {
    const [a, b, c] = scenes.readmeDetail.quest.members;
    // 7 to 8 results is level 1 to 2: said. A first quest that earns 8 (null to 2): said. 8 to 9 stays at 2: silent.
    const said = await creditsOf([levelOf(a, 1, 2), levelOf(b, null, 2), levelOf(c, 2, 2)]);
    expect(said).toHaveLength(2);
    for (const line of said) expect(line).toMatch(/^.+ was level 2 after this quest\.$/);
    // Never on a first result to level 1, nor on a legacy tale with no snapshot.
    expect(await creditsOf([levelOf(a, null, 1)])).toEqual([]);
    expect(await creditsOf(null)).toEqual([]);
  });
  it("says a character's level once when the party holds it twice, in the character's own name", async () => {
    const d = structuredClone(scenes.readmeDetail);
    const lark = d.quest.members.find((m) => m.characterId === "lark")!;
    // A second Lark in the same role: the server tells them apart as "Lark II"; the level belongs to the character.
    d.quest.members.push({ ...lark, threadId: "thr_lark2", displayName: "Lark II" });
    const slot = await tale({ ...d, tale: { ...d.tale!, levels: [levelOf(lark, 1, 2, true)] } });
    await waitFor(() => expect(slot.container.querySelectorAll(".tv-credit").length).toBe(d.quest.members.length), { timeout: 3000 });
    const said = [...slot.container.querySelectorAll<HTMLElement>(".tv-credit-lvl")];
    expect(said.map((p) => p.textContent)).toEqual(["Lark reached level 2 on this quest."]);
    expect(said[0]!.closest(".tv-credit")!.querySelector(".tv-credit-nm b")!.textContent).toBe("Lark");
    const second = [...slot.container.querySelectorAll<HTMLElement>(".tv-credit")].find((c) => c.querySelector(".tv-credit-nm b")!.textContent === "Lark II")!;
    expect(second.querySelector(".tv-credit-lvl")).toBeNull();
  });
  it("with levels off in Settings, draws no level chip, notch or level line on the credits", async () => {
    const svc = (characterId: string, verifiedWaypoints: number) => ({ characterId, firstEarnedAt: 1, lastEarnedAt: 1, completeSince: null, backfilledAt: null, maker: { verifiedWaypoints, quests: 1 }, recordsTotal: 0, records: [] });
    const d = scenes.readmeDetail;
    const [a] = d.quest.members;
    const slot = await tale({ ...d, tale: { ...d.tale!, levels: [levelOf(a, 1, 2, true)], keptCharacterIds: ["lark"] } }, scenes.richRoom, false, { levels: false, serviceRecords: [svc("lark", 9)] });
    await waitFor(() => expect(slot.container.querySelectorAll(".tv-credit").length).toBe(d.quest.members.length), { timeout: 3000 });
    expect(slot.container.querySelector(".tv-credit .tv-lvl, .tv-credit-lvl")).toBeNull();
    expect([...slot.container.querySelectorAll(".tv-credit svg.tavern-crest")].some((c) => c.hasAttribute("data-notches"))).toBe(false);
    // Keep is the user's own mark, not a level: it stays.
    expect(slot.container.querySelector(".tv-credit [data-kept]")).not.toBeNull();
  });
  it("words a level from the helper: earned only with historyComplete true, else what it was after the quest", () => {
    const m = { characterId: "juno", classId: "ranger" };
    const at = (extra: object) => reachedLevel({ tale: { levels: [{ characterId: "juno", role: "maker", before: 1, after: 2, ...extra }] } } as Pick<BoardQuestDetail, "tale">, m)!;
    expect(reachedWords("Juno", at({ historyComplete: true }))).toBe("Juno reached level 2 on this quest.");
    expect(reachedWords("Juno", at({ historyComplete: false }))).toBe("Juno was level 2 after this quest.");
    expect(reachedWords("Juno", at({}))).toBe("Juno was level 2 after this quest.");
  });
  it("marks a credit Kept when its character kept this tale, as a still fact, not a control", async () => {
    const d = scenes.readmeDetail;
    const slot = await tale({ ...d, tale: { ...d.tale!, keptCharacterIds: ["lark"] } });
    await waitFor(() => expect(slot.container.querySelectorAll(".tv-credit").length).toBe(d.quest.members.length), { timeout: 3000 });
    const kept = [...slot.container.querySelectorAll<HTMLElement>(".tv-credit [data-kept]")];
    expect(kept).toHaveLength(1);
    // The seal sits beside the name, named for a screen reader; the level chip keeps its own place.
    expect(kept[0]!.closest(".tv-credit-nm")!.querySelector("b")!.textContent).toBe("Lark");
    expect(kept[0]!.getAttribute("aria-label")).toBe("Kept");
    expect(kept[0]!.tagName).toBe("SPAN");
  });
  it("shows a credit's level chip from level 2 up, with the crest's notch, and none at level 1", async () => {
    const svc = (characterId: string, verifiedWaypoints: number) => ({ characterId, firstEarnedAt: 1, lastEarnedAt: 1, completeSince: null, backfilledAt: null, maker: { verifiedWaypoints, quests: 1 }, recordsTotal: 0, records: [] });
    const d = scenes.readmeDetail;
    const slot = await tale({ ...d, tale: { ...d.tale!, keptCharacterIds: ["lark"] } }, scenes.richRoom, false, { serviceRecords: [svc("lark", 9), svc("rook", 1)] });
    await waitFor(() => expect(slot.container.querySelectorAll(".tv-credit .tv-lvl").length).toBe(1), { timeout: 3000 });
    const card = (name: string) => [...slot.container.querySelectorAll<HTMLElement>(".tv-credit")].find((c) => c.querySelector(".tv-credit-nm b")!.textContent === name)!;
    expect(card("Lark").querySelector(".tv-lvl")!.textContent).toBe("level 2");
    expect(card("Lark").querySelector("[data-kept]")).not.toBeNull();
    expect(card("Lark").querySelector("[role=img][aria-label$=', level 2']")).not.toBeNull();
    expect(card("Rook").querySelector(".tv-lvl")).toBeNull();
  });
  it("says the quest earned the level only when the server's history was complete", async () => {
    const [a, b] = scenes.readmeDetail.quest.members;
    const said = await creditsOf([levelOf(a, 1, 2, true), levelOf(b, null, 2, false)]);
    expect(said[0]).toMatch(/^.+ reached level 2 on this quest\.$/);
    expect(said[1]).toMatch(/^.+ was level 2 after this quest\.$/);
  });
  it("names the Keeper's tale and its note for you: the party, the Keeper, waypoints and reports, never raw ids", async () => {
    const d = scenes.readmeDetail;
    const lark = d.quest.members.find((m) => m.characterId === "lark")!;
    const report = d.reports.find((r) => r.memberThreadId === lark.threadId)!;
    const detail = { ...d, tale: { ...d.tale!, outcome: `${lark.threadId} finished per ${report.id}, and ${d.quest.keeperThreadId} sealed it.`, left: `Ask ${lark.threadId} about it.` } };
    const slot = await tale(detail);
    // Skeleton shapes keep the real classes, so look past them for the real lead.
    const lead = await waitFor(() => { const el = [...slot.container.querySelectorAll(".tv-tale-lead")].find((e) => !e.closest(".sk"))!; expect(el).toBeTruthy(); return el; });
    expect(lead.textContent).toMatch(/^Lark finished per Lark’s report( for .+)?, and the Keeper sealed it\.$/);
    expect(slot.container.querySelector(".tv-leftfor")!.textContent).toContain("Ask Lark about it.");
    expect(slot.container.querySelector(".tv-tale-lead, .tv-leftfor")!.textContent).not.toMatch(/\bthr_|\breport_/);
  });

});
