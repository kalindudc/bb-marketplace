import { fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { rpcContract, type BoardQuestDetail } from "../../../src/shared/contract";
import { QuestPage } from "../../../src/ui/page/quest";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { bigPlan, firstPlan, planDetail, smallPlan } from "../fixtures/plan-changes";

function renderPlan(detail: BoardQuestDetail, view: "card" | "page", version: number | null = null) {
  return renderSlot({ component: () => view === "card"
    ? <QuestMapCard detail={detail} version={version} />
    : <QuestPage detail={detail} registry={fixtureRegistry} />
  }, {}, {
    pluginId: "tavern", experimental_rpcContract: rpcContract,
    composer: { scope: { kind: "thread", threadId: detail.quest.keeperThreadId! } },
    rpc: { registry: () => fixtureRegistry, answerAsk: () => ({ ok: true }) },
  });
}

it.each(["card", "page"] as const)("shows the note and only the done-when change without a steer on the %s", view => {
  const slot = renderPlan(planDetail(smallPlan, [smallPlan, firstPlan]), view);
  try {
    const changes = within(slot.getByRole("region", { name: "Changed since v1" }));
    expect(changes.getByText(smallPlan.changeNote!)).toBeTruthy();
    expect(changes.getAllByRole("listitem").map(item => item.textContent)).toEqual([
      "Clean the lens · done when: No streaks → No streaks under a second lamp",
    ]);
    expect(changes.getByText("No streaks").tagName).toBe("DEL");
  } finally { slot.lifecycle.unmount(); }
});

it("lists added steps and the party change with the full map folded and approval still reachable", () => {
  const slot = renderPlan(planDetail(bigPlan, [bigPlan, firstPlan, smallPlan]), "card");
  try {
    const changes = within(slot.getByRole("region", { name: "Changed since v2" }));
    expect(changes.getAllByRole("listitem").map(item => item.textContent)).toEqual([
      "Added: Inspect the storm glass",
      "Added: Seal the lamp housing",
      "Added: Repeat the signal at low tide",
      "Party: Warden 0 to 1",
    ]);
    expect(slot.getByRole("button", { name: "Form the party (greenlight)" })).toBeTruthy();
    const mapName = "Quest map: Harbor signal lamp";
    const fold = slot.getByRole("button", { name: "Show full map (11 waypoints)" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("region", { name: mapName })).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    const map = within(slot.getByRole("region", { name: mapName }));
    expect(within(map.getByRole("list", { name: "Waypoints in order" })).getAllByRole("listitem")).toHaveLength(11);
  } finally { slot.lifecycle.unmount(); }
});

it("compares a historical card to its own preceding version and leaves v1 open", () => {
  const detail = planDetail(bigPlan, [bigPlan, firstPlan, smallPlan]);
  const historic = renderPlan(detail, "card", 2);
  try {
    expect(within(historic.getByRole("region", { name: "Changed since v1" })).getByText(smallPlan.changeNote!)).toBeTruthy();
    expect(historic.queryByText(bigPlan.changeNote!)).toBeNull();
  } finally { historic.lifecycle.unmount(); }
  const original = renderPlan(detail, "card", 1);
  try {
    expect(original.queryByRole("region", { name: /Changed since/ })).toBeNull();
    expect(original.getByRole("region", { name: "Quest map: Harbor signal lamp" })).toBeTruthy();
  } finally { original.lifecycle.unmount(); }
});

it("reports removals, field updates and relative order without treating additions as a reorder", () => {
  const [inspect, clean, , shutter, ...rest] = smallPlan.waypoints;
  const revised = {
    ...bigPlan, changeNote: null,
    party: [{ ...smallPlan.party[0]!, waypointIds: ["w1", "w2", "w4"] }],
    waypoints: [clean!, { ...inspect!, title: "Inspect the brass lamp", owner: "warden", check: "warden" as const }, shutter!, ...rest],
  };
  const slot = renderPlan(planDetail(revised, [smallPlan, revised]), "page");
  try {
    const changes = within(slot.getByRole("region", { name: "Changed since v2" }));
    expect(changes.getAllByRole("listitem").map(item => item.textContent)).toEqual([
      "Removed: Replace the wick",
      "Title: Inspect the lamp → Inspect the brass lamp; owner: Smith → Warden; check: Keeper accepts → Warden check",
      "Party: Smith slots updated",
      "Order: Waypoints reordered",
    ]);
  } finally { slot.lifecycle.unmount(); }
});

it("reports a party-only reorder", () => {
  const reordered = { ...bigPlan, version: 4, changeNote: null, party: [...bigPlan.party].reverse() };
  const slot = renderPlan(planDetail(reordered, [reordered, bigPlan]), "card");
  try {
    const changes = within(slot.getByRole("region", { name: "Changed since v3" }));
    expect(changes.getAllByRole("listitem").map(item => item.textContent)).toEqual(["Order: Party slots reordered"]);
  } finally { slot.lifecycle.unmount(); }
});

it("shows the note without inventing a comparison when history is missing", () => {
  const slot = renderPlan(planDetail(bigPlan, [firstPlan, bigPlan]), "card");
  try {
    expect(within(slot.getByRole("region", { name: "Plan update" })).getByText(bigPlan.changeNote!)).toBeTruthy();
    expect(slot.queryByRole("region", { name: /Changed since/ })).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});
