// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDetail, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { QuestMap } from "../../../src/ui/kit";

afterEach(cleanup);
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));

async function card(detail = fixtureDetail) {
  await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const slot = renderSlot({ component: () => <QuestMapCard detail={detail} version={1} /> } as never, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry, answerAsk: () => ({ ok: true }) } });
  fireEvent.click(slot.getByRole("button", { name: "Quest map" }));
  await waitFor(() => expect(slot.getByRole("region", { name: /^Drawn quest map:/ })).toBeTruthy());
  return slot;
}

describe("the quest map's readability", () => {
  it("stretches the plan map across the greenlight card, and leaves the live map alone", async () => {
    const plan = await card();
    expect(plan.getByRole("region", { name: /^Drawn quest map:/ }).classList.contains("stretch")).toBe(true);
    plan.lifecycle.unmount();
    const sealed = { ...fixtureDetail, quest: { ...fixtureDetail.quest, greenlitVersion: 1 } };
    const live = await card(sealed);
    expect(live.getByRole("region", { name: /^Drawn quest map:/ }).classList.contains("stretch")).toBe(false);
    live.lifecycle.unmount();
  });

  it("names the current journal state in the plan card's waypoint list", async () => {
    const detail = structuredClone(fixtureDetail);
    detail.quest.waypoints[0]!.state = "reported";
    Object.assign(detail.quest.waypoints[1]!, { state: "accepted", acceptedBy: "Fern", resolutionReason: "The notes match" });
    const plan = await card(detail);
    try {
      const drawn = within(plan.getByRole("region", { name: /^Drawn quest map:/ }));
      expect(drawn.getByText("Waiting for a check")).toBeTruthy();
      expect(drawn.getByText("Done")).toBeTruthy();
      expect(drawn.getByText("Accepted by Fern; no Warden check")).toBeTruthy();
      expect(drawn.getByText("The notes match")).toBeTruthy();
    } finally { plan.lifecycle.unmount(); }
  });

  it("uses one card tab stop and moves card focus in reading order with the arrow keys", () => {
    const slot = renderSlot({ component: () => <QuestMap quest={fixtureDetail.quest} mode="live" /> }, {}, { rpc: { registry: () => fixtureRegistry } });
    const cards = slot.getAllByRole("listitem");
    expect(cards.map(card => card.tabIndex)).toEqual([0, -1]);
    cards[0]!.focus();
    fireEvent.keyDown(cards[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cards[1]);
    expect(cards.map(card => card.tabIndex)).toEqual([-1, 0]);
    fireEvent.keyDown(cards[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[0]);
  });

  it("keeps status chips, a crest rail and one metadata line in the compact route", () => {
    const [first, second] = fixtureDetail.quest.waypoints;
    const quest = { ...fixtureDetail.quest, waypoints: [{ ...first!, state: "doing" as const }, { ...second!, askId: "yes" }] };
    const slot = renderSlot({ component: () => <QuestMap quest={quest} mode="live" showChecks rowsOnly /> }, {}, { rpc: { registry: () => fixtureRegistry } });
    const [working, yourMove] = slot.getAllByRole("listitem");
    expect(working!.classList.contains("cur")).toBe(true);
    expect(within(working!).getByText("Doing").classList.contains("status-doing")).toBe(true);
    expect(within(working!).getByText("Warden check").parentElement?.textContent).toContain("25m");
    expect(yourMove!.classList.contains("your-move")).toBe(true);
  });

  it("shows every full title and puts the named ask action inside its step", () => {
    const onOpenAsk = vi.fn();
    const title = "Replace the old route without losing the record of the checks, the names of the reviewers, or the answers to earlier asks";
    const waypoints = Array.from({ length: 11 }, (_, i) => ({
      ...fixtureDetail.quest.waypoints[0]!, id: `w${i + 1}`, dependsOn: [], title: `${i + 1}. ${title}`, askId: i === 10 ? "ask-last" : undefined,
    }));
    const slot = renderSlot({ component: () => <QuestMap quest={{ ...fixtureDetail.quest, waypoints }} mode="live" onOpenAsk={onOpenAsk} /> }, {}, { rpc: { registry: () => fixtureRegistry } });
    const list = within(slot.getByRole("list", { name: "Waypoints in order" }));
    expect(list.getAllByRole("listitem")).toHaveLength(11);
    expect(list.queryByRole("button", { name: /more waypoints|fold after/i })).toBeNull();
    const last = list.getByText(`11. ${title}`).closest("li")!;
    expect(last.querySelector("foreignObject")).toBeNull();
    fireEvent.click(within(last).getByRole("button", { name: `Answer ask: 11. ${title}` }));
    expect(onOpenAsk).toHaveBeenCalledWith("ask-last");
  });
});
