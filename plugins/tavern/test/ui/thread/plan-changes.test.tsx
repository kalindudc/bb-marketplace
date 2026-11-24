import { act, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
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
    const fold = slot.getByRole("button", { name: "Quest map" });
    const route = within(slot.getByRole("region", { name: "Route in order" }));
    expect(within(route.getByRole("list", { name: "Waypoints in order" })).getAllByRole("listitem")).toHaveLength(11);
    expect(route.queryByText("planned")).toBeNull();
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector(".qsvg")).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(slot.container.querySelectorAll(".qsvg .wp")).toHaveLength(11);
    fireEvent.click(fold);
    expect(slot.container.querySelector(".qsvg")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

it("compares a historical card to its own preceding version and starts v1 with the map closed", () => {
  const detail = planDetail(bigPlan, [bigPlan, firstPlan, smallPlan]);
  const historic = renderPlan(detail, "card", 2);
  try {
    expect(within(historic.getByRole("region", { name: "Changed since v1" })).getByText(smallPlan.changeNote!)).toBeTruthy();
    expect(historic.queryByText(bigPlan.changeNote!)).toBeNull();
  } finally { historic.lifecycle.unmount(); }
  const original = renderPlan(detail, "card", 1);
  try {
    expect(original.queryByRole("region", { name: /Changed since/ })).toBeNull();
    expect(original.getByRole("button", { name: "Quest map" }).getAttribute("aria-expanded")).toBe("false");
    expect(original.container.querySelector(".qsvg")).toBeNull();
    expect(original.getByText("This plan was superseded; it cannot be greenlit here.")).toBeTruthy();
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
      "Party: Smith on waypoint 1, 2, 3, 4, 5, 6, 7, 8 → 1, 2, 4",
      "Order: Waypoints reordered",
    ]);
  } finally { slot.lifecycle.unmount(); }
});

it("shows the Spread's goal, criteria, exact commands and everything that comes back to you", () => {
  const plan = { ...firstPlan, goal: "Restore the lamp. Keep its brass housing.",
    doneWhen: "The lamp burns steadily. Run \`npm --prefix tools/lamp test\`. No live install or release.",
    findings: ["The lamp needs fuel."], assumptions: ["The watch has spare fuel."],
    waypoints: firstPlan.waypoints.map(w => w.id === "w2" ? { ...w, actor: "user" as const, check: "you" as const, dependsOn: ["w1"] } : w),
    questions: [{ id: "q1", text: "Use the spare fuel?", options: ["Yes", "No"], recommended: 0, reversible: true }],
  };
  const slot = renderPlan(planDetail(plan, [plan]), "card");
  try {
    expect(slot.getByText("Restore the lamp.").tagName).toBe("B");
    expect(slot.getByText("Keep its brass housing.").closest("b")).toBeNull();
    const done = within(slot.getByRole("region", { name: "Done when" }));
    expect(done.getByText("The lamp burns steadily.").closest(".lg-clamp")).toBeNull();
    expect(done.getByText("Never")).toBeTruthy();
    expect(done.getByTitle("No live install or release.").textContent).toContain("live install · release");
    expect(done.getByText("test").tagName).toBe("CODE");
    expect(done.queryByText("npm --prefix tools/lamp test")).toBeNull();
    fireEvent.click(done.getByRole("button", { name: "Exact commands" }));
    expect(done.getByText("npm --prefix tools/lamp test").closest("pre")).toBeTruthy();
    const back = within(slot.getByRole("region", { name: "Comes back to you" }));
    expect(back.getByText("Use the spare fuel?")).toBeTruthy();
    expect(back.getByText("Waypoint 2")).toBeTruthy();
    expect(back.getByText("One review")).toBeTruthy();
    expect(back.getByText("Production steps and anything sent as you still ask you.")).toBeTruthy();
    expect(slot.queryByText("The lamp needs fuel.")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /findings and assumptions/ }));
    expect(slot.getByText("The lamp needs fuel.")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Redirect in chat" })).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it("only gives the drawn map a tab stop and a scroll cue when it needs them", () => {
  let update!: (entries: { contentRect: { width: number } }[]) => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: typeof update) {}
    observe(el: HTMLElement) { if (el.classList.contains("drawn")) update = this.callback; }
    disconnect() {}
  });
  const plan = { ...firstPlan, waypoints: firstPlan.waypoints.map(w => w.id === "w2" ? { ...w, dependsOn: ["w1"] } : w.id === "w3" ? { ...w, dependsOn: ["w2"] } : w) };
  const slot = renderPlan(planDetail(plan, [plan]), "card");
  try {
    fireEvent.click(slot.getByRole("button", { name: "Quest map" }));
    const route = slot.getByRole("region", { name: "Route in order" });
    const map = slot.getByRole("region", { name: "Drawn quest map: Harbor signal lamp" });
    expect(within(route).getByRole("list", { name: "Waypoints in order" })).toBeTruthy();
    act(() => update([{ contentRect: { width: 730 } }]));
    expect(map.hasAttribute("tabindex")).toBe(false);
    expect(slot.queryByText("Scroll sideways to see the full map")).toBeNull();
    act(() => update([{ contentRect: { width: 340 } }]));
    expect(map.tabIndex).toBe(0);
    expect(slot.getByText("Scroll sideways to see the full map")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); vi.unstubAllGlobals(); }
});

it("shows only edited sentences, and spells out a reassignment and added question", () => {
  const before = { ...firstPlan, party: [{ ...firstPlan.party[0]!, classId: "warden", waypointIds: ["w2"] }],
    waypoints: firstPlan.waypoints.map(w => w.id === "w2" ? { ...w, doneWhen: "Light the lamp. Check the old glass. Record the watch." } : w),
  };
  const after = { ...before, version: 2, party: [{ ...before.party[0]!, waypointIds: ["w1", "w2"] }],
    waypoints: before.waypoints.map(w => w.id === "w2" ? { ...w, doneWhen: "Light the lamp. Check the new glass. Record the watch." } : w),
    questions: [{ id: "q1", text: "Check after dark?", options: ["Yes", "No"], recommended: 0, reversible: true }],
  };
  const slot = renderPlan(planDetail(after, [before, after]), "card");
  try {
    const changes = within(slot.getByRole("region", { name: "Changed since v1" }));
    expect(changes.getByText("Check the old glass.").tagName).toBe("DEL");
    expect(changes.getByText("Check the new glass.").tagName).toBe("INS");
    expect(changes.getByText("(2 other sentences unchanged)")).toBeTruthy();
    expect(changes.queryByText("Light the lamp.")).toBeNull();
    expect(changes.getByRole("list").textContent).toContain("Warden on waypoint 2 → 1, 2");
    expect(changes.getByText("+1 for you")).toBeTruthy();
    expect(changes.queryByRole("button")).toBeNull();
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
