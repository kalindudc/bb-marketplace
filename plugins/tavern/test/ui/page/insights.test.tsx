import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { insightsContract } from "../../../src/shared/insights";
import { settingsContract, type SettingsView } from "../../../src/shared/settings";
import { detail, registry, room } from "../../../src/ui/page/fixtures";
import { emptyInsights, insightsView, settingsToml, settingsView } from "../../../src/ui/page/fixtures-insights";
import { VOICE_HELP } from "../../../src/ui/page/settings";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { importSummary } from "../../../src/ui/page/settings";

const contract = { ...rpcContract, ...settingsContract, ...insightsContract };
type Handlers = PluginRpcTestHandlers<typeof contract>;
const ok = (settings: SettingsView = settingsView) => ({ code: "ok" as const, revision: settings.revision + 1, problems: [], settings });
const base: Partial<Handlers> = {
  room: () => structuredClone(room), registry: () => structuredClone(registry), boardQuest: () => structuredClone(detail),
  insights: () => structuredClone(insightsView), settings: () => structuredClone(settingsView),
};
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
// The panel remembers its place per device; each test starts on a fresh device.
beforeEach(() => window.localStorage.clear());
async function app() { return loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) })); }
async function insightsPage(rpc: Partial<Handlers> = {}) {
  const plugin = await app();
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "insights" }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { ...base, ...rpc } as Handlers });
  slots.push(slot); return slot;
}
const providers: { status: "ready" | "loading"; providers: never } = { status: "ready", providers: [{ id: "codex", name: "Codex", available: true }] as never };
async function section(id: string, rpc: Partial<Handlers> = {}, options: { providers?: typeof providers } = {}) {
  const plugin = await app();
  const registration = plugin.settingsSections.find((s) => s.id === id)!;
  const slot = renderSlot(registration, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { ...base, ...rpc } as Handlers, providers: options.providers ?? providers });
  slots.push(slot); return slot;
}

describe("Insights page", () => {
  it("leads with the range, headline figures and Ideas, then the sections in the spec's order", async () => {
    const slot = await insightsPage();
    await slot.findByRole("heading", { level: 1, name: "Insights" });
    expect(within(slot.getByRole("group", { name: "Range" })).getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
    await slot.findByText("Median goal to return");
    expect(slot.getByText("5.2 h")).toBeTruthy();
    expect(slot.getByText("from 7.9 h")).toBeTruthy();
    const headings = slot.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Ideas", "Keeper reliability", "Where quests spend their time", "Your attention", "The party", "Guardrails", "Tuning history", "Cost and time per quest"]);
    for (const section of ["Keeper reliability", "Your attention"]) expect(slot.getByRole("region", { name: section }).querySelector(".tv-isec-cap")?.textContent).toMatch(/\w+/);
    expect(within(slot.getByRole("region", { name: "Keeper reliability" })).getByText("93%")).toBeTruthy();
  });
  it("glows only on Ideas that need action, and applies a tuned value with the settings revision", async () => {
    const applySuggestion = vi.fn((_input: { key: string; revision: number }) => ok());
    const slot = await insightsPage({ settingsApplySuggestion: applySuggestion });
    const ideas = await slot.findByRole("region", { name: /^Ideas/ });
    const items = ideas.querySelectorAll("li.tv-idea");
    expect([...items].map((li) => li.classList.contains("act"))).toEqual([true, true, false]);
    expect((items[2] as HTMLElement).style.getPropertyValue("--glow-x")).toBe("");
    fireEvent.click(within(ideas).getByRole("button", { name: "Set hold while you type to 75 s" }));
    await waitFor(() => expect(applySuggestion).toHaveBeenCalledWith({ key: "typingHoldSeconds", revision: 12 }));
    await slot.findByText(/Hold while you type is now 75 s/);
  });
  it("lists tuning history in words with Undo, and changes range", async () => {
    const undo = vi.fn((_input: { id: string; revision: number; why: string }) => ok());
    const insights = vi.fn((input: { range?: "7d" | "30d" | "90d" }) => input.range === "7d" ? structuredClone(emptyInsights) : structuredClone(insightsView));
    const slot = await insightsPage({ settingsUndo: undo, insights });
    const history = await slot.findByRole("region", { name: /^Tuning history/ });
    expect(history.textContent).toContain("Keeper tick interval: 60 s to 90 s");
    expect(history.textContent).toContain("undone");
    fireEvent.click(within(history).getAllByRole("button", { name: "Undo" })[0]!);
    await waitFor(() => expect(undo).toHaveBeenCalledWith({ id: "d-tick", revision: 12, why: "Undone from Insights" }));
    fireEvent.click(within(slot.getByRole("group", { name: "Range" })).getByRole("button", { name: "7 days" }));
    await slot.findByText(/No ideas yet/);
    expect(slot.queryByRole("heading", { name: "Cost and time per quest" })).toBeNull();
  });
});

describe("Insights labels", () => {
  it("draws no Character levels chart when levels are off in Settings; the other party charts stay", async () => {
    const view = structuredClone(insightsView);
    view.party.series = [
      { id: "hires", label: "Hires by class", unit: "count", points: [{ x: "ranger", y: 2 }] },
      { id: "character-levels", label: "Character levels (all retained wins)", unit: "level", points: [{ x: "lark", y: 2 }] },
    ];
    // Each wait is scoped to its own slot: the first is still mounted in the document.
    const loaded = (slot: RenderedSlot) => waitFor(() => expect(slot.container.textContent).toContain("Hires by class"), { timeout: 4000 });
    const on = await insightsPage({ insights: () => structuredClone(view) });
    await loaded(on);
    expect(on.container.textContent).toContain("Character levels (all retained wins)");
    const off = await insightsPage({ insights: () => structuredClone(view), registry: () => ({ ...structuredClone(registry), levels: false }) });
    await loaded(off);
    expect(off.container.textContent).not.toContain("Character levels");
  });
  it("names chart rows by the server label, quest title, class or character, never by raw id, and keeps same-titled quests apart", async () => {
    const view = structuredClone(insightsView);
    view.party.series = [
      { id: "hires", label: "Hires by class", unit: "count", points: [{ x: "ranger", y: 2 }, { x: "warden", y: 3 }] },
      { id: "levels", label: "Character levels", unit: "level", points: [{ x: "lark", y: 1 }, { x: "vex", y: 1 }] },
    ];
    view.cost = { ...view.cost!, quests: [
      { questId: "quest_aaaa1111", title: "Count lines", cost: 2, tokens: 1000, seconds: 60, complete: true },
      { questId: "quest_bbbb2222", title: "Count lines", cost: 1, tokens: 1000, seconds: 60, complete: true },
    ], series: [{ id: "cost-per-quest", label: "Recorded cost per quest", unit: "usd", points: [
      { x: "quest_aaaa1111", y: 2 }, { x: "quest_bbbb2222", y: 1 }, { x: "quest_cccc3333", y: 1, label: "Archived audit" },
    ] }] };
    const slot = await insightsPage({ insights: () => structuredClone(view) });
    await slot.findByText("Hires by class");
    for (const name of ["Ranger", "Warden", "Lark", "Vex", "Archived audit", "Count lines · aa1111", "Count lines · bb2222"]) expect(slot.getAllByText(name, { exact: false }).length).toBeGreaterThan(0);
    expect(slot.queryByText("quest_aaaa1111", { exact: false })).toBeNull();
    expect(slot.queryByText("quest_cccc3333", { exact: false })).toBeNull();
    expect(slot.queryByText(/^ranger$/)).toBeNull();
  });
});

describe("Settings import preview", () => {
  it("leads with how many settings return to defaults, in the CLI's own words", () => {
    const set = (key: string) => ({ key, from: 1, to: 2, kind: "set" as const });
    const unset = (key: string) => ({ key, from: 1, to: null, kind: "unset" as const });
    expect(importSummary([unset("a"), unset("b"), unset("c"), set("d"), set("e")])).toBe("Replaces all settings. 3 settings return to defaults. 2 others change.");
    expect(importSummary([unset("a"), set("b")])).toBe("Replaces all settings. 1 setting returns to defaults. 1 other changes.");
    expect(importSummary([set("a")])).toBe("Replaces all settings. No settings return to defaults. 1 other changes.");
    expect(importSummary([unset("a")])).toBe("Replaces all settings. 1 setting returns to defaults.");
    expect(importSummary([])).toBe("Replaces all settings. No settings return to defaults. Nothing else would change.");
  });
});

describe("Tavern settings sections", () => {
  it("saves a toggle and a bounded number as sectioned patches with the revision", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const tavern = await section("tavern", { settingsUpdate: update });
    fireEvent.click(await tavern.findByRole("switch", { name: "Pause every Keeper" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ revision: 12, patch: { tavern: { paused: true } } })));
    const attention = await section("attention", { settingsUpdate: update });
    const budget = await attention.findByRole("spinbutton", { name: "Review budget" });
    fireEvent.change(budget, { target: { value: "99" } });
    fireEvent.blur(budget);
    expect(update).toHaveBeenCalledTimes(1);
    fireEvent.change(budget, { target: { value: "6" } });
    fireEvent.keyDown(budget, { key: "Enter" });
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ patch: { attention: { reviewBudget: 6 } } })));
  });
  it("offers Calm, Lively and Off with a bounded repeat interval and synchronizes the legacy switch", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const motion = await section("motion", { settingsUpdate: update });
    const group = await motion.findByRole("group", { name: "Ambient motion" });
    expect(within(group).getByRole("button", { name: "Calm" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "Lively" })).toBeTruthy();
    const interval = motion.getByRole("spinbutton", { name: "Repeat every" });
    expect(interval.getAttribute("min")).toBe("3");
    expect(interval.getAttribute("max")).toBe("60");
    fireEvent.click(within(group).getByRole("button", { name: "Off" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { tavern: { ambientMotion: "off", hearthFlicker: false } } })));
  });
  it("attributes agent history and tuned changes to a named thread link", async () => {
    const settings = structuredClone(settingsView);
    settings.history.find(c => c.id === "d-stale")!.threadId = "thr_agent";
    const crests = vi.fn(() => ({crests:[{threadId:"thr_agent",classId:"keeper",characterId:null,label:"Moss II"}, {threadId:"keeper",classId:"keeper",characterId:null,label:"Moss"}]}));
    const rpc = { settings: () => settings, crests } as Partial<Handlers>;
    const history = await section("settings-history", rpc);
    await history.findByRole("button", {name:"Moss II"});
    expect(history.container.textContent).toContain("by an agent in Moss II");
    expect(history.container.textContent).not.toContain("thr_agent");
    await waitFor(() => expect(history.container.textContent).toContain("by Moss (Keeper)"));
    expect(crests).toHaveBeenCalledTimes(1);
    expect(crests).toHaveBeenCalledWith({threadIds:["keeper","thr_agent"]});
    const tuned = await section("tuned", rpc);
    await waitFor(() => expect(tuned.container.textContent).toContain("An agent in Moss II changed it"));
  });
  it("offers Character voice as three plain choices, each explained, saved as its own patch", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const tavern = await section("tavern", { settingsUpdate: update });
    const group = await tavern.findByRole("group", { name: "Character voice" });
    const choices = within(group).getAllByRole("button");
    expect(choices.map((b) => b.textContent)).toEqual(["Full", "Light", "Off"]);
    expect(choices.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(tavern.getByText("Each character may open or wrap a reply with one short line in its voice. Asks, blockers and evidence stay plain.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Off" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { tavern: { voice: "off" } } })));
  });
  it("words each Character voice choice", () => {
    expect(VOICE_HELP).toEqual({
      full: "Each character may open or wrap a reply with one short line in its voice. Asks, blockers and evidence stay plain.",
      light: "One short line at most, only when a character finishes successfully; no greetings or progress lines. Asks, blockers and evidence stay plain.",
      off: "Plain replies only. New reports carry no voice line, and the page hides the ones already stored.",
    });
  });
  it("shows Always ask read-only, and tuned rows with default, bounds, who set it, Undo and Pin", async () => {
    const keepers = await section("keepers");
    await keepers.findByText("scope widening");
    expect(keepers.queryByRole("button", { name: /scope widening/ })).toBeNull();
    const update = vi.fn((_input: { revision: number; patch: unknown; pins?: unknown; why: string }) => ok());
    const tuned = await section("tuned", { settingsUpdate: update });
    const row = (await tuned.findByText("Keeper tick interval")).closest("li")!;
    expect(row.textContent).toContain("default 60 s");
    expect(row.textContent).toContain("bounds 30 s to 5 min");
    expect(row.textContent).toContain("set by Tavern");
    expect(within(row as HTMLElement).getByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: {}, pins: { tickSeconds: 90 } })));
    const hold = (tuned.getByText("Hold while you type")).closest("li")!;
    expect(within(hold as HTMLElement).getByRole("button", { name: "Apply 75 s" })).toBeTruthy();
  });
  it("chooses a class's agent, model and thinking with bb's picker, and can return a class to its file", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const slot = await section("classes", { settingsUpdate: update });
    fireEvent.click(await slot.findByRole("button", { name: "Choose model and thinking for Ranger" }));
    const pickers = slot.getAllByTestId("bb-provider-model-picker");
    expect(pickers).toHaveLength(2);
    const ranger = within(pickers.find((p) => !within(p).queryByDisplayValue("gpt-6.1-sol"))!);
    fireEvent.change(ranger.getByLabelText("Model"), { target: { value: "claude-sonnet-5.5" } });
    fireEvent.change(ranger.getByLabelText("Reasoning level"), { target: { value: "medium" } });
    fireEvent.click(ranger.getByRole("button", { name: "Apply execution selection" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Save model and thinking for Ranger" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { classes: { ranger: { provider: "codex", model: "claude-sonnet-5.5", reasoning: "medium" } } } })));
    fireEvent.click(slot.getByRole("button", { name: "Use the class file for Smith" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { classes: { smith: {} } } })));
  });
  it("stores nothing when you only open the picker or cancel: choosing is a draft until Save", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const slot = await section("classes", { settingsUpdate: update });
    fireEvent.click(await slot.findByRole("button", { name: "Choose model and thinking for Keeper" }));
    const draft = slot.container.querySelector(".tv-exec-draft")!;
    expect(draft.textContent).toMatch(/Class file: /);
    const picker = within(slot.getAllByTestId("bb-provider-model-picker").find((p) => !within(p).queryByDisplayValue("gpt-6.1-sol"))!);
    fireEvent.change(picker.getByLabelText("Model"), { target: { value: "gpt-6.1-sol" } });
    fireEvent.click(picker.getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(slot.getByRole("button", { name: "Cancel choosing for Keeper" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(update).not.toHaveBeenCalled();
    expect(slot.getByRole("button", { name: "Choose model and thinking for Keeper" })).toBeTruthy();
  });

  it("saves the picker's default thinking as null, so the class file's level does not apply behind it", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const slot = await section("classes", { settingsUpdate: update });
    fireEvent.click(await slot.findByRole("button", { name: "Choose model and thinking for Ranger" }));
    const picker = within(slot.getAllByTestId("bb-provider-model-picker").find((p) => !within(p).queryByDisplayValue("gpt-6.1-sol"))!);
    expect((picker.getByLabelText("Reasoning level") as HTMLInputElement).value).toBe("");
    fireEvent.change(picker.getByLabelText("Model"), { target: { value: "gpt-6.1-sol" } });
    fireEvent.click(picker.getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(slot.getByRole("button", { name: "Save model and thinking for Ranger" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { classes: { ranger: { provider: "codex", model: "gpt-6.1-sol", reasoning: null } } } })));
  });

  it("reads a saved default thinking back as chosen, and says so where the picker cannot show", async () => {
    const view = structuredClone(settingsView);
    view.effective.classes.warden = { model: "gpt-6.1-sol", reasoning: null };
    const slot = await section("classes", { settings: () => structuredClone(view) }, { providers: { status: "loading", providers: [] as never } });
    expect(await slot.findByText(/Set here: gpt-6.1-sol, the model's default thinking/)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Use the class file for Warden" })).toBeTruthy();
  });
  it("puts the Ranger time-box ceiling under Keepers as your own budget, not in Tavern tunes these", async () => {
    const update = vi.fn((_input: { revision: number; patch: unknown; why: string }) => ok());
    const slot = await section("keepers", { settingsUpdate: update });
    const field = await slot.findByLabelText("Ranger time-box ceiling");
    fireEvent.change(field, { target: { value: "15" } });
    fireEvent.blur(field);
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ patch: { knobs: { rangerTimeboxMaxMinutes: 15 } } })));
    for (const slot of slots.splice(0)) slot.lifecycle.unmount();
    const tuned = await section("tuned");
    await tuned.findByText("Keeper tick interval");
    expect(tuned.queryByText("Ranger time-box ceiling")).toBeNull();
  });
  it("previews pasted TOML in place and applies it only on the second click", async () => {
    const imp = vi.fn((input: { toml: string; apply?: boolean; revision?: number }) => ({ code: input.apply ? "applied" as const : "preview" as const, revision: 12, applied: !!input.apply, changes: [{ key: "attention.reviewBudget", from: 4, to: 6, kind: "set" as const }], problems: [] }));
    const slot = await section("import-export", { settingsImport: imp, settingsExport: () => ({ toml: settingsToml }) });
    fireEvent.click(await slot.findByRole("button", { name: "Import TOML" }));
    fireEvent.change(slot.getByLabelText("Paste TOML"), { target: { value: "[attention]\nreview_budget = 6\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Preview changes" }));
    await slot.findByText(/^Replaces all settings\. /);
    expect(imp).toHaveBeenLastCalledWith(expect.objectContaining({ apply: false }));
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Apply these changes" }));
    await waitFor(() => expect(imp).toHaveBeenLastCalledWith(expect.objectContaining({ apply: true, revision: 12 })));
    await slot.findByText("Applied 1 change.");
  });
  it("flags a differing settings file and loads it only with the preview's revision and the file's hash", async () => {
    const file = vi.fn((input: { action: "status" | "load" | "save"; apply?: boolean; revision?: number; expectedHash?: string | null }) => ({ file: settingsView.file, preview: input.action === "load" ? { code: input.apply ? "applied" as const : "preview" as const, revision: 12, applied: !!input.apply, changes: [{ key: "attention.reviewBudget", from: 4, to: 3, kind: "set" as const }], problems: [] } : null }));
    const slot = await section("import-export", { settingsFile: file });
    await slot.findByText("Settings file differs");
    fireEvent.click(slot.getByRole("button", { name: "Preview load" }));
    await slot.findByText(/^Replaces all settings\. /);
    fireEvent.click(slot.getByRole("button", { name: "Load the file" }));
    await waitFor(() => expect(file).toHaveBeenLastCalledWith(expect.objectContaining({ action: "load", apply: true, revision: 12, expectedHash: "a1b2c3" })));
  });
});
