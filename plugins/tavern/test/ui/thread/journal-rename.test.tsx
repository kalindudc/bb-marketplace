// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { type PluginCommandRegistration, definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { JournalTab } from "../../../src/ui/thread/journal";
import { fixtureDecor, fixtureJournal } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);
it("names the checklist Journal while preserving the shortcut and board quest words", async () => {
  const commands: PluginCommandRegistration[] = [];
  const app = await loadPluginApp(definePluginApp(app => {
    const register = app.commands.register.bind(app.commands);
    app.commands.register = command => { commands.push(command); register(command); };
    registerThreadSurfaces(app);
  }));
  expect(app.tabs.find(t => t.id === "journal")?.title).toBe("Journal (checklist)");
  expect(commands.find(c => c.id === "open-journal")).toMatchObject({ title: "Open the journal", defaultShortcut: { key: "l", mod: true, shift: true } });
  expect(app.messageActions.find(a => a.id === "add-to-journal")?.title).toBe("Add to journal (checklist)");
  const composer = app.composerCustomizations.find(c => c.id === "tavern-thread")!;
  expect(composer.sendMenu?.find(m => m.id === "add-journal")?.label).toBe("Add to journal (checklist)");
  expect(composer.sendMenu?.find(m => m.id === "new-quest")?.label).toContain("board quest");
});
it("renders the Journal heading and reads the canonical journal RPC", async () => {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  expect(app.tabs.some(t => t.id === "journal")).toBe(true);
  const slot = renderSlot({ component: JournalTab }, { threadId: "t", environment: null, params: null }, { rpc: { journal: () => fixtureJournal } });
  // The heading shows while the journal loads too, so wait for the journal's own tally before checking both.
  expect(await slot.findByRole("img", { name: "Tally: 0 of 1 done" })).toBeTruthy();
  expect(slot.getByRole("heading", { name: "Journal checklist" })).toBeTruthy();
  expect(slot.inspection.rpcCalls.map(c => c.method)).toContain("journal");
  slot.lifecycle.unmount();
});
it("labels the context row's journal progress, not board quest progress", async () => {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const segment = app.threadContextSegments.find(s => s.id === "journal")!;
  const slot = renderSlot({ component: segment.summary }, { threadId: "t", projectId: "p", environment: null, segments: [], isExpanded: false, onToggle: () => {} }, { rpc: { decor: () => ({ ...fixtureDecor, member: null, keeperView: null, progress: { ...fixtureJournal.progress, done: 3, total: 7 } }) } });
  const button = await slot.findByRole("button", { name: "Journal (checklist): 3 of 7 done" });
  expect(button.textContent).toContain("3 of 7");
  expect(button.textContent).not.toMatch(/quest/i);
  slot.lifecycle.unmount();
});
