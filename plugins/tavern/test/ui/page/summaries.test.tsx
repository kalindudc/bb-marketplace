import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { definePluginApp, Markdown } from "@get-bb/plugin-sdk/app";
import type { ComponentProps } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import type { Attention } from "../../../src/shared/attention";
import type { SummaryView } from "../../../src/shared/schema";
import { TavernPage } from "../../../src/ui/page/register";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { richDetails, richRoom, registry, min } from "./scenes";

const markdown = vi.hoisted(() => vi.fn());
vi.mock(import("@get-bb/plugin-sdk/app"), async importOriginal => {
  const original = await importOriginal();
  return { ...original, Markdown: (props: ComponentProps<typeof Markdown>) => {
    markdown(props);
    return <original.Markdown {...props} />;
  } };
});
afterEach(() => { cleanup(); markdown.mockClear(); });

const base: SummaryView = {
  id: "summary-original", title: "Watch covered both clusters", body: "The first log included two clusters.",
  createdAt: min(90), boardQuestId: "vault", keeperThreadId: "thr-wren", links: [], seen: true, correctedBy: "summary-correction",
};
const correction: SummaryView = { ...base, id: "summary-correction", createdAt: min(40), title: "Correction: watch covered one cluster", body: "Only the west cluster was in scope.", correctedBy: null, supersedes: base.id };
const current: SummaryView = {
  ...base, id: "summary-current", createdAt: min(8), title: "Watch ended with no alerts", body: "No actionable alerts in two shifts.",
  seen: false, correctedBy: null, results: { figures: [{ label: "Hours watched", value: "48 h" }] },
  links: [{ kind: "url", ref: "https://example.com/watch", detail: "Search over both shifts", exitCode: null }],
  next: ["Send the watch record to the next shift."],
};
const count: Attention = { items: [{ id: current.id, kind: "summary", title: current.title, questId: current.boardQuestId, keeperThreadId: current.keeperThreadId, action: "Open", since: current.createdAt, seen: false }], needYou: 0, new: 1, summaries: 1, heldByYou: 0 };
const summaries = [current, correction, base];
const documentContext = { threadId: "thr-wren", rootPath: "/keeper/work", target: { kind: "workspace" as const, environmentId: "keeper-env", path: "/keeper/work" } };
const detail = { ...richDetails.vault!, summaries, attention: count, summaryDocument: documentContext, summaryCounts: { current: 2, corrected: 1 } };
const page = (kind: "quest" | "tale" = "quest", markSummariesSeen = vi.fn(() => ({ ok: true as const }))) => renderSlot({ component: TavernPage }, { subPath: `${kind}/vault` }, {
  pluginId: "tavern", rpc: { registry: () => registry, room: () => richRoom, boardQuest: () => kind === "quest" ? detail : { ...detail, quest: { ...detail.quest, phase: "done", endedAt: min(1) } }, markSummariesSeen },
});

it("shows newest first, keeps the new mark until leaving, and folds the original under its correction", async () => {
  const mark = vi.fn(() => ({ ok: true as const }));
  const slot = page("quest", mark);
  const section = await slot.findByRole("region", { name: "Summaries" });
  const titles = [...section.querySelectorAll("article h3")].map(h => h.textContent);
  expect(titles).toEqual([current.title, correction.title]);
  expect(within(section).getByText("2 summaries, 1 corrected")).toBeTruthy();
  expect(within(section).getByText("new", { exact: true }).closest("article")?.textContent).toContain(current.title);
  const folded = within(section).getByText(base.title, { selector: "summary span" }).closest("details");
  expect(folded?.open).toBe(false);
  expect(folded?.parentElement?.closest("li")?.textContent).toContain(correction.title);
  expect(mark).not.toHaveBeenCalled();

  slot.lifecycle.unmount();
  await waitFor(() => expect(mark).toHaveBeenCalledWith({ boardQuestId: "vault", ids: [current.id] }));
});

it("renders the stored title, Markdown and figures on both the registered chat directive and the quest page", async () => {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const directive = app.messageDirectives.find(d => d.id === "tavern-summary")!;
  expect(directive).toBeDefined();
  const chat = renderSlot(directive, { attributes: { id: current.id }, source: "summary", message: { id: "m1", threadId: "thr-wren", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: { summary: () => ({ summary: current, ask: null, handBack: null }) } });
  const quest = page();
  for (const slot of [chat, quest]) {
    const heading = await within(slot.container).findByText(current.title, { selector: "h3" });
    const card = within(heading.closest("article")!);
    expect(card.getByText(current.body)).toBeTruthy();
    expect(card.getByText("48 h")).toBeTruthy();
    expect(card.getByRole("link", { name: "https://example.com/watch" })).toBeTruthy();
  }
  expect(markdown).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(current.body), experimental_document: documentContext }));
  fireEvent.click(chat.getByRole("button", { name: "Open on the quest page" }));
  expect(chat.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "quest/vault/summary/summary-current" } });
});

it("keeps the Keeper's return headline and lists the summaries oldest first Along the way", async () => {
  const slot = page("tale");
  const section = await slot.findByRole("region", { name: "Along the way" });
  expect(within(section).getAllByRole("heading", { level: 3 }).map(h => h.textContent)).toEqual([correction.title, current.title]);
  expect(within(section).getByText(base.title).closest("details")?.open).toBe(false);
});

it.each(["pagehide", "visibilitychange"])("marks displayed unread IDs on %s, without acknowledging on mount", async event => {
  const seen = vi.fn(() => ({ ok: true as const }));
  const slot = page("quest", seen);
  await slot.findByRole("region", { name: "Summaries" });
  expect(seen).not.toHaveBeenCalled();
  if (event === "pagehide") window.dispatchEvent(new Event(event));
  else {
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event(event));
    hidden.mockRestore();
  }
  await waitFor(() => expect(seen).toHaveBeenCalledWith({ boardQuestId: "vault", ids: [current.id] }));
  slot.lifecycle.unmount();
  expect(seen).toHaveBeenCalledTimes(1);
});

it("lets the chat reader acknowledge only this summary", async () => {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const directive = app.messageDirectives.find(d => d.id === "tavern-summary")!;
  const markSummariesSeen = vi.fn(() => ({ ok: true as const }));
  const slot = renderSlot(directive, { attributes: { id: current.id }, source: "summary", message: { id: "m1", threadId: "thr-wren", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: { summary: () => ({ summary: current, ask: null, handBack: null }), markSummariesSeen } });
  fireEvent.click(await slot.findByRole("button", { name: "OK" }));
  await waitFor(() => expect(markSummariesSeen).toHaveBeenCalledWith({ boardQuestId: "vault", ids: [current.id] }));
});

it("loads seen history as title rows and fetches older titles only when asked", async () => {
  const { body: _body, links: _links, ...title } = { ...base, id: "older-title", title: "An older summary", correctedBy: null };
  const olderSummaries = vi.fn(() => ({ summaries: [title], nextCursor: null }));
  const slot = renderSlot({ component: TavernPage }, { subPath: "quest/vault" }, { pluginId: "tavern", rpc: {
    registry: () => registry, room: () => richRoom, boardQuest: () => ({ ...detail, summaryCounts: { current: 3, corrected: 1 }, summariesNextCursor: correction.id }),
    olderSummaries, summary: () => ({ summary: { ...title, body: "Older words", links: [] }, ask: null, handBack: null }),
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Show 1 older" }));
  await waitFor(() => expect(olderSummaries).toHaveBeenCalledWith({ boardQuestId: "vault", beforeId: correction.id }));
  const open = await slot.findByText("An older summary");
  expect(slot.queryByText("Older words")).toBeNull();
  fireEvent.click(open.closest("summary")!);
  expect(await slot.findByText("Older words")).toBeTruthy();
});

it("uses the projected summary count on the quest chip and in its inline section", async () => {
  const quest = { ...fixtureDecor.keeperView!.boardQuests[0]!, attention: count };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { registry: () => fixtureRegistry, decor: () => ({ ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, attention: count, boardQuests: [quest] } }) } });
  const chip = await slot.findByRole("button", { name: `Show ${quest.title}` });
  expect(chip.title).toContain("1 new summary");
  expect(chip.textContent).toContain("1 new");
  fireEvent.click(chip);
  const popover = slot.getByRole("region", { name: "Board quests" });
  expect(within(popover).getByText("1 new summary")).toBeTruthy();
});
