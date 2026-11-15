import { definePluginApp, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { detail, registry, room } from "../../../src/ui/page/fixtures";
import { NARROW_TITLE_QUERY, narrowTitle } from "../../../src/ui/page/page-title";
import { registerPageSurfaces } from "../../../src/ui/page/register";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const rpc = { room: () => structuredClone(room), registry: () => structuredClone(registry), boardQuest: () => structuredClone(detail) } as Partial<Handlers> as Handlers;
const slots: RenderedSlot[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); vi.unstubAllGlobals(); });

/** A window whose width can change under the hook: it answers the narrow-title query and tells listeners when that flips. */
function windowOf(width: number) {
  const listeners = new Set<() => void>();
  const state = { width };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === NARROW_TITLE_QUERY && state.width < 480; },
    media: query, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return { resize: (w: number) => { state.width = w; for (const fn of listeners) fn(); } };
}
async function title(subPath: string) {
  const p = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const useTitle = p.navPanels[0]!.experimental_usePageTitle!;
  function Probe() { return <pre data-testid="t">{JSON.stringify(useTitle({ subPath } as PluginNavPanelProps))}</pre>; }
  const slot = renderSlot({ component: Probe }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc });
  slots.push(slot);
  return { read: () => JSON.parse(slot.getByTestId("t").textContent || "null") };
}

describe("The page title in a narrow window", () => {
  it("keeps only the last step, with the whole trail as the window title", () => {
    expect(narrowTitle({ breadcrumbs: [{ label: "Classes", to: "/plugins/tavern/tavern/classes" }, { label: "Keeper" }] })).toEqual({ title: "Keeper", windowTitle: "Classes / Keeper" });
    expect(narrowTitle({ title: "Common room" })).toEqual({ title: "Common room" });
    expect(narrowTitle(null)).toBeNull();
  });

  it("shows a class page's last step below 480 px, and the full trail again when the window widens", async () => {
    const win = windowOf(390);
    const t = await title("class/keeper");
    await waitFor(() => expect(t.read()).toEqual({ title: registry.classes.find((c) => c.id === "keeper")!.label, windowTitle: `Classes / ${registry.classes.find((c) => c.id === "keeper")!.label}` }));
    act(() => win.resize(1024));
    await waitFor(() => expect(t.read().breadcrumbs.map((b: { label: string }) => b.label)).toEqual(["Classes", registry.classes.find((c) => c.id === "keeper")!.label]));
  });

  it("names a quest page by the quest alone on a phone", async () => {
    windowOf(360);
    const t = await title(`quest/${detail.quest.id}`);
    await waitFor(() => expect(t.read()).toEqual({ title: detail.quest.short, windowTitle: `Quests / ${detail.quest.short}` }));
  });

  it("leaves one-word titles alone at every width", async () => {
    windowOf(360);
    const t = await title("classes");
    await waitFor(() => expect(t.read()).toEqual({ title: "Classes" }));
  });
});

describe("The header in a narrow window", () => {
  async function header(width: number) {
    const win = windowOf(width);
    const p = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const Head = p.navPanels[0]!.headerContent!;
    const slot = renderSlot({ component: () => <Head subPath="classes" /> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc });
    slots.push(slot);
    return { slot, win };
  }
  it("leaves Closing time to the page picker below 480 px, so the title has the room", async () => {
    const { slot, win } = await header(390);
    await waitFor(() => expect(slot.getByRole("button", { name: /Start a quest/ })).toBeTruthy());
    expect(slot.queryByRole("button", { name: "Closing time" })).toBeNull();
    act(() => win.resize(720));
    await waitFor(() => expect(slot.getByRole("button", { name: "Closing time" })).toBeTruthy());
  });
});

describe("The header beside a narrow page column", () => {
  // bb's side panel at 1400: the window is wide, but the page column is about 540 px, and the trail ran under Closing time.
  function observed() {
    const boxes: { cb: ResizeObserverCallback; el: Element }[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(private cb: ResizeObserverCallback) {} observe(el: Element) { boxes.push({ cb: this.cb, el }); } unobserve() {} disconnect() {} });
    return { resize: (width: number) => {
      const root = boxes.find((x) => x.el.classList.contains("tv-page-root"))!;
      vi.spyOn(root.el, "getBoundingClientRect").mockReturnValue({ width } as DOMRect);
      root.cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    } };
  }
  async function surfaces(subPath: string) {
    const p = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const panel = p.navPanels[0]!, Head = panel.headerContent!, useTitle = panel.experimental_usePageTitle!, Page = panel.component;
    function Probe() { return <pre data-testid="t">{JSON.stringify(useTitle({ subPath } as PluginNavPanelProps))}</pre>; }
    const slot = renderSlot({ component: () => <><Head subPath={subPath} /><Probe /><Page subPath={subPath} /></> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc });
    slots.push(slot);
    return { slot, title: () => JSON.parse(slot.getByTestId("t").textContent || "null"), head: () => slot.container.querySelector(".tv-head")! };
  }

  it("folds the header to icons and shortens the trail while the page column is under 640 px, in a wide window", async () => {
    windowOf(1400);
    const box = observed();
    const s = await surfaces("character/wren");
    await s.slot.findByRole("button", { name: /Edit Wren's voice/ });
    act(() => box.resize(540));
    await waitFor(() => expect(s.head().classList.contains("fold")).toBe(true));
    expect(s.title()).toEqual({ title: "Wren", windowTitle: "Character sheets / Wren" });
    // Folded, not removed: both actions keep their names and targets; only a phone window drops Closing time.
    expect(s.slot.getByRole("button", { name: "Closing time" })).toBeTruthy();
    expect(s.slot.getByRole("button", { name: /Start a quest/ })).toBeTruthy();
    act(() => box.resize(900));
    await waitFor(() => expect(s.head().classList.contains("fold")).toBe(false));
    expect(s.title().breadcrumbs.map((b: { label: string }) => b.label)).toEqual(["Character sheets", "Wren"]);
  });

  it("forgets the column when the page goes, so another page's header isn't folded by it", async () => {
    windowOf(1400);
    const box = observed();
    const s = await surfaces("character/wren");
    await s.slot.findByRole("button", { name: /Edit Wren's voice/ });
    act(() => box.resize(540));
    await waitFor(() => expect(s.head().classList.contains("fold")).toBe(true));
    act(() => { s.slot.lifecycle.unmount(); slots.splice(slots.indexOf(s.slot), 1); });
    const p = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const Head = p.navPanels[0]!.headerContent!;
    const alone = renderSlot({ component: () => <Head subPath="classes" /> }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc });
    slots.push(alone);
    await waitFor(() => expect(alone.getByRole("button", { name: /Start a quest/ })).toBeTruthy());
    expect(alone.container.querySelector(".tv-head")!.classList.contains("fold")).toBe(false);
  });
});
