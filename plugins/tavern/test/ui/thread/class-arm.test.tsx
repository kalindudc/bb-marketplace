// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp, type ComposerSelection } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ClassModeFacts } from "../../../src/shared/class-execution-contract";
import { fixtureClass, fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { bindRpc } from "../../../src/ui/thread/state";
import { CLASS_ARM_TTL_MS, armClassSettings, takeArmedClass } from "../../../src/ui/kit/remember";

afterEach(() => { cleanup(); localStorage.clear(); });
const pill = { text: "!Keeper move the vault", mentions: [{ kind: "plugin" as const, pluginId: "tavern", provider: "classes", id: "keeper", label: "Keeper", from: 0, to: 7 }] };
const execution = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "auto" as const };
const facts = (over: Partial<ClassModeFacts> = {}): ClassModeFacts => ({ execution, fields: [], errors: [], notes: [], requiresPi: false, projectOverrides: [], body: { bytes: 0, limit: 1 }, ...over });
const settings = (defaultClass: string) => ({ ...settingsView, effective: { ...settingsView.effective, tavern: { ...settingsView.effective.tavern, defaultClass } } });

async function banner({ composer = pill as { text: string; mentions: typeof pill.mentions }, selection, classFacts = facts(), defaultClass = "none" }: { composer?: { text: string; mentions: typeof pill.mentions }; selection?: ComposerSelection; classFacts?: ClassModeFacts; defaultClass?: string } = {}) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const b = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!.banners![0]!;
  const calls: unknown[] = [];
  const slot = renderSlot(b, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p1" }, ...composer, ...(selection ? { selection } : {}) }, rpc: { registry: () => fixtureRegistry, classExecution: (input: unknown) => { calls.push(input); return classFacts; }, settings: () => settings(defaultClass) } });
  return { slot, calls };
}
const applied = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "auto" };
/** Renders the draft once so its class applies, as the person would see it first; the next render is the same draft later. */
async function applyOnce() {
  const { slot } = await banner();
  await waitFor(() => expect(slot.inspection.composer.selections).toContainEqual(applied));
  cleanup();
}

describe("a class in the new-thread composer", () => {
  it("asks the server for the class's settings in this project and applies them once", async () => {
    const { slot, calls } = await banner();
    await slot.findByText("Keeper");
    await waitFor(() => expect(slot.inspection.composer.selections).toContainEqual(applied));
    expect(calls[0]).toEqual({ classId: "keeper", projectId: "p1", environmentId: null, mode: "start" });
    await new Promise(r => setTimeout(r, 50));
    expect(slot.queryByRole("alert")).toBeNull();
    cleanup();
    // The same draft, seen again, keeps whatever the pickers now say: the class applied once.
    const again = await banner();
    await again.slot.findByText("Keeper");
    await new Promise(r => setTimeout(r, 50));
    expect(again.slot.inspection.composer.selections).toHaveLength(0);
  });

  it("spends the page's armed record, which no longer gates the settings", async () => {
    armClassSettings("keeper");
    const { slot } = await banner();
    await waitFor(() => expect(slot.inspection.composer.selections).toContainEqual(applied));
    expect(takeArmedClass("keeper")).toBe(false);
  });

  it("names a model the person chose, and puts the class's back on request without blocking the send", async () => {
    await applyOnce();
    const { slot } = await banner({ selection: { ...applied, model: "gpt-6-1-sol", reasoningLevel: "low" } as ComposerSelection });
    const line = await slot.findByText(/^Running on /);
    expect(line.textContent).toMatch(/low reasoning; the Keeper class says Claude Opus 5\.5 · high reasoning\.$/);
    expect(slot.queryByRole("alert")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Use class settings" }));
    await waitFor(() => expect(slot.inspection.composer.selections).toContainEqual(applied));
  });

  it("warns before send when the pickers can't carry the class's guarantees", async () => {
    await applyOnce();
    const { slot } = await banner({ selection: { ...applied, providerId: "claude-code" } as ComposerSelection, classFacts: facts({ requiresPi: true, execution: { ...execution, providerId: "pi" } }) });
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toMatch(/^Won’t start as Keeper\. This class requires Pi to block commands before execution\./);
    expect(slot.queryByText(/^Running on /)).toBeNull();
  });

  it("says when a class picked by pill can't start here", async () => {
    const { slot } = await banner({ classFacts: facts({ execution: null, errors: ["Pi is not installed on this machine."] }) });
    expect((await slot.findByRole("alert")).textContent).toBe("Keeper can’t start here: Pi is not installed on this machine.");
    expect(slot.inspection.composer.selections).toHaveLength(0);
  });

  it("says it couldn't read the class's settings, rather than that the class can't start", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const b = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!.banners![0]!;
    const slot = renderSlot(b, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p1" }, ...pill }, rpc: { registry: () => fixtureRegistry, classExecution: () => { throw new Error("server restarting"); }, settings: () => settings("none") } });
    expect((await slot.findByRole("alert")).textContent).toBe("Couldn’t read the Keeper class’s settings (server restarting). Check the pickers below before you send.");
    expect(slot.queryByText(/can’t start here/)).toBeNull();
  });
});

describe("the default class", () => {
  const draft = { text: "fix the flaky canary", mentions: [] };
  it("applies with no pill, says it is the default, and can start this one plain", async () => {
    const { slot, calls } = await banner({ composer: draft, defaultClass: "keeper" });
    expect((await slot.findByText(/^By default · /)).textContent).toMatch(/Wren takes it/);
    await waitFor(() => expect(slot.inspection.composer.selections).toContainEqual(applied));
    expect(calls[0]).toMatchObject({ classId: "keeper", mode: "start" });
    fireEvent.click(slot.getByRole("button", { name: "Start as a plain thread" }));
    await waitFor(() => expect(slot.inspection.composer.submits).toContainEqual({ experimental_data: { classId: "none" } }));
  });

  it("never falls back silently: it says why the thread starts plain and links to the setting", async () => {
    const { slot } = await banner({ composer: draft, defaultClass: "keeper", classFacts: facts({ execution: null, errors: ["the Keeper needs Pi"] }) });
    const note = await slot.findByText("Starts as a plain thread: the default class Keeper can’t start here (the Keeper needs Pi).");
    expect(note.closest(".tw-class-note")!.querySelector("a")!.getAttribute("href")).toBe("/settings/plugins/tavern");
    expect(slot.inspection.composer.selections).toHaveLength(0);
  });

  it("draws nothing when no class is set", async () => {
    const { slot, calls } = await banner({ composer: draft });
    await new Promise(r => setTimeout(r, 50));
    expect(slot.container.querySelector(".tw-class")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("the server's class note in a started thread", () => {
  async function thread(decor: object) {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const b = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
    const calls: { method: string; input: unknown }[] = [];
    const log = (method: string, out: unknown) => (input: unknown) => { calls.push({ method, input }); return out; };
    const slot = renderSlot(b, {}, { pluginId: "tavern", composer: { scope: { kind: "thread", threadId: "t1" } }, rpc: { registry: () => fixtureRegistry, decor: () => ({ ...fixtureDecor, threadId: "t1", ...decor }), applyClassExecution: log("apply", { model: "claude-opus-5-5", reasoningLevel: "high" }), dismissClassNotice: log("dismiss", { ok: true }) } });
    return { slot, calls };
  }
  const notice = { message: "This thread runs on GPT-6.1 Sol; the Keeper class says Claude Opus 5.5.", settings: false, switchExecution: { model: "claude-opus-5-5", reasoningLevel: "high" } };

  it("switches to the class's settings and shows what bb applied", async () => {
    const { slot, calls } = await thread({ classNotice: notice });
    await slot.findByText(notice.message);
    fireEvent.click(slot.getByRole("button", { name: "Use class settings" }));
    expect((await slot.findByRole("status")).textContent).toBe("Now on Claude Opus 5.5 · high reasoning.");
    expect(calls).toContainEqual({ method: "apply", input: { threadId: "t1" } });
  });

  it("shows on a plain thread and with the row hidden, links to settings, and dismisses", async () => {
    const plain = await thread({ member: null, classNotice: { message: "Started as a plain thread: the default class Smith can’t start here (no Pi).", settings: true, switchExecution: null } });
    const line = await plain.slot.findByText(/^Started as a plain thread/);
    expect(line.closest("section")!.querySelector("a")!.getAttribute("href")).toBe("/settings/plugins/tavern");
    expect(plain.slot.queryByRole("button", { name: "Use class settings" })).toBeNull();
    fireEvent.click(plain.slot.getByRole("button", { name: "Dismiss this note" }));
    await waitFor(() => expect(plain.calls).toContainEqual({ method: "dismiss", input: { threadId: "t1" } }));
    cleanup();
    const hidden = await thread({ hidden: true, classNotice: notice });
    await hidden.slot.findByText(notice.message);
  });
});

describe("Start as Keeper in the send menu", () => {
  async function run(classFacts: ClassModeFacts, accepted?: Partial<ComposerSelection>) {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const item = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!.sendMenu!.find(i => i.id === "start-keeper")!;
    bindRpc({ call: async (method: string) => method === "registry" ? fixtureRegistry : classFacts } as never);
    const log = { selections: [] as ComposerSelection[], submits: [] as unknown[] };
    const composer = { scope: { kind: "new-thread", projectId: "p1" }, selection: null, setSelection: async (sel: ComposerSelection) => { log.selections.push(sel); return { ...sel, ...accepted }; }, submit: async (o: unknown) => { log.submits.push(o); } };
    const result = await Promise.resolve(item.run({ composer } as never)).then(() => null, (e: Error) => e.message);
    bindRpc(null);
    return { ...log, error: result };
  }
  it("starts with the server's settings for this project, not the class file's", async () => {
    const r = await run(facts({ execution: { ...execution, model: "claude-sonnet-5-5" } }));
    expect(r.selections).toEqual([{ ...applied, model: "claude-sonnet-5-5" }]);
    expect(r.submits).toEqual([{ experimental_data: { classId: "keeper" } }]);
  });
  it("sends nothing when the class can't start or bb kept a wider permission", async () => {
    expect((await run(facts({ execution: null, errors: ["no Pi"] }))).error).toBe("Keeper can’t start here: no Pi");
    const wider = await run(facts(), { permissionMode: "full" });
    expect(wider.error).toMatch(/^Won’t start as Keeper\. This class allows auto permission; the composer requests full\./);
    expect(wider.submits).toHaveLength(0);
  });
});

describe("the class picker", () => {
  it("shows each class's model as this project resolves it, and why a class can't start", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const popup = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!.experimental_popups![0]!;
    const slot = renderSlot(popup, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p1" } }, rpc: { registry: () => fixtureRegistry, classExecutions: () => ({ classes: [{ classId: "keeper", start: facts({ execution: { ...execution, model: "claude-sonnet-5-5" } }), hire: facts() }] }) } });
    expect((await slot.findByText(/Claude Sonnet 5\.5/)).textContent).toMatch(/^Wren takes it · Claude Sonnet 5\.5/);
    cleanup();
    const off = renderSlot(popup, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p1" } }, rpc: { registry: () => fixtureRegistry, classExecutions: () => ({ classes: [{ classId: "keeper", start: facts({ execution: null, errors: ["no Pi"] }), hire: facts() }] }) } });
    expect((await off.findByText(/^Can’t start here/)).textContent).toBe("Can’t start here: no Pi");
  });

  it("says when it can't read this project's settings, rather than passing off the class files' as resolved", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const popup = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!.experimental_popups![0]!;
    const slot = renderSlot(popup, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p1" } }, rpc: { registry: () => fixtureRegistry, classExecutions: () => { throw new Error("server restarting"); } } });
    expect((await slot.findByText(/^Couldn’t read this project’s class settings/)).textContent).toBe("Couldn’t read this project’s class settings (server restarting). Models shown are the class files’; the banner checks again when you pick.");
  });
});

describe("model names", () => {
  it("reads as the families write them", async () => {
    const { modelLabel } = await import("../../../src/ui/thread/composer");
    expect(["gpt-6-1-sol", "claude-opus-5-5", "anthropic/claude-sonnet-5-5", "gpt-5", null].map(modelLabel)).toEqual(["GPT-6.1 Sol", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-5", "Your default model"]);
  });
});

describe("the page's armed record", () => {
  it("ignores a stale record, and keeps one armed for another class", () => {
    localStorage.setItem("tavern:armed-class:v1", JSON.stringify({ classId: "keeper", armedAt: Date.now() - CLASS_ARM_TTL_MS - 1 }));
    expect(takeArmedClass("keeper")).toBe(false);
    expect(localStorage.getItem("tavern:armed-class:v1")).toBeNull();
    armClassSettings("smith");
    expect(takeArmedClass("keeper")).toBe(false);
    expect(takeArmedClass("smith")).toBe(true);
    expect(takeArmedClass("smith")).toBe(false);
  });
});
