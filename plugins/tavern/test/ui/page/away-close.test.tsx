import { readFileSync } from "node:fs";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type Room } from "../../../src/shared/contract";
import type { AwayControl, AwayDigest } from "../../../src/shared/away-rpc";
import { settingsContract } from "../../../src/shared/settings";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import type { Ask } from "../../../src/shared/schema";
import { NOTHING_ENDED_LINE, NOTHING_RUNNING_LINE, REOPEN_LINE, closePlan, returnReceipt } from "../../../src/ui/page/away";
import { askOutcome } from "../../../src/ui/page/finished";
import { activeQuests, workingQuests } from "../../../src/ui/page/model";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { StatusLine } from "../../../src/ui/page/room";
import * as scenes from "./scenes";

// Times read "returned 19:49" today and "returned Sat 23:31" after midnight, and the fixtures here and in scenes are relative to now,
// so the clock is pinned to midday before they load: only Date is faked, so findBy and the skeleton timers stay real.
vi.hoisted(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 14, 12, 0)); });
afterAll(() => { vi.useRealTimers(); });

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
const contract = {...rpcContract,...settingsContract};
type Handlers = PluginRpcTestHandlers<typeof contract>;

const LOADED = { timeout: 3000 };
const open: Room = { ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: null } };
const closedRoom: Room = { ...scenes.richRoom, away: { closed: true, until: Date.now() + 8 * 3600_000, dueBack: false, windowId: "w1" } };
/** A valid window for a state at this revision (the schema ties the two together). */
function win(version: number, over: Partial<NonNullable<AwayControl["window"]>> = {}): NonNullable<AwayControl["window"]> {
  return { id: "w1", version, closedAt: Date.now() - 60_000, until: Date.now() + 8 * 3600_000, note: null, quests: [], allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false }, stopList: ["merge", "deploy", "production", "sends-as-you", "delete"], eventFloor: 0, eventCeiling: null, returnedAt: null, returnCause: null, ...over };
}
const closedState = (revision: number, over: Partial<AwayControl> = {}) => control({ revision, window: win(revision), status: { closed: true, until: Date.now() + 8 * 3600_000, dueBack: false, windowId: "w1" }, ...over });
function control(over: Partial<AwayControl> = {}): AwayControl {
  return { revision: 0, window: null, status: { closed: false, until: null, dueBack: false, windowId: null }, watchedCount: 2, heldCount: 0, pendingStops: [], resumeRequired: [], ...over };
}
const inPlay = (m: Pick<Room["solos"][number], "engagement" | "state">) => m.engagement === "active" && m.state !== "failed";
const vault = scenes.richRoom.keepers.flatMap((k) => k.boardQuests).find((q) => q.id === "vault")!;
const vaultOnRoad = vault.members.filter((m) => m.role === "member" && !m.errand && inPlay(m)).length;
const wake = { blockers: true, productionAsksAfterTwoHours: false };

describe("what closing would do (the confirm's lines)", () => {
  describe("with the server's eligible counts (the members and solos Close acts on)", () => {
    const opts = { choices: { audit: "pause" as const }, allowWatched: false, wakeRules: wake };
    it("counts each quest from eligibleByQuest, not from the room's member states, and a missing row is 0", () => {
      // The room shows members on the road in every quest; the server says only 2 of Vault's count, 1 of them watched, and none of Audit's.
      const plan = closePlan(open, control({ eligibleByQuest: [{ questId: "vault", members: 2, watchedCount: 1 }], watchedByQuest: [{ questId: "vault", watchedCount: 1 }] }), opts);
      const line = (id: string) => plan.quests.find((q) => q.id === id)!.detail;
      expect(vaultOnRoad).not.toBe(2);
      expect(line("vault")).toBe("1 member keeps drafting where the guard holds; 1 watched member holds.");
      expect(line("audit")).toBe("paused; no member is on the road.");
      expect(line("rollout")).toBe("No member is on the road; new work stays as private drafts.");
      expect(plan.watchedTotal).toBeNull();
    });
    it("takes the errands that belong to no quest from the null row, and the solos from soloCount", () => {
      const plan = closePlan(open, control({ eligibleByQuest: [{ questId: null, members: 2, watchedCount: 1 }], soloCount: 0 }), opts);
      expect(plan.unattached).toBe("Errands that belong to no quest pause: 2, 1 of them watched.");
      expect(open.solos.some((m) => inPlay(m))).toBe(true);
      expect(plan.solos.running).toBe(0);
      const none = closePlan(open, control({ eligibleByQuest: [] , soloCount: 0 }), opts);
      expect(none.unattached).toBeNull();
    });
    it("shows the side-quest rule without a number while the server counts side quests inside their quest, and with one when it splits them", () => {
      const lumped = closePlan(open, control({ eligibleByQuest: [{ questId: "audit", members: 3, watchedCount: 0 }] }), opts);
      expect(lumped.sideQuests.pausing).toBeNull();
      const split = closePlan(open, control({ eligibleByQuest: [{ questId: "audit", members: 3, watchedCount: 0, errands: 1 } as never, { questId: "vault", members: 2, watchedCount: 0, errands: 0 } as never] }), opts);
      expect(split.sideQuests.pausing).toBe(1);
      expect(split.quests.find((q) => q.id === "audit")!.detail).toBe("paused; 2 members stop their turn and wait.");
    });
  });
  it("lists every live quest with its choice, and splits each quest's watched members from the server's per-quest counts", () => {
    const plan = closePlan(open, control({ watchedByQuest: [{ questId: "vault", watchedCount: 1 }, { questId: null, watchedCount: 1 }] }), { choices: { audit: "pause", rollout: "hold" }, allowWatched: false, wakeRules: wake });
    expect(plan.quests.map((q) => q.id)).toEqual(activeQuests(open).map((q) => q.id));
    const line = (id: string) => plan.quests.find((q) => q.id === id)!;
    expect(line("vault").choice).toBe("drafts-ready");
    expect(line("vault").text).toBe(`${vault.short}: ${vaultOnRoad - 1 === 1 ? "1 member keeps" : `${vaultOnRoad - 1} members keep`} drafting where the guard holds; 1 watched member holds.`);
    expect(line("audit").text).toMatch(/^[^:]+: paused; \d+ members? (stops its turn and waits|stop their turn and wait)\.$/);
    expect(line("rollout").text).toMatch(/: left out, so it's held; /);
    expect(plan.watchedTotal).toBeNull();
    expect(plan.unattached).toBe("Errands that belong to no quest pause: 1, 1 of them watched.");
    expect(plan.solos.text).toBe("Solo threads keep running. Where a solo is guarded, the stop list still applies; a watched solo isn't stopped, only watched.");
    expect(plan.solos.running).toBe(scenes.richRoom.solos.filter((m) => inPlay(m)).length);
    // Each kind is said once: the side-quest line counts only side quests whose quest pauses; the errands line carries the rest.
    expect(plan.sideQuests.text).toBe("Side quests follow their quest: a paused or unselected quest pauses its side quests.");
    expect(plan.sideQuests.text).not.toMatch(/no quest/);
    const attachedPausing = open.keepers.flatMap((k) => k.errands).filter((m) => inPlay(m) && (m.boardQuestId === "audit" || m.boardQuestId === "rollout")).length;
    expect(plan.sideQuests.pausing).toBe(attachedPausing);
  });
  it("says watched members keep drafting, watched, only when the user lets them", () => {
    const plan = closePlan(open, control({ watchedByQuest: [{ questId: "vault", watchedCount: 1 }] }), { choices: {}, allowWatched: true, wakeRules: wake });
    expect(plan.quests.find((q) => q.id === "vault")!.text).toMatch(/1 watched member keeps drafting, watched\.$/);
  });
  it("says a drafts-ready quest with nobody on the road keeps new work as private drafts, without repeating its choice", () => {
    const quiet: Room = { ...open, keepers: open.keepers.map((k) => ({ ...k, boardQuests: k.boardQuests.map((q) => q.id === "vault" ? { ...q, members: q.members.map((m) => ({ ...m, state: "idle" as const, engagement: "resting" as const })) } : q) })) };
    const plan = closePlan(quiet, control({ watchedByQuest: [] }), { choices: {}, allowWatched: false, wakeRules: wake });
    const v = plan.quests.find((q) => q.id === "vault")!;
    expect(v.detail).toBe("No member is on the road; new work stays as private drafts.");
    expect(v.detail).not.toMatch(/drafts ready/i);
  });
  it("without per-quest counts from the server, keeps one total line instead of inventing zeros", () => {
    const plan = closePlan(open, control({ watchedCount: 2 }), { choices: {}, allowWatched: false, wakeRules: wake });
    expect(plan.watchedTotal).toBe("2 watched members hold across all quests.");
    expect(plan.quests.find((q) => q.id === "vault")!.text).not.toMatch(/watched/);
  });
  it("reopens on any real message from you, a solo's thread included, and ends nothing", () => {
    expect(REOPEN_LINE).toBe("Answering an ask or messaging any Tavern thread, a solo included, reopens the tavern.");
    expect(NOTHING_ENDED_LINE).toBe("Nothing is ended; paused work waits for your return.");
  });
});

async function tab(rpc: Partial<Handlers>, room: Room = open) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const t = plugin.tabs.find((x) => x.id === "closing-time")!;
  const slot = renderSlot(t as never, { subPath: "closing", params: null } as never, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), settings: () => settingsView, away: () => control({ watchedByQuest: [{ questId: "vault", watchedCount: 1 }] }), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
async function review(slot: RenderedSlot) {
  const button = await slot.findByRole("button", { name: "Review before closing" }, LOADED);
  // It waits for the server's away state (the revision to close against).
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false), LOADED);
  fireEvent.click(button);
  return slot.findByRole("region", { name: /^Before you close/ });
}

describe("the Closing time sheet", () => {
  it("uses changed sheet defaults and allows an empty stop list", async () => {
    const view = structuredClone(settingsView);
    view.effective.away = { neverWhileClosed: [], defaultEndState: "pause", defaultAllowWatched: true, defaultBackAtHour: 16, defaultWakeBlockers: false, defaultWakeProduction: true, productionWakeHours: 5 };
    const save = vi.fn(() => ({code:"ok" as const,revision:view.revision+1,settings:view,problems:[]}));
    const awayClose = vi.fn(() => ({code:"closed" as const,state:closedState(1)}));
    const slot = await tab({ settings:()=>view, settingsUpdate:save, awayClose });
    const stop = within(await slot.findByRole("group",{name:"Never while closed"}));
    expect(stop.getAllByRole("checkbox",{checked:false})).toHaveLength(6);
    expect(stop.getAllByRole("checkbox").every(input => !(input as HTMLInputElement).disabled)).toBe(true);
    const confirm = await review(slot);
    expect(confirm.textContent).toContain("Nothing is blocked while closed.");
    expect(confirm.textContent).toContain("A production or cluster write ask wakes you after 5 hours.");
    expect(confirm.querySelectorAll(".tv-confirm-c.c-pause")).toHaveLength(workingQuests(open).length);
    expect((slot.getByLabelText("Back at") as HTMLInputElement).value).toMatch(/T16:00$/);
    expect((slot.getByRole("checkbox",{name:/Let watched/}) as HTMLInputElement).checked).toBe(true);
    expect(slot.container.textContent).toContain("These choices apply only to this window.");
    fireEvent.click(stop.getByRole("checkbox",{name:"Merge"}));
    const amended = await review(slot);
    expect(amended.textContent).toContain("Closing time blocks merge.");
    fireEvent.click(within(amended).getByRole("button",{name:"Close the tavern"}));
    await waitFor(()=>expect(awayClose).toHaveBeenCalledWith(expect.objectContaining({stopList:["merge"]})));
    expect(save).not.toHaveBeenCalled();
    expect(view.effective.away.neverWhileClosed).toEqual([]);
  });
  it("with nothing live, leads with one line and shows no zero-count lines and no empty divider", async () => {
    const quiet: Room = { ...open, asks: [], solos: open.solos.map((m) => ({ ...m, state: "idle" as const, engagement: "stopped" as const })), keepers: open.keepers.map((k) => ({ ...k, errands: k.errands.map((m) => ({ ...m, state: "idle" as const, engagement: "resting" as const })), boardQuests: k.boardQuests.map((q) => ({ ...q, phase: "done" as const })) })) };
    const slot = await tab({}, quiet);
    const confirm = await review(slot);
    expect(confirm.querySelector(".tv-confirm-q")).toBeNull();
    expect(confirm.querySelectorAll("ul")).toHaveLength(1);
    const lines = [...confirm.querySelectorAll<HTMLElement>("li[data-line]")];
    expect(lines.map((l) => l.dataset.line)).toEqual(["nothing-running", "stop-policy", "reopen", "nothing-ended"]);
    expect(lines[0]!.textContent).toBe(NOTHING_RUNNING_LINE);
    for (const l of lines) expect(l.textContent).not.toMatch(/\b0\b|: 0\./);
    // The divider belongs between the quest list and the rest, so with no quest list there is none.
    const css = readFileSync("src/ui/page/away.css", "utf8");
    expect(css).toMatch(/\.tv-confirm-q \+ \.tv-confirm-l \{[^}]*border-top/);
    expect(css).not.toMatch(/\.tv-page \.tv-confirm-l \{[^}]*border-top/);
  });
  it("confirms in place with every quest and its choice, then closes with what the user chose; Hold leaves the quest out", async () => {
    const awayClose = vi.fn((input: Parameters<Handlers["awayClose"]>[0]) => ({ code: "closed" as const, state: closedState(1, { window: win(1, { until: input.until }), status: { closed: true, until: input.until, dueBack: false, windowId: "w1" } }) }));
    const slot = await tab({ awayClose });
    const audit = await slot.findByRole("group", { name: /audit$/ }, LOADED);
    fireEvent.click(within(audit).getByLabelText(/^Pause/));
    const rollout = slot.getByRole("group", { name: /^Rollout/ });
    fireEvent.click(within(rollout).getByLabelText(/^Hold/));
    const confirm = await review(slot);
    const rows = [...confirm.querySelectorAll<HTMLElement>("li[data-quest]")];
    expect(rows.map((r) => r.dataset.quest)).toEqual(activeQuests(open).map((q) => q.id));
    expect(rows.map((r) => r.querySelector(".tv-confirm-c")!.textContent)).toEqual(activeQuests(open).map((q) => q.id === "audit" ? "Pause" : q.id === "rollout" ? "Hold" : "Drafts ready"));
    expect(confirm.querySelector('[data-line="reopen"]')!.textContent).toBe(REOPEN_LINE);
    expect(confirm.querySelector('[data-line="solos"]')!.textContent).toMatch(/solos? running\.$/);
    expect(confirm.querySelector('[data-line="nothing-ended"]')!.textContent).toBe(NOTHING_ENDED_LINE);
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Close the tavern" }));
    await waitFor(() => expect(awayClose).toHaveBeenCalledTimes(1));
    const input = awayClose.mock.calls[0]![0];
    expect(input.revision).toBe(0);
    expect(input.allowWatched).toBe(false);
    expect(input.wakeRules).toEqual(wake);
    expect(input.quests).toEqual(activeQuests(open).filter((q) => q.id !== "rollout").map((q) => ({ questId: q.id, endState: q.id === "audit" ? "pause" : "drafts-ready" })));
    expect(input.until).toBeGreaterThan(Date.now());
    expect((await slot.findByRole("status")).textContent).toMatch(/^Closed until .+\. Return from the status line or here\.$/);
  });
  it("says so when stops haven't confirmed, naming each member without raw ids", async () => {
    const pending = closedState(1, { pendingStops: [{ threadId: "thr-lark", error: "thr-lark did not stop in time" }] });
    const slot = await tab({ awayClose: () => ({ code: "pending" as const, state: pending }) });
    fireEvent.click(within(await review(slot)).getByRole("button", { name: "Close the tavern" }));
    const note = await slot.findByText((_, el) => el?.matches("[data-pending-stop]") ?? false, undefined, LOADED);
    expect(note.textContent).toBe("Lark’s stop isn’t confirmed yet: Lark did not stop in time. Tavern retries it.");
  });
  it("on a stale revision, says nothing has closed and keeps the choices", async () => {
    const slot = await tab({ awayClose: () => ({ code: "stale" as const, state: closedState(3) }) });
    fireEvent.click(within(await review(slot)).getByRole("button", { name: "Close the tavern" }));
    expect((await slot.findByRole("status", {}, LOADED)).textContent).toMatch(/settings changed\. Nothing has closed/);
  });
  it("when closing fails, keeps every field and offers Retry", async () => {
    const slot = await tab({ awayClose: () => { throw new Error("guard unreachable"); } });
    fireEvent.click(within(await review(slot)).getByRole("button", { name: "Close the tavern" }));
    const alert = await slot.findByRole("alert", {}, LOADED);
    expect(alert.textContent).toMatch(/Couldn’t close: .*guard unreachable.*Nothing has closed; your choices are kept\./);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(slot.getByLabelText("Back at")).toBeTruthy();
  });
});

describe("Return and the stops that haven't confirmed", () => {
  it("puts a real Return button on the status line, and its receipt says who waits for their Keeper", async () => {
    const awayReturn = vi.fn(() => ({ code: "returned" as const, state: control({ revision: 2, window: win(2, { eventCeiling: 5, returnedAt: Date.now(), returnCause: { kind: "explicit-return", threadId: null, refId: null } }), status: { closed: false, until: null, dueBack: false, windowId: "w1" }, resumeRequired: [{ threadId: "thr-lark", keeperThreadId: "thr-wren", questId: "audit" }] }) }));
    const slot = renderSlot({ component: () => <StatusLine room={closedRoom} registry={scenes.registry} /> }, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { away: () => closedState(1), awayReturn } as Partial<Handlers> as Handlers });
    slots.push(slot);
    const button = await slot.findByRole("button", { name: /^Return/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button.classList.contains("btn")).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(awayReturn).toHaveBeenCalledTimes(1));
    expect((awayReturn.mock.calls[0] as unknown[])[0]).toEqual({ windowId: "w1" });
    expect((await slot.findByRole("status")).textContent).toMatch(/Lark waits for a fresh instruction from its Keeper\./);
  });
  // The server pushes a room change once Return lands; the test does the same with an invalidation.
  async function reopening(subPath: string, panel = false) {
    let returned = false;
    const awayReturn = vi.fn(() => { returned = true; return { code: "returned" as const, state: control({ revision: 2, window: win(2, { eventCeiling: 5, returnedAt: Date.now(), returnCause: { kind: "explicit-return", threadId: null, refId: null } }), status: { closed: false, until: null, dueBack: false, windowId: "w1" } }) }; });
    const reopened: Room = { ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: "w1" } };
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const rpc = { registry: () => structuredClone(scenes.registry), room: () => structuredClone(returned ? reopened : closedRoom), boardQuest: () => structuredClone(scenes.richDetails.vault!), away: () => returned ? control({ revision: 2 }) : closedState(1), awayReturn } as Partial<Handlers> as Handlers;
    const target = panel ? plugin.tabs.find((x) => x.id === "closing-time")! : plugin.navPanels[0]!;
    const slot = renderSlot(target as never, { subPath, params: null } as never, { pluginId: "tavern", experimental_rpcContract: contract, rpc });
    slots.push(slot);
    fireEvent.click(await slot.findByRole("button", { name: /^Return$/ }, LOADED));
    await waitFor(() => expect(awayReturn).toHaveBeenCalledTimes(1), LOADED);
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    return slot;
  }
  for (const [where, subPath, panel] of [["the common room's status line", "room", false], ["the Closing time page", "closing", false], ["the Closing time sheet in the side panel", "closing", true]] as const) {
    it(`keeps the Return receipt on ${where} after the room reopens`, async () => {
      const slot = await reopening(subPath, panel);
      // The room now says open: the Return button is gone, and the receipt stays, with its link to the digest.
      const surface = subPath === "room" ? within(await slot.findByRole("group", { name: "Status" }, LOADED)) : slot;
      await waitFor(() => expect(surface.queryByRole("button", { name: /^Return(?:ing…)?$/ })).toBeNull(), LOADED);
      const receipt = await surface.findByRole("status", {}, LOADED);
      expect(receipt.textContent).toMatch(/^Back\. Keepers pick up with a digest on their next tick\./);
      expect(within(receipt).getByRole("button", { name: /While closed/ })).toBeTruthy();
      if (panel) expect(slot.container.querySelector("form.tv-awayform")).not.toBeNull();
    });
  }
  it("drops Close's receipt once the room says closed, so the sheet shows only Return's after it reopens", async () => {
    type Phase = "open" | "closed" | "back";
    let phase = "open" as Phase;
    const back = control({ revision: 2, window: win(2, { eventCeiling: 5, returnedAt: Date.now(), returnCause: { kind: "explicit-return", threadId: null, refId: null } }), status: { closed: false, until: null, dueBack: false, windowId: "w1" } });
    const awayClose = vi.fn(() => { phase = "closed"; return { code: "closed" as const, state: closedState(1) }; });
    const awayReturn = vi.fn(() => { phase = "back"; return { code: "returned" as const, state: back }; });
    const rooms: Record<Phase, Room> = { open, closed: closedRoom, back: { ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: "w1" } } };
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const t = plugin.tabs.find((x) => x.id === "closing-time")!;
    const slot = renderSlot(t as never, { subPath: "closing", params: null } as never, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(rooms[phase]), settings: () => settingsView, away: () => phase === "open" ? control() : phase === "closed" ? closedState(1) : back, awayClose, awayReturn } as Partial<Handlers> as Handlers });
    slots.push(slot);
    const confirm = await review(slot);
    fireEvent.click(within(confirm).getByRole("button", { name: "Close the tavern" }));
    await waitFor(() => expect(awayClose).toHaveBeenCalledTimes(1), LOADED);
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    fireEvent.click(await slot.findByRole("button", { name: /^Return/ }, LOADED));
    await waitFor(() => expect(awayReturn).toHaveBeenCalledTimes(1), LOADED);
    await act(async () => { await slot.experimental_invalidateRpc(null); });
    await slot.findByRole("button", { name: "Review before closing" }, LOADED);
    const said = slot.getAllByRole("status").map((x) => x.textContent);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Back\. /);
  });
  it("says nothing on the status line while open with no Return to report", async () => {
    const slot = renderSlot({ component: () => <StatusLine room={open} registry={scenes.registry} /> }, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { away: () => control() } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await slot.findByText(/need you/);
    expect(slot.container.querySelector(".tv-return")).toBeNull();
  });
  it("names drafts-ready quests and their cleanup only when the window had them", () => {
    const empty = returnReceipt({ code: "returned", state: control({ window: win(2, { quests: [] }) }) }, closedRoom, scenes.registry);
    expect(empty).toBe("Back. Keepers pick up with a digest on their next tick.");
    const kept = returnReceipt({ code: "returned", state: control({ window: win(2, { quests: [{ questId: "vault", endState: "drafts-ready" }, { questId: "audit", endState: "pause" }] as never }) }) }, closedRoom, scenes.registry);
    expect(kept).toBe("Back. Keepers pick up with a digest on their next tick. The drafts-ready quest carries on, and the member threads of any that returned while you were away are cleaned up now.");
  });
  it("words each return code", () => {
    const state = control();
    expect(returnReceipt({ code: "unchanged", state }, closedRoom, scenes.registry)).toBe("Already open.");
    expect(returnReceipt({ code: "returned", state }, closedRoom, scenes.registry)).toMatch(/^Back\. Keepers pick up with a digest/);
  });
  it("names unconfirmed stops on the room and on the member's quest page, with the count on the status line", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const rpc = { registry: () => structuredClone(scenes.registry), room: () => structuredClone(closedRoom), boardQuest: () => structuredClone(scenes.richDetails.vault!), away: () => closedState(1, { pendingStops: [{ threadId: "thr-juno", error: null }] }) } as Partial<Handlers> as Handlers;
    const room = renderSlot(plugin.navPanels[0]!, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc });
    slots.push(room);
    expect((await room.findByRole("button", { name: /1 stop not confirmed/ }, LOADED))).toBeTruthy();
    expect(room.container.querySelector("[data-pending-stop]")!.textContent).toBe("Juno’s stop isn’t confirmed yet. Tavern retries it.");
    const quest = renderSlot(plugin.navPanels[0]!, { subPath: "quest/vault" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc });
    slots.push(quest);
    await waitFor(() => expect(quest.container.querySelector("[data-pending-stop]")).not.toBeNull(), LOADED);
  });
});

describe("While closed (the digest)", () => {
  const ask = (id: string, createdAt: number, state: Ask["state"] = "open"): Ask => ({ ...scenes.richAsks[0]!, id, createdAt, state });
  const digest: AwayDigest = {
    window: { id: "w1", version: 1, closedAt: Date.now() - 9 * 3600_000, until: Date.now() - 3600_000, note: "Back after the standup", quests: [{ questId: "vault", endState: "drafts-ready" }], allowWatched: false, wakeRules: wake, stopList: ["merge", "deploy", "production", "sends-as-you", "delete"], eventFloor: 0, eventCeiling: 10, returnedAt: Date.now() - 1800_000, returnCause: { kind: "explicit-return", threadId: null, refId: null } },
    totalEvents: 0, nextCursor: null, events: [], totalAsks: 2, nextAskCursor: null,
    asks: [{ ask: ask("a-old", 1, "answered"), waitingAtEnd: false }, { ask: ask("a-wait", 2), waitingAtEnd: true }],
    quests: [
      { questId: "vault", title: vault.title, short: vault.short, missing: false, events: 3, reports: 1, decisions: 0, asks: 1, returnedWhileAway: true, deferredCleanup: [{ threadId: "thr-juno", action: "archive-member-thread", pending: true, error: null }, { threadId: "thr-pip", action: "archive-member-thread", pending: false, error: "thr-pip is busy; thr_9zzunknown holds it" }, { threadId: "thr-vex", action: "archive-member-thread", pending: true, error: "No cleanup state recorded" }] },
      { questId: "audit", title: "DNS audit", short: "Audit", missing: false, events: 2, reports: 0, decisions: 1, asks: 0 },
      { questId: "gone", title: "Old quest", short: "Old", missing: true, events: 1, reports: 0, decisions: 0, asks: 0 },
    ],
  };
  it("leads with what waits on you, then the quests that returned (with the tale and the full quest) and their cleanup, then the rest", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const room: Room = { ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: "w1" } };
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "digest" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), away: () => control(), awayDigest: () => structuredClone(digest) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await slot.findByRole("heading", { name: "Returned while you were away" }, LOADED);
    expect([...slot.container.querySelectorAll<HTMLElement>(".tv-digest-grid > [data-sec]")].map((s) => s.dataset.sec)).toEqual(["asks", "returned", "other", "events"]);
    expect(slot.container.querySelector('[data-sec="asks"] [data-rest]')).toBeNull();
    const asks = [...slot.container.querySelectorAll<HTMLElement>(".tv-dg-ask")];
    expect(asks[0]!.dataset.waiting).toBe("true");
    expect(asks[0]!.textContent).toContain("was waiting when you returned");
    const returned = slot.container.querySelector<HTMLElement>('[data-returned="vault"]')!;
    expect(within(returned).getByRole("button", { name: /^The tale/ })).toBeTruthy();
    expect(within(returned).getByRole("button", { name: /^The full quest/ })).toBeTruthy();
    const clean = [...returned.querySelectorAll<HTMLElement>("[data-cleanup]")].map((c) => [c.dataset.cleanup, c.textContent]);
    expect(clean, JSON.stringify(clean)).toEqual([["waits", "Juno’s thread: archive waits"], ["failed", "Pip’s thread: archive failed: Pip is busy; another thread holds it"], ["waits-problem", "Vex’s thread: archive waits: No cleanup state recorded"]]);
    const page = slot.container.querySelector<HTMLElement>(".tv-digest")!;
    expect(page.textContent).not.toMatch(/\bthr[-_]/);
    expect([...page.querySelectorAll(".tv-sline .tv-facts > span")].map((e) => e.textContent)).toEqual([expect.stringMatching(/^closed /), expect.stringMatching(/^back at /), expect.stringMatching(/^returned \d\d:\d\d$/), "you returned"]);
    expect(page.textContent).toContain("Your note: “Back after the standup”");
    expect(page.textContent).toContain("no longer on the board");
  });
  it("never counts more asks than it lists: the rest comes from the next page, or the list says how many it shows", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const room: Room = { ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: "w1" } };
    const three = [ask("a1", 1), ask("a2", 2), ask("a3", 3)].map((a) => ({ ask: a, waitingAtEnd: false }));
    const paged = vi.fn((input: { askCursor?: string | null }) => input.askCursor === "c2" ? { ...digest, asks: [{ ask: ask("a4", 4), waitingAtEnd: false }], nextAskCursor: null } : { ...digest, totalAsks: 4, asks: three, nextAskCursor: "c2" });
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "digest" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), away: () => control(), awayDigest: paged } as Partial<Handlers> as Handlers });
    slots.push(slot);
    const asks = await waitFor(() => { const sec = slot.container.querySelector<HTMLElement>('[data-sec="asks"]'); expect(sec).not.toBeNull(); return sec!; }, LOADED);
    expect(asks.querySelector(".tv-count")!.textContent).toBe("4 asks");
    expect(asks.querySelectorAll(".tv-dg-ask")).toHaveLength(3);
    const more = within(asks).getByRole("button", { name: "Show 1 more ask" });
    fireEvent.click(more);
    await waitFor(() => expect(asks.querySelectorAll(".tv-dg-ask")).toHaveLength(4), LOADED);
    expect(asks.querySelector("[data-rest]")).toBeNull();
  });
  it("says how many it shows when the server holds more asks than it sent and offers no next page", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const room: Room = { ...scenes.richRoom, away: { closed: false, until: null, dueBack: false, windowId: "w1" } };
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "digest" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), away: () => control(), awayDigest: () => ({ ...digest, totalAsks: 4, nextAskCursor: null }) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    const rest = await waitFor(() => { const r = slot.container.querySelector<HTMLElement>('[data-sec="asks"] [data-rest]'); expect(r).not.toBeNull(); return r!; }, LOADED);
    expect(rest.textContent).toBe("2 of 4 shown");
  });
  it("says the tavern hasn't closed yet when there is no window", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "digest" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(open) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    expect(await slot.findByText(/hasn’t closed yet/, undefined, LOADED)).toBeTruthy();
  });
  it("words an ask closed by a quest that returned while you were away", () => {
    expect(askOutcome({ ...scenes.richAsks[0]!, state: "withdrawn", answer: null, withdrawnCause: "backup-restored" } as unknown as Ask)).toBe("withdrawn when this backup was restored");
    expect(askOutcome({ ...scenes.richAsks[0]!, state: "withdrawn", answer: null, withdrawnCause: "plan-superseded" } as Ask)).toBe("withdrawn");
    expect(askOutcome({ ...scenes.richAsks[0]!, state: "withdrawn", answer: null, withdrawnCause: "quest-returned" } as Ask)).toBe("withdrawn when the quest returned");
  });
});
