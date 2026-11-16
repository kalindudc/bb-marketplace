import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveExecution } from "../../../src/shared/class-execution";
import { rpcContract } from "../../../src/shared/contract";
import { detail, registry, room } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces } from "../../../src/ui/page/register";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
// jsdom has no ResizeObserver; the page's skeleton measure needs one that does nothing.
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });
// Smith picks Wren, Moss, then Ada: not the registry's alphabetical order. Bram lists Smith but isn't picked.
const juno = registry.characters.find((c) => c.id === "juno")!;
const extra = [["wren2", "Wren"], ["moss", "Moss"], ["ada", "Ada"], ["bram", "Bram"]].map(([id, name]) => ({ ...juno, id: id!, name: name! }));
const characters = [...registry.characters, ...extra].sort((a, b) => a.name.localeCompare(b.name));
const smith = { ...registry.classes.find((c) => c.id === "smith")!, characters: ["wren2", "moss", "ada"], scope: "worktree" as const, body: "# You are a Smith\n\nBuild one change.", provider: null, model: "openai/gpt-6.1-sol", reasoning: "xhigh" };
// The Settings row for Smith that the class page card and the editor both read.
const settingsOverride = { provider: "codex", model: "gpt-6.1-sol", reasoning: "high" };
const editor = (over: Record<string, unknown> = {}) => ({
  current: smith, revision: "rev-1", projectPath: null,
  layers: [{ source: "shipped" as const, path: "/opt/tavern/classes/smith.md", exists: true }, { source: "global" as const, path: "/Users/me/.agents/tavern/classes/smith.md", exists: false }],
  models: effectiveExecution(smith, settingsOverride), running: 2, ...over,
});
const preview = (edit: Record<string, unknown>) => ({
  code: "ok" as const, path: "/Users/me/.agents/tavern/classes/smith.md", shadowedBy: null,
  changes: Object.entries(edit).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((smith as Record<string, unknown>)[k])).map(([field, to]) => ({ field, from: (smith as Record<string, unknown>)[field] ?? null, to })),
  widening: edit.scope === "open" ? [{ field: "scope" as const, from: "worktree", to: "open" }] : [],
});
const base: Partial<Handlers> = {
  room: () => structuredClone(room), registry: () => structuredClone({ ...registry, characters, classes: registry.classes.map((c) => c.id === "smith" ? smith : c) }), boardQuest: () => structuredClone(detail),
  classEditor: () => editor(), classPreview: ({ edit }) => preview(edit),
};
async function tab(rpc: Partial<Handlers> = {}, params: Record<string, unknown> = { classId: "smith" }) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const reg = plugin.tabs.find((t) => t.id === "class-edit")!;
  // "now" is stamped after the app loads, as bb stamps it when the button is pressed, so a slow load can't age an explicit open.
  if (params.openedAt === "now") params = { ...params, openedAt: Date.now() };
  const slot = renderSlot(reg as never, { params } as never, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { ...base, ...rpc } as Handlers });
  slots.push(slot); return slot;
}

describe("Classes page: the class editor", () => {
  it("opens from the class page in the side panel", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "class/smith" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: base as Handlers, experimental_panel: { openTab: () => true } });
    slots.push(slot);
    fireEvent.click(await slot.findByRole("button", { name: /Edit the Smith class/ }));
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: { id: "class-edit", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" }, params: { classId: "smith", openedAt: expect.any(Number) }, title: "Edit Smith" } });
  });

  it("shows where models and the rest are set, and what applies when with the running count", async () => {
    const slot = await tab();
    await slot.findByRole("form", { name: "Edit the Smith class" });
    expect(slot.getAllByText(/gpt-6\.1-sol/).length).toBeGreaterThan(0);
    expect(slot.getByRole("link", { name: /Change in Settings/ })).toBeTruthy();
    expect(slot.getByText(/Full while Scopes are on/)).toBeTruthy();
    expect(slot.getByText(/In the class file only/)).toBeTruthy();
    expect(slot.getByText(/2 running members get it too/)).toBeTruthy();
    expect(slot.getByText(/2 running members keep what they were hired with/)).toBeTruthy();
    expect(slot.getByText("Changes how every Smith works from its next turn, running ones included.")).toBeTruthy();
    expect(slot.queryByRole("textbox", { name: /Tools|Permission|Model/ })).toBeNull();
  });

  it("previews each change before saving and saves the draft with the revision it opened on", async () => {
    const saveClass = vi.fn(() => ({ code: "ok" as const, class: { ...smith, label: "Mason" }, path: "/Users/me/.agents/tavern/classes/smith.md" }));
    const slot = await tab({ saveClass });
    fireEvent.change(await slot.findByRole("textbox", { name: "Name" }), { target: { value: "Mason" } });
    const box = await slot.findByRole("region", { name: "What changes" });
    await waitFor(() => expect(box.textContent).toMatch(/Name\s*Smith\s*→\s*Mason/));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText(/Saved to ~\/\.agents\/tavern\/classes\/smith\.md/);
    expect(saveClass).toHaveBeenCalledWith(expect.objectContaining({ classId: "smith", target: "global", revision: "rev-1", edit: expect.objectContaining({ label: "Mason" }) }));
  });

  it("warns before widening the scope and asks to save and allow; narrowing needs no confirm", async () => {
    const slot = await tab();
    const select = await slot.findByRole("combobox", { name: /Scope preset/ });
    fireEvent.change(select, { target: { value: "open" } });
    expect(await slot.findByText(/will be able to touch more: scope worktree to open, with no Tavern limits/)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Save and allow" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "readonly" } });
    await waitFor(() => expect(slot.queryByRole("button", { name: "Save and allow" })).toBeNull());
    expect(slot.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("keeps the draft when the class changed underneath, and Discard restores the loaded class", async () => {
    const slot = await tab({ saveClass: () => ({ code: "stale" as const }) });
    const name = await slot.findByRole("textbox", { name: "Name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Mason" } });
    await waitFor(() => expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(await slot.findByText(/This class changed since you opened it/)).toBeTruthy();
    expect(name.value).toBe("Mason");
    fireEvent.click(slot.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect((slot.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Smith"));
  });

  it("removes an existing override after a confirm, with Cancel focused", async () => {
    const removeClassOverride = vi.fn(() => ({ code: "ok" as const, path: "/Users/me/.agents/tavern/classes/smith.md" }));
    const slot = await tab({ removeClassOverride, classEditor: () => editor({ layers: [{ source: "shipped", path: "/opt/s.md", exists: true }, { source: "global", path: "/Users/me/.agents/tavern/classes/smith.md", exists: true }] }) });
    fireEvent.click(await slot.findByRole("button", { name: "Remove this override" }));
    const confirm = slot.getByRole("group", { name: "Remove this override?" });
    expect(confirm.textContent).toMatch(/~\/\.agents\/tavern\/classes\/smith\.md/);
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(slot.getByRole("button", { name: "Remove" }));
    await slot.findByText(/Removed the every-project override/);
    expect(removeClassOverride).toHaveBeenCalledWith(expect.objectContaining({ classId: "smith", target: "global", revision: "rev-1" }));
  });

  it("saves to this project by default in a project with no override, and to the override that already wins otherwise", async () => {
    const saveClass = vi.fn(() => ({ code: "ok" as const, class: smith, path: "/p/.agents/tavern/classes/smith.md" }));
    const project = { source: "project" as const, path: "/p/.agents/tavern/classes/smith.md", exists: false };
    const slot = await tab({ saveClass, classEditor: () => editor({ projectPath: "/p", layers: [...editor().layers, project] }) });
    expect((await slot.findByRole("radio", { name: /This project/ }) as HTMLInputElement).checked).toBe(true);
    slot.lifecycle.unmount();
    const again = await tab({ classEditor: () => editor({ projectPath: "/p", layers: [editor().layers[0], { ...editor().layers[1], exists: true }, project] }) });
    expect((await again.findByRole("radio", { name: /Every project/ }) as HTMLInputElement).checked).toBe(true);
  });

  // The class page shows what a hire resolves to (class-facts.test.tsx); the editor shows what is configured and where to change it.
  it("lists the configured provider, model and reasoning in the editor, with the class file's value beside a Settings one", async () => {
    const rows = (root: Element) => [...root.querySelectorAll("dt")].filter((dt) => ["Provider", "Model", "Reasoning"].includes(dt.textContent ?? "")).map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`);
    const want = ["Provider: codex from Settings · class file: project default", "Model: gpt-6.1-sol from Settings · class file: openai/gpt-6.1-sol", "Reasoning: high from Settings · class file: xhigh"];
    const slot = await tab();
    const set = await slot.findByRole("region", { name: "Set elsewhere" });
    expect(rows(set)).toEqual(want);
  });

  it("counts the role prompt in UTF-8 bytes against the 12,000 limit, and refuses to save a longer one", async () => {
    const slot = await tab();
    const body = await slot.findByLabelText("Role prompt", {}, { timeout: 3000 });
    const count = () => slot.container.querySelector<HTMLElement>(".tv-ce-bytes")!;
    expect(count().textContent).toBe(`${new TextEncoder().encode(smith.body).length} of 12,000 bytes`);
    // 4,001 three-byte characters: 12,003 bytes, though only 4,001 characters.
    fireEvent.change(body, { target: { value: "…".repeat(4001) } });
    await waitFor(() => expect(count().textContent).toBe("12,003 of 12,000 bytes: 3 over. Shorten it to save; Tavern refuses a longer role prompt."));
    expect(body.getAttribute("aria-invalid")).toBe("true");
    expect(body.getAttribute("aria-describedby")).toContain(count().id);
    expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("folds Tavern's own rules, read-only, under the role prompt", async () => {
    const slot = await tab();
    const fold = await waitFor(() => { const d = slot.container.querySelector<HTMLDetailsElement>(".tv-ce-rules"); expect(d).not.toBeNull(); return d!; });
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")!.textContent).toBe("Tavern's own rules, added after this prompt");
    expect(fold.querySelector("textarea, input")).toBeNull();
    expect(fold.textContent).toContain("Tavern quality rules");
  });
  it("says a save copies every field when it writes to another file than the one that wins", async () => {
    const slot = await tab();
    fireEvent.change(await slot.findByLabelText("Plain word", {}, { timeout: 3000 }), { target: { value: "maker" } });
    const note = await waitFor(() => { const n = slot.container.querySelector<HTMLElement>("[data-copies]"); expect(n).not.toBeNull(); return n!; });
    expect(note.textContent).toBe("Saving writes the whole class to ~/.agents/tavern/classes/smith.md, copying every field as it is now in /opt/tavern/classes/smith.md. Later changes to that file won't reach this one.");
  });
  it("lists the picked characters in pick order, the same as the class page, then the rest under Not in this class", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const page = renderSlot(plugin.navPanels[0]!, { subPath: "class/smith" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: base as Handlers });
    slots.push(page);
    const card = (await page.findByRole("heading", { name: /^Characters/ })).closest("section")!;
    expect([...card.querySelectorAll(".tv-cd-chars a, .tv-cd-chars button")].map((e) => e.textContent?.trim())).toEqual(["Wren", "Moss", "Ada"]);
    const slot = await tab();
    const order = await waitFor(() => { const ol = slot.container.querySelector(".tv-ce-order"); if (!ol) throw new Error("no order"); return ol; });
    expect([...order.querySelectorAll("li")].map((li) => li.querySelector(".tv-chk > span:last-child")?.textContent)).toEqual(["Wren", "Moss", "Ada"]);
    expect(slot.getByText("Not in this class").nextElementSibling?.textContent).toContain("Bram");
    expect(slot.queryByRole("button", { name: "Move Bram up" })).toBeNull();
  });

  it("moves a picked character, keeps focus on it, and saves the new order", async () => {
    const saveClass = vi.fn(() => ({ code: "ok" as const, class: smith, path: "/p" }));
    const slot = await tab({ saveClass });
    const down = await slot.findByRole("button", { name: "Move Wren down" });
    down.focus(); fireEvent.click(down);
    await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: "Move Wren down" })));
    const names = () => [...slot.container.querySelectorAll(".tv-ce-order li")].map((li) => li.querySelector(".tv-chk > span:last-child")?.textContent);
    expect(names()).toEqual(["Moss", "Wren", "Ada"]);
    fireEvent.click(slot.getByRole("button", { name: "Move Wren down" }));
    // At the end, Down is disabled, so focus moves to the same character's Up.
    await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: "Move Wren up" })));
    expect(names()).toEqual(["Moss", "Ada", "Wren"]);
    await waitFor(() => expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveClass).toHaveBeenCalledWith(expect.objectContaining({ edit: expect.objectContaining({ characters: ["moss", "ada", "wren2"] }) })));
  });

  it("focuses the editor's heading once on an explicit open, and never on a restored panel or a refetch", async () => {
    const reads = vi.fn(() => editor());
    const fresh = await tab({ classEditor: reads }, { classId: "smith", openedAt: "now" });
    const heading = await fresh.findByRole("heading", { name: "Edit the Smith class" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const name = fresh.getByRole("textbox", { name: "Name" });
    name.focus();
    const before = reads.mock.calls.length;
    fresh.experimental_invalidateRpc(null);
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(name);
    fresh.lifecycle.unmount();
    const restored = await tab({}, { classId: "smith", openedAt: Date.now() - 60_000 });
    await restored.findByRole("heading", { name: "Edit the Smith class" });
    expect(document.activeElement).not.toBe(restored.getByRole("heading", { name: "Edit the Smith class" }));
  });

  it("returns focus to the Edit button when the panel tab closes, and when the in-place editor hides", async () => {
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const page = renderSlot(plugin.navPanels[0]!, { subPath: "class/smith" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: base as Handlers, experimental_panel: { openTab: () => true } });
    slots.push(page);
    const opener = await page.findByRole("button", { name: /Edit the Smith class/ });
    const panel = await tab({}, { classId: "smith", openedAt: "now" });
    const heading = await panel.findByRole("heading", { name: "Edit the Smith class" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    panel.lifecycle.unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    page.lifecycle.unmount();

    const inline = renderSlot(plugin.navPanels[0]!, { subPath: "class/smith" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: base as Handlers });
    slots.push(inline);
    const inlineOpener = await inline.findByRole("button", { name: /Edit the Smith class/ });
    fireEvent.click(inlineOpener);
    const form = await inline.findByRole("heading", { name: "Edit the Smith class" });
    await waitFor(() => expect(document.activeElement).toBe(form));
    fireEvent.click(inline.getByRole("button", { name: "Hide the editor" }));
    await waitFor(() => expect(document.activeElement).toBe(inlineOpener));
  });
});

describe("one editor tab per class", () => {
  const editTab = (key: string, classId: string) => ({ key, title: `Edit ${classId}`, status: null, closable: true, detail: { kind: "plugin" as const, pluginId: "tavern", tab: { id: "class-edit", context: { kind: "nav-panel" as const, panelId: "tavern" } }, params: { classId, openedAt: 1 } } });
  async function page(tabs: ReturnType<typeof editTab>[]) {
    const panel = {
      openTab: (o: { params: { classId: string } }) => { tabs.push(editTab(`k${tabs.length + 1}`, o.params.classId)); return true; },
      getTabs: () => ({ open: true, selectedKey: tabs.at(-1)?.key ?? null, tabs }),
      selectTab: () => true,
    };
    const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(plugin.navPanels[0]!, { subPath: "class/smith" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: base as Handlers, experimental_panel: panel as never });
    slots.push(slot); return slot;
  }
  it("brings the open tab forward on a second open instead of opening another", async () => {
    const tabs: ReturnType<typeof editTab>[] = [];
    const slot = await page(tabs);
    const button = await slot.findByRole("button", { name: /Edit the Smith class/ });
    fireEvent.click(button); fireEvent.click(button);
    const calls = slot.inspection.experimental_panelCalls;
    expect(calls.filter((c) => c.method === "openTab")).toHaveLength(1);
    expect(calls).toContainEqual({ method: "selectTab", key: "k1" });
    expect(tabs).toHaveLength(1);
  });
  it("still opens a tab when only another class's editor is open", async () => {
    const tabs = [editTab("k-keeper", "keeper")];
    const slot = await page(tabs);
    fireEvent.click(await slot.findByRole("button", { name: /Edit the Smith class/ }));
    expect(slot.inspection.experimental_panelCalls.filter((c) => c.method === "openTab")).toHaveLength(1);
    expect(slot.inspection.experimental_panelCalls.some((c) => c.method === "selectTab")).toBe(false);
  });
  it("keeps the reused tab's draft and moves focus to its heading", async () => {
    const { requestClassEditorFocus } = await import("../../../src/ui/page/class-editor");
    const slot = await tab();
    const name = await slot.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Mason" } });
    name.blur();
    const { act } = await import("@testing-library/react");
    act(() => requestClassEditorFocus("keeper"));
    expect(document.activeElement).not.toBe(slot.getByRole("heading", { level: 2 }));
    act(() => requestClassEditorFocus("smith"));
    expect(document.activeElement).toBe(slot.getByRole("heading", { level: 2 }));
    expect((slot.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Mason");
  });
  it("shows the stale note when the class changed since the draft began, and saves against the draft's revision", async () => {
    const first = await tab();
    fireEvent.change(await first.findByRole("textbox", { name: "Name" }), { target: { value: "Mason" } });
    await waitFor(() => expect(window.localStorage.length).toBeGreaterThan(0));
    first.lifecycle.unmount(); slots.splice(slots.indexOf(first), 1);
    const saveClass = vi.fn(() => ({ code: "stale" as const }));
    const again = await tab({ classEditor: () => editor({ revision: "rev-2" }), saveClass });
    expect((await again.findByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Mason");
    expect((await again.findByRole("alert")).textContent).toMatch(/changed since you started this draft/);
    fireEvent.click(again.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveClass).toHaveBeenCalledWith(expect.objectContaining({ revision: "rev-1" })));
  });
});

describe("the stale note names what changed elsewhere", () => {
  it("names both fields, says the overlapping one is replaced by yours, and the other takes the newer version", async () => {
    const first = await tab();
    fireEvent.change(await first.findByRole("textbox", { name: "Name" }), { target: { value: "Mason" } });
    await waitFor(() => expect(window.localStorage.getItem([...Array(window.localStorage.length).keys()].map((i) => window.localStorage.key(i)!).find((k) => k.endsWith(":base"))!)).toBeTruthy());
    first.lifecycle.unmount(); slots.splice(slots.indexOf(first), 1);
    // Elsewhere, someone renamed the class (which this draft also did) and rewrote its role prompt (which it didn't).
    const newer = { ...smith, label: "Forge", body: "# You are a Smith\n\nBuild one change, then test it." };
    const saveClass = vi.fn(() => ({ code: "ok" as const, class: newer, path: "/Users/me/.agents/tavern/classes/smith.md" }));
    const again = await tab({ classEditor: () => editor({ current: newer, revision: "rev-2" }), saveClass });
    const note = await again.findByRole("alert");
    expect(note.textContent).toMatch(/Changed since: Name, Role prompt\./);
    expect(note.textContent).toMatch(/You edited Name too: yours will replace the newer one\./);
    expect(note.textContent).toMatch(/The other field takes the newer version\./);
    fireEvent.click(within(note).getByRole("button", { name: "Use the newer class, keep my edits" }));
    await waitFor(() => expect(again.queryByRole("alert")).toBeNull());
    expect((again.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Mason");
    expect((again.getByRole("textbox", { name: /Role prompt/ }) as HTMLTextAreaElement).value).toBe(newer.body);
    fireEvent.click(again.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveClass).toHaveBeenCalledWith(expect.objectContaining({ revision: "rev-2", edit: expect.objectContaining({ label: "Mason", body: newer.body }) })));
  });
});
