import { fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { rpcContract, type BoardQuestDetail } from "../../../src/shared/contract";
import type { Plan } from "../../../src/shared/schema";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { firstPlan, planDetail } from "../fixtures/plan-changes";

const party = firstPlan.party[0]!;
const [first, second, third, fourth, fifth] = firstPlan.waypoints;
const plan: Plan = {
  ...firstPlan, version: 2,
  goal: "Restore the signal lamp. Keep its brass housing.",
  doneWhen: "The lamp burns steadily. Run `npm test`. No live install or release.",
  waypoints: [
    { ...first!, doneWhen: "Install cron for the checks." },
    { ...second!, actor: "user", check: "you", owner: null, dependsOn: ["w1"] },
    { ...third!, actor: "outside", owner: "Harbor office", dependsOn: ["w4"], doneWhen: "Keep the office systemd unit in service." },
    { ...fourth!, doneWhen: "Store the launchd job." },
    { ...fifth!, owner: "ranger", check: "warden", dependsOn: ["w2", "w3"], doneWhen: "Check the automations every night." },
  ],
  party: [
    { ...party, purpose: "Lampwright: repair the lamp", waypointIds: ["w1", "w4"] },
    { ...party, purpose: "Night watcher: check the lights", classId: "ranger", waypointIds: ["w5"], permanent: { why: "The lights keep running" } },
    { ...party, purpose: "Inspect", classId: "warden", waypointIds: ["w4", "w5"] },
  ],
};
const detail = planDetail(plan, [plan]);

function render(detail: BoardQuestDetail, version: number | null = null) {
  return renderSlot({ component: () => <QuestMapCard detail={detail} version={version} /> } as never, {}, {
    pluginId: "tavern", experimental_rpcContract: rpcContract,
    composer: { scope: { kind: "thread", threadId: "keeper-1" } },
    rpc: { registry: () => fixtureRegistry, answerAsk: () => ({ ok: true }) },
  });
}

it("keeps Done when open and puts the five questions in one ordered set of disclosures", () => {
  const slot = render(detail);
  try {
    expect(slot.getByTitle("Harbor signal lamp").textContent).toBe("Signal lamp · plan v2");
    expect(within(slot.getByRole("region", { name: "Done when" })).getByText("The lamp burns steadily.")).toBeTruthy();
    const labels = [/^Who /, /^Order /, /^Checks /, /^To you /, /^Keeps running /];
    const rows = labels.map(name => slot.getByRole("button", { name }));
    expect(rows.map(row => row.getAttribute("aria-expanded"))).toEqual(Array(5).fill("false"));
    rows.forEach((row, i) => {
      if (i > 0) expect(rows[i - 1]!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.getElementById(row.getAttribute("aria-controls")!)?.hidden).toBe(true);
    });
    expect(rows[0]!.textContent).toContain("Lampwright");
    expect(rows[1]!.textContent).toMatch(/5 steps.*3 stages/);
    expect(rows[2]!.textContent).toMatch(/Warden 1.*Keeper 3.*You 1/);
    fireEvent.click(rows[2]!);
    const checkBody = within(document.getElementById(rows[2]!.getAttribute("aria-controls")!)!);
    expect(checkBody.getByText("checks 5")).toBeTruthy();
    expect(checkBody.queryByText("checks 4, 5")).toBeNull();
    expect(rows[4]!.textContent).toMatch(/Night watcher/);
    expect(rows[4]!.textContent).toMatch(/Harbor office.*1 step to check/);
    expect(slot.getByRole("button", { name: "Approve: Form the party (greenlight)" }).textContent).toContain("Approve");
    expect(slot.getByRole("button", { name: "Redirect in chat" }).textContent).toContain("Redirect");
    expect(slot.getByText("Approves the party and these checks.")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it("opens To you for questions, jumps to the real step, and flags only uncovered work", () => {
  const withQuestion = { ...plan, questions: [{ id: "q1", text: "Use the spare fuel?", options: ["Yes", "No"], recommended: 0, reversible: true }] };
  const slot = render(planDetail(withQuestion, [withQuestion]));
  try {
    expect(slot.getByRole("button", { name: /^To you / }).getAttribute("aria-expanded")).toBe("true");
    expect(slot.getByText("Use the spare fuel?")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Your move: waypoint 2" }));
    const route = within(slot.getByRole("region", { name: "Route in order" }));
    const move = route.getByRole("button", { name: /2 Clean the lens.*Your move/ });
    expect(document.activeElement).toBe(move);
    fireEvent.click(move);
    expect(move.getAttribute("aria-expanded")).toBe("true");
    expect(route.getByText("No streaks")).toBeTruthy();
    expect(route.getAllByRole("listitem", { name: /^Stage / }).map(row => row.getAttribute("aria-label"))).toEqual(["Stage 1, 2 can run at once", "Stage 2, 2 can run at once", "Stage 3"]);
    fireEvent.click(slot.getByRole("button", { name: /^Keeps running / }));
    expect(slot.queryByRole("button", { name: "Check waypoint 4" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Check waypoint 5" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Check waypoint 1" }));
    expect(document.activeElement).toBe(route.getByRole("button", { name: /1 Inspect the lamp.*Lampwright/ }));
  } finally { slot.lifecycle.unmount(); }
});

it("keeps each finished step on the revised road and its old detail and reason on demand", () => {
  const slot = render({ ...detail, quest: { ...detail.quest, greenlitVersion: 2,
    waypoints: detail.quest.waypoints.map((w, i) => i === 0 ? { ...w, state: "accepted", resolutionReason: "Night check recorded" }
      : i === 1 ? { ...w, state: "done" } : i === 2 ? { ...w, state: "reported" } : w),
  } });
  try {
    expect(slot.getByText("Sealed · party formed")).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Form the party|Redirect in chat/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^Order .*2 done/ }));
    const route = within(slot.getByRole("region", { name: "Route in order" }));
    const accepted = route.getByRole("button", { name: /1 Inspect the lamp.*Done/ });
    expect(route.getByRole("button", { name: /2 Clean the lens.*Done/ })).toBeTruthy();
    expect(route.getByRole("button", { name: /3 .*Waiting for a check/ })).toBeTruthy();
    fireEvent.click(accepted);
    expect(route.getByText("Accepted by the Keeper; no Warden check")).toBeTruthy();
    expect(route.getByText("Night check recorded")).toBeTruthy();
    expect(route.getByText("Install cron for the checks.")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it("shows each plan-level revision in place, in addition to the step edits", () => {
  const before = { ...plan, version: 1, eta: "Ready Monday with two checks.", findings: ["The mirror is clean."] };
  const after = { ...plan, goal: "Restore the harbor bell.", doneWhen: "The bell rings at low tide.",
    eta: "Ready Tuesday with three checks.", reviewLoad: "Two reviews", findings: ["The bell needs a rope."],
  };
  const slot = render(planDetail(after, [before, after]));
  try {
    const changes = within(slot.getByRole("region", { name: /^Changed since v1/ }));
    for (const label of ["Goal:", "Done when:", "Forecast:", "Review load:", "Findings:"]) expect(changes.getByText(label)).toBeTruthy();
    expect(changes.getByText("Monday with two").tagName).toBe("DEL");
    expect(changes.getByText("Tuesday with three").tagName).toBe("INS");
    expect(changes.getByText("1 new or reworded")).toBeTruthy();
    expect(changes.queryByRole("button")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});
