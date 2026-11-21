import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopeStore } from "../../../src/scope/store";
import { scopeForClass } from "../../../src/scope/presets";
import { archiveTotal } from "../../../src/ui/page/archive";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import type { CharacterVoice } from "../../../src/shared/schema";
import { detail, emptyRoom, registry, room } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces, useTavernBadge } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
// The panel remembers its place per device; each test starts on a fresh device.
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const handlers: Partial<Handlers> = {
  room: () => structuredClone(room), registry: () => structuredClone(registry), boardQuest: () => structuredClone(detail),
  ledger: () => ({ keeperThreadId: "keeper", boardQuests: [detail.quest], decisions: detail.decisions, rules: detail.rules, asks: detail.asks, routes: detail.routes, restatement: "Vault first. Draft only.", lastReanchorAt: null }),
};
async function app() { return loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) })); }
async function page(subPath = "", rpc: Partial<Handlers> = {}, options: { panelAccepts?: boolean } = {}) {
  const plugin = await app();
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { ...handlers, ...rpc } as Handlers, ...(options.panelAccepts ? { experimental_panel: { openTab: () => true } } : {}) });
  slots.push(slot); return slot;
}

async function sidebar(subPath = "", rpc: Partial<Handlers> = {}) {
  const plugin = await app();
  const slot = renderSlot({ component: plugin.navPanels[0]!.experimental_sidebar! }, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { ...handlers, ...rpc } as Handlers });
  slots.push(slot); return slot;
}

describe("Tavern page surfaces", () => {
  it("offers cellar and inline delete only on an ended quest, never applies on Cancel", async () => {
    const archive = vi.fn(() => ({ ok: true as const, changed: 1, notes: ["Moss stays: it has another quest on the board"], pendingArchives: ["child"] }));
    const remove = vi.fn(() => ({ ok: true as const, changed: 1, notes: [], pendingArchives: [] }));
    const ended = { ...detail, quest: { ...detail.quest, phase: "done" as const } };
    const slot = await page("quest/sfe", { boardQuest: () => ended, archiveBoardQuests: archive, deleteBoardQuest: remove });
    fireEvent.click(await slot.findByRole("button", { name: "Delete" }));
    const confirm = slot.getByRole("group", { name: "Confirm deleting quest" });
    expect(confirm.textContent).toContain("You can restore it from the cellar's Deleted view.");
    expect(confirm.textContent).not.toMatch(/30 days|purge|expires/);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: /Send to the cellar/ }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith({ ids: [ended.quest.id], archived: true }));
    await slot.findByText("Moss stays: it has another quest on the board");
    await slot.findByText("Archiving 1 thread remains pending. Tavern retries automatically.");
    const live = await page("quest/sfe");
    await live.findByRole("heading", { name: detail.quest.title });
    expect(within(live.container).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(live.container).queryByRole("button", { name: /Send to the cellar/ })).toBeNull();
  });
  it("brings a cellar quest up from its header and deletes only after inline confirmation", async () => {
    const archive = vi.fn(() => ({ ok: true as const, changed: 1, notes: [], pendingArchives: [] }));
    const remove = vi.fn(() => ({ ok: true as const, changed: 1, notes: [], pendingArchives: [] }));
    const ended = { ...detail, quest: { ...detail.quest, phase: "stopped" as const, archivedAt: 123 } };
    const slot = await page("quest/sfe", { boardQuest: () => ended, archiveBoardQuests: archive, deleteBoardQuest: remove });
    fireEvent.click(await slot.findByRole("button", { name: /Bring up/ }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith({ ids: [ended.quest.id], archived: false }));
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(slot.getByRole("group", { name: "Confirm deleting quest" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: ended.quest.id }));
  });
  it("omits a genuinely empty cellar from the room", async () => {
    const slot = await page("", { room: () => ({ ...room, archivedCount: 0 }), deletedBoardQuests: () => ({ boardQuests: [], total: 0, nextCursor: null }) });
    await slot.findByRole("heading", { name: /The quest board/ });
    expect(slot.queryByRole("button", { name: /Cellar \(archived\).*0/ })).toBeNull();
    expect(slot.container.querySelector("[data-sec=cellar]")).toBeNull();
  });
  it("keeps a deleted-only cellar reachable and restores a deleted quest to the cellar", async () => {
    const deleted = { ...detail.quest, phase: "done" as const, archivedAt: 123, deletedAt: 456 };
    const restore = vi.fn(() => ({ ok: true as const, changed: 1 }));
    const slot = await page("", { room: () => ({ ...room, archivedCount: 0 }), deletedBoardQuests: () => ({ boardQuests: [deleted], total: 1, nextCursor: null }), restoreDeletedQuest: restore });
    fireEvent.click(await slot.findByRole("button", { name: /cellar.*1 deleted/i }));
    fireEvent.click(slot.getByRole("button", { name: /Deleted/ }));
    fireEvent.click(await slot.findByRole("button", { name: `Restore: ${deleted.short}` }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ id: deleted.id }));
    await slot.findByText(/Restored .* to the cellar/);
  });

  it("registers a page with sidebar, badge, home and settings, but never a chat", async () => {
    const plugin = await app();
    expect(plugin.navPanels[0]?.experimental_sidebar).toBeTruthy();
    expect(plugin.navPanels[0]?.experimental_useBadge).toBe(useTavernBadge);
    expect(plugin.homepageSections).toHaveLength(1);
    expect(plugin.settingsSections.map((s) => s.id)).toEqual(["setup", "tavern", "attention", "keepers", "classes", "scopes", "machines", "atmosphere", "away", "journal", "tuning", "data", "settings-history"]);
    const slot = await page();
    await slot.findByRole("heading", { name: /The quest board/ });
    expect(slot.container.querySelector('[data-thread-chat], [data-composer]')).toBeNull();
    expect(slot.getByRole("heading", { name: /Side quests/ })).toBeTruthy();
    expect(slot.getByRole("heading", { name: /Review queue/ })).toBeTruthy();
  });
  it("keeps age, readable quest, Keeper and held work in collapsed ask summaries", async () => {
    const newer = { ...room.asks[0]!, id: "scope", question: "Keep the scope narrow?", createdAt: room.asks[0]!.createdAt + 60_000, holds: [], why: "The manifest stays draft-only." };
    const slot = await page("", { room: () => ({ ...room, asks: [newer, room.asks[0]!] }) });
    await slot.findByRole("heading", { name: /Needs you/ });
    const queue = slot.getByRole("region", { name: "Needs you" });
    const summaries = [...queue.querySelectorAll("[data-need-card=ask]")];
    expect(summaries[0]?.textContent).toContain("Send Luc the PR link?");
    for (const summary of summaries) {
      expect(summary.textContent).toContain("Vault cutover");
      expect(summary.textContent).toContain("Wren");
      expect(summary.querySelector("time")?.dateTime).toBeTruthy();
      expect(summary.textContent).not.toMatch(/· vault\b/);
    }
    expect(summaries[0]?.textContent).toContain("Holds: Review");
    expect(summaries[1]?.textContent).toContain("Consequence: The manifest stays draft-only.");
    // One "oldest" on the page: the status line's, with the exact time in its title.
    expect(queue.querySelector("header")?.textContent).not.toContain("Oldest wait");
    const oldest = slot.container.querySelector(".rm-sline .rm-oldest")!;
    expect(oldest.textContent).toMatch(/^oldest \d/);
    expect(oldest.getAttribute("title")).toBe(new Date(Math.min(...room.asks.filter((a) => a.state === "open").map((a) => a.createdAt))).toLocaleString());
  });
  it("shows an ask's full question even when its common-room answer form is closed", async () => {
    const slot = await page("", { room: () => ({ ...room, asks: [room.asks[0]!] }) });
    await slot.findByRole("heading", { name: /Needs you/ });
    const card = slot.container.querySelector("[data-need-card=ask]")!;
    expect(card.querySelector("details")?.open).toBe(false);
    expect(card.querySelector(".tv-need-sentence")?.textContent).toBe(room.asks[0]!.question);
  });
  it("never substitutes an internal id when an ask's quest or Keeper is unavailable", async () => {
    const slot = await page("", { room: () => ({ ...room, asks: [{ ...room.asks[0]!, boardQuestId: "bq_missing_123", keeperThreadId: "thr_missing_456" }] }) });
    await slot.findByRole("heading", { name: /Needs you/ });
    const summary = slot.container.querySelector("[data-need-card=ask]")!;
    expect(summary.textContent).toContain("Quest unavailable");
    expect(summary.textContent).toContain("Keeper unavailable");
    expect(summary.textContent).not.toMatch(/bq_missing_123|thr_missing_456|\bw2\b/);
  });
  it("invites a first-night start in the normal composer with one Keeper pill and no send", async () => {
    const plugin = await app();
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "" }, {
      pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { ...handlers, room: () => emptyRoom } as Handlers,
      composer: { text: "Move Vault safely", scope: { kind: "new-thread", projectId: "p1" } },
      context: { projectId: "p1", threadId: null },
    });
    slots.push(slot);
    const start = await slot.findByRole("button", { name: /Start with a Keeper \(lead\)/ });
    expect(slot.container.querySelectorAll(".tv-hearth .tavern-crest").length).toBe(registry.characters.length);
    const activity = slot.container.querySelector(".tv-empty-fold") as HTMLDetailsElement;
    expect(activity.open).toBe(false);
    for (const heading of slot.getAllByRole("heading", { name: /Needs you|Decided for you|Side quests|Solos|Returned|Recent events/ })) expect(activity.contains(heading)).toBe(true);
    fireEvent.click(start);
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "p1", focusPrompt: true } }));
    expect(slot.inspection.composer.text).toContain("Move Vault safely");
    expect(slot.inspection.composer.draft.mentions).toMatchObject([{ provider: "classes", id: "keeper", pluginId: "tavern" }]);
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });
  it("shows the full sends-as-you consent before accepting an explicit choice", async () => {
    const answer = vi.fn((_input: { askId: string; optionId: string; note?: string | null; via: string }) => ({ ok: true as const }));
    const slot = await page("", { answerAsk: answer });
    await slot.findByRole("heading", { name: /The quest board/ });
    fireEvent.click(slot.container.querySelector("summary")!);
    const ask = slot.getByRole("region", { name: "Ask: Send Luc the PR link?" });
    expect(within(ask).getByText("Luc · #vault")).toBeTruthy();
    expect(within(ask).getByText(/Please review https/)).toBeTruthy();
    const button = within(ask).getByRole("button", { name: "Record answer" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(ask).getByRole("radio", { name: /Send the link/ }));
    fireEvent.click(button);
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer.mock.calls[0]?.[0]).toEqual({ askId: "send", optionId: "send", note: null, via: "page" });
    const receipt = await slot.findByRole("status", { name: "Ask answered: Send Luc the PR link?" });
    expect(receipt.textContent).toContain("Answered");
    expect(receipt.textContent).toContain("cleared everywhere");
  });
  it("refuses a send with no preview and retains the ask when the server refuses", async () => {
    const missing = { ...room, asks: [{ ...room.asks[0]!, draft: null }] };
    const slot = await page("", { room: () => missing });
    await slot.findByRole("heading", { name: /The quest board/ });
    fireEvent.click(slot.container.querySelector("summary")!);
    expect(slot.getByRole("alert").textContent).toContain("Ask the Keeper for the recipient and the full draft");
    expect((slot.getByRole("button", { name: "Record answer" }) as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount(); slots.pop();
    const refused = await page("quest/vault", { answerAsk: () => { throw new Error("Already answered on the phone"); } });
    const radio = await refused.findByRole("radio", { name: /Send the link/ });
    fireEvent.click(radio); fireEvent.click(refused.getByRole("button", { name: "Record answer" }));
    await refused.findByText(/Already answered on the phone/);
    expect((radio as HTMLInputElement).checked).toBe(true);
  });
  it("opens real threads instead of embedding a chat", async () => {
    const slot = await page();
    const buttons = await slot.findAllByRole("button", { name: "Open Wren's thread" });
    fireEvent.click(buttons[0]!);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "keeper" });
  });
  it("shows re-anchors, steers, current ledger and two-part report confidence", async () => {
    const slot = await page("quest/vault");
    await slot.findByRole("heading", { name: "Vault cutover" });
    fireEvent.click(slot.getByRole("button", { name: /rules and re-anchor/ }));
    await slot.findByText("Vault first. Draft only.");
    const history = slot.getByRole("region", { name: /History/ });
    expect(history.textContent).toMatch(/re-anchored/i);
    expect(history.textContent).toContain("quest map v2 from your steer");
    const reports = slot.getByRole("region", { name: /Reports and evidence/ });
    expect(within(reports).queryByRole("group", { name: "Member’s own estimate" })).toBeNull();
    fireEvent.click(within(reports).getByRole("button", { name: /^Reports and evidence/ }));
    expect(within(reports).getAllByRole("group", { name: "Member’s own estimate" }).length).toBeGreaterThan(0);
    fireEvent.click(within(history).getByRole("button", { name: /^Re-anchors/ }));
    expect(history.textContent).not.toContain("quest map v2 from your steer");
    expect(history.textContent).toMatch(/re-anchored/i);
  });
  it("stops only after the explicit quest-specific confirmation", async () => {
    const stop = vi.fn((_input: { id: string; reason?: string | null }) => ({ phase: "stopped" as const, unconfirmed: 0 }));
    const slot = await page("quest/vault", { stopBoardQuest: stop });
    fireEvent.click(await slot.findByRole("button", { name: "Stop quest" }));
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Yes, stop this quest" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(stop.mock.calls[0]?.[0]).toEqual({ id: "vault", reason: null });
  });
  it("sends the optional stop reason, trimmed, capped at 500 characters", async () => {
    const stop = vi.fn((_input: { id: string; reason?: string | null }) => ({ phase: "stopped" as const, unconfirmed: 0 }));
    const slot = await page("quest/vault", { stopBoardQuest: stop });
    fireEvent.click(await slot.findByRole("button", { name: "Stop quest" }));
    const field = slot.getByRole("textbox", { name: /Reason \(optional/ });
    expect(field.getAttribute("maxLength") ?? field.getAttribute("maxlength")).toBe("500");
    fireEvent.change(field, { target: { value: "  the release window closed  " } });
    fireEvent.click(slot.getByRole("button", { name: "Yes, stop this quest" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(stop.mock.calls[0]?.[0]).toEqual({ id: "vault", reason: "the release window closed" });
  });
  it("never claims a tale before a quest has returned", async () => {
    const slot = await page("tale/vault");
    await slot.findByText(/This quest has not returned/);
    expect(slot.queryByRole("heading", { name: /Loot/ })).toBeNull();
  });
  it("shows verified-only loot and leaves unverified work marked in a finished tale", async () => {
    const slot = await page("tale/vault", { boardQuest: () => ({ ...detail, quest: { ...detail.quest, phase: "done", endedAt: detail.quest.updatedAt } }) });
    await slot.findByRole("heading", { name: "Loot (verified results)" });
    expect(slot.container.textContent).toContain("DNS cut · still yours");
    const figure = [...slot.container.querySelectorAll(".tfig > div")].find((d) => d.querySelector("dt")?.textContent === "path verified");
    expect(figure?.querySelector("dd")?.textContent).toMatch(/^1 of \d+$/);
  });
  it("opens the voice editor in the side panel, never over the sheet", async () => {
    const slot = await page("character/wren", {}, { panelAccepts: true });
    fireEvent.click(await slot.findByRole("button", { name: /Edit Wren's voice/ }));
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: { id: "character-voice", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" }, params: { characterId: "wren" } } });
    expect(slot.queryByRole("textbox", { name: "Voice style" })).toBeNull();
    expect(slot.queryByRole("dialog")).toBeNull();
  });
  it("rolls privately, puts back the saved avatar, and keeps exactly the shown seed", async () => {
    const character = { ...registry.characters.find(c => c.id === "wren")!, look: { hat: "cap" as const, hair: "long" as const } };
    const keep = vi.fn(({ avatar }: { characterId: string; avatar: string }) => ({ ...character, avatar }));
    const saveVoice = vi.fn();
    const random = vi.spyOn(crypto, "getRandomValues");
    try {
      const slot = await page("character/wren", {
        registry: () => ({ ...registry, characters: [character] }),
        saveCharacterAvatar: keep, saveCharacterVoice: saveVoice,
      });
      const sheet = await slot.findByRole("img", { name: "Wren's avatar" });
      expect(sheet.getAttribute("data-avatar-seed")).toBe("wren");
      fireEvent.click(slot.getByRole("button", { name: /Edit Wren's voice/ }));
      const group = within(slot.getByRole("group", { name: "Avatar" }));
      const shown = () => group.getByRole("img", { name: "Wren's avatar" }).getAttribute("data-avatar-seed");
      const roll = () => fireEvent.click(group.getByRole("button", { name: "Roll" }));
      expect(group.getByText(/Pinned in the file:.*hat.*hair|Pinned in the file:.*hair.*hat/)).toBeTruthy();
      expect(shown()).toBe("wren");
      random.mockImplementationOnce(array => { (array as Uint32Array)[0] = 1234567; return array; });
      roll();
      expect(shown()).toBe((1234567).toString(36));
      expect(group.getByRole("status").textContent).toBe("This roll is not saved.");
      expect(sheet.getAttribute("data-avatar-seed")).toBe("wren");
      fireEvent.click(group.getByRole("button", { name: "Put back" }));
      expect(shown()).toBe("wren");
      expect(keep).not.toHaveBeenCalled();

      fireEvent.change(slot.getByRole("textbox", { name: "Voice style" }), { target: { value: "Unsaved voice draft" } });
      random.mockImplementationOnce(array => { (array as Uint32Array)[0] = 2345678; return array; });
      roll();
      const previous = shown();
      random.mockImplementationOnce(array => { (array as Uint32Array)[0] = 3456789; return array; });
      roll();
      const seed = shown();
      expect(seed).not.toBe(previous);
      expect(keep).not.toHaveBeenCalled();
      fireEvent.click(group.getByRole("button", { name: "Keep" }));
      await group.findByText("Avatar kept.");
      expect(keep).toHaveBeenCalledExactlyOnceWith({ characterId: "wren", avatar: seed });
      expect(shown()).toBe(seed);
      expect(saveVoice).not.toHaveBeenCalled();
      expect((slot.getByRole("textbox", { name: "Voice style" }) as HTMLInputElement).value).toBe("Unsaved voice draft");
    } finally { random.mockRestore(); }
  });

  it.each(["reduced", "off"] as const)("draws the sheet avatar once without a loop with %s motion", async (mode) => {
    const clearRect = vi.fn();
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(), clearRect, fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const bounds = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 16, 96, 112));
    const raf = vi.spyOn(window, "requestAnimationFrame");
    if (mode === "reduced") document.documentElement.dataset.motion = "reduced";
    try {
      const slot = await page("character/wren", { registry: () => ({ ...registry, ambientMotion: mode === "off" ? "off" : "calm" }) });
      const avatar = await slot.findByRole("img", { name: "Wren's avatar" });
      expect(avatar.getAttribute("width")).toBe("96");
      expect(avatar.getAttribute("height")).toBe("112");
      expect(clearRect).toHaveBeenCalledTimes(1);
      expect(raf).not.toHaveBeenCalled();
      slot.lifecycle.unmount();
      slots.pop();
    } finally {
      delete document.documentElement.dataset.motion;
      context.mockRestore(); bounds.mockRestore(); raf.mockRestore();
    }
  });

  it("shows authored bubble lines by mood in the Voice panel without replacing the old slots", async () => {
    const character = { ...registry.characters.find(c => c.id === "wren")!, says: {
      idle: ["The hearth is warm."],
      working: ["Fair road as far as {waypoint}.", "Lantern lit."],
    } };
    const slot = await page("character/wren", { registry: () => ({ ...registry, characters: [character] }) });
    const bubble = within(await slot.findByRole("region", { name: "Bubble lines" }));
    expect(bubble.getByRole("heading", { name: "Idle" })).toBeTruthy();
    expect(bubble.getByRole("heading", { name: "Working" })).toBeTruthy();
    expect(bubble.getByRole("list", { name: "Working" }).textContent).toBe("Fair road as far as {waypoint}.Lantern lit.");
    expect(bubble.getByRole("list", { name: "Working" }).querySelector("code")?.textContent).toBe("{waypoint}");
    expect(bubble.getByText(/Never sent to the model/)).toBeTruthy();
    expect(bubble.getByText(/when Tavern knows them/)).toBeTruthy();
    expect(slot.getByText(character.lines.hired)).toBeTruthy();
  });

  it("sends the edited bubble lines with the voice and keeps other moods and legacy slots", async () => {
    const character = { ...registry.characters.find(c => c.id === "wren")!, says: { idle: ["The hearth is warm."], working: ["Lantern lit."] } };
    const save = vi.fn(({ voice }: { voice: CharacterVoice }) => ({ ...character, ...voice }));
    const slot = await page("character/wren", {
      registry: () => ({ ...registry, characters: [character] }), saveCharacterVoice: save,
    });
    fireEvent.click(await slot.findByRole("button", { name: /Edit Wren's voice/ }));
    const working = await slot.findByRole("textbox", { name: "Working bubble lines" }) as HTMLTextAreaElement;
    expect(working.value).toBe("Lantern lit.");
    fireEvent.change(working, { target: { value: "Fair road as far as {waypoint}.\n\nWind steady." } });
    fireEvent.click(slot.getByRole("button", { name: "Save Wren" }));
    await slot.findByText("Voice saved to your character override.");
    expect(save).toHaveBeenCalledExactlyOnceWith({ characterId: "wren", voice: expect.objectContaining({
      lines: character.lines,
      says: { idle: ["The hearth is warm."], working: ["Fair road as far as {waypoint}.", "Wind steady."] },
    }) });
  });

  it.each([
    ["a long line", "Wind steady.\n" + "a".repeat(61), "Line 2 is too long. Use 60 characters or fewer."],
    ["a sixth line", ["One", "Two", "Three", "Four", "Five", "Six"].join("\n"), "Use at most five lines."],
  ])("refuses %s with a message beside the mood field", async (_test, input, message) => {
    const save = vi.fn();
    const slot = await page("character/wren", { saveCharacterVoice: save });
    fireEvent.click(await slot.findByRole("button", { name: /Edit Wren's voice/ }));
    const working = await slot.findByRole("textbox", { name: "Working bubble lines" });
    fireEvent.change(working, { target: { value: input } });
    fireEvent.click(slot.getByRole("button", { name: "Save Wren" }));
    const alert = await slot.findByText(message);
    expect(alert.previousElementSibling).toBe(working);
    expect(working.getAttribute("aria-invalid")).toBe("true");
    expect(working.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves only the editable character presentation fields", async () => {
    const save = vi.fn((input: { characterId: string; voice: Partial<typeof registry.characters[0]> }) => ({ ...registry.characters[0]!, ...input.voice }));
    const slot = await page("character/wren", { saveCharacterVoice: save });
    fireEvent.click(await slot.findByRole("button", { name: /Edit Wren's voice/ }));
    const input = await slot.findByRole("textbox", { name: "Voice style" });
    fireEvent.change(input, { target: { value: "A short weather report." } });
    const hue = slot.getByRole("combobox", { name: "Hue" }) as HTMLSelectElement;
    fireEvent.change(hue, { target: { value: "plum" } });
    expect(save).not.toHaveBeenCalled();
    expect(hue.disabled).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Save Wren" }));
    await slot.findByText("Voice saved to your character override.");
    expect(save.mock.calls[0]?.[0].voice.style).toBe("A short weather report.");
    expect(save.mock.calls[0]?.[0].voice).not.toHaveProperty("body");
    expect(slot.container.textContent).toContain("Agents never see levels");
    expect(slot.queryByRole("region", { name: "Voice check" })).toBeNull();
    expect(slot.container.textContent).not.toContain("No automatic voice check is available");
  });
  it("provides connection focus and navigation in the native-size list", async () => {
    const slot = await page("map");
    const focus = await slot.findByRole("group", { name: "Focus on a quest" });
    fireEvent.click(within(focus).getByRole("button", { name: /^Focus on Vault cutover · Build/ }));
    expect(within(focus).getByRole("button", { name: /^Focus on Vault cutover · Build/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: /^Luc: open Vault cutover/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "quest/vault" } });
  });
  it("zooms the map window and copies the map as a Markdown outline", async () => {
    const slot = await page("map");
    const view = await slot.findByRole("toolbar", { name: "Map view" });
    const pct = () => within(view).getByRole("button", { name: /^Zoom \d+%/ }).textContent;
    fireEvent.click(within(view).getByRole("button", { name: "Zoom in" }));
    const zoomed = pct();
    fireEvent.click(within(view).getByRole("button", { name: /^Zoom \d+%, reset to 100%/ }));
    expect(pct()).toBe("100%");
    expect(zoomed).not.toBe("100%");
    expect(slot.getByRole("group", { name: /^The map: Focus plus one hop/ }).getAttribute("tabindex")).toBe("0");
    expect(slot.queryByRole("button", { name: /Show the picture/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Export" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Copy as text outline (Markdown)" }));
    await slot.findByText("Copied the map as a Markdown outline");
    const write = slot.inspection.experimental_clipboardWrites.at(-1)!;
    expect(write.text).toMatch(/^# Tavern · the map · Vault cutover/);
    expect(write.text).toMatch(/^- \*\*Wren\*\* · /m);
    expect(write.text).toMatch(/^  - \*\*Vault cutover\*\* · Build/m);
    expect(write.text).toMatch(/^    - \*\*Juno\*\* · Smith \(builder\) · working/m);
    expect(write.html).toContain("<ul>");
  });
  it("uses class display names and plain roles in both the map list and picture", async () => {
    const slot = await page("map");
    await slot.findByRole("heading", { name: "Everyone on the map" });
    const picture = slot.container.querySelector(".tv-mappic") as HTMLElement;
    const list = slot.getByRole("region", { name: /Everyone on the map/ });
    for (const words of ["Smith (builder) · working", "Warden (checker) · working"]) {
      expect(within(picture).getAllByText(words).length).toBeGreaterThan(0);
      expect(within(list).getAllByText(words).length).toBeGreaterThan(0);
    }
    expect(slot.container.textContent).not.toMatch(/smith · working|warden · working/);
  });
  it("honours a custom class display name without exposing its id on the map", async () => {
    const slot = await page("map", { registry: () => ({ ...registry, classes: registry.classes.map((cls) => cls.id === "smith" ? { ...cls, label: "Artificer", plain: "builder" } : cls) }) });
    await slot.findByRole("heading", { name: "Everyone on the map" });
    expect(within(slot.container.querySelector(".tv-mappic") as HTMLElement).getAllByText("Artificer (builder) · working").length).toBeGreaterThan(0);
    expect(within(slot.getByRole("region", { name: /Everyone on the map/ })).getAllByText("Artificer (builder) · working").length).toBeGreaterThan(0);
    expect(slot.container.textContent).not.toMatch(/\bsmith\b/);
  });
  it("opens closing time in the side panel, never as a dialog", async () => {
    const slot = await page("closing", {}, { panelAccepts: true });
    fireEvent.click(await slot.findByRole("button", { name: /^Close the tavern…/ }));
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: { id: "closing-time", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" } } });
    expect(slot.queryByRole("dialog")).toBeNull();
    const plugin = await app();
    const tab = plugin.tabs.find((t) => t.id === "closing-time")!;
    const panel = renderSlot(tab as never, { subPath: "closing", params: null } as never, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: handlers as Handlers });
    slots.push(panel);
    expect(await panel.findByRole("button", { name: "Review before closing" })).toBeTruthy();
    expect(panel.queryByRole("dialog")).toBeNull();
  });
  it("shows closing time in place when bb has no side panel", async () => {
    const slot = await page("closing");
    fireEvent.click(await slot.findByRole("button", { name: /^Close the tavern…/ }));
    const inline = await slot.findByRole("region", { name: "Closing-time sheet" });
    expect(await within(inline).findByRole("button", { name: "Review before closing" })).toBeTruthy();
    expect(slot.queryByRole("dialog")).toBeNull();
  });
  it("lists every quest in the sidebar, with returned ones in a fold that starts closed", async () => {
    const at = detail.quest.updatedAt;
    const done = Array.from({ length: 6 }, (_, i) => ({ ...detail.quest, id: `done${i}`, short: `Done ${i}`, title: `Returned quest ${i}`, phase: "done" as const, endedAt: at - i * 1000 }));
    const stopped = { ...detail.quest, id: "old", short: "Old", title: "Old audit", phase: "stopped" as const, endedAt: at - 10_000 };
    const archived = { ...detail.quest, id: "gone", short: "Gone", title: "Archived quest", phase: "done" as const, endedAt: at, archivedAt: at };
    const ask = { ...room.asks[0]!, id: "navask", state: "open" as const, boardQuestId: detail.quest.id, keeperThreadId: room.keepers[0]!.member.threadId };
    const slot = await sidebar("", { room: () => ({ ...room, asks: [ask], keepers: [{ ...room.keepers[0]!, boardQuests: [detail.quest, ...done, stopped, archived] }] }) });
    await slot.findByText("1 active");
    const row = slot.getByRole("button", { name: new RegExp(`^${detail.quest.title} · .* · 1 needs you$`) });
    expect(row.getAttribute("title")).toBe(detail.quest.title);
    const fold = slot.getByRole("button", { name: "Returned and stopped: 6 returned · 1 stopped" });
    expect(fold.textContent).toContain("Returned and stopped");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("button", { name: /^Returned quest 0/ })).toBeNull();
    fireEvent.click(fold);
    expect(slot.getAllByRole("button", { name: /^Returned quest \d · returned/ })).toHaveLength(5);
    expect(slot.queryByText("Archived quest")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^Returned quest 0 · returned/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "tale/done0" } });
    fireEvent.click(slot.getByRole("button", { name: /Show all 7/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "returned" } });
  });
  it("groups sidebar quests by Keeper when there is more than one, and is honest when only returned quests exist", async () => {
    const other = { ...room.keepers[0]!, member: { ...room.keepers[0]!.member, threadId: "keeper2" }, boardQuests: [{ ...detail.quest, id: "q2", title: "Second quest", keeperThreadId: "keeper2" }], errands: [] };
    const two = await sidebar("quest/q2", { room: () => ({ ...room, keepers: [room.keepers[0]!, other] }) });
    await two.findByText("2 active");
    expect(two.getAllByRole("button", { name: /, Keeper: open thread$/ })).toHaveLength(2);
    expect(two.getByRole("button", { name: /^Second quest · / }).getAttribute("aria-current")).toBe("page");
    const onlyDone = await sidebar("", { room: () => ({ ...room, asks: [], keepers: [{ ...room.keepers[0]!, boardQuests: [{ ...detail.quest, phase: "done" as const, endedAt: detail.quest.updatedAt }] }] }) });
    await onlyDone.findByText("0 active");
    expect(onlyDone.getByRole("button", { name: "Returned: 1 returned" })).toBeTruthy();
    expect(onlyDone.getByText("No active quests right now")).toBeTruthy();
  });
  it("lists the quests in the phone page picker and marks the current one", async () => {
    const slot = await page(`quest/${detail.quest.id}`);
    const picker = await slot.findByRole("combobox", { name: "Tavern page" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.querySelector('optgroup[label="Quests on the board"]')?.textContent).toContain(detail.quest.title));
    expect(picker.value).toBe(`quest/${detail.quest.id}`);
    expect(picker.selectedOptions[0]!.textContent).toContain(detail.quest.title);
  });
  it("keeps Insights apart from The tavern, in its own Observability group with Settings", async () => {
    const slot = await sidebar("insights");
    const group = await slot.findByRole("group", { name: "Observability" });
    expect(within(group).getByRole("button", { name: /Insights/ }).getAttribute("aria-current")).toBe("page");
    expect(within(group).getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe("/settings/plugins/tavern");
    const tavernLinks = slot.getAllByRole("button").filter((b) => !group.contains(b)).map((b) => b.textContent ?? "");
    expect(tavernLinks.some((t) => t.includes("Insights"))).toBe(false);
  });
  it("shows a quiet Keeper with Resume, reads it as Quiet and moves the board's glow to another Keeper", async () => {
    const resumeKeeper = vi.fn((_input: { threadId: string }) => ({ ok: true as const }));
    const quiet = structuredClone(scenes.richRoom);
    quiet.keepers[0]!.quietSince = Date.now() - 60_000;
    const slot = await page("", { room: () => structuredClone(quiet), registry: () => structuredClone(scenes.registry), boardQuest: ({ id }: { id: string }) => structuredClone(scenes.richDetails[id]!), resumeKeeper } as never);
    const wren = await slot.findByRole("article", { name: /Wren, Keeper/ });
    const notice = within(wren).getByRole("group", { name: /Quiet since you stopped it/ });
    expect(within(wren).getByText("Quiet")).toBeTruthy();
    expect(wren.classList.contains("lit")).toBe(false);
    expect(slot.getByRole("article", { name: /Moss, Keeper/ }).classList.contains("lit")).toBe(true);
    fireEvent.click(within(notice).getByRole("button", { name: /Resume/ }));
    await waitFor(() => expect(resumeKeeper).toHaveBeenCalledWith(expect.objectContaining({ threadId: quiet.keepers[0]!.member.threadId })));
  });
  it("keeps the pause mark for a stopped Keeper only: holding shows the typing dots", async () => {
    const holding = structuredClone(scenes.richRoom);
    holding.keepers[0]!.status = "holding";
    holding.keepers[1]!.quietSince = Date.now() - 60_000;
    const slot = await page("", { room: () => structuredClone(holding), registry: () => structuredClone(scenes.registry), boardQuest: ({ id }: { id: string }) => structuredClone(scenes.richDetails[id]!) } as never);
    const wren = await slot.findByRole("article", { name: /Wren, Keeper/ });
    const moss = slot.getByRole("article", { name: /Moss, Keeper/ });
    expect(within(wren).getByText("Holding while you type").closest(".tv-st")!.querySelector(".tv-g-typing")).toBeTruthy();
    expect(wren.querySelector(".tv-g-pause")).toBeNull();
    expect(within(moss).getByText("Quiet").closest(".tv-st")!.querySelector(".tv-g-pause")).toBeTruthy();
    const pauses = [...slot.container.querySelectorAll(".tv-g-pause, .tavern-glyph-pause")].filter((g) => !g.closest(".tquiet") && !g.closest(".tv-st-quiet"));
    expect(pauses).toHaveLength(0);
  });
  it("shows each standing rule with its scope in words and its full text, and widens it to all Keepers after a confirm in place", async () => {
    const widenRule = vi.fn((_input: { ruleId: string; scope: "global" | "project" | "keeper" }) => ({ ok: true as const }));
    const withRules = structuredClone(detail);
    withRules.rules = [
      { id: "rule", scope: "quest", scopeId: "vault", text: "Draft only. Production changes wait for my go.", source: "user", active: true, createdAt: Date.now() },
      { id: "kept", scope: "keeper", scopeId: "keeper", text: "Ask before touching the shared staging cluster.", source: "keeper-proposed", active: false, createdAt: Date.now() },
    ];
    const slot = await page("quest/vault", { boardQuest: () => structuredClone(withRules), widenRule });
    fireEvent.click(await slot.findByRole("button", { name: /rules and re-anchor/ }));
    expect(await slot.findByText("This quest")).toBeTruthy();
    expect(slot.queryByText(/This quest: /)).toBeNull();
    expect(slot.getByText("Proposed · This Keeper")).toBeTruthy();
    expect(slot.getByText("Draft only. Production changes wait for my go.")).toBeTruthy();
    expect(slot.queryByText(/All Tavern threads|One board quest/)).toBeNull();
    const triggers = slot.getAllByRole("button", { name: "Apply to all Keepers" });
    expect(triggers).toHaveLength(1);
    fireEvent.click(triggers[0]!);
    const confirm = slot.getByRole("group", { name: "Apply this rule to all Keepers" });
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Apply to all Keepers" }));
    await waitFor(() => expect(widenRule).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "rule", scope: "global" })));
  });

  it("lets you confirm or dismiss a proposed rule where the quest page shows it, as the Ledger does", async () => {
    const confirmRule = vi.fn((_input: { ruleId: string; active: boolean }) => ({ ok: true as const }));
    const withRules = structuredClone(detail);
    withRules.rules = [
      { id: "kept", scope: "keeper", scopeId: "keeper", text: "Ask before touching the shared staging cluster.", source: "keeper-proposed", active: false, createdAt: Date.now() },
      { id: "kept2", scope: "keeper", scopeId: "keeper", text: "Batch reports every 10 minutes.", source: "keeper-proposed", active: false, createdAt: Date.now() },
    ];
    const slot = await page("quest/vault", { boardQuest: () => structuredClone(withRules), confirmRule });
    fireEvent.click(await slot.findByRole("button", { name: /rules and re-anchor/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Confirm the rule: Ask before touching the shared staging cluster." }));
    await waitFor(() => expect(confirmRule).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "kept", active: true })));
    fireEvent.click(slot.getByRole("button", { name: "Dismiss the proposed rule: Batch reports every 10 minutes." }));
    await waitFor(() => expect(confirmRule).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "kept2", active: false })));
    await waitFor(() => expect(slot.queryByText("Batch reports every 10 minutes.")).toBeNull());
  });

  it("marks a same-family Warden next to its name outside the party picture", async () => {
    const sameFamily = structuredClone(scenes.richDetails["vault"]!);
    const wp = sameFamily.quest.waypoints.find((w) => w.ownerMember && w.state !== "verified")!;
    wp.ownerMember = { ...wp.ownerMember!, checkIndependence: "same-family" };
    const slot = await page("quest/vault", { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), boardQuest: () => structuredClone(sameFamily) } as never);
    expect((await slot.findAllByText("same-family check (not independent)")).length).toBeGreaterThan(0);
  });
  it("lists returned quests once in the sidebar, in the fold, and links the cellar separately", async () => {
    const withArchive = { ...structuredClone(scenes.richRoom), archivedCount: 3 };
    const slot = await sidebar("", { room: () => structuredClone(withArchive), registry: () => structuredClone(scenes.registry) } as never);
    await slot.findByRole("button", { name: /^Returned(?: and stopped)?: / });
    expect(slot.queryByText("Returned (done)")).toBeNull();
    const cellar = slot.getByRole("button", { name: /Cellar/ });
    expect(cellar.textContent).toContain("3");
    expect(cellar.textContent).toContain("archived");
    const page2 = await page("archive", { room: () => structuredClone(withArchive), registry: () => structuredClone(scenes.registry), archivedBoardQuests: () => ({ quests: [], nextCursor: null }) } as never);
    const filter = await page2.findByRole("group", { name: "Show returned quests" });
    expect(within(filter).getByRole("button", { name: /Cellar/ }).getAttribute("aria-pressed")).toBe("true");
    expect(page2.container.textContent).not.toMatch(/\bArchive(d)?\b/);
  });

  it("leaves rules you turned off out of the quest page; the Ledger keeps them with Turn on", async () => {
    const withRules = structuredClone(detail);
    withRules.rules = [
      { id: "on", scope: "keeper", scopeId: "keeper", text: "No docs-only PRs.", source: "user", active: true, createdAt: Date.now() },
      { id: "off", scope: "keeper", scopeId: "keeper", text: "Batch every report.", source: "user", active: false, createdAt: Date.now() },
    ];
    const slot = await page("quest/vault", { boardQuest: () => structuredClone(withRules) });
    fireEvent.click(await slot.findByRole("button", { name: /rules and re-anchor/ }));
    expect(await slot.findByText("No docs-only PRs.")).toBeTruthy();
    expect(slot.queryByText("Batch every report.")).toBeNull();
    expect(slot.queryByText(/^Off · /)).toBeNull();
  });

  it("marks a detection-only member next to its name outside the party picture", async () => {
    const watched = structuredClone(scenes.richDetails["vault"]!);
    const wp = watched.quest.waypoints.find((w) => w.ownerMember && w.state !== "verified")!;
    wp.ownerMember = { ...wp.ownerMember!, guardPosture: { providerId: "claude-code", mode: "detection-only", label: "detection only (not prevented)", approvalAskId: null } };
    const slot = await page("quest/vault", { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), boardQuest: () => structuredClone(watched) } as never);
    expect((await slot.findAllByText("detection only (not prevented)")).length).toBeGreaterThan(0);
  });
  it("counts an archived quest once, before and after the room refetches", () => {
    const done = { ...detail.quest, id: "sfe", phase: "done" as const, endedAt: detail.quest.updatedAt };
    const before = { ...room, keepers: [{ ...room.keepers[0]!, boardQuests: [detail.quest, done] }], archivedCount: 0 };
    const after = { ...room, keepers: [{ ...room.keepers[0]!, boardQuests: [detail.quest] }], archivedCount: 1 };
    expect(archiveTotal(before, new Set(["sfe"]), new Set())).toBe(1);
    expect(archiveTotal(after, new Set(["sfe"]), new Set())).toBe(1);
    expect(archiveTotal(after, new Set(), new Set(["sfe"]))).toBe(0);
    expect(archiveTotal(before, new Set(), new Set(["sfe"]))).toBe(0);
  });
  it("sends a returned quest to the cellar in place, with an inline receipt and Bring up", async () => {
    const done = { ...detail.quest, id: "sfe", short: "SFE candidates", title: "Pick SFE candidates", phase: "done" as const, endedAt: detail.quest.updatedAt };
    const stopped = { ...detail.quest, id: "old", short: "Old audit", title: "Old audit", phase: "stopped" as const, endedAt: detail.quest.updatedAt };
    const withDone = { ...room, keepers: [{ ...room.keepers[0]!, boardQuests: [detail.quest, done, stopped] }], archivedCount: 3 };
    const archive = vi.fn((_input: { ids: string[]; archived: boolean }) => ({ ok: true as const, changed: _input.ids.length, notes: [], pendingArchives: [] }));
    const list = vi.fn((_input: { cursor?: string | null; limit?: number }) => ({ boardQuests: [{ ...done, id: "older", short: "Older quest", archivedAt: detail.quest.updatedAt }], nextCursor: null, total: 3 }));
    const slot = await page("", { room: () => withDone, archiveBoardQuests: archive, archivedBoardQuests: list });
    fireEvent.click(await slot.findByRole("button", { name: /Returned and stopped.*2/ }));
    const row = await slot.findByRole("button", { name: "Send to the cellar (archive): SFE candidates" });
    expect(row.classList.contains("btn")).toBe(false);
    fireEvent.click(row);
    await waitFor(() => expect(archive).toHaveBeenCalledWith({ ids: ["sfe"], archived: true }));
    await waitFor(() => expect(slot.container.querySelector(".tv-receipt")).toBeTruthy());
    const receipt = slot.container.querySelector(".tv-receipt")!;
    expect(receipt.textContent).toContain("SFE candidates sent to the cellar");
    expect(slot.queryByRole("button", { name: "Send to the cellar (archive): SFE candidates" })).toBeNull();
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(receipt as HTMLElement).getByRole("button", { name: "Bring up" }));
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith({ ids: ["sfe"], archived: false }));
    await waitFor(() => expect(slot.container.querySelector(".tv-receipt")!.textContent).toContain("Party threads stay archived; the Keeper can bring members back."));
    await slot.findByRole("button", { name: "Send to the cellar (archive): SFE candidates" });
    fireEvent.click(slot.getByRole("button", { name: "Send all 2 to the cellar" }));
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith({ ids: ["sfe", "old"], archived: true }));
    expect(slot.container.querySelector(".tv-receipt")!.textContent).toContain("2 sent to the cellar");
    const fold = slot.getByRole("button", { name: "Cellar (archived) · 5" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    fireEvent.click(await slot.findByRole("button", { name: "Bring up: Older quest" }));
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith({ ids: ["older"], archived: false }));
    expect(slot.container.querySelector(".tv-receipt")!.textContent).toContain("Brought up");
    expect(slot.container.textContent).not.toMatch(/\bArchive(d)?\b/);
  }, 15_000); // a dozen steps through the whole room: about 0.4 s alone, past 5 s when the machine runs several suites at once
  it("folds the cellar's events out of What happened", async () => {
    const gone = { ...room.recent[0]!, id: 999, boardQuestId: "archived-quest" };
    const slot = await page("", { room: () => ({ ...room, recent: [gone, ...room.recent], archivedCount: 1 }) });
    const fold = await slot.findByRole("button", { name: /1 event from quests in the cellar folded out/ });
    fireEvent.click(fold);
    expect(slot.getByRole("button", { name: /Fold the cellar's events/ })).toBeTruthy();
  });
  it("does not flag recorded allowed acts as violations or attention", async () => {
    const root = mkdtempSync(join(tmpdir(), "scope-act-ui-"));
    try {
      const store = new ScopeStore(root), member = detail.quest.members[0]!;
      store.recordAct({ threadId: member.threadId, providerId: "pi", at: 1, eventId: "e1", seq: 1, kind: "publish", call: { kind: "bash", toolName: "bash", cwd: root, input: { command: "git push origin assigned" } }, mode: "enforce" });
      const scoped = { ...detail, scopes: [{ threadId: member.threadId, scope: scopeForClass("smith"), error: null, armed: true, pendingAskId: null, mode: "enforce" as const, problems: [] }], violations: store.violations(member.threadId) };
      const slot = await page("quest/vault", { boardQuest: () => scoped });
      const guards = await slot.findByRole("region", { name: /Guardrails/ });
      expect(guards.textContent).toContain("0 violations");
      expect(guards.textContent).not.toContain("need attention");
      expect(guards.textContent).not.toContain("tripped a rule");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("shows each member's scope mode, policy problems and watch-mode violations as recorded, not stopped", async () => {
    const member = detail.quest.members[0]!;
    const scoped = { ...detail, scopes: [{ threadId: member.threadId, scope: null, error: null, armed: true, pendingAskId: null, mode: "watch" as const, problems: ["A project file tried to widen push to main and was ignored"] }], violations: [{ threadId: member.threadId, providerId: "pi", at: detail.quest.updatedAt, eventId: "e1", seq: 1, ruleId: "git.push", reason: "push to main", stopped: false, latencyMs: 0, mode: "watch" as const }] };
    const slot = await page("quest/vault", { boardQuest: () => scoped });
    const guards = await slot.findByRole("region", { name: /Guardrails/ });
    expect(guards.textContent).toContain("watch: recorded only");
    expect(guards.textContent).toContain("recorded, not stopped");
    expect(guards.textContent).toContain("tried to widen push to main and was ignored");
  });
  it("shows read errors rather than replacing them with demonstration data", async () => {
    const slot = await page("", { room: () => { throw new Error("Room unavailable"); } });
    await slot.findByRole("alert");
    expect(slot.container.textContent).toContain("Room unavailable");
    expect(slot.queryByText("Vault cutover")).toBeNull();
  });
  it.each(["homepage", "first night"])("%s start cards show candidates and the registry model without promising a character", async (surface) => {
    const plugin = await app();
    const candidates = {
      ...registry,
      classes: registry.classes.map((cls) => cls.id === "keeper" ? { ...cls, characters: ["wren", "moss", "ada"], model: "anthropic/claude-opus-5-5" } : cls),
      characters: [...registry.characters, { ...registry.characters[0]!, id: "moss", name: "Moss" }, { ...registry.characters[0]!, id: "ada", name: "Ada" }],
    };
    const options = {
      pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { ...handlers, registry: () => candidates, room: () => emptyRoom } as Handlers,
      composer: { scope: { kind: "new-thread" as const, projectId: "p1" } }, context: { projectId: "p1", threadId: null },
    };
    const slot = surface === "homepage" ? renderSlot(plugin.homepageSections[0]!, { projectId: "p1" }, options) : renderSlot(plugin.navPanels[0]!, { subPath: "" }, options);
    slots.push(slot);
    const keeper = await slot.findByRole("button", { name: /Keeper \(lead\)/ });
    expect(keeper.textContent).toContain("Wren, Moss or Ada");
    expect(keeper.textContent).not.toContain("takes it");
    expect(within(keeper).getByText("anthropic/claude-opus-5-5")).toBeTruthy();
    expect(within(keeper).queryByText(/project default model/i)).toBeNull();
    const smith = slot.getByRole("button", { name: /Smith \(builder\)/ });
    expect(within(smith).getByText("project default model")).toBeTruthy();
  });
  it("home class cards add the class mention and keep existing draft text until send", async () => {
    const plugin = await app();
    const slot = renderSlot(plugin.homepageSections[0]!, { projectId: "p1" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: handlers as Handlers, composer: { text: "Move Vault safely", scope: { kind: "new-thread", projectId: "p1" } }, context: { projectId: "p1", threadId: null } });
    slots.push(slot);
    fireEvent.click(await slot.findByRole("button", { name: /Keeper \(lead\)/ }));
    await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
    expect(slot.inspection.composer.text).toContain("Move Vault safely");
    expect(slot.inspection.composer.draft.mentions[0]).toMatchObject({ provider: "classes", id: "keeper" });
    fireEvent.click(slot.getByRole("button", { name: /Smith \(builder\)/ }));
    await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
    expect(slot.inspection.composer.draft.mentions[0]).toMatchObject({ id: "smith" });
    expect(slot.inspection.composer.text).not.toContain("Keeper");
  });
});
