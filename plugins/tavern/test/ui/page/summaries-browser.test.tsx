import { fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { it } from "vitest";
import type { Attention } from "../../../src/shared/attention";
import type { SummaryView } from "../../../src/shared/schema";
import { QuestPage } from "../../../src/ui/page/quest";
import { DirectiveCard } from "../../../src/ui/thread/cards";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor } from "../../../src/ui/thread/fixtures";
import { min, registry, richDetails, richRoom } from "./scenes";

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the summaries and collapsed widget with real fixtures", async () => {
  const outcome = "The watch covered the west cluster for two complete shifts. **No incidents met the escalation rule.** The second shift checked the handoff against the original timestamps before closing the log.";
  const evidence = " Coverage note: the east cluster was outside the watch. The evidence records the query window, exclusions, timestamps, and handoff checks so the next shift can reproduce the result.";
  const body = (outcome + ("\n\n" + evidence.trim()).repeat(30)).slice(0, 4000);
  const current: SummaryView = {
    id: "watch-result", boardQuestId: "vault", keeperThreadId: "thr-wren", title: "Watch ended: no incidents in 48 hours",
    body,
    results: { figures: [{ value: "0", label: "Incidents" }, { value: "48 h", label: "Watched" }] },
    links: [{ kind: "url", ref: "https://example.com/watch/shift-handoff/cross-check?window=48-hours&cluster=west", detail: "The watch query and the coverage note.", exitCode: null }],
    next: ["Use the same search for the next west-cluster watch."],
    createdAt: min(8), seen: false, correctedBy: null,
  };
  const correction: SummaryView = { ...current, id: "watch-correction", title: "Correction: west cluster only", body: "The first note wrongly included the east cluster.", createdAt: min(40), seen: true, links: [], next: [], results: undefined, supersedes: "watch-original" };
  const original: SummaryView = { ...correction, id: "watch-original", title: "Initial scope included both clusters", supersedes: undefined, correctedBy: correction.id, createdAt: min(60) };
  const attention: Attention = { items: [{ id: current.id, title: current.title, kind: "summary", since: current.createdAt, questId: "vault", keeperThreadId: "thr-wren", action: "Open", seen: false }], summaries: 1, new: 1, needYou: 0, heldByYou: 0 };
  const seen = { ...correction, id: "watch-start", title: "West-cluster watch started", body: "The alert query was recorded before the watch began.", supersedes: undefined };
  const titles = Array.from({ length: 26 }, (_, index) => ({ id: `watch-notes-${index}`, title: `Confirmed coverage for shift ${26 - index}`, boardQuestId: "vault", keeperThreadId: "thr-wren", createdAt: min(120 + index * 30), seen: true, correctedBy: null }));
  const detail = { ...richDetails.vault!, summaries: [current, { ...correction, previousTitle: original.title }, seen, ...titles.slice(0, 9)], summaryCounts: { current: 3 + titles.length, corrected: 1 }, summariesNextCursor: titles[8]!.id, attention, quest: { ...richDetails.vault!.quest, attention, short: "Edge watch" } };
  const rpc = { registry: () => registry, markSummariesSeen: () => ({ ok: true }), decor: () => ({ ...fixtureDecor, characters: false, keeperView: { ...fixtureDecor.keeperView!, attention, boardQuests: [detail.quest, richDetails.audit!.quest] } }), summary: () => ({ summary: { ...current, body: outcome + "\n\n" + evidence.trim() }, ask: null, handBack: null }) };
  const quest = renderSlot({ component: QuestPage }, { detail, registry, room: richRoom }, { rpc });
  const questHtml = (await quest.findByRole("region", { name: "Summaries" })).outerHTML;
  const chat = renderSlot({ component: DirectiveCard }, { kind: "tavern-summary", attributes: { id: current.id }, source: "summary", message: { id: "msg", threadId: "thr-wren", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc });
  await within(chat.container).findByRole("button", { name: "OK" });
  const widget = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc });
  fireEvent.click(await within(widget.container).findByRole("button", { name: "Show 2 quests" }));
  await within(widget.container).findByText("1 new summary");
  process.stdout.write("SB2_SUMMARIES=" + JSON.stringify({ quest: questHtml, chat: chat.container.innerHTML, widget: widget.container.innerHTML }) + "\n");
  quest.lifecycle.unmount(); chat.lifecycle.unmount(); widget.lifecycle.unmount();
});
