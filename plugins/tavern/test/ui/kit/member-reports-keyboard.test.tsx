// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MemberReports } from "../../../src/ui/kit";
import { readmeDetail, registry } from "../page/scenes";

afterEach(cleanup);
const tabStops = (root: Element) => [...root.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex='-1'])")];

describe("MemberReports from the keyboard", () => {
  it("after a jump from the index, the next Tab reaches the chosen report, and Back to the list returns to its entry", async () => {
    const counts = new Map<string, number>();
    for (const r of readmeDetail.reports) counts.set(r.memberThreadId, (counts.get(r.memberThreadId) ?? 0) + 1);
    const [threadId] = [...counts].find(([, n]) => n >= 3)!;
    const member = readmeDetail.quest.members.find(m => m.threadId === threadId)!;
    const app = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: () => <MemberReports detail={readmeDetail} member={member} registry={registry} /> } as never); }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {});
    const nav = await slot.findByRole("navigation");
    const entries = [...nav.querySelectorAll<HTMLButtonElement>("button")];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    entries[2]!.focus();
    fireEvent.click(entries[2]!);
    const head = document.activeElement as HTMLElement;
    const section = head.closest("[data-report]")!;
    expect(head.classList.contains("rv-rep-h")).toBe(true);
    const next = tabStops(slot.container).find(el => head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(next).toBeDefined();
    expect(section.contains(next!)).toBe(true);
    expect(next!.textContent).toBe("Back to the list");
    fireEvent.click(next!);
    expect(document.activeElement).toBe(entries[2]);
  });

  it("draws no Back to the list without an index", async () => {
    const member = readmeDetail.quest.members.find(m => readmeDetail.reports.filter(r => r.memberThreadId === m.threadId).length === 1)!;
    const app = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: () => <MemberReports detail={readmeDetail} member={member} registry={registry} /> } as never); }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {});
    await slot.findAllByText(/Open thread/);
    expect(slot.container.querySelector(".rv-rep-back")).toBeNull();
  });
});
