import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { readReportsParams } from "../../../src/ui/page/reports";
import { questShortName } from "../../../src/ui/page/register";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const detail = scenes.readmeDetail;
const ID = detail.quest.id;
const LARK = "thr_z5k6x43jc2", VEX = "thr_f8kheswkzk";
const rpc = { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), boardQuest: () => structuredClone(detail) } as Partial<Handlers> as Handlers;
const plugin = () => loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
async function tab(params: unknown) {
  const t = (await plugin()).tabs.find((x) => x.id === "member-reports")!;
  const slot = renderSlot(t as never, { params } as never, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc });
  slots.push(slot); return slot;
}
async function questPage(panelAccepts: boolean) {
  const slot = renderSlot((await plugin()).navPanels[0]!, { subPath: `quest/${ID}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc, ...(panelAccepts ? { experimental_panel: { openTab: () => true } } : {}) });
  slots.push(slot); return slot;
}

describe("the reports tab", () => {
  it("is registered beside the page's other panel tabs", async () => {
    expect((await plugin()).tabs.find((t) => t.id === "member-reports")?.title).toBe("Reports");
  });
  it("reads only well-formed params", () => {
    expect(readReportsParams({ questId: ID, memberThreadId: LARK })).toEqual({ questId: ID, memberThreadId: LARK });
    expect(readReportsParams({ questId: ID, memberThreadId: LARK, reportId: "r1" })).toEqual({ questId: ID, memberThreadId: LARK, reportId: "r1" });
    expect(readReportsParams({ questId: ID })).toBeNull();
    expect(readReportsParams(null)).toBeNull();
  });
  it("says who and which quest at the top, then every report of that member, newest first, as its own scroll container", async () => {
    const slot = await tab({ questId: ID, memberThreadId: LARK });
    await waitFor(() => expect(slot.container.querySelectorAll(".rv-rep")).toHaveLength(3));
    const head = slot.container.querySelector(".rv-reps-h")!;
    expect(head.textContent).toContain("Lark");
    expect(head.textContent).toContain(detail.quest.short);
    expect(slot.container.querySelector(".tavern.tv-paneltab.tv-reptab")).toBeTruthy();
    expect(slot.getByRole("navigation", { name: "Lark’s reports" })).toBeTruthy();
    const times = [...slot.container.querySelectorAll(".rv-rep")].map((s) => (s as HTMLElement).dataset.report);
    expect(times).toEqual(detail.reports.filter((r) => r.memberThreadId === LARK).sort((a, b) => b.createdAt - a.createdAt).map((r) => r.id));
    expect(slot.container.textContent).not.toMatch(/\bthr_[a-z0-9]{6,}\b(?![^\s]*\/)/);
    expect(slot.queryByRole("dialog")).toBeNull();
  });
  it("tells reports apart in the jump list by time, status and the start of an id-free headline", async () => {
    const slot = await tab({ questId: ID, memberThreadId: LARK });
    const nav = await slot.findByRole("navigation", { name: "Lark’s reports" });
    const entries = [...nav.querySelectorAll("button")];
    expect(entries).toHaveLength(3);
    for (const b of entries) {
      expect(b.textContent).toMatch(/^\S.* · (done|blocked|needs a decision) · .{8,}/);
      expect(b.getAttribute("title")).toBe(b.textContent);
      expect(b.textContent).not.toMatch(/\bthr_|\bquest_/);
    }
    expect(new Set(entries.map((b) => b.textContent)).size).toBe(3);
  });
  it("moves focus to the chosen report from the index, so the next Tab continues inside it (Pedro r5)", async () => {
    const slot = await tab({ questId: ID, memberThreadId: LARK });
    const nav = await slot.findByRole("navigation", { name: "Lark’s reports" });
    const third = [...nav.querySelectorAll<HTMLButtonElement>("button")][2]!;
    third.focus();
    fireEvent.click(third);
    const head = document.activeElement as HTMLElement;
    expect(head.classList.contains("rv-rep-h")).toBe(true);
    expect(head.getAttribute("tabindex")).toBe("-1");
    const section = head.closest("[data-report]")!;
    expect([...slot.container.querySelectorAll("[data-report]")].indexOf(section)).toBe(2);
    // The next Tab stop after the header, in document order, is inside the same report.
    const stops = [...slot.container.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")];
    const next = stops.find((el) => head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(next).toBeTruthy();
    expect(section.contains(next!)).toBe(true);
  });
  it("shows another member's reports in place of the first when opened again", async () => {
    const slot = await tab({ questId: ID, memberThreadId: VEX });
    await waitFor(() => expect(slot.container.querySelectorAll(".rv-rep")).toHaveLength(2));
    expect(slot.container.querySelector(".rv-reps-h")!.textContent).toContain("Vex");
    expect(slot.queryByRole("navigation")).toBeNull();
  });
  it("says so when the member is not on the quest", async () => {
    const slot = await tab({ questId: ID, memberThreadId: "thr_nobody" });
    expect(await slot.findByText("This member is no longer on the quest.")).toBeTruthy();
  });
});

describe("the tale's breadcrumb", () => {
  it("is the quest's short name, else its title cut to 40 characters, never a generic word", () => {
    expect(questShortName({ short: "isZeroDuration", title: "Add isZeroDuration(ms) with two tests" })).toBe("isZeroDuration");
    const long = "List plugins/* folders missing from the README.md plugin table, one per line";
    expect(questShortName({ short: "", title: long })).toBe(`${long.slice(0, 39).trimEnd()}…`);
    expect(questShortName({ short: null, title: "Short title" })).toBe("Short title");
  });
  it("names a quest the room no longer lists from its own detail", async () => {
    const p = await plugin();
    const useTitle = p.navPanels[0]!.experimental_usePageTitle!;
    function Probe() { const t = useTitle({ subPath: `tale/${ID}` } as never); return <span data-testid="crumb">{t && "breadcrumbs" in t && t.breadcrumbs ? t.breadcrumbs.map((b) => `${b.label}${b.to ? ` <${b.to}>` : ""}`).join(" / ") : ""}</span>; }
    const slot = renderSlot({ component: Probe }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc });
    slots.push(slot);
    // The quest's record is the middle step, so the tale is one step from everything the quest recorded.
    await waitFor(() => expect(slot.getByTestId("crumb").textContent).toBe(`Returned </plugins/tavern/tavern/returned> / ${detail.quest.short} </plugins/tavern/tavern/quest/${encodeURIComponent(ID)}> / The tale`));
  });
});

describe("a stopped quest's tale route", () => {
  it("starts its breadcrumb with Stopped, not Returned", async () => {
    const p = await plugin();
    const useTitle = p.navPanels[0]!.experimental_usePageTitle!;
    const stopped = { ...detail, quest: { ...detail.quest, phase: "stopped" as const } };
    const stoppedRpc = { ...rpc, boardQuest: () => structuredClone(stopped) } as typeof rpc;
    function Probe() { const t = useTitle({ subPath: `tale/${ID}` } as never); return <span data-testid="crumb">{t && "breadcrumbs" in t && t.breadcrumbs ? t.breadcrumbs.map((b) => b.label).join(" / ") : ""}</span>; }
    const slot = renderSlot({ component: Probe }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: stoppedRpc });
    slots.push(slot);
    await waitFor(() => expect(slot.getByTestId("crumb").textContent).toBe(`Stopped / ${detail.quest.short} / The tale`));
  });
});

describe("the quest page's report rows", () => {
  it("open the member's reports at that report, with an id-free line", async () => {
    const slot = await questPage(true);
    fireEvent.click(await slot.findByRole("button", { name: /^Reports\b/, expanded: false }));
    const rows = await waitFor(() => { const r = slot.container.querySelectorAll(".tv-items > .tv-item"); expect(r.length).toBe(detail.reports.length); return r; });
    for (const r of rows) expect(r.querySelector(".tv-item-t")!.textContent).not.toMatch(/\bthr_|\bquest_/);
    const report = detail.reports[0]!;
    const view = [...rows].map((r) => r.querySelector<HTMLButtonElement>("button.lnk-btn")!)[0]!;
    expect(view.textContent).toContain("View");
    fireEvent.click(view);
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: { id: "member-reports", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" }, params: { questId: ID, memberThreadId: report.memberThreadId, reportId: report.id }, title: expect.stringMatching(/’s reports · /) } });
  });
  it("keep one reports tab: opening another member's closes the earlier one once the new tab is in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const closed: string[] = [];
    let tabs = [{ key: "k-old", title: `Lark’s reports · ${detail.quest.short}`, status: null, closable: true, detail: { kind: "info" as const } }, { key: "k-closing", title: "Closing time", status: null, closable: true, detail: { kind: "info" as const } }];
    const panel = {
      openTab: () => { tabs = [...tabs, { key: "k-new", title: "Vex’s reports · x", status: null, closable: true, detail: { kind: "info" as const } }]; return true; },
      getTabs: () => ({ open: true, selectedKey: "k-new", tabs }),
      closeTab: (key: string) => { closed.push(key); tabs = tabs.filter((t) => t.key !== key); return true; },
    };
    const slot = renderSlot((await plugin()).navPanels[0]!, { subPath: `quest/${ID}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc, experimental_panel: panel as never });
    slots.push(slot);
    fireEvent.click(await slot.findByRole("button", { name: /^Reports\b/, expanded: false }));
    const view = await waitFor(() => slot.container.querySelector<HTMLButtonElement>(".tv-items > .tv-item button.lnk-btn")!);
    fireEvent.click(view);
    await vi.advanceTimersByTimeAsync(200);
    expect(closed).toEqual(["k-old"]);
    vi.useRealTimers();
  });
  it("show the report in place when bb declines the panel", async () => {
    const slot = await questPage(false);
    fireEvent.click(await slot.findByRole("button", { name: /^Reports\b/, expanded: false }));
    const view = await waitFor(() => slot.container.querySelector<HTMLButtonElement>(".tv-items > .tv-item button.lnk-btn")!);
    fireEvent.click(view);
    expect(slot.container.querySelector(".tv-items .tv-item-x .rv")).toBeTruthy();
  });
});
