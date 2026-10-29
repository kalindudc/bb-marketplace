// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { MenuAnchor } from "../src/menu";
import { resetStore } from "../src/store";
import { setPinned, type CatalogProvider, type LineupState, type ModelRef, type RecentModel } from "../src/lineup";
import { buildPicker, type FakeProvider } from "./fake-picker";

// jsdom has no layout, so it leaves scrollIntoView out.
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  resetStore();
  document.body.replaceChildren();
});

const catalog: CatalogProvider[] = [
  {
    id: "codex",
    displayName: "Codex",
    brandPrefix: "GPT-",
    models: [
      { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
      { model: "gpt-5.5", displayName: "GPT-5.5" },
    ],
  },
  {
    id: "pi",
    displayName: "Pi",
    models: [
      { model: "anthropic/claude-opus-5-5", displayName: "Claude Opus 5.5", routeProviderId: "anthropic" },
      { model: "google/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", routeProviderId: "google" },
    ],
  },
];
const nativeProviders: FakeProvider[] = [
  { title: "Codex", rows: ["6.1-Sol", "5.5"] },
  { title: "Pi", rows: ["Claude Opus 5.5 · anthropic", "Gemini 2.5 Flash · google"] },
];
const opus: ModelRef = { providerId: "pi", model: "anthropic/claude-opus-5-5" };
const sol: ModelRef = { providerId: "codex", model: "gpt-6.1-sol" };
const now = Date.now();
const recent: RecentModel[] = [
  { ...opus, usedAt: now - 4 * 60_000 },
  { providerId: "codex", model: "gpt-5.5", usedAt: now - 2 * 3_600_000 },
  { providerId: "codex", model: "retired", usedAt: now - 3 * 3_600_000 },
];

function setup(
  options: {
    state?: LineupState;
    providers?: FakeProvider[];
    catalog?: CatalogProvider[];
    slowPins?: boolean;
    /** Hold each pin's reply until the test calls `release`. */
    heldPins?: boolean;
  } = {},
) {
  let holdStateReads = false;
  let stateReleases: Array<() => void> = [];
  /** Hold state reads (each one keeps the state it read) until `releaseStateReads`. */
  const holdStates = () => {
    holdStateReads = true;
  };
  const releaseStateReads = () => {
    holdStateReads = false;
    const pending = stateReleases;
    stateReleases = [];
    for (const done of pending) done();
  };
  let releases: Array<() => void> = [];
  const release = () => {
    const pending = releases;
    releases = [];
    for (const done of pending) done();
  };
  const fake = buildPicker(options.providers ?? nativeProviders);
  let stored: LineupState = options.state ?? { lineup: [sol], lastView: "native" };
  const calls: Array<[string, unknown]> = [];
  const events: string[] = [];
  const config: RenderSlotOptions = {
    rpc: {
      state: async () => {
        const read = stored;
        if (holdStateReads) await new Promise<void>((resolve) => stateReleases.push(resolve));
        return read;
      },
      recent: () => ({ models: recent }),
      catalog: () => ({ providers: options.catalog ?? catalog }),
      pin: async (input: unknown) => {
        calls.push(["pin", input]);
        const { providerId, model, pinned } = input as ModelRef & { pinned: boolean };
        events.push(`start ${model} ${pinned}`);
        // Like the server: the write is applied, then the reply takes its time.
        stored = { ...stored, lineup: setPinned(stored.lineup, { providerId, model }, pinned) };
        const reply = stored;
        if (options.slowPins) await new Promise((resolve) => setTimeout(resolve, 30));
        if (options.heldPins) await new Promise<void>((resolve) => releases.push(resolve));
        events.push(`end ${model} ${pinned}`);
        return reply;
      },
      setLastView: (input: unknown) => {
        calls.push(["setLastView", input]);
        stored = { ...stored, lastView: (input as { view: LineupState["lastView"] }).view };
        return stored;
      },
    },
    composer: { scope: { kind: "new-thread", projectId: null }, selection: { providerId: "codex", model: "gpt-6.1-sol" } },
    providers: {
      status: "ready",
      providers: [{ id: "codex", displayName: "Codex" }, { id: "pi", displayName: "Pi" }] as never,
    },
  };
  const slot = renderSlot({ component: MenuAnchor }, {}, config);
  const otherWindow = (change: (state: LineupState) => LineupState) => {
    stored = change(stored);
  };
  return { fake, slot, calls, events, otherWindow, release, holdStates, releaseStateReads, stored: () => stored };
}

async function openMenu(fake: ReturnType<typeof buildPicker>) {
  await act(async () => {
    fake.open();
  });
  await waitFor(() => expect(fake.popover.querySelector("[data-lineup-tabs] button")).not.toBeNull());
}

const tab = (fake: ReturnType<typeof buildPicker>, name: string) =>
  Array.from(fake.popover.querySelectorAll<HTMLButtonElement>("[data-lineup-tabs] button")).find(
    (button) => button.textContent === name,
  )!;
const ownRows = (fake: ReturnType<typeof buildPicker>) =>
  Array.from(fake.popover.querySelectorAll<HTMLElement>("[data-lineup-list] [role=option]"));

describe("Lineup in bb's model menu", () => {
  it("adds Recent and Lineup before bb's provider tabs and keeps bb's list on first open", async () => {
    const { fake } = setup();
    await openMenu(fake);
    const row = fake.popover.firstElementChild!;
    expect(row.firstElementChild!.hasAttribute("data-lineup-tabs")).toBe(true);
    expect(tab(fake, "Recent")).toBeTruthy();
    expect(tab(fake, "Lineup")).toBeTruthy();
    expect(fake.popover.getAttribute("data-lineup-view")).toBe("native");
    expect(ownRows(fake)).toHaveLength(0);
  });

  it("shows models recent threads used, with bb's names, and remembers the tab", async () => {
    const { fake, calls } = setup();
    await openMenu(fake);
    fireEvent.click(tab(fake, "Recent"));
    await waitFor(() => expect(ownRows(fake)).toHaveLength(2));
    expect(fake.popover.getAttribute("data-lineup-view")).toBe("recent");
    expect(ownRows(fake).map((row) => row.textContent)).toEqual([
      expect.stringContaining("Claude Opus 5.5anthropic4m"),
      expect.stringContaining("5.52h"),
    ]);
    expect(calls).toContainEqual(["setLastView", { view: "recent" }]);
  });

  it("sets the composer's model when a row is picked, and leaves bb's rows alone", async () => {
    const { fake, slot } = setup({ state: { lineup: [sol, opus], lastView: "lineup" } });
    await openMenu(fake);
    await waitFor(() => expect(ownRows(fake)).toHaveLength(2));
    fireEvent.click(ownRows(fake)[1]!);
    await waitFor(() =>
      expect(slot.inspection.composer.selections).toEqual([{ providerId: "pi", model: "anthropic/claude-opus-5-5" }]),
    );
    expect(fake.picked).toEqual([]);
  });

  it("opens on the tab used last", async () => {
    const { fake } = setup({ state: { lineup: [sol], lastView: "lineup" } });
    await openMenu(fake);
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("lineup"));
    expect(tab(fake, "Lineup").getAttribute("aria-selected")).toBe("true");
    expect(ownRows(fake)[0]!.textContent).toContain("6.1-Sol");
  });

  it("pins and unpins from its own rows", async () => {
    const { fake, calls } = setup({ state: { lineup: [sol], lastView: "recent" } });
    await openMenu(fake);
    await waitFor(() => expect(ownRows(fake)).toHaveLength(2));
    fireEvent.click(ownRows(fake)[0]!.querySelector('[data-lineup-pin="off"]')!);
    await waitFor(() => expect(calls).toContainEqual(["pin", { ...opus, pinned: true }]));
    await waitFor(() => expect(ownRows(fake)[0]!.querySelector('[data-lineup-pin="on"]')).not.toBeNull());
  });

  it("sends a window's pins one at a time, in the order they were made", async () => {
    const { fake, events } = setup({ slowPins: true });
    await openMenu(fake);
    await waitFor(() => expect(fake.rows()[1]!.querySelector('[data-lineup-pin="off"]')).not.toBeNull());
    fireEvent.click(fake.rows()[1]!.querySelector('[data-lineup-pin="off"]')!);
    fireEvent.click(fake.rows()[0]!.querySelector('[data-lineup-pin="on"]')!);
    await waitFor(() => expect(events).toHaveLength(4));
    expect(events).toEqual(["start gpt-5.5 true", "end gpt-5.5 true", "start gpt-6.1-sol false", "end gpt-6.1-sol false"]);
  });

  it("picks up another window's change that lands while its own write is on its way", async () => {
    const { fake, slot, calls, events, otherWindow, release } = setup({ heldPins: true });
    await openMenu(fake);
    await waitFor(() => expect(fake.rows()[1]!.querySelector('[data-lineup-pin="off"]')).not.toBeNull());
    fireEvent.click(fake.rows()[1]!.querySelector('[data-lineup-pin="off"]')!);
    await waitFor(() => expect(events).toEqual(["start gpt-5.5 true"]));
    otherWindow((state) => ({ ...state, lineup: setPinned(state.lineup, opus, true) }));
    await slot.behavior.emitRealtime("state-changed", { reason: "state" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
    });
    await waitFor(() => expect(events).toContain("end gpt-5.5 true"));
    // Switching bb's list writes nothing, so only a fresh read can show the other window's pin.
    fireEvent.click(fake.tabs()[1]!);
    await waitFor(() => expect(fake.activeTitle()).toBe("Pi"));
    await waitFor(() => expect(fake.rows()[0]!.querySelector('[data-lineup-pin="on"]')).not.toBeNull());
    expect(calls.filter(([method]) => method === "setLastView")).toEqual([]);
  });

  it("reads the state again when a change is announced during an older read", async () => {
    const { fake, slot, otherWindow, holdStates, releaseStateReads } = setup();
    await openMenu(fake);
    holdStates();
    await slot.behavior.emitRealtime("state-changed", { reason: "state" });
    otherWindow((state) => ({ ...state, lineup: setPinned(state.lineup, opus, true) }));
    await slot.behavior.emitRealtime("state-changed", { reason: "state" });
    await act(async () => {
      releaseStateReads();
    });
    fireEvent.click(fake.tabs()[1]!);
    await waitFor(() => expect(fake.activeTitle()).toBe("Pi"));
    await waitFor(() => expect(fake.rows()[0]!.querySelector('[data-lineup-pin="on"]')).not.toBeNull());
  });

  it("puts a pin on bb's rows that adds the model without picking it", async () => {
    const { fake, calls } = setup();
    await openMenu(fake);
    await waitFor(() => expect(fake.rows()[1]!.querySelector("[data-lineup-pin]")).not.toBeNull());
    expect(fake.rows()[0]!.querySelector('[data-lineup-pin="on"]')).not.toBeNull();
    fireEvent.click(fake.rows()[1]!.querySelector('[data-lineup-pin="off"]')!);
    await waitFor(() => expect(calls).toContainEqual(["pin", { providerId: "codex", model: "gpt-5.5", pinned: true }]));
    expect(fake.picked).toEqual([]);
  });

  it("filters as you type and offers matches from every provider", async () => {
    const { fake } = setup({ state: { lineup: [sol], lastView: "lineup" } });
    await openMenu(fake);
    await waitFor(() => expect(ownRows(fake)).toHaveLength(1));
    fireEvent.input(fake.search, { target: { value: "gemini" } });
    await waitFor(() => expect(fake.popover.querySelector("[data-lineup-list]")!.textContent).toContain("All models"));
    expect(ownRows(fake).map((row) => row.textContent)).toEqual([expect.stringContaining("Gemini 2.5 Flash")]);
  });

  it("moves through rows with the arrow keys, picks with Enter and changes tab with Tab", async () => {
    const { fake, slot } = setup({ state: { lineup: [sol, opus], lastView: "lineup" } });
    await openMenu(fake);
    await waitFor(() => expect(ownRows(fake)).toHaveLength(2));
    fake.search.focus();
    fireEvent.keyDown(fake.search, { key: "ArrowDown" });
    fireEvent.keyDown(fake.search, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.composer.selections.at(-1)).toMatchObject({ model: "anthropic/claude-opus-5-5" }));
    fireEvent.keyDown(fake.search, { key: "Tab" });
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("native"));
    fireEvent.keyDown(fake.search, { key: "Tab" });
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("recent"));
    // Tab never clicks a provider tab, because that would switch the composer's provider.
    expect(fake.activeTitle()).toBe("Codex");
    fireEvent.keyDown(fake.search, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(fake.search, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("lineup"));
  });

  it("goes back to bb's list when a provider tab is clicked", async () => {
    const { fake, calls } = setup({ state: { lineup: [sol], lastView: "lineup" } });
    await openMenu(fake);
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("lineup"));
    fireEvent.click(fake.tabs()[1]!);
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("native"));
    expect(fake.activeTitle()).toBe("Pi");
    expect(calls).toContainEqual(["setLastView", { view: "native" }]);
  });

  it("adds its own tab row with All models when only one provider is enabled", async () => {
    const { fake } = setup({ providers: [nativeProviders[1]!], catalog: [catalog[1]!], state: { lineup: [], lastView: "recent" } });
    await openMenu(fake);
    expect(fake.popover.firstElementChild!.hasAttribute("data-lineup-tabrow")).toBe(true);
    await waitFor(() => expect(tab(fake, "Recent").getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(tab(fake, "All models"));
    await waitFor(() => expect(fake.popover.getAttribute("data-lineup-view")).toBe("native"));
  });

  it("takes everything out when the menu closes", async () => {
    const { fake } = setup();
    await openMenu(fake);
    await act(async () => {
      fake.close();
    });
    await waitFor(() => expect(fake.popover.querySelector("[data-lineup-tabs]")).toBeNull());
    expect(fake.popover.hasAttribute("data-lineup-view")).toBe(false);
  });
});
