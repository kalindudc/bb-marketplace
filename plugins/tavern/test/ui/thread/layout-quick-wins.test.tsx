import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Chart } from "../../../src/ui/kit/charts";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureLedger, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { clearThreadState } from "../../../src/ui/thread/state";

const css = readFileSync("src/ui/kit/components.css", "utf8");
const trim = readFileSync("src/ui/kit/tavern.css", "utf8");
const contextCss = readFileSync("src/ui/thread/journal-segment.css", "utf8");
afterEach(() => { cleanup(); clearThreadState(); vi.unstubAllGlobals(); });

it.each([false, true])("uses the chart's actual content width before its first resize (named: %s)", named => {
  const width = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 313.9 } as DOMRect);
  try {
    const series = { id: "days", label: "Ticks", unit: "count", points: [{ x: "2026-11-01", y: 1 }, { x: "2026-11-02", y: 2 }] };
    const view = render(<Chart type="trend" series={named ? [series] : series} />);
    const chart = view.container.querySelector<HTMLElement>("figure")!;
    expect(chart.querySelector("svg")?.getAttribute("width")).toBe("313");
  } finally { width.mockRestore(); }
});

it.each([false, true])("never rounds a measured chart up into SVG downscaling (named: %s)", named => {
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: ResizeObserverCallback) { resize = cb; } observe() {} disconnect() {} });
  const series = { id: "days", label: "Ticks", unit: "count", points: [{ x: "2026-11-01", y: 1 }, { x: "2026-11-02", y: 2 }] };
  const view = render(<Chart type="trend" series={named ? [series] : series} />);
  act(() => resize([{ contentRect: { width: 287.9 } }] as ResizeObserverEntry[], {} as ResizeObserver));
  expect(view.container.querySelector("svg")?.getAttribute("width")).toBe("287");
});

it.each([1, 2, 3])("keeps all %i quests reachable from the single row chip", async count => {
  const quests = Array.from({ length: count }, (_, i) => ({ ...fixtureQuest, id: `q${i}`, title: `Survey ${i + 1}` }));
  const decor = { ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, boardQuests: quests } };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  const chip = await slot.findByRole("button", { name: /^Show Survey 1/ });
  expect(chip.querySelectorAll(".tw-ph i")).toHaveLength(5);
  fireEvent.click(chip);
  const links = slot.getAllByRole("button", { name: /Open the quest page for Survey/ });
  expect(links).toHaveLength(count);
  fireEvent.click(links.at(-1)!);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: `quest/q${count - 1}` } });
});

it("opens live and sealed quests from the Keeper's signposts", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  try {
    const decor = {
      ...fixtureDecor,
      characters: true,
      stripScene: { revision: "fixture", at: null, role: "keeper", stage: "work", activity: "unknown", moment: "none", posture: "clear",
        road: { kind: "keeper", key: "keeper-1", current: "bridge", places: [
          { kind: "quest", id: "bridge", name: "Bridge", state: "building", done: 3, total: 5 },
          { kind: "quest", id: "gate", name: "Gate", state: "sealed", done: 1, total: 1 },
        ] },
      },
    } as const;
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
    fireEvent.click(await slot.findByRole("button", { name: "Bridge · building, 3 of 5 steps done" }));
    fireEvent.click(slot.getByRole("button", { name: "Gate · sealed, 1 of 1 steps done" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "tavern", options: { subPath: "quest/bridge" } },
      { method: "toPluginPanel", path: "tavern", options: { subPath: "tale/gate" } },
    ]);
  } finally {
    width.mockRestore(); canvas.mockRestore();
  }
});

it.each(["scout", "held"] as const)("keeps the full %s quest move in the tooltip and section", async phase => {
  const text = "Propose the quest map · next " + "review the remaining findings and schedule the handoff ".repeat(12).trimEnd();
  const quest = { ...fixtureQuest, phase, nextNewsBy: 60_000, move: { ...fixtureQuest.move, text } };
  const decor = { ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, boardQuests: [quest] } };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  const chip = await slot.findByRole("button", { name: `Show ${quest.title}` });
  expect(chip.title).toContain(text);
  fireEvent.click(chip);
  expect(slot.getByText(text)).toBeTruthy();
});

it("keeps the journal progress control content-sized beside other context chips", () => {
  expect(contextCss).toMatch(/\.jseg-sum:not\(\.jseg-skel\)\s*\{[^}]*flex: none[^}]*min-width: max-content/);
});

it("keeps the full Ledger title in a tooltip and marks its clamp for optical trimming", async () => {
  const title = "Monitor Edge Infrastructure operations and prepare non-staging resiliency action";
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, boardQuests: [{ ...fixtureQuest, title }] }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
  const button = await slot.findByRole("button", { name: title });
  expect(button.title).toContain(title);
  expect(button.querySelector("b")?.classList.contains("clamp")).toBe(true);
  slot.lifecycle.unmount();
});

it("clamps the title to two lines and guards the other constrained Ledger labels", () => {
  expect(css).toMatch(/\.lg-qt b\.clamp\s*\{[^}]*min-width: 0[^}]*-webkit-line-clamp: 2[^}]*white-space: normal/s);
  expect(trim).toMatch(/:not\([^)]*\.lg-qt > b/);
  expect(css).toMatch(/\.lg-card h3\s*\{[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.lg-card h3 \.num\s*\{[^}]*white-space: normal/);
  expect(css).toMatch(/\.mem-gt b\s*\{[^}]*min-width: 0[^}]*text-overflow: ellipsis/);
  expect(css).toMatch(/\.lg-done \.lg-row \.m\s*\{[^}]*min-width: 0[^}]*text-overflow: ellipsis/);
});

it("keeps the Keeper row to one bb widget height with 24px controls and the full name in its tooltip", async () => {
  expect(css).toMatch(/\.v-keeper \.tw-row\s*\{[^}]*flex-wrap: nowrap/);
  expect(css).toMatch(/\.v-keeper \.tw-row\s*\{[^}]*min-height: 33px/);
  expect(css).toMatch(/\.v-keeper \.tw-row > button\s*\{[^}]*min-width: 24px; height: 24px/);
  expect(css).toMatch(/@media \(max-width: 767px\) and \(pointer: coarse\)\s*\{[^}]*\.v-keeper \.tw-row\s*\{[^}]*min-height: 36px/);
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => fixtureDecor, registry: () => fixtureRegistry } });
  await slot.findByRole("button", { name: "Expand Tavern widget" });
  const name = slot.container.querySelector(".tw-name")!.textContent;
  expect(name).toBeTruthy();
  expect(slot.container.querySelector(".tw-id")!.getAttribute("title")).toContain(name);
});

it("sets chart labels to at least 11 px and lets long model ids wrap", () => {
  expect(css).toMatch(/\.tchart-trend text\s*\{[^}]*font-size: 11px/);
  expect(css).toMatch(/\.tchart-bars \.l\s*\{[^}]*white-space: normal[^}]*overflow-wrap: anywhere/);
  expect(css).toMatch(/\.tchart-bars\s*\{[^}]*minmax\(0, max-content\)/);
});
