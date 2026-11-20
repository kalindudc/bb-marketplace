import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHARACTER_PRESENTATION_PROBLEM_PREFIX } from "../../../src/shared/character-presentation";
import { rpcContract } from "../../../src/shared/contract";
import type { VoiceCheck, VoiceCheckView } from "../../../src/shared/voice-check";
import { VOICE_CHECK_SITUATIONS } from "../../../src/shared/voice-check";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
const LOADED = { timeout: 3000 };
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });

const wren = scenes.registry.characters.find((c) => c.id === "wren")!;
const at = new Date(new Date().getFullYear(), 10, 13, 12).getTime();
const five = (failing = 0) => VOICE_CHECK_SITUATIONS.map((id, i) => ({ id, title: id, pass: i >= failing, failures: [], answer: null }));
const check = (over: Partial<VoiceCheck> = {}): VoiceCheck => ({ id: "vc_1", characterId: "wren", draft: { name: wren.name, style: wren.style }, state: "passed", startedAt: at - 30_000, finishedAt: at,
  writer: { providerId: "pi", model: "gpt-5.1" }, judge: { providerId: "pi", model: "claude-haiku-4-5" }, tone: "judged", situations: five(), reason: null, cost: null, ...over });
const view = (history: VoiceCheck[]): VoiceCheckView => ({ history, running: null, cap: { used: history.length, max: 10, nextAt: null } });

async function sheet(history: VoiceCheck[], extra: Partial<typeof scenes.registry> = {}, panel = false) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const registry = { ...structuredClone(scenes.registry), ...extra };
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "character/wren" }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { registry: () => structuredClone(registry), room: () => structuredClone(scenes.richRoom), voiceCheck: () => view(history) } as Partial<Handlers> as Handlers,
    ...(panel ? { experimental_panel: { openTab: () => true } } : {}) });
  slots.push(slot);
  await slot.findByRole("heading", { name: wren.name }, LOADED);
  return slot;
}
const seal = (slot: RenderedSlot) => slot.container.querySelector<HTMLElement>(".tv-sheet-head [data-seal]");

describe("the voice check's seal on the character sheet", () => {
  it("keeps a full seal for a pass whose tone a model judged", async () => {
    const slot = await sheet([check()]);
    const el = await waitFor(() => { expect(seal(slot)).not.toBeNull(); return seal(slot)!; }, LOADED);
    expect(el.dataset.seal).toBe("full");
    expect(el.textContent).toBe("Voice checked 13 Nov, 5 of 5");
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("never shows a rules-only pass as a full seal", async () => {
    const slot = await sheet([check({ judge: null, tone: "not-judged" })]);
    const el = await waitFor(() => { expect(seal(slot)).not.toBeNull(); return seal(slot)!; }, LOADED);
    expect(el.dataset.seal).toBe("rules");
    expect(el.textContent).toBe("Rules checked 13 Nov, 5 of 5 · tone not judged");
    expect(el.textContent).not.toMatch(/Voice checked/);
    expect(el.querySelector("svg")).toBeNull();
  });

  it("leaves no seal when the latest finished check failed, or checked an earlier draft", async () => {
    for (const history of [[check({ state: "failed", situations: five(1) }), check({ id: "vc_0" })], [check({ draft: { name: wren.name, style: "an older style" } })]]) {
      const slot = await sheet(history);
      await slot.findByText(/Agents never see levels/, {}, LOADED);
      await new Promise((r) => setTimeout(r, 80));
      expect(seal(slot)).toBeNull();
      slot.lifecycle.unmount(); slots.pop();
    }
  });
});

describe("the user's hand on the character sheet", () => {
  const changed = new Date(new Date().getFullYear(), 10, 12, 9).getTime();
  const yours = (slot: RenderedSlot) => slot.container.querySelector<HTMLElement>(".tv-sheet-head [data-yours]");

  it("says Your character, with the file's change date, for a file that didn't ship with Tavern; never 'edited'", async () => {
    const slot = await sheet([], { characterAuthorship: [{ characterId: "wren", source: "global", changedAt: changed }] });
    const el = await waitFor(() => { expect(yours(slot)).not.toBeNull(); return yours(slot)!; }, LOADED);
    expect(el.textContent).toBe("Your character · file changed 12 Nov");
    expect(slot.container.textContent).not.toMatch(/edited/i);
    const project = await sheet([], { characterAuthorship: [{ characterId: "wren", source: "project", changedAt: null }] });
    await waitFor(() => expect(yours(project)?.textContent).toBe("Your character · this project's file"), LOADED);
  });

  it("never says Your character for a shipped character, or when the server sends no entry", async () => {
    for (const extra of [{ characterAuthorship: [{ characterId: "wren", source: "shipped" as const, changedAt: null }] }, {}]) {
      const slot = await sheet([], extra);
      await slot.findByText(/Agents never see levels/, {}, LOADED);
      expect(yours(slot)).toBeNull();
    }
  });

  it("shows the lines the agent wrote in this voice with a done report, never a stock line, each opening its report", async () => {
    const voices = [
      { reportId: "r3", line: "Skies clear over the vault.", at: changed + 2 * 86_400_000, threadId: "thr-juno", questId: "vault" },
      { reportId: "r2", line: "Front passed; drafts are in.", at: changed + 86_400_000, threadId: null, questId: "vault" },
      { reportId: "r1", line: "Light rain on the audit.", at: changed, threadId: "thr-lark", questId: "audit" },
    ];
    const slot = await sheet([], { characterReportVoices: [{ characterId: "wren", voices }] }, true);
    const section = await slot.findByRole("region", { name: "Said in a report" }, LOADED);
    const rows = [...section.querySelectorAll("li")];
    expect(rows.map((r) => r.querySelector(".tv-voice")!.textContent)).toEqual(voices.map((v) => v.line));
    for (const line of Object.values(wren.lines)) expect(section.textContent).not.toContain(line);
    // A deleted thread keeps its line and date, with no link.
    expect(rows[1]!.querySelector("button")).toBeNull();
    expect(rows[1]!.textContent).toContain("13 Nov");
    const open = rows[0]!.querySelector("button")!;
    expect(open.textContent).toBe("14 Nov");
    fireEvent.click(open);
    expect(slot.inspection.experimental_panelCalls).toContainEqual(expect.objectContaining({ method: "openTab", options: expect.objectContaining({ params: { questId: "vault", memberThreadId: "thr-juno", reportId: "r3" } }) }));
  });

  it("draws no section when the character has no report lines", async () => {
    const slot = await sheet([], { characterReportVoices: [{ characterId: "wren", voices: [] }] });
    await slot.findByText(/Agents never see levels/, {}, LOADED);
    expect(slot.queryByRole("region", { name: "Said in a report" })).toBeNull();
  });
});

describe("the tales on a character's sheet", () => {
  const day = (d: number) => new Date(new Date().getFullYear(), 10, d, 12).getTime();
  type R = NonNullable<typeof scenes.registry["serviceRecords"]>[number]["records"][number];
  const row = (questId: string, over: Partial<R> = {}): R => ({ questId, title: `${questId} title`, short: questId, phase: "done", endedAt: day(12), keeperThreadId: null, role: "maker", verifiedWaypoints: 1, threadIds: [], told: true, kept: false, available: true, waypoints: { verified: 5, total: 6 }, ...over });
  const records = [
    row("vault", { endedAt: day(14) }),
    // Two rows for one quest (maker and Warden there): one tale row, with the Warden's checks.
    row("audit", { endedAt: day(13), waypoints: { verified: 4, total: 4 } }), row("audit", { endedAt: day(13), role: "warden", verifiedWaypoints: 0, checks: 3, independentChecks: 2, sameFamilyChecks: 1, waypoints: { verified: 4, total: 4 } }),
    row("old", { endedAt: null, waypoints: null }),
    // A new record counts skipped waypoints; the older ones above leave it out, which means not recorded.
    row("kept", { endedAt: day(10), kept: true, waypoints: { verified: 5, total: 6, skipped: 1 } }),
    row("gone", { endedAt: day(11), available: false }),
    row("stopped", { phase: "stopped", told: false }),
    row("untold", { told: false }),
  ];
  const svc = { characterId: "wren", firstEarnedAt: day(10), lastEarnedAt: day(14), completeSince: null, backfilledAt: null, maker: { verifiedWaypoints: 6, quests: 6 }, recordsTotal: records.length, records };
  async function sheetWith(rpc: Partial<Handlers> = {}) {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const registry = { ...structuredClone(scenes.registry), serviceRecords: [svc] };
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "character/wren" }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
      rpc: { registry: () => structuredClone(registry), room: () => structuredClone(scenes.richRoom), voiceCheck: () => view([]), ...rpc } as Partial<Handlers> as Handlers });
    slots.push(slot);
    // Scoped to this slot: an earlier slot may still be mounted in the document.
    const section = await waitFor(() => { const el = slot.container.querySelector<HTMLElement>("section.tv-tales"); expect(el).not.toBeNull(); return el!; }, LOADED);
    return { slot, section };
  }
  const rows = (section: HTMLElement) => [...section.querySelectorAll<HTMLElement>("li")];

  it("lists told tales only, one row per quest, kept first, then newest, undated last", async () => {
    const { section } = await sheetWith();
    expect(rows(section).map((r) => r.dataset.quest)).toEqual(["kept", "vault", "audit", "gone", "old"]);
    expect(section.textContent).not.toMatch(/stopped|untold/);
    const audit = rows(section)[2]!;
    // A no-break space before each "·", so a wrapped line never starts with one.
    expect(audit.querySelector(".tv-tale-f")!.textContent).toBe("4 of 4 verified\u00a0· 3 checks, 2 independent, 1 same-family");
    expect(audit.querySelector(".tv-tale-m")!.textContent).toBe("4 of 4 verified\u00a0· 3 checks, 2 independent, 1 same-family\u00a0· 13 Nov");
    for (const r of rows(section)) expect(r.querySelector(".tv-tale-m")!.textContent).not.toMatch(/(^|[^\u00a0])·/);
    expect(rows(section)[4]!.querySelector(".tv-tale-d")!.textContent).toBe("date not recorded");
    expect(rows(section)[0]!.querySelector(".tv-tale-f")!.textContent).toBe("5 of 6 verified\u00a0· 1 skipped");
    expect(rows(section)[1]!.querySelector(".tv-tale-f")!.textContent).toBe("5 of 6 verified");
    expect(section.querySelector(".tv-count")!.textContent).toBe("5 tales");
  });

  it("opens each tale, even after the cellar, and shows no link when its quest is gone", async () => {
    const { slot, section } = await sheetWith();
    const vault = rows(section)[1]!.querySelector<HTMLButtonElement>("button.tv-tale-open")!;
    expect(vault.title).toBe("Open the tale: vault title");
    vault.click();
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toPluginPanel", options: expect.objectContaining({ subPath: "tale/vault" }) })));
    const gone = rows(section)[3]!;
    expect(gone.querySelector("button.tv-tale-open")).toBeNull();
    expect(gone.querySelector(".tv-tale-when")!.textContent).toBe("11 Nov\u00a0· tale not available");
  });

  it("keeps a tale through the server, as a control with its own state, and says a refusal in words", async () => {
    const calls: unknown[] = [];
    const { section } = await sheetWith({ setTaleKept: (input: unknown) => { calls.push(input); return { kept: true }; } } as Partial<Handlers>);
    const keep = rows(section)[1]!.querySelector<HTMLButtonElement>("button.tv-keep")!;
    expect(keep.getAttribute("aria-pressed")).toBe("false");
    expect(keep.textContent).toBe("Keep");
    expect(rows(section)[0]!.querySelector("button.tv-keep")!.textContent).toBe("Kept");
    fireEvent.click(keep);
    await waitFor(() => expect(calls).toEqual([{ questId: "vault", characterId: "wren", kept: true }]));
    const refused = await sheetWith({ setTaleKept: () => { throw new Error("Only the person in the app can keep a tale"); } } as Partial<Handlers>);
    fireEvent.click(rows(refused.section)[1]!.querySelector<HTMLButtonElement>("button.tv-keep")!);
    await waitFor(() => expect(refused.section.querySelector("[role=alert]")?.textContent).toMatch(/^Couldn’t keep it: .*Only the person in the app can keep a tale/), LOADED);
  });

  it("draws no Tales section for a character with no told tale", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const registry = { ...structuredClone(scenes.registry), serviceRecords: [{ ...svc, records: [row("stopped", { phase: "stopped", told: false })] }] };
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "character/wren" }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
      rpc: { registry: () => structuredClone(registry), room: () => structuredClone(scenes.richRoom), voiceCheck: () => view([]) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    await slot.findByText(/Agents never see levels/, {}, LOADED);
    expect(slot.queryByRole("region", { name: "Tales" })).toBeNull();
  });
});

describe("when part of a character's presentation can't be read", () => {
  const P = CHARACTER_PRESENTATION_PROBLEM_PREFIX;
  // Fixture characters all say "builtin"; the server names the character's own file.
  const WREN_FILE = "/home/u/.agents/tavern/characters/wren.md";
  const problems = () => [
    { path: WREN_FILE, message: `${P}EACCES: permission denied` },
    { path: "reports", message: `${P}database is locked` },
    { path: "/x/characters/broken.md", message: "Invalid front matter" },
  ];
  async function at(subPath: string) {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const base = structuredClone(scenes.registry);
    base.characters = base.characters.map((c) => c.id === "wren" ? { ...c, source: WREN_FILE } : c);
    const registry = { ...base, problems: problems(), characterAuthorship: [{ characterId: "wren", source: "global" as const, changedAt: null }] };
    const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
      rpc: { registry: () => structuredClone(registry), room: () => structuredClone(scenes.richRoom), voiceCheck: () => view([]), deletedBoardQuests: () => ({ boardQuests: [], total: 0, nextCursor: null }) } as Partial<Handlers> as Handlers });
    slots.push(slot);
    // The other problem's alert shows once the registry is in; then the route's own content, past its skeleton.
    await waitFor(() => expect(slot.container.textContent).toContain("Invalid front matter"), LOADED);
    const ready = subPath === "room" ? "[data-room] [data-sec=status]" : subPath === "characters" ? ".tv-ccard" : ".tv-sheet-head h1";
    await waitFor(() => expect([...slot.container.querySelectorAll(ready)].some((e) => !e.closest(".sk"))).toBe(true), LOADED);
    return slot;
  }
  const alerts = (slot: RenderedSlot) => [...slot.container.querySelectorAll("[role=alert]")].map((a) => a.textContent);
  const notes = (slot: RenderedSlot) => [...slot.container.querySelectorAll("[data-presentation-problem]")].map((a) => a.textContent);

  it("says it quietly on the sheet, in words, and keeps it out of the page's alerts; other problems still alert", async () => {
    const slot = await at("character/wren");
    expect(alerts(slot)).toEqual(["/x/characters/broken.md: Invalid front matter"]);
    // Plain words on the sheet; the raw error, with any path, one step away in the title.
    expect(notes(slot)).toEqual(["Couldn’t read when this file last changed.", "Couldn’t read the lines said in reports."]);
    expect([...slot.container.querySelectorAll<HTMLElement>("[data-presentation-problem]")].map((n) => n.title)).toEqual(["EACCES: permission denied", "database is locked"]);
    expect(slot.container.querySelector(".tv-sheet-head")!.textContent).not.toMatch(/EACCES|locked/);
    expect(slot.container.querySelector("[data-presentation-problem]")!.closest("[role=alert]")).toBeNull();
  });

  it("lists them once on the sheets page, and nowhere else", async () => {
    const list = await at("characters");
    expect(notes(list)).toEqual([`Couldn’t read when ${wren.name}'s file last changed.`, "Couldn’t read the lines said in reports."]);
    const room = await at("room");
    expect(notes(room)).toEqual([]);
    expect(alerts(room)).toEqual(["/x/characters/broken.md: Invalid front matter"]);
  });
});
