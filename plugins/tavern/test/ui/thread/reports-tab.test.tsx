// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDetail, fixtureMember, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { REPORTS_TAB } from "../../../src/ui/thread/reports-tab";

afterEach(cleanup);
const load = () => loadPluginApp(definePluginApp(registerThreadSurfaces));
const juno = { ...fixtureMember, threadId: "member-1", role: "member" as const, keeperThreadId: "keeper-1", boardQuestId: "vault", displayName: "Juno" };
const detail = { ...fixtureDetail, quest: { ...fixtureDetail.quest, members: [juno] } };
const rawId = { ...fixtureReport, id: "report-2", outcome: "Checked thr_zz9 against the plan. The cutover script runs clean twice.", createdAt: 2000 };
const otherQuest = { ...fixtureReport, id: "report-3", boardQuestId: "other", outcome: "Not about the vault" };
const message = { id: "m1", threadId: "keeper-1", turnId: null, projectId: null };

describe("Report card and report tab", () => {
  it("shows the report in short with no raw id, and View report opens the thread's report tab on that report", async () => {
    const app = await load();
    const card = app.messageDirectives.find(d => d.id === "tavern-reports")!;
    const slot = renderSlot(card, { attributes: { ids: "report-2" }, source: "reports", message, openWorkspaceFile: null }, { rpc: { reports: () => ({ reports: [rawId] }), boardQuest: () => detail, registry: () => fixtureRegistry, crests: () => ({ crests: [] }) } });
    await slot.findByText(/Checked another thread against the plan/);
    expect(slot.container.textContent).not.toMatch(/thr_zz9/);
    expect(slot.getByText("1 piece of evidence")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /View report/ }));
    expect(slot.inspection.experimental_panelCalls).toContainEqual({ method: "openTab", options: { tab: REPORTS_TAB, params: { memberThreadId: "member-1", questId: "vault", reportId: "report-2" } } });
    slot.lifecycle.unmount();
  });

  it("lists one member's reports on that quest in full, newest first, and opens the member's thread", async () => {
    const app = await load();
    const tab = app.tabs.find(t => t.id === REPORTS_TAB.id)!;
    const slot = renderSlot(tab as never, { threadId: "keeper-1", environment: null, params: { memberThreadId: "member-1", questId: "vault", reportId: "report-2" } }, { rpc: { reports: () => ({ reports: [fixtureReport, rawId, otherQuest] }), boardQuest: () => ({ ...detail, reports: [fixtureReport, rawId] }), registry: () => fixtureRegistry, crests: () => ({ crests: [] }) } });
    await slot.findByText("Juno");
    const sections = await slot.findAllByRole("region", { name: /^Report, / });
    expect(sections).toHaveLength(2);
    expect(sections[0]!.textContent).toMatch(/Checked another thread/);
    expect(slot.container.textContent).not.toMatch(/Not about the vault|thr_zz9/);
    fireEvent.click(slot.getByRole("button", { name: /Open thread/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "member-1" });
    slot.lifecycle.unmount();
  });

  it("lists an errand's results, which have no board quest, with the same header", async () => {
    const app = await load();
    const tab = app.tabs.find(t => t.id === REPORTS_TAB.id)!;
    const errand = { ...fixtureReport, id: "report-9", boardQuestId: null, waypointId: null, outcome: "Lead time is 70 minutes." };
    const slot = renderSlot(tab as never, { threadId: "keeper-1", environment: null, params: { memberThreadId: "member-1", questId: null } }, { rpc: { reports: () => ({ reports: [errand, rawId] }), registry: () => fixtureRegistry, crests: () => ({ crests: [] }) } });
    await slot.findByText(/Lead time is 70 minutes/);
    expect(slot.getByText(/Side quest \(errand\) · 1 report/)).toBeTruthy();
    expect(slot.container.textContent).not.toMatch(/Checked another thread/);
    slot.lifecycle.unmount();
  });

  it("says so when the link lacks its member, rather than showing nothing", async () => {
    const app = await load();
    const tab = app.tabs.find(t => t.id === REPORTS_TAB.id)!;
    const slot = renderSlot(tab as never, { threadId: "keeper-1", environment: null, params: null }, { rpc: { registry: () => fixtureRegistry } });
    await slot.findByText(/This report link is incomplete/);
    slot.lifecycle.unmount();
  });
});

describe("Tale card", () => {
  it("names ids in the Keeper's tale: party members, waypoints and reports, and the Keeper itself", async () => {
    const app = await load();
    const card = app.messageDirectives.find(d => d.id === "tavern-tale")!;
    const tale = { outcome: "thr_juno finished waypoint w1 per report_r1, and thr_keep sealed it.", left: null, skipped: [], wrappedAt: 3000 };
    const done = { ...detail, quest: { ...detail.quest, phase: "done" as const, keeperThreadId: "thr_keep", members: [{ ...juno, threadId: "thr_juno" }] }, reports: [{ ...fixtureReport, id: "report_r1", memberThreadId: "thr_juno" }], tale };
    const slot = renderSlot(card, { attributes: { quest: "vault" }, source: "tale", message, openWorkspaceFile: null }, { rpc: { boardQuest: () => done, registry: () => fixtureRegistry, crests: () => ({ crests: [] }) } });
    const lead = await slot.findByText(/finished/);
    expect(lead.textContent).toBe(`Juno finished waypoint ${detail.quest.waypoints[0]!.title} per Juno’s report, and the Keeper sealed it.`);
    slot.lifecycle.unmount();
  });
});
