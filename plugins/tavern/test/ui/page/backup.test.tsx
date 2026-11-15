import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupContract, type BackupEntry, type BackupRestore } from "../../../src/shared/backup";
import { rpcContract } from "../../../src/shared/contract";
import { settingsContract } from "../../../src/shared/settings";
import { detail, registry, room } from "../../../src/ui/page/fixtures";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { registerPageSurfaces } from "../../../src/ui/page/register";

const contract = { ...rpcContract, ...settingsContract, ...backupContract };
type Handlers = PluginRpcTestHandlers<typeof contract>;
const entry = (name: string, at: number, withData = false): BackupEntry => ({ name, createdAt: at, withData, projects: false, bytes: 48_200, tavernVersion: "0.4.0", counts: { classes: 5, characters: 12, records: withData ? 1204 : null }, problems: [] });
const list = (over: Partial<ReturnType<Handlers["backupList"]>> = {}) => ({ dir: "/Users/me/.agents/tavern/backups", keep: 14, backups: [entry("2026-11-14-0412", Date.parse("2026-11-14T04:12:00Z"), true), entry("2026-11-13-0400", Date.parse("2026-11-13T04:00:00Z"))], error: null, dataBytes: 2_400_000, exportLimitBytes: 8 * 1024 * 1024, ...over });
const preview = (over: Partial<BackupRestore> = {}): BackupRestore => ({ code: "preview", previewHash: "h1", settings: { changes: [{ key: "attention.reviewBudget", from: 4, to: 6, kind: "set" }] }, files: [{ path: "classes/smith.md", kind: "class", action: "change" }, { path: "characters/lark.md", kind: "character", action: "add" }, { path: "scopes.yml", kind: "scopes", action: "same" }], records: { action: "refused", counts: { quests: 9 }, reason: "Tavern already has records" }, problems: [], ...over });
const base: Partial<Handlers> = {
  room: () => structuredClone(room), registry: () => structuredClone(registry), boardQuest: () => structuredClone(detail), settings: () => structuredClone(settingsView),
  backupList: () => list(),
};
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
// The panel remembers its place per device; each test starts on a fresh device.
beforeEach(() => window.localStorage.clear());
async function app() { return loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) })); }
async function section(rpc: Partial<Handlers> = {}) {
  const plugin = await app();
  const slot = renderSlot(plugin.settingsSections.find((s) => s.id === "backup")!, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { ...base, ...rpc } as Handlers });
  slots.push(slot); return slot;
}
/** The Export trigger once the menu is real: while Tavern checks for backup calls, a hidden copy holds its space under the same title. */
const shownTrigger = (slot: RenderedSlot, title: string) => waitFor(() => {
  const el = slot.getAllByTitle(title).find((e) => !e.closest('[aria-hidden="true"]'));
  if (!el) throw new Error(`No shown trigger titled ${title}`);
  return el;
});
async function page(subPath: string, rpc: Partial<Handlers> = {}) {
  const plugin = await app();
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: contract, rpc: { ...base, ...rpc } as Handlers });
  slots.push(slot); return slot;
}

describe("the Export menu's held space", () => {
  it("is out of reach while Tavern checks for backups (inert, hidden), and exactly one Export button is reachable after", async () => {
    let release!: (v: ReturnType<typeof list>) => void;
    const pending = new Promise<ReturnType<typeof list>>((r) => { release = r; });
    const slot = await page("classes", { backupList: () => pending });
    const held = await waitFor(() => { const el = slot.container.querySelector<HTMLElement>(".tv-export[inert]"); if (!el) throw new Error("no held Export"); return el; });
    expect(held.getAttribute("aria-hidden")).toBe("true");
    expect(slot.queryAllByRole("button", { name: /^Export/ })).toHaveLength(0);
    release(list());
    await waitFor(() => expect(slot.container.querySelector(".tv-export[inert]")).toBeNull());
    expect(slot.getAllByRole("button", { name: /^Export/ })).toHaveLength(1);
  });
});

describe("Backup settings section", () => {
  it("saves a backup with the chosen parts and says what it kept", async () => {
    const backupSave = vi.fn((input: Parameters<Handlers["backupSave"]>[0]) => ({ code: "ok" as const, backup: entry("2026-11-14-0530", Date.now(), input.withData), pruned: ["2026-10-31-0400"], problem: null }));
    const slot = await section({ backupSave });
    fireEvent.click(await slot.findByLabelText(/With records/));
    fireEvent.click(slot.getByRole("button", { name: "Save backup now" }));
    await waitFor(() => expect(backupSave).toHaveBeenCalledWith(expect.objectContaining({ withData: true, projects: false })));
    expect(await slot.findByText(/Saved 2026-11-14-0530 .*removed 1 older backup/)).toBeTruthy();
  });

  it("disables a download with records over the limit and says why, and shows the same sentence for a too-large reply", async () => {
    const slot = await section({ backupList: () => list({ dataBytes: 12_000_000 }) });
    fireEvent.click(await slot.findByLabelText(/With records/));
    const exportButton = slot.getByRole("button", { name: "Download backup (JSON)" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(slot.getByText(/about 12 MB, over the 8.4 MB a download allows\. Save backup keeps them on disk\./)).toBeTruthy();

    const backupExport = vi.fn(() => ({ code: "too-large" as const, filename: null, json: null, counts: { classes: 5, characters: 12, records: 1204 }, bytes: 9_000_000, limit: 8_388_608 }));
    for (const s of slots.splice(0)) s.lifecycle.unmount();
    const other = await section({ backupExport });
    fireEvent.click(await other.findByRole("button", { name: "Download backup (JSON)" }));
    expect(await other.findByText(/about 9.0 MB, over the 8.4 MB a download allows/)).toBeTruthy();
  });

  it("previews a restore in place, applies exactly that preview, and asks again when it went stale", async () => {
    const backupRestore = vi.fn((input: Parameters<Handlers["backupRestore"]>[0]) => input.apply ? preview({ code: "stale" }) : preview());
    const slot = await section({ backupRestore });
    fireEvent.click((await slot.findAllByRole("button", { name: /Restore the backup from/, expanded: false }))[0]!);
    expect(await slot.findByText("Review budget", { exact: false })).toBeTruthy();
    expect(slot.getByText(/1 added · 1 changed · 1 the same/)).toBeTruthy();
    expect(slot.getByText(/Not restored: Tavern already has records\. Settings, classes, characters and scopes still restore\./)).toBeTruthy();
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Restore 1 setting and 2 files" }));
    await waitFor(() => expect(backupRestore).toHaveBeenLastCalledWith(expect.objectContaining({ from: { name: "2026-11-14-0412" }, apply: true, previewHash: "h1" })));
    expect(await slot.findByText(/changed after this preview, so nothing was restored/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(backupRestore).toHaveBeenLastCalledWith(expect.objectContaining({ apply: false })));
  });

  it("restores from a file only if it is a Tavern backup, sending the same text as the bundle", async () => {
    const backupRestore = vi.fn((_input: Parameters<Handlers["backupRestore"]>[0]) => preview());
    const slot = await section({ backupRestore });
    const input = (await slot.findByLabelText("Choose a Tavern backup file")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["not json"], "notes.json")] } });
    expect(await slot.findByText(/notes\.json is not a Tavern backup: it is not JSON\./)).toBeTruthy();
    const manifest = { format: "tavern-backup/1", tavernVersion: "0.4.0", createdAt: Date.parse("2026-11-12T09:00:00Z"), schemaVersion: 7, migrations: [], machine: { hostname: "kalindu-mbp", platform: "darwin", arch: "arm64" }, data: { included: false, bytes: 0 }, parts: ["settings", "classes"], counts: { classes: 5, characters: 12, records: null }, projects: [], files: [], problems: [] };
    const text = JSON.stringify({ manifest, files: {} });
    fireEvent.change(input, { target: { files: [new File([text], "tavern-backup.json")] } });
    expect(await slot.findByText(/saved .* on kalindu-mbp, Tavern 0\.4\.0, 5 classes · 12 characters/)).toBeTruthy();
    await waitFor(() => expect(backupRestore).toHaveBeenCalledWith(expect.objectContaining({ from: { bundle: text }, apply: false })));
  });

  it("shows one quiet line and no controls while the server has no backup calls yet", async () => {
    const slot = await section({ backupList: undefined });
    expect(await slot.findByText("Backups arrive in the next update.")).toBeTruthy();
    expect(slot.queryAllByRole("button")).toHaveLength(0);
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("edits the keep count through the settings, 0 to 365", async () => {
    const settingsUpdate = vi.fn((_input: Parameters<Handlers["settingsUpdate"]>[0]) => ({ code: "ok" as const, revision: settingsView.revision + 1, problems: [], settings: settingsView }));
    const slot = await section({ settingsUpdate });
    const field = (await slot.findByLabelText("Keep the newest")) as HTMLInputElement;
    expect(field.value).toBe(String(settingsView.effective.data.backupKeep));
    fireEvent.change(field, { target: { value: "400" } });
    fireEvent.blur(field);
    expect(settingsUpdate).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.blur(field);
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith(expect.objectContaining({ patch: { data: { backupKeep: 30 } } })));
  });

  it("shows times on Tavern's clock, counts with separators and paths with ~", async () => {
    const slot = await section();
    expect(await slot.findByText(/1,204 records/)).toBeTruthy();
    expect(slot.getByText("~/.agents/tavern/backups")).toBeTruthy();
    expect(slot.queryByText(/AM|PM/)).toBeNull();
  });

  it("shows an empty list with the CLI line and the keep count", async () => {
    const view = structuredClone(settingsView); view.effective.data.backupKeep = 0;
    const slot = await section({ backupList: () => list({ backups: [], keep: 0 }), settings: () => view });
    expect(await slot.findByText(/No saved backups yet/)).toBeTruthy();
    expect(slot.getByText("bb tavern backup save")).toBeTruthy();
    expect(await slot.findByText("0 keeps every backup")).toBeTruthy();
    // The empty line already says there are none, so the count stays out at zero.
    expect(slot.queryByText("0 backups")).toBeNull();
  });

  it("says what the parts add and the keep rule in plain words, and restores from a file with a button", async () => {
    const slot = await section();
    expect(await slot.findByLabelText("Each project's .agents/tavern folder")).toBeTruthy();
    expect(await slot.findByText("0 keeps every backup")).toBeTruthy();
    expect(slot.queryByText("0 keeps all")).toBeNull();
    expect(slot.getByText("2 backups")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Restore from a file…" }).className).toMatch(/\bbtn\b/);
  });
});

// bb draws a section's description in its own subtle text (3.38:1), so every Tavern section draws its line itself, in the kit's muted text.
describe("settings section descriptions", () => {
  it("leaves bb's description empty and draws the line first in each section's body", async () => {
    const plugin = await app();
    expect(plugin.settingsSections.length).toBeGreaterThan(10);
    for (const registration of plugin.settingsSections) expect(registration.description ?? "").toBe("");
    const slot = await section();
    const intro = await slot.findByText(/Without records, a backup holds your settings/);
    expect(intro.className).toMatch(/tv-set-intro/);
    expect(intro.closest(".tavern")?.firstElementChild).toBe(intro);
  });
});

describe("Export menu on Classes and Character sheets", () => {
  it("saves every character sheet as a folder and shows the path", async () => {
    const registryExportFolder = vi.fn((_input: { kind: "class" | "character" }) => ({ path: "/Users/me/.agents/tavern/exports/characters-2026-11-14-0530", files: ["lark.md", "vex.md"] }));
    const slot = await page("characters", { registryExportFolder });
    fireEvent.click(await shownTrigger(slot, "Export every character sheet"));
    fireEvent.click(slot.getByRole("menuitem", { name: "Save as files in ~/.agents/tavern/exports" }));
    await waitFor(() => expect(registryExportFolder).toHaveBeenCalledWith(expect.objectContaining({ kind: "character" })));
    expect(await slot.findByText(/Saved 2 files to ~\/\.agents\/tavern\/exports\/characters-2026-11-14-0530\./)).toBeTruthy();
  });

  it("says where each export goes, and its trigger is a small button", async () => {
    const slot = await page("classes");
    const trigger = await shownTrigger(slot, "Export every class");
    expect(trigger.className).toMatch(/\bbtn\b/);
    expect(trigger.className).toMatch(/\bsm\b/);
    fireEvent.click(trigger);
    expect(slot.getByRole("menuitem", { name: "Save as files in ~/.agents/tavern/exports" })).toBeTruthy();
    expect(slot.getByRole("menuitem", { name: "Download one file (JSON)" })).toBeTruthy();
  });

  it("names the class or character in the phone page picker instead of 'Current page'", async () => {
    const slot = await page("class/smith");
    const picker = (await slot.findByLabelText("Tavern page")) as HTMLSelectElement;
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe("Smith (builder)"));
    expect(slot.queryByRole("option", { name: "Current page" })).toBeNull();
  });

  it("hides the Export menu while the server has no backup calls yet", async () => {
    // Until the missing call fails, an inert copy holds the menu's space under the same title. It mounts after the page text and can be
    // gone within a frame, so watch from before the first render: the held copy must appear, then go, and no menu may follow it.
    let held = false;
    const watch = new MutationObserver(() => { if (document.querySelector(".tv-export[inert]")) held = true; });
    watch.observe(document.body, { childList: true, subtree: true, attributes: true });
    const slot = await page("characters", { backupList: undefined });
    try {
      await slot.findByText("character sheets", { exact: false });
      await waitFor(() => { expect(held).toBe(true); expect(slot.container.querySelector(".tv-export[inert]")).toBeNull(); });
    } finally { watch.disconnect(); }
    expect(slot.queryByTitle("Export every character sheet")).toBeNull();
    expect(slot.queryAllByRole("button", { name: /^Export/ })).toHaveLength(0);
  });

  it("saves one class file, and says when it is the shipped one", async () => {
    const registryFile = vi.fn((input: { kind: "class" | "character"; id: string }) => ({ filename: `${input.id}.md`, source: "shipped" as const, path: null, text: "---\nlabel: Smith\n---\nBuild." }));
    const slot = await page("class/smith", { registryFile });
    fireEvent.click(await shownTrigger(slot, "Export the Smith class"));
    fireEvent.click(slot.getByRole("menuitem", { name: "Save this file" }));
    await waitFor(() => expect(registryFile).toHaveBeenCalledWith(expect.objectContaining({ kind: "class", id: "smith" })));
    expect(await slot.findByText(/Saved smith\.md\. It ships with Tavern/)).toBeTruthy();
  });
});
