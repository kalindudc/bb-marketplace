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

it.each([1, 2, 3])("offers one collapsed chip for %i quests with the Ledger still reachable", async count => {
  const decor = { ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, boardQuests: Array.from({ length: count }, (_, i) => ({ ...fixtureQuest, id: `q${i}` })) } };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  const chip = await slot.findByRole("button", { name: `Show ${count} ${count === 1 ? "quest" : "quests"}` });
  expect(chip.classList.contains("tw-quests-count")).toBe(true);
  expect(chip.textContent).toBe(`${count} ${count === 1 ? "quest" : "quests"}`);
  expect(slot.getAllByRole("button", { name: /Open the quest page for/ })).toHaveLength(count);
  fireEvent.click(chip);
  fireEvent.click(slot.getByRole("button", { name: "Open the Ledger" }));
  expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: expect.objectContaining({ id: "ledger" }) } });
  slot.lifecycle.unmount();
});

it.each(["scout", "held"] as const)("lets a long %s quest summary yield to the Ledger and close controls", async phase => {
  const text = "Propose the quest map · next " + "review the remaining findings and schedule the handoff ".repeat(12).trimEnd();
  const quest = { ...fixtureQuest, phase, nextNewsBy: 60_000, move: { ...fixtureQuest.move, text } };
  const decor = { ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, boardQuests: [quest] } };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  const chip = await slot.findByRole("button", { name: /Open the quest page for/ });
  expect(chip.title).toContain(text);
  expect(chip.querySelector(".tw-quest-move")?.textContent).toBe(text);
  expect(css).toMatch(/\.tw-quest-move\s*\{[^}]*min-width: 0[^}]*overflow: hidden[^}]*text-overflow: ellipsis/);
  const ledger = slot.getByRole("button", { name: /Open the Keeper’s ledger/ });
  const close = slot.getByRole("button", { name: /Hide Tavern in this thread/ });
  expect(chip.closest(".tw-row")).toBe(ledger.parentElement);
  expect(ledger.parentElement).toBe(close.parentElement);
  slot.lifecycle.unmount();
});

it("reserves chip space for a crowded Keeper row even at desktop widths", async () => {
  const attention = { items: [], needYou: 1, new: 4, heldByYou: 0 };
  const quest = { ...fixtureQuest, phase: "scout" as const, nextNewsBy: 60_000, move: { ...fixtureQuest.move, text: "Propose the quest map · next compare the autumn atlases".repeat(10) }, attention: { ...attention, summaries: 12 } };
  const scope = { threadId: "keeper-1", scope: null, error: null, armed: true, pendingAskId: null, clusterGuard: "armed" as const, sendGuard: "armed" as const };
  const decor = { ...fixtureDecor, scope, characters: false, keeperView: { ...fixtureDecor.keeperView!, attention, boardQuests: [quest] } };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  const needs = await slot.findByRole("button", { name: /1 need you/ });
  const chip = slot.getByRole("button", { name: /Open the quest page for/ });
  expect(chip.querySelectorAll(".tw-ph i")).toHaveLength(5);
  expect(chip.querySelector(".tw-unread")?.textContent).toBe("12 new");
  expect(slot.getByRole("button", { name: /4 new/ })).toBeTruthy();
  expect(needs.closest(".tw-row")).toBe(chip.closest(".tw-row"));
  expect(css).toMatch(/^\.tavern\.v-keeper \.tw-row\s*\{[^}]*flex-wrap: wrap/m);
  expect(css).toMatch(/\.tw-quests\s*\{[^}]*flex: 1 1 0[^}]*flex-wrap: wrap[^}]*overflow: clip/);
  expect(css).toMatch(/\.tw-quests:has\(\.tw-unread\)\s*\{[^}]*min-width:/);
  expect(css).toMatch(/\.tw-quest:has\(\.tw-unread\)\s*\{[^}]*min-width:/);
  slot.lifecycle.unmount();
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
