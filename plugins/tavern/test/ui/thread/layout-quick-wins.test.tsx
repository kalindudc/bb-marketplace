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
afterEach(() => { cleanup(); clearThreadState(); vi.unstubAllGlobals(); });

it.each([false, true])("never rounds a measured chart up into SVG downscaling (named: %s)", named => {
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: ResizeObserverCallback) { resize = cb; } observe() {} disconnect() {} });
  const series = { id: "days", label: "Ticks", unit: "count", points: [{ x: "2026-11-01", y: 1 }, { x: "2026-11-02", y: 2 }] };
  const view = render(<Chart type="trend" series={named ? [series] : series} />);
  act(() => resize([{ contentRect: { width: 287.9 } }] as ResizeObserverEntry[], {} as ResizeObserver));
  expect(view.container.querySelector("svg")?.getAttribute("width")).toBe("287");
});

it.each([1, 2, 3])("offers one collapsed Ledger chip for %i quests without replacing the quest links", async count => {
  const decor = { ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, boardQuests: Array.from({ length: count }, (_, i) => ({ ...fixtureQuest, id: `q${i}` })) } };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  const chip = await slot.findByRole("button", { name: `${count} ${count === 1 ? "quest" : "quests"}: open the Ledger` });
  expect(chip.classList.contains("tw-quests-count")).toBe(true);
  expect(chip.textContent).toBe(`${count} ${count === 1 ? "quest" : "quests"}`);
  expect(slot.getAllByRole("button", { name: /Open the quest page for/ })).toHaveLength(count);
  fireEvent.click(chip);
  expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: expect.objectContaining({ id: "ledger" }) } });
  slot.lifecycle.unmount();
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
  expect(css).toMatch(/\.lg-qt b\s*\{[^}]*min-width: 0[^}]*-webkit-line-clamp: 2[^}]*white-space: normal/s);
  expect(trim).toMatch(/:not\([^)]*\.lg-qt > b/);
  expect(css).toMatch(/\.lg-card h3\s*\{[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.lg-card h3 \.num\s*\{[^}]*white-space: normal/);
  expect(css).toMatch(/\.mem-gt b\s*\{[^}]*min-width: 0[^}]*text-overflow: ellipsis/);
  expect(css).toMatch(/\.lg-done \.lg-row \.m\s*\{[^}]*min-width: 0[^}]*text-overflow: ellipsis/);
});

it("reserves the Keeper name until after quests collapse and keeps count nouns at 340", () => {
  expect(css).toMatch(/\.v-keeper \.tw-id\s*\{[^}]*flex: none/);
  expect(css).toMatch(/\.tw-quest b\s*\{[^}]*min-width: 6ch/);
  expect(css).toMatch(/max-width: 520px[^}]*\.tw-quests-count[^}]*display: inline-flex/);
  expect(css).toMatch(/max-width: 339px[^}]*\.tw-w[^}]*display: none/);
  expect(css).not.toMatch(/max-width: 340px[^}]*\.tavern \.tw-id \.tw-name[^}]*display: none/);
});

it("sets chart labels to at least 11 px and lets long model ids wrap", () => {
  expect(css).toMatch(/\.tchart-trend text\s*\{[^}]*font-size: 11px/);
  expect(css).toMatch(/\.tchart-bars \.l\s*\{[^}]*white-space: normal[^}]*overflow-wrap: anywhere/);
  expect(css).toMatch(/\.tchart-bars\s*\{[^}]*minmax\(0, max-content\)/);
});
