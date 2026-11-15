import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Room } from "../../../src/shared/contract";
import { ReviewQueue } from "../../../src/ui/page/room";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });
const item = { title: "The full reported outcome", url: "https://example.com/review", boardQuestId: "environment", questTitle: "Environment rules", waypoint: { id: "w1", title: "Check the environment", doneWhen: "The sandbox checks pass" }, member: { threadId: "maker", displayName: "Juno II", classId: "smith" }, reportId: "review-context", headline: "The complete report headline with context", evidenceCount: 3, reportedAt: Date.now() - 300_000, waitingFor: { who: "checker" as const, name: "Vex III" } };
function mount(items: Room["review"]["items"] = [item]) {
  const slot = renderSlot({ component: () => <ReviewQueue review={{ waiting: items.length, budget: 5, items }} /> }, {}, { pluginId: "tavern", experimental_panel: { openTab: () => true } });
  slots.push(slot); return slot;
}
it("opens a single review with context and the right actions", () => {
  const slot = mount();
  expect(slot.getByText("1 waiting of 5")).toBeTruthy();
  expect(slot.getByText(/Check the environment · Juno II/)).toBeTruthy();
  expect(slot.getByText("Environment rules")).toBeTruthy();
  expect(slot.getByText(/Vex III checking/)).toBeTruthy();
  expect(slot.getByText("The complete report headline with context")).toBeTruthy();
  expect(slot.getByText("The sandbox checks pass")).toBeTruthy();
  expect(slot.getByText("3 pieces of evidence")).toBeTruthy();
  expect(slot.container.querySelector("time")).not.toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Open report" }));
  expect(slot.inspection.experimental_panelCalls).toContainEqual(expect.objectContaining({ method: "openTab", options: expect.objectContaining({ params: { questId: "environment", memberThreadId: "maker", reportId: "review-context" } }) }));
  fireEvent.click(slot.getByRole("button", { name: /Open quest/ }));
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toPluginPanel", path: "tavern", options: { subPath: "quest/environment" } }));
  expect(slot.getByRole("link", { name: /Open review/ }).getAttribute("href")).toBe(item.url);
});
it("remembers a row's closed choice after a remount", () => {
  const first = mount([{ ...item, reportId: "remember-fold" }]);
  fireEvent.click(first.getByRole("button", { name: /Review Check the environment/ }));
  expect(first.queryByText(item.headline)).toBeNull();
  first.lifecycle.unmount(); slots.pop();
  const second = mount([{ ...item, reportId: "remember-fold" }]);
  expect(second.getByRole("button", { name: /Review Check the environment/ }).getAttribute("aria-expanded")).toBe("false");
  expect(second.queryByText(item.headline)).toBeNull();
});
it("starts multiple items folded and expands each in place", () => {
  const slot = mount([{ ...item, reportId: "multiple-a" }, { ...item, reportId: "multiple-b", waypoint: { ...item.waypoint, title: "Check the limits" } }]);
  expect(slot.queryByText(item.headline)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Review Check the limits/ }));
  expect(slot.getByText(item.headline)).toBeTruthy();
});
it.each([true, false])("shows an assigned checker working=%s", working => {
  const slot = mount([{ ...item, reportId: `assigned-${working}`, waitingFor: { who: "checker", name: "Vex III", working } }]);
  expect(slot.getByText(working ? "Waiting for Vex III checking" : "Waiting for Vex III (assigned, not working)")).toBeTruthy();
});
it.each(["you", "keeper"] as const)("shows the neutral waiting label for %s", who => {
  const slot = mount([{ ...item, reportId: `gate-${who}`, waitingFor: { who } }]);
  expect(slot.getByText(who === "you" ? "Waiting for you" : "No checker working")).toBeTruthy();
});
it("marks a clipped headline and keeps the full report action", () => {
  const slot = mount([{ ...item, reportId: "clipped-headline", headlineTruncated: true }]);
  expect(slot.getByText(item.headline + "…")).toBeTruthy();
  expect(slot.getByText("Read the rest in Open report.")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Open report" })).toBeTruthy();
});
it("renders older review items without optional context", () => {
  const slot = renderSlot({ component: () => <ReviewQueue review={{ waiting: 1, budget: 1, items: [{ title: "Legacy outcome", url: null, boardQuestId: "legacy" }] }} /> }, {}, { pluginId: "tavern" });
  slots.push(slot);
  expect(slot.getByText("Legacy outcome")).toBeTruthy();
  expect(slot.getByRole("button", { name: /Open quest/ })).toBeTruthy();
  expect(slot.getByRole("status").textContent).toContain("At the review budget");
});
