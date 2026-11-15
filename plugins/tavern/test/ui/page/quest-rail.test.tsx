import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpcContract, type BoardQuestDetail } from "../../../src/shared/contract";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { railDetail } from "./quest-rail-fixture";
import * as scenes from "./scenes";

const slots: RenderedSlot[] = [];
beforeEach(() => { localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { slots.splice(0).forEach(s => s.lifecycle.unmount()); });
async function mount(detail = railDetail) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "quest/vault" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => scenes.registry, room: () => scenes.richRoom, boardQuest: () => detail, ledger: () => scenes.ledgerFor(scenes.richRoom, { vault: detail }, "thr-wren"), undoDecision: () => ({ ok: true }) } });
  slots.push(slot);
  await slot.findByRole("heading", { name: detail.quest.title });
  return slot;
}
it("shows the per-class scopes in the screenshot fixture without claiming a Wanderer is fully guarded", async () => {
  const slot = await mount();
  const party = slot.container.querySelector('[data-fold="quest.party"]')!;
  for (const words of ["scope: worktree · enforced", "scope: open · only protected files guarded", "scope: checker · enforced", "scope: readonly · enforced"]) expect(party.textContent).toContain(words);
});
it("caps only the History row text at 100ch, not its card", () => {
  const css = readFileSync("src/ui/page/page.css", "utf8");
  expect(css).toContain('.tv-quest [data-fold="quest.history"] .tv-ev-b { max-width: 100ch; }');
  expect(css).not.toContain('.tv-quest [data-fold="quest.history"] { max-width: 100ch; }');
});
it("caps newest decisions at three with Undo, folds rules with counts, and remembers both", async () => {
  const slot = await mount();
  const decided = slot.getByRole("region", { name: "Decided for you (reversible calls)" });
  expect(within(decided).getAllByRole("listitem")).toHaveLength(3);
  expect(within(decided).getAllByRole("button", { name: /^Undo:/ })).toHaveLength(3);
  fireEvent.click(within(decided).getByRole("button", { name: "Show all 11" }));
  expect(within(decided).getAllByRole("listitem")).toHaveLength(11);
  const ledger = slot.container.querySelector('[data-fold="quest.rules"]')!;
  expect(ledger.querySelector(".tv-cell")).toBeNull();
  expect(ledger.textContent).toContain("3 rules");
  fireEvent.click(within(ledger as HTMLElement).getByRole("button", { name: /rules and re-anchor/ }));
  expect(ledger.querySelector(".tv-cell")).not.toBeNull();
  slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
  const again = await mount();
  expect(within(again.getByRole("region", { name: "Decided for you (reversible calls)" })).getAllByRole("listitem")).toHaveLength(11);
  expect(again.container.querySelector('[data-fold="quest.rules"] .tv-cell')).not.toBeNull();
});
it("caps each note kind at the newest three and remembers Show all", async () => {
  const notes = Array.from({ length: 10 }, (_, i) => ({ ...railDetail.notes![i % 2]!, id: `n${i}`, text: `Note ${i}`, createdAt: scenes.min(i + 1), dueAt: i % 2 ? null : scenes.min(-i - 10) }));
  const detail = { ...railDetail, notes };
  const slot = await mount(detail);
  fireEvent.click(slot.getByRole("button", { name: /^Kept in mind/ }));
  const memory = slot.getByRole("region", { name: "Kept in mind" });
  expect(within(memory).getAllByRole("listitem")).toHaveLength(6);
  expect(within(memory).getAllByRole("listitem")[0]!.textContent).toContain("Note 0");
  fireEvent.click(within(memory).getAllByRole("button", { name: "Show all 5" })[0]!);
  expect(within(memory).getAllByRole("listitem")).toHaveLength(8);
  slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
  expect(within((await mount(detail)).getByRole("region", { name: "Kept in mind" })).getAllByRole("listitem")).toHaveLength(8);
});
it("summarises healthy guards and remembers Show each member", async () => {
  const slot = await mount();
  const guards = slot.getByRole("region", { name: /Guardrails/ });
  expect(guards.textContent).toContain("4 members · all enforced · 0 violations");
  expect(guards.querySelectorAll(".tv-guard")).toHaveLength(0);
  fireEvent.click(within(guards).getByRole("button", { name: "Show each member" }));
  expect(guards.querySelectorAll(".tv-guard")).toHaveLength(4);
  slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
  expect((await mount()).container.querySelectorAll(".tv-guard")).toHaveLength(4);
});
it.each(["unarmed", "watch", "off", "error", "violation", "pending"])("always lists a guard with %s even while folded", async kind => {
  const detail = structuredClone(railDetail);
  const sc = detail.scopes![0]!;
  if (kind === "unarmed") sc.armed = false;
  if (kind === "watch" || kind === "off") sc.mode = kind;
  if (kind === "error") sc.error = "Scope delivery failed";
  if (kind === "pending") sc.pendingAskId = "widen-1";
  if (kind === "violation") detail.violations = [{ threadId: sc.threadId, providerId: "pi", at: scenes.min(1), eventId: "v1", seq: 1, ruleId: "git.push", reason: "push is blocked", stopped: true, latencyMs: 1, mode: "enforce" }];
  const guards = (await mount(detail)).getByRole("region", { name: /Guardrails/ });
  expect(guards.querySelectorAll(".tv-guard")).toHaveLength(1);
  expect(guards.querySelector(".tv-guard")!.textContent).toContain("Juno");
});
it.each(["build", "done", "stopped"] as const)("keeps the same section order for %s, with phase-specific work and defaults", async phase => {
  const detail: BoardQuestDetail = { ...railDetail, quest: { ...railDetail.quest, phase, endedAt: phase === "build" ? null : scenes.min(1) } };
  const slot = await mount(detail);
  const grid = slot.container.querySelector(".tv-ggrid")!;
  expect([...grid.querySelectorAll("[data-fold]")].map(s => s.querySelector(".tv-rec-tt")!.textContent)).toEqual(["Reports and evidence", "History", "The party team", "Kept in mind", "Guardrails", "Decided for you", "Asks and answers", "The plan", "Wren’s rules and re-anchor"]);
  expect(slot.queryByRole("region", { name: "By whose move" }) !== null).toBe(phase === "build");
  expect(slot.queryByRole("region", { name: "Done and left" }) !== null).toBe(phase !== "build");
  expect(grid.querySelector('[data-fold="quest.party"] button')!.getAttribute("aria-expanded")).toBe(phase === "build" ? "true" : "false");
  expect(grid.querySelector('[data-fold="quest.history"] button')!.getAttribute("aria-expanded")).toBe("true");
  expect(grid.querySelector('[data-fold="quest.decisions"] button')!.getAttribute("aria-expanded")).toBe("true");
  expect(grid.querySelector('[data-fold="quest.asks"] button')!.getAttribute("aria-expanded")).toBe("false");
  expect(grid.querySelector('[data-fold="quest.plan"] button')!.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: "Stop quest" }) !== null).toBe(phase === "build");
  const decided = slot.getByRole("region", { name: "Decided for you (reversible calls)" });
  expect(within(decided).queryAllByRole("button", { name: /^Undo:/ }).length).toBe(phase === "build" ? 3 : 0);
});
it("shares remembered section folds between quests instead of starting a new set", async () => {
  const slot = await mount();
  fireEvent.click(slot.getByRole("button", { name: /^The plan/ }));
  slot.lifecycle.unmount(); slots.splice(slots.indexOf(slot), 1);
  const other = await mount({ ...railDetail, quest: { ...railDetail.quest, id: "another-quest" } });
  expect(other.getByRole("button", { name: /^The plan/ }).getAttribute("aria-expanded")).toBe("true");
});
it("uses a shared wide rail and one column below 1100 without moving the rail ahead of History", async () => {
  const css = readFileSync("src/ui/page/page.css", "utf8");
  expect(css).toMatch(/\.tv-quest \.tv-ggrid\s*\{[^}]*clamp\(340px, 30%, 460px\)/);
  expect(css).toMatch(/@container tavern-page \(max-width: 1100px\)\s*\{\s*\.tavern\.tv-page \.tv-quest \.tv-ggrid\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  const grid = (await mount()).container.querySelector(".tv-quest .tv-ggrid")!;
  expect(grid.children[0]!.textContent).toContain("History");
  expect(grid.children[1]!.getAttribute("aria-label")).toBe("Party and ledger");
});
