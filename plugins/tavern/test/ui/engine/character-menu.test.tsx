// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { settingsContract } from "../../../src/shared/settings";
import type { z } from "zod";
import { motion } from "../../../src/ui/kit/motion";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { AtmosphereSection } from "../../../src/ui/page/settings";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor, fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";

beforeEach(() => {
  motion.reset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(8, 8, 360, 64));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); motion.reset(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture({ characters = true, held = false, voice = "full" as "full" | "light" | "off" } = {}) {
  const state = structuredClone(settingsView);
  Object.assign(state.effective.tavern, { characters, voice, ambientMotion: "lively", hearthFlicker: true });
  const registry = { ...fixtureRegistry, characters: fixtureRegistry.characters.map(c => ({ ...c, says: { working: ["Lantern high.", "Good footing."] } })) };
  const slots: Array<ReturnType<typeof renderSlot>> = [];
  const update = vi.fn(({ patch }: z.input<typeof settingsContract.settingsUpdate.input>) => {
    Object.assign(state.effective.tavern, patch.tavern);
    state.revision++;
    return { code: "ok" as const, revision: state.revision, settings: state, problems: [] };
  });
  const contract = {
    decor: rpcContract.decor, registry: rpcContract.registry,
    settings: settingsContract.settings, settingsUpdate: settingsContract.settingsUpdate,
  };
  const options: RenderSlotOptions<typeof contract> = {
    pluginId: "tavern",
    experimental_rpcContract: contract,
    rpc: {
      settings: () => structuredClone(state),
      settingsUpdate: update,
      registry: () => registry,
      decor: () => ({
        ...fixtureDecor, keeperView: held ? fixtureDecor.keeperView : null,
        member: { ...fixtureMember, state: "working" as const },
        ...state.effective.tavern,
      }),
    },
  };
  const row = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, options);
  slots.push(row);
  const atmosphere = () => {
    const slot = renderSlot({ component: AtmosphereSection }, {}, options);
    slots.push(slot);
    return slot;
  };
  const refresh = async () => {
    for (const slot of slots) await slot.experimental_invalidateRpc(["tavern:settings"]);
  };
  const actor = () => row.container.querySelector<HTMLButtonElement>("button[data-actor]")!;
  const openMenu = () => {
    fireEvent.contextMenu(actor());
    return within(screen.getByRole("menu", { name: /character settings/i }));
  };
  await row.findByRole("region", { name: "Tavern widget" });
  if (characters) await waitFor(() => expect(actor()).not.toBeNull());
  return { row, actor, update, state, atmosphere, openMenu, refresh };
}

describe("character context menu", () => {
  it.each(["ContextMenu", "F10"] as const)("opens with %s, including while the widget has an ask", async key => {
    const f = await fixture({ held: true });
    const actor = f.actor();
    expect(actor.dataset.mood).toBe("waiting");
    actor.focus();
    fireEvent.keyDown(actor, { key, shiftKey: key === "F10" });
    const menu = within(screen.getByRole("menu", { name: /character settings/i }));
    const hide = menu.getByRole("menuitem", { name: "Hide characters" });
    const calm = menu.getByRole("menuitemradio", { name: "Calm" });
    const quiet = menu.getByRole("menuitem", { name: "Quiet for an hour" });
    expect(document.activeElement).toBe(hide);
    fireEvent.keyDown(hide, { key: "ArrowDown" });
    expect(document.activeElement).toBe(calm);
    fireEvent.keyDown(calm, { key: "End" });
    expect(document.activeElement).toBe(quiet);
    fireEvent.keyDown(quiet, { key: "Home" });
    expect(document.activeElement).toBe(hide);
    fireEvent.keyDown(hide, { key: "ArrowUp" });
    expect(document.activeElement).toBe(quiet);
    fireEvent.keyDown(quiet, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(actor);
    fireEvent.contextMenu(actor);
    expect(fireEvent.keyDown(screen.getByRole("menuitem", { name: "Hide characters" }), { key: "Tab" })).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(actor);
  });

  it.each(["Calm", "Lively", "Off"] as const)("sets %s with the same patch as Settings", async name => {
    const f = await fixture();
    const menu = f.openMenu();
    expect(menu.getByRole("menuitemradio", { name: "Lively" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(menu.getByRole("menuitemradio", { name }));
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(1));
    await f.row.findByText(`Motion set to ${name}. Also in Settings, Atmosphere.`);
    expect(screen.queryByRole("menu")).toBeNull();
    const settings = f.atmosphere();
    const motion = within(await settings.findByRole("group", { name: "Ambient motion" }));
    fireEvent.click(motion.getByRole("button", { name }));
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(2));
    expect(f.update.mock.calls[0]![0].patch).toEqual({ tavern: { ambientMotion: name.toLowerCase(), hearthFlicker: name !== "Off" } });
    expect(f.update.mock.calls[1]![0].patch).toEqual(f.update.mock.calls[0]![0].patch);
  });

  it.each(["menu", "Settings"] as const)("remembers Light when speech is turned off in %s", async source => {
    const f = await fixture({ voice: "light" });
    if (source === "menu") fireEvent.click(f.openMenu().getByRole("menuitemcheckbox", { name: "Speech bubbles" }));
    else {
      const voices = within(await f.atmosphere().findByRole("group", { name: "Speech bubbles" }));
      fireEvent.click(voices.getByRole("button", { name: "Off" }));
    }
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(1));
    expect(f.update.mock.calls[0]![0].patch).toEqual({ tavern: { voice: "off", voiceBeforeOff: "light" } });
    await f.refresh();
    const checkbox = f.openMenu().getByRole("menuitemcheckbox", { name: "Speech bubbles" });
    await waitFor(() => expect(checkbox.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(checkbox);
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(2));
    expect(f.update.mock.calls[1]![0].patch).toEqual({ tavern: { voice: "light" } });
    expect(await f.row.findByText("Speech bubbles set to Light. Also in Settings, Atmosphere.")).toBeTruthy();
  });

  it("restores Full when no prior speech level was recorded", async () => {
    const f = await fixture({ voice: "off" });
    fireEvent.click(f.openMenu().getByRole("menuitemcheckbox", { name: "Speech bubbles" }));
    await waitFor(() => expect(f.update.mock.calls[0]?.[0].patch).toEqual({ tavern: { voice: "full" } }));
  });

  it("describes the shortcut without claiming the actor is a menu button", async () => {
    const f = await fixture();
    const actor = f.actor();
    expect(actor.hasAttribute("aria-haspopup")).toBe(false);
    expect(actor.hasAttribute("aria-expanded")).toBe(false);
    expect(actor.getAttribute("aria-keyshortcuts")).toBe("ContextMenu Shift+F10");
    const hint = "Right-click or Shift+F10 for character settings";
    expect(actor.title).toContain(hint);
    expect(document.getElementById(actor.getAttribute("aria-describedby")!)?.textContent).toBe(hint);
    fireEvent.click(actor, { detail: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(f.row.container.querySelector(".twalk-speech:not([hidden])")).not.toBeNull();
  });

  it("opens on a 500 ms touch press, suppresses that click and keeps the next tap", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const actor = f.actor();
    const pointer = { pointerId: 7, pointerType: "touch", clientX: 20, clientY: 20 };
    fireEvent.pointerDown(actor, { ...pointer, isPrimary: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(screen.queryByRole("menu")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const menu = screen.getByRole("menu");
    fireEvent.pointerUp(actor, pointer);
    fireEvent.click(actor, { detail: 1 });
    expect(f.row.container.querySelector(".twalk-speech")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.pointerDown(actor, { ...pointer, isPrimary: true });
    fireEvent.pointerUp(actor, pointer);
    fireEvent.click(actor, { detail: 1 });
    expect(f.row.container.querySelector(".twalk-speech:not([hidden])")).not.toBeNull();
  });

  it.each(["move", "cancel", "release"] as const)("cancels a pending touch press on %s", async reason => {
    const f = await fixture();
    vi.useFakeTimers();
    const actor = f.actor();
    const pointer = { pointerId: 7, pointerType: "touch", clientX: 20, clientY: 20 };
    fireEvent.pointerDown(actor, { ...pointer, isPrimary: true });
    if (reason === "move") fireEvent.pointerMove(actor, { ...pointer, clientX: 29 });
    if (reason === "cancel") fireEvent.pointerCancel(actor, pointer);
    if (reason === "release") fireEvent.pointerUp(actor, pointer);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["menu", "Settings"] as const)("restores the characters inline after they are hidden from %s", async source => {
    const f = await fixture();
    if (source === "menu") fireEvent.click(f.openMenu().getByRole("menuitem", { name: "Hide characters" }));
    else fireEvent.click(await f.atmosphere().findByRole("switch", { name: "Show characters" }));
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(1));
    await f.refresh();
    const show = await f.row.findByRole("button", { name: "Show characters" });
    expect(show.closest(".tw-row")).not.toBeNull();
    expect(f.actor()).toBeNull();
    if (source === "menu") {
      expect(document.activeElement).toBe(show);
      expect(f.row.getByText("Characters hidden. Settings → Atmosphere.")).toBeTruthy();
    }
    const restore = source === "menu" ? await f.row.findByRole("button", { name: "Show" }) : show;
    restore.focus();
    fireEvent.click(restore);
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(2));
    await f.refresh();
    await waitFor(() => expect(f.actor()).not.toBeNull());
    expect(f.row.queryByRole("button", { name: "Show characters" })).toBeNull();
    expect(f.update.mock.calls.map(([input]) => input.patch)).toEqual([{ tavern: { characters: false } }, { tavern: { characters: true } }]);
  });

  it("offers one restore button on a thread that starts with characters hidden", async () => {
    const f = await fixture({ characters: false });
    expect(f.actor()).toBeNull();
    const buttons = f.row.getAllByRole("button", { name: "Show characters" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest(".tw-row")).not.toBeNull();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("opens the character's existing sheet", async () => {
    const f = await fixture();
    fireEvent.click(f.openMenu().getByRole("menuitem", { name: /Open .+'s sheet/ }));
    expect(f.row.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `character/${f.actor().dataset.actor}` } });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("shows the active Quiet time and lets the same menu end it", async () => {
    const f = await fixture();
    fireEvent.click(f.openMenu().getByRole("menuitem", { name: "Quiet for an hour" }));
    await waitFor(() => expect(f.update).toHaveBeenCalledTimes(1));
    await f.refresh();
    const until = f.state.effective.tavern.characterQuietUntil;
    const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(until);
    const label = `Quiet until ${time}`;
    await waitFor(() => expect(f.actor().title).toContain(label));
    expect(f.actor().getAttribute("aria-label")).toContain(label);
    expect(await f.row.findByText(`${label}. Also in Settings, Atmosphere.`)).toBeTruthy();
    const quiet = f.openMenu().getByRole("menuitemcheckbox", { name: label, checked: true });
    fireEvent.click(quiet);
    expect(await f.row.findByText("Quiet ended. Also in Settings, Atmosphere.")).toBeTruthy();
    expect(f.update.mock.calls[1]![0].patch).toEqual({ tavern: { characterQuietUntil: 0 } });
    await f.refresh();
    await waitFor(() => expect(f.actor().title).not.toContain(label));
    fireEvent.click(f.actor());
    expect(f.row.container.querySelector(".twalk-speech:not([hidden])")).not.toBeNull();
  });

  it("goes still and silent for exactly an hour, then resumes with its settings unchanged", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const now = Date.now();
    const spoken = () => f.row.container.querySelector(".twalk-speech:not([hidden])")?.textContent;
    fireEvent.click(f.actor());
    const first = spoken();
    expect(first).toMatch(/Lantern high|Good footing/);
    fireEvent.click(f.openMenu().getByRole("menuitem", { name: "Quiet for an hour" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const until = now + 3_600_000;
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ patch: { tavern: { characterQuietUntil: until } } }));
    await f.refresh();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(spoken()).toBeUndefined();
    fireEvent.click(f.actor());
    expect(spoken()).toBeUndefined();
    const engine = () => (window as unknown as { __tavernEngine: { frames: number; running: boolean } }).__tavernEngine;
    expect(engine().running).toBe(false);
    const frames = engine().frames;
    await act(async () => { await vi.advanceTimersByTimeAsync(until - Date.now() - 1); });
    expect(engine()).toMatchObject({ running: false, frames });
    fireEvent.click(f.actor());
    expect(spoken()).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(engine().frames).toBeGreaterThan(frames);
    if (!spoken()) fireEvent.click(f.actor());
    expect(spoken()).toMatch(/Lantern high|Good footing/);
    expect(f.state.effective.tavern).toMatchObject({ ambientMotion: "lively", voice: "full", hearthFlicker: true });
  });
});
