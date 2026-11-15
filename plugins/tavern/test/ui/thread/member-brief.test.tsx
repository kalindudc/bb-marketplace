// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { clearThreadState } from "../../../src/ui/thread/state";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { threadDecorSchema } from "../../../src/shared/contract";
import { briefSchema, type Brief } from "../../../src/shared/schema";

const brief = briefSchema.parse({ outcome: "Repair `parseDuration`\nKeep the API stable.", mode: "make-it-work", doneWhen: "The focused tests pass.", context: ["Read `src/parser.ts`.", "Keep **literal markdown**."], outOfScope: "No production deploy." });
afterEach(() => { cleanup(); clearThreadState(); });
async function panel(classId: string, fields: Brief) {
  const registry = { ...fixtureRegistry, classes: [{ ...fixtureRegistry.classes[0]!, id: classId, label: classId }] };
  const decor = threadDecorSchema.parse({ ...fixtureDecor, member: { ...fixtureDecor.member!, role: "member", classId }, keeperView: null, scope: { threadId: "keeper-1", scope: null, error: null, armed: false, pendingAskId: null, mode: "off" }, brief: JSON.stringify(fields, null, 2), briefFields: fields });
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => registry } });
  fireEvent.click(await slot.findByRole("button", { name: /Member: show/ }));
  return slot;
}
it("renders a legacy-server brief as content with line breaks", async () => {
  const legacy = "Repair the parser.\nTests must pass.";
  const decor = { ...fixtureDecor, member: { ...fixtureDecor.member!, role: "member" as const }, keeperView: null, brief: legacy };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  fireEvent.click(await slot.findByRole("button", { name: /Member: show/ }));
  expect(slot.container.querySelector(".tw-brief-fields p[data-content]")?.textContent).toBe(legacy);
  expect(slot.container.querySelector("pre")).toBeNull();
  slot.lifecycle.unmount();
});
it("renders a Smith brief as ordered readable sections, inline code and the existing messaging note", async () => {
  const slot = await panel("smith", brief);
  expect(slot.getAllByRole("heading", { level: 4 }).map(h => h.textContent)).toEqual(["Outcome", "Done when", "Context", "Out of scope", "Scope details"]);
  expect(slot.getByText("Make it work")).toBeTruthy();
  expect(slot.container.querySelector(".tw-brief-outcome code")?.textContent).toBe("parseDuration");
  expect(slot.container.querySelector(".tw-brief-outcome")?.textContent).toContain("\nKeep the API stable.");
  expect(slot.getByText("Keep **literal markdown**.")).toBeTruthy();
  expect(slot.container.querySelectorAll("[data-content]").length).toBeGreaterThanOrEqual(5);
  expect(slot.container.querySelector("pre")).toBeNull();
  expect(slot.container.textContent).not.toContain('"outcome":');
  expect(slot.getByText(/Messages you send here reach this member now/)).toBeTruthy();
  slot.lifecycle.unmount();
});
it("renders Ranger questions as a numbered list with a time box before context", async () => {
  const slot = await panel("ranger", { ...brief, mode: "make-it-better", questions: ["What exists?", "What is missing?"], timeboxMinutes: 6 });
  expect(slot.getAllByRole("heading", { level: 4 }).map(h => h.textContent)).toEqual(["Outcome", "Done when", "Questions · 6 min", "Context", "Out of scope", "Scope details"]);
  expect(slot.getByText("Make it better")).toBeTruthy();
  expect(slot.container.querySelectorAll("ol li")).toHaveLength(2);
  slot.lifecycle.unmount();
});
it("omits empty sections and keeps questions Ranger-only", async () => {
  const slot = await panel("smith", { ...brief, context: ["", "  "], outOfScope: "", questions: ["Not a Smith question"], timeboxMinutes: 6 });
  expect(slot.getAllByRole("heading", { level: 4 }).map(h => h.textContent)).toEqual(["Outcome", "Done when", "Scope details"]);
  slot.lifecycle.unmount();
});
it("constrains narrow layout with wrapping prose, paths and headings, using theme tokens and the existing scroll panel", () => {
  const css = readFileSync("src/ui/thread/member-brief.css", "utf8");
  expect(css).toMatch(/:is\(p, li\)[^}]*white-space: pre-wrap; overflow-wrap: anywhere/);
  expect(css).toMatch(/code[^}]*white-space: pre-wrap; overflow-wrap: anywhere/);
  expect(css).toMatch(/header[^}]*flex-wrap: wrap/);
  expect(css).toContain("min-width: 0");
  expect(css).toContain("var(--foreground)");
  expect(css).toContain("var(--tavern-muted)");
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  const panelCss = readFileSync("src/ui/kit/components.css", "utf8");
  expect(panelCss).toMatch(/\.tw-panel[^}]*max-height:[^;]+; overflow: auto/);
});
it.each([390, 760])("preserves the complete long-path markup at a %i px widget width", async width => {
  const path = `/tmp/${"very-long-segment/".repeat(20)}result.txt`;
  const slot = await panel("smith", { ...brief, outcome: `Read \`${path}\`` });
  slot.container.style.width = `${width}px`;
  expect(slot.container.querySelector(".tw-brief-outcome code")?.textContent).toBe(path);
  expect(slot.container.querySelector(".tw-brief-fields")).not.toBeNull();
  slot.lifecycle.unmount();
});
