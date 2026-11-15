import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardQuestDetailSchema, ledgerSchema, rpcContract, type BoardQuestDetail, type Room } from "../../../src/shared/contract";
import formatDuration from "./live-format-duration.json";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

// The live captures ended on Sat Nov 14 2026 (08:05 local), and a time reads "08:04" on that day but "Nov 14 08:04" on any other,
// so the clock is pinned to that day's midday before scenes loads: only Date is faked, so findBy stays real.
const CAPTURE_DAY_NOON = vi.hoisted(() => { const noon = new Date(2026, 10, 14, 12, 0).getTime(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(noon); return noon; });
afterAll(() => { vi.useRealTimers(); });

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

async function open(subPath: string, room: Room, detail: BoardQuestDetail) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const ledger = ledgerSchema.parse({ keeperThreadId: detail.quest.keeperThreadId, boardQuests: [detail.quest], decisions: detail.decisions, rules: detail.rules, asks: detail.asks, routes: detail.routes, restatement: "Rules: none.", lastReanchorAt: null });
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(room), boardQuest: () => structuredClone(detail), ledger: () => ledger } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}

const vault = scenes.richDetails.vault!;
const stopEvent = { id: 9001, at: scenes.min(360), keeperThreadId: "thr-wren", boardQuestId: "vault", actor: { kind: "user" as const }, type: "quest.stopped", text: "Stop requested for every party member", data: {} };
const stopped: BoardQuestDetail = { ...vault, asks: vault.asks.map((a) => ({ ...a, state: "withdrawn" as const, answer: null })), events: [...vault.events, stopEvent], quest: { ...vault.quest, phase: "stopped", endedAt: scenes.min(360) } };
const returned = scenes.readmeDetail;

// A page waits on three RPCs before its first element; under a loaded full run that can pass testing-library's 1 s default.
const LOADED = { timeout: 3000 };
async function heading(slot: RenderedSlot, title: string) { return (await slot.findByRole("heading", { level: 1, name: title }, LOADED)).closest("header")!; }

describe("the pinned clock", () => {
  it("is the live capture's own day, so its times read without a date", () => {
    expect(new Date(formatDuration.quest.endedAt!).toDateString()).toBe(new Date(CAPTURE_DAY_NOON).toDateString());
    expect(Date.now()).toBeGreaterThanOrEqual(CAPTURE_DAY_NOON);
  });
});

describe("a stopped quest's record", () => {
  it("says who stopped it, when and after how long, once, with no Stop, filled button or review budget", async () => {
    const slot = await open(`quest/${vault.quest.id}`, scenes.richRoom, stopped);
    const head = await heading(slot, vault.quest.title);
    expect(within(head).getByText("Stopped by you")).toBeTruthy();
    expect(head.textContent).toMatch(/after \d/);
    expect(head.textContent).not.toMatch(/Stopped · Stopped|by you · by you|review \d+ of \d+/);
    expect(within(head).queryByRole("button", { name: /Stop quest/ })).toBeNull();
    expect(head.querySelector(".btn.pri")).toBeNull();
  });
  it("says only 'Stopped' when the stop was not recorded", async () => {
    const slot = await open(`quest/${vault.quest.id}`, scenes.richRoom, { ...stopped, events: vault.events });
    const head = await heading(slot, vault.quest.title);
    expect(head.textContent).toMatch(/Stopped/);
    expect(head.textContent).not.toMatch(/Stopped by/);
  });
  it("leads with what happened in sentences, then what was done and left, with no live-quest machinery and no glow", async () => {
    const slot = await open(`quest/${vault.quest.id}`, scenes.richRoom, stopped);
    const story = await slot.findByRole("region", { name: "What happened" }, LOADED);
    const lines = [...story.querySelectorAll(".tv-rec-lines li")].map((li) => li.textContent);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)).toBe("2 asks withdrawn.");
    expect(lines.join(" ")).not.toMatch(/\bthr[-_]|\bw\d\b|No reason was recorded/);
    expect(within(story).getByText("pickup to stop")).toBeTruthy();
    expect(slot.getByRole("region", { name: "Done" })).toBeTruthy();
    expect(within(slot.getByRole("region", { name: "Left" })).getByText(/DNS cut/)).toBeTruthy();
    expect(slot.queryByRole("region", { name: "By whose move" })).toBeNull();
    expect(slot.container.textContent).not.toMatch(/By whose move|Left when stopped|ready ≈/);
    expect(slot.container.querySelector(".tv-record .lit, .tv-record.lit")).toBeNull();
    expect(slot.container.querySelector(".tv-ggrid, .tv-ghead")).toBeNull();
  });
  it("folds the map with 'as it was when stopped' and shows it on request, remembered", async () => {
    const slot = await open(`quest/${vault.quest.id}`, scenes.richRoom, stopped);
    const show = await slot.findByRole("button", { name: /^Quest map\b.*as it was when stopped Show$/ }, LOADED);
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector(".qm")).toBeNull();
    fireEvent.click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(JSON.stringify(window.localStorage)).toContain(`quest:${vault.quest.id}.map`);
  });
  it("keeps the complete record, each part with its count; history and decisions open, the rest folded", async () => {
    const slot = await open(`quest/${vault.quest.id}`, scenes.richRoom, stopped);
    const record = await slot.findByRole("group", { name: "The complete record" }, LOADED);
    const parts = [...record.querySelectorAll<HTMLButtonElement>(".tv-rec-ft")].map((b) => [b.querySelector(".tv-rec-tt")!.textContent, b.querySelector(".tv-count")?.textContent, b.getAttribute("aria-expanded")]);
    expect(parts.map(([t]) => t)).toEqual(["History", "Decisions", "Asks and answers", "The plan", "Reports", ...(vault.scopes?.length || vault.violations?.length ? ["Guardrails"] : []), ...(vault.notes?.some((n) => n.kind !== "waiting-on-user") ? ["Kept in mind"] : []), "Wren’s rules and re-anchor"]);
    for (const [, count] of parts) expect(count).toMatch(/^\d+ \w/);
    expect(parts.find(([t]) => t === "History")![2]).toBe("true");
    expect(parts.find(([t]) => t === "Decisions")![2]).toBe("true");
    expect(parts.find(([t]) => t === "Asks and answers")).toEqual(["Asks and answers", "2 asks", "false"]);
    fireEvent.click(within(record).getByRole("button", { name: /Asks and answers/ }));
    expect(within(record).getAllByText("withdrawn").length).toBe(2);
  });
  it("has no tale: the tale route says so and points to the record", async () => {
    const slot = await open(`tale/${vault.quest.id}`, scenes.richRoom, stopped);
    await slot.findByText("This quest was stopped, so it has no tale. The quest record has what was done and left.", undefined, LOADED);
    fireEvent.click(slot.getByRole("button", { name: /The quest record/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `quest/${vault.quest.id}` } });
  });
});

describe("a returned quest's record", () => {
  it("leads with the Keeper's outcome and the tale; the header has The tale first and no filled button", async () => {
    const slot = await open(`quest/${returned.quest.id}`, scenes.liveRoom, returned);
    const head = await heading(slot, returned.quest.title);
    expect(within(head).getByText("Returned")).toBeTruthy();
    expect(head.textContent).toMatch(/took \d/);
    expect(head.querySelector(".tv-gacts > button")!.textContent).toMatch(/The tale/);
    expect(head.querySelector(".btn.pri")).toBeNull();
    const story = slot.getByRole("region", { name: "What happened" });
    expect(story.textContent).toContain(returned.tale!.outcome.slice(0, 40));
    expect(within(story).getByText("pickup to return")).toBeTruthy();
    expect(slot.container.querySelector(".tv-record .lit")).toBeNull();
    expect(slot.getByRole("button", { name: /^Quest map\b.*as it returned Show$/ }).getAttribute("aria-expanded")).toBe("false");
  });
  it("links to the tale", async () => {
    const slot = await open(`quest/${returned.quest.id}`, scenes.liveRoom, returned);
    const story = await slot.findByRole("region", { name: "What happened" }, LOADED);
    fireEvent.click(within(story).getByRole("button", { name: /The tale/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `tale/${returned.quest.id}` } });
  });
  it("and the tale links back to the full quest", async () => {
    const tale = await open(`tale/${returned.quest.id}`, scenes.liveRoom, returned);
    fireEvent.click(await tale.findByRole("button", { name: /The full quest/ }, LOADED));
    expect(tale.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `quest/${returned.quest.id}` } });
  });
});

describe("a live quest keeps its live page", () => {
  it("still has By whose move and the glow", async () => {
    const slot = await open(`quest/${vault.quest.id}`, scenes.richRoom, vault);
    await waitFor(() => expect(slot.getByRole("region", { name: "By whose move" })).toBeTruthy());
    expect(slot.container.querySelector(".tv-record")).toBeNull();
  });
});

describe("truth on the record (Tony's review)", () => {
  const live = boardQuestDetailSchema.parse(formatDuration);
  const keeper = { ...scenes.liveRoom.keepers[0]!, member: { ...scenes.liveRoom.keepers[0]!.member, threadId: live.quest.keeperThreadId }, boardQuests: [live.quest], errands: [], archived: true };
  const room: Room = { ...scenes.liveRoom, keepers: [...scenes.liveRoom.keepers, keeper] };
  it("an archived Keeper reads 'Thread archived' in the header, and its thread button is a plain link", async () => {
    const slot = await open(`quest/${live.quest.id}`, room, live);
    const head = await heading(slot, live.quest.title);
    expect(within(head).getByText("Thread archived")).toBeTruthy();
    expect(head.textContent).not.toMatch(/Idle|Listening/);
    const thread = within(head).getByRole("button", { name: /thread$/ });
    expect(thread.classList.contains("lnk-btn")).toBe(true);
  });
  it("formatDuration's Rook, stopped mid-check, gets no stock wrap line; a member's own report voice still shows", async () => {
    const slot = await open(`quest/${live.quest.id}`, room, live);
    const cards = await waitFor(() => { const c = [...slot.container.querySelectorAll<HTMLElement>(".tv-credit")]; expect(c.length).toBe(3); return c; });
    const card = (name: string) => cards.find((c) => c.querySelector(".tv-credit-n b")!.textContent === name)!;
    const rook = scenes.registry.characters.find((c) => c.id === "rook")!;
    expect(card("Rook").querySelector(".tv-credit-v")).toBeNull();
    expect(card("Rook").textContent).not.toContain(rook.lines.wrap);
    const junoVoice = live.reports.filter((r) => r.memberThreadId === "thr_ragzivfix4" && r.status === "done")[0]!.voice!;
    expect(card("Juno").querySelector(".tv-credit-v")!.textContent).toBe(junoVoice);
  });
  it("folds the three archived member threads from one moment into one line, keeping every name, with the unknown actor in the title", async () => {
    const slot = await open(`quest/${live.quest.id}`, room, live);
    const history = await slot.findByRole("button", { name: /^History/ }, LOADED);
    const body = document.getElementById(history.getAttribute("aria-controls")!)!;
    const lines = [...body.querySelectorAll(".tv-ev-h")].map((h) => h.textContent!.trim());
    expect(lines.filter((l) => /thread/.test(l) && /archived/.test(l))).toEqual(["3 member threads archived: Juno, Lark and Rook"]);
    const head = [...body.querySelectorAll<HTMLElement>(".tv-ev-h span[title]")].find((s) => s.textContent!.startsWith("3 member threads"))!;
    expect(head.title).toBe("The host did not say who archived it.");
    expect(body.textContent).not.toMatch(/actor unknown|not supplied by the host|Wren\s*archived/);
  });
  it("a finished record's guardrails say what was asked for, what the run recorded and the state now, never a bare 'enforce' or 'not armed yet'", async () => {
    const rook = "thr_4r5sy6cqzq";
    const blocked = { eventId: "ev-77", seq: 0, threadId: rook, providerId: "codex", at: live.quest.endedAt! - 60_000, mode: "enforce", stopped: true, latencyMs: 40, ruleId: "writes", reason: "Blocked od -c: writes outside the scope" };
    const withBlock = boardQuestDetailSchema.parse({ ...formatDuration, violations: [blocked] });
    const slot = await open(`quest/${live.quest.id}`, room, withBlock);
    const fold = await slot.findByRole("button", { name: /^Guardrails/ }, LOADED);
    fireEvent.click(fold);
    const rows = await waitFor(() => { const r = [...slot.container.querySelectorAll<HTMLElement>(".tv-guard")]; expect(r.length).toBe(3); return r; });
    for (const row of rows) {
      expect(row.classList.contains("ended")).toBe(true);
      expect(row.textContent).toMatch(/Scope asked for: .+\s· enforce/);
      expect(row.textContent).toContain("Not armed: the member's thread has ended");
      expect(row.textContent).not.toContain("not armed yet");
      expect(row.querySelector(".tv-mode")).toBeNull();
    }
    const rookRow = rows.find((r) => r.textContent!.includes("Rook"))!;
    expect(rookRow.textContent).toMatch(/Guard blocked 1 call at \d\d:\d\d \(od -c\)/);
    const quiet = rows.find((r) => !r.textContent!.includes("Rook"))!;
    const evidence = quiet.querySelector<HTMLElement>(".tv-guard-ev [title]")!;
    expect(evidence.textContent).toContain("No guard evidence recorded");
    expect(evidence.title).toMatch(/not proof/);
  });
  it("a live quest's guardrails keep today's words", async () => {
    const working = boardQuestDetailSchema.parse({ ...formatDuration, quest: { ...formatDuration.quest, phase: "build", endedAt: null } });
    const slot = await open(`quest/${live.quest.id}`, { ...room, keepers: room.keepers.map((k) => k === keeper ? { ...k, archived: false, boardQuests: [working.quest] } : k) }, working);
    const rows = await waitFor(() => { const r = [...slot.container.querySelectorAll<HTMLElement>(".tv-guard")]; expect(r.length).toBe(3); return r; }, LOADED);
    expect(rows[0]!.textContent).toContain("not armed yet");
    expect(rows[0]!.querySelector(".tv-mode")).toBeTruthy();
    expect(rows[0]!.textContent).not.toContain("Scope asked for");
  });
});
