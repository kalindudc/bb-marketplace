import { boardQuestDetailSchema } from "../../../src/shared/contract";
import type { Plan, Waypoint } from "../../../src/shared/schema";
import { fixtureDetail, fixtureGreenlight, fixturePlan } from "../../../src/ui/thread/fixtures";

const id = "signal-lamp";
const waypoint = (n: number, title: string): Waypoint => ({
  id: `w${n}`, title, actor: "agent", check: "keeper", owner: "smith", leadTime: "15m",
  dependsOn: [], doneWhen: null, optional: false,
});

export const firstPlan: Plan = {
  ...fixturePlan, boardQuestId: id, goal: "Restore the harbor signal lamp", doneWhen: "The lamp passes the night watch",
  findings: [], assumptions: [], reviewLoad: "One review",
  waypoints: [
    waypoint(1, "Inspect the lamp"), { ...waypoint(2, "Clean the lens"), doneWhen: "No streaks" }, waypoint(3, "Replace the wick"),
    waypoint(4, "Test the shutter"), waypoint(5, "Service the fuel line"), waypoint(6, "Align the mirror"),
    waypoint(7, "Log the fuel level"), waypoint(8, "Run a night watch"),
  ],
  party: [{ classId: "smith", characterId: null, model: null, purpose: "Repair the lamp", waypointIds: ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"] }],
};

export const smallPlan: Plan = {
  ...firstPlan, version: 2, changeNote: "Tightened the lens check so fog does not mask streaks.",
  waypoints: firstPlan.waypoints.map(w => w.id === "w2" ? { ...w, doneWhen: "No streaks under a second lamp" } : w),
};

export const bigPlan: Plan = {
  ...smallPlan, version: 3, changeNote: "Added a storm-readiness pass and a Warden to check it.",
  waypoints: [...smallPlan.waypoints, waypoint(9, "Inspect the storm glass"), waypoint(10, "Seal the lamp housing"), waypoint(11, "Repeat the signal at low tide")],
  party: [...smallPlan.party, { classId: "warden", characterId: null, model: null, purpose: "Check the storm-readiness pass", waypointIds: ["w9", "w10", "w11"] }],
};

export function planDetail(plan: Plan, plans: Plan[]) {
  return boardQuestDetailSchema.parse({
    ...fixtureDetail,
    quest: {
      ...fixtureDetail.quest, id, title: "Harbor signal lamp", short: "Signal lamp", plan, planVersion: plan.version,
      waypoints: plan.waypoints.map(w => ({ ...w, state: "planned", ownerMember: null, evidenceCount: 0, verifiedBy: null, rejectedReason: null })),
    },
    plans,
    asks: [{ ...fixtureGreenlight, id: "seal-lamp", boardQuestId: id, question: "Form the party for the harbor signal lamp?" }],
  });
}
