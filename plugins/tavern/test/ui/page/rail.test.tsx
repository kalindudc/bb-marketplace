import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
import { fireEvent, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcContract, type BoardQuestSummary, type Room } from "../../../src/shared/contract";
import { placeHeld } from "../../../src/ui/page/rail";
import { onTheRoad } from "../../../src/ui/kit";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

async function room(data: Room = scenes.richRoom) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(data) } as Partial<Handlers> as Handlers });
  slots.push(slot);
  await slot.findByRole("heading", { name: /The quest board/ });
  return slot;
}
const [wren, moss] = scenes.richRoom.keepers;
const quests = (base: BoardQuestSummary, n: number, phase: BoardQuestSummary["phase"]) => Array.from({ length: n }, (_, i) => ({ ...base, id: `${base.id}-${phase}-${i}`, short: `${base.short} ${i + 1}`, phase, endedAt: phase === "done" || phase === "stopped" ? base.updatedAt - i : null, archivedAt: null }));

// The hearth's own words; with the replay on, the kit ends them with the flicker and a link to its setting.
const hearthWords = (el: Element) => el.querySelector(".hearth-w")!.textContent!.replace(/\u00a0·$/, "");

describe("the rail's order", () => {
  it("puts the full-width queue first, then the board and cellar, then decisions, review, history and side folds", async () => {
    const slot = await room({ ...scenes.richRoom, archivedCount: 1 });
    const cols = [...slot.container.querySelectorAll(".rm-a-grid [class*='rm-o']")].map((el) => [...el.classList].find((c) => /^rm-o\d$/.test(c)));
    expect(cols).toEqual(["rm-o2", "rm-o5", "rm-o1", "rm-o3", "rm-o4"]);
    const o1 = slot.container.querySelector(".rm-o1")!;
    expect([...o1.querySelectorAll("[data-sec]")].map((el) => (el as HTMLElement).dataset.sec)).toEqual(["decided", "review"]);
    expect(slot.container.querySelector("[data-sec=needs] + .rm-a-grid")).toBeTruthy();
    expect((slot.container.querySelector(".rm-o2 [data-sec]") as HTMLElement).dataset.sec).toBe("board");
    expect([...slot.container.querySelectorAll(".rm-o4 #rm-lists [data-board-fold]")].map(el => el.getAttribute("data-board-fold"))).toEqual(["errands", "solos"]);
    expect((slot.container.querySelector(".rm-o4 [data-sec]") as HTMLElement).dataset.sec).toBe("events");
    expect((slot.container.querySelector(".rm-o5 [data-sec]") as HTMLElement).dataset.sec).toBe("cellar");
    const css = readFileSync(join(process.cwd(), "src/ui/page/page.css"), "utf8");
    const narrow = css.slice(css.indexOf("@container tavern-page (max-width: 900px)"));
    [2, 5, 1, 4, 3].forEach((slot, i) => expect(narrow).toContain(`.rm-o${slot} { order: ${i + 1}; }`));
  });
  it("holds a column taller than the screen once its end is in view, and never moves a column that just grew without a scroll", () => {
    expect(placeHeld({ scroll: 0, view: 900, moved: 0, height: 2000, bandTop: 100, shift: 0 })).toBe(0);
    // Scrolled past its end: it holds with its end 16 px above the screen's bottom (2000 - 900 + 16 = 1116 above the band's top).
    expect(placeHeld({ scroll: 1500, view: 900, moved: 1500, height: 2000, bandTop: 100, shift: 0 })).toBe(284);
    // It grew by 400 px with no scroll: it stays where it is.
    expect(placeHeld({ scroll: 1500, view: 900, moved: 0, height: 2400, bandTop: 100, shift: 284 })).toBe(284);
    expect(placeHeld({ scroll: 1000, view: 900, moved: 1000, height: 400, bandTop: 100, shift: 0 })).toBe(900);
  });
  it("never lengthens the page at its end: past the band's natural height a column only eases back (Pedro r5, 24 px per wheel)", () => {
    // The taller column at the page's end, its 16 px bound out of reach because the page has 40 px below the band: no push.
    const end = { view: 852, moved: 700, height: 1952, bandTop: 72, room: 1952 };
    let shift = 0, scroll = 1212;
    for (let i = 0; i < 10; i++) shift = placeHeld({ ...end, scroll, shift });
    expect(shift).toBe(0);
    // Without the band's height it would be pushed past the band (the old behaviour), which then grows the page.
    expect(placeHeld({ ...end, scroll, shift: 0, room: undefined })).toBe(24);
    // A shorter column still holds at its end inside the band.
    expect(placeHeld({ scroll: 1212, view: 852, moved: 1212, height: 696, bandTop: 72, shift: 0, room: 1952 })).toBe(1140);
    // The band shrank under a held column: it stays put, then eases back only as the page scrolls.
    expect(placeHeld({ scroll: 1212, view: 852, moved: 0, height: 696, bandTop: 72, shift: 1140, room: 1500 })).toBe(1140);
    expect(placeHeld({ scroll: 1112, view: 852, moved: 100, height: 696, bandTop: 72, shift: 1140, room: 1500 })).toBe(1040);
    // Back inside the band, it holds at the top again as the page scrolls up.
    expect(placeHeld({ scroll: 712, view: 852, moved: 400, height: 696, bandTop: 72, shift: 1040, room: 1500 })).toBe(640);
  });
});

describe("the status line", () => {
  it("jumps to a section and puts focus on its heading", async () => {
    const slot = await room();
    const line = slot.getByRole("group", { name: "Status" });
    fireEvent.click(within(line).getByRole("button", { name: /on the road/ }));
    expect(document.activeElement?.id).toBe("rm-board-h");
    fireEvent.click(within(line).getByRole("button", { name: /decided/ }));
    expect(document.activeElement?.id).toBe("room-decided");
    fireEvent.click(within(line).getByRole("button", { name: "What happened" }));
    expect(document.activeElement?.textContent).toMatch(/^What happened/);
    expect(document.activeElement?.closest("#rm-events")).toBeTruthy();
  });
  it("names the side lists' jump with both forms and both counts, and shows it only when the lists have something", async () => {
    const slot = await room();
    const errands = scenes.richRoom.keepers.flatMap((k) => k.errands).length, solos = scenes.richRoom.solos.length;
    const lists = `${errands} side quest${errands === 1 ? "" : "s"} · ${solos} solo${solos === 1 ? "" : "s"}`;
    const jump = slot.getByRole("button", { name: `${errands + solos} threads: ${lists}` });
    expect(jump.querySelector(".rm-lists-long")!.textContent).toBe(lists);
    expect(jump.querySelector(".rm-lists-short")!.textContent).toBe(`${errands + solos} threads`);
    fireEvent.click(jump);
    expect(document.activeElement?.textContent).toMatch(/^Side quests/);
    slots.splice(0).forEach((s) => s.lifecycle.unmount());
    const bare = await room({ ...scenes.richRoom, solos: [], keepers: scenes.richRoom.keepers.map((k) => ({ ...k, errands: [] })) });
    expect(within(bare.getByRole("group", { name: "Status" })).queryByRole("button", { name: /threads:/ })).toBeNull();
  });
  it("carries the one oldest wait on the page and has no cellar jump", async () => {
    const slot = await room();
    const line = slot.getByRole("group", { name: "Status" });
    expect(line.querySelector(".rm-oldest")!.textContent).toMatch(/^oldest \d/);
    expect(within(line).queryByRole("button", { name: /cellar/i })).toBeNull();
    expect(slot.container.textContent).not.toContain("Oldest wait");
  });
});

describe("the board", () => {
  it("keeps one hearth in the band and the map in the board heading", async () => {
    const slot = await room();
    const head = slot.container.querySelector(".rm-boardhead")!;
    const slotEl = slot.container.querySelectorAll(".tv-hearth-band [data-slot=hearth]");
    expect(head.querySelector("[data-slot=hearth]")).toBeNull();
    expect(slotEl).toHaveLength(1);
    // The hearth reads the same members-on-the-road count as the status line.
    expect(hearthWords(slotEl[0]!)).toBe("Lit · 1 Keeper busy");
    expect(within(slot.getByRole("group", { name: "Status" })).getByRole("button", { name: `${onTheRoad(scenes.richRoom)} on the road` })).toBeTruthy();
    expect(slotEl[0]!.querySelector("[data-part=Hearth]")).not.toBeNull();
    expect(within(head as HTMLElement).getByRole("button", { name: /The map/ })).toBeTruthy();
    expect(head.textContent).not.toMatch(/\d+ quests? on the road/);
  });
  it("gives a notice only to a Keeper with a quest in the room or an open ask, and one line to the rest", async () => {
    const idle = { ...moss!, boardQuests: [], errands: [], status: "listening" as const };
    const slot = await room({ ...scenes.richRoom, keepers: [wren!, idle], asks: scenes.richRoom.asks.filter((a) => a.keeperThreadId !== moss!.member.threadId) });
    expect(slot.getByRole("article", { name: /^Wren\b.*Keeper$/ })).toBeTruthy();
    expect(slot.queryByRole("article", { name: /^Moss\b.*Keeper$/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Keepers without a quest/ }));
    const row = slot.container.querySelector(".rm-idle .krow")!;
    expect(row.textContent).toContain("Moss");
    expect(row.textContent).toContain("no quest");
  });
  it("shows five active quests per Keeper and puts all returned work in one fold", async () => {
    const base = wren!.boardQuests.find((q) => q.phase !== "done" && q.phase !== "stopped")!;
    const many = { ...wren!, boardQuests: [...quests(base, 7, base.phase), ...quests(base, 4, "done")] };
    const slot = await room({ ...scenes.richRoom, keepers: [many, moss!], asks: [] });
    const notice = slot.getByRole("article", { name: /^Wren\b.*Keeper$/ });
    expect(notice.querySelectorAll(".qrow-live")).toHaveLength(5);
    expect(notice.querySelectorAll(".qrow-done")).toHaveLength(0);
    fireEvent.click(within(notice).getByRole("button", { name: "+2 more active quests" }));
    expect(notice.querySelectorAll(".qrow-live")).toHaveLength(7);
    fireEvent.click(slot.getByRole("button", { name: /Returned and stopped.*5/ }));
    const returned = slot.container.querySelector("[data-board-fold=returned]")!;
    expect(returned.querySelectorAll(".qrow-done")).toHaveLength(5);
    for (const name of notice.querySelectorAll<HTMLButtonElement>(".qrow-live [data-quest-name]")) expect(name.title).toMatch(/^Open the quest page: /);
    for (const name of returned.querySelectorAll<HTMLButtonElement>(".qrow-done [data-quest-name]")) expect(name.title).toMatch(/^Open the quest record: /);
  });
  it("lights one notice, never a quiet or archived Keeper's", async () => {
    const slot = await room({ ...scenes.richRoom, keepers: [{ ...wren!, quietSince: scenes.min(30) }, moss!] });
    const lit = slot.container.querySelectorAll(".rm-notice.lit");
    expect(lit.length).toBeLessThanOrEqual(1);
    expect(slot.getByRole("article", { name: /^Wren\b.*Keeper$/ }).classList.contains("lit")).toBe(false);
  });
});

describe("reduced motion", () => {
  it("has one rule for everything that moves, the kit's, and the page adds none of its own", () => {
    const page = readFileSync(join(process.cwd(), "src/ui/page/page.css"), "utf8");
    const kit = readFileSync(join(process.cwd(), "src/ui/kit/tavern.css"), "utf8");
    expect(page).not.toMatch(/prefers-reduced-motion|data-motion/);
    const rule = kit.slice(kit.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rule).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{ \.tavern, [^{]*\.tavern \*, [^{]*\{ animation: none !important; transition: none !important; \} \}/);
  });
  it("jumps in one step under reduce, and glides otherwise", async () => {
    const slot = await room();
    const calls: (ScrollBehavior | undefined)[] = [];
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) { calls.push(typeof arg === "object" ? arg.behavior : undefined); };
    const line = slot.getByRole("group", { name: "Status" });
    const before = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
    fireEvent.click(within(line).getByRole("button", { name: /on the road/ }));
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    fireEvent.click(within(line).getByRole("button", { name: /on the road/ }));
    window.matchMedia = before;
    expect(calls.slice(-2)).toEqual(["auto", "smooth"]);
  });
});
