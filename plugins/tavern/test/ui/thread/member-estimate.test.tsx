import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { ReportView } from "../../../src/ui/kit/report-view";
import { ReportCard } from "../../../src/ui/thread/cards";
import { ReportItem } from "../../../src/ui/page/record";
import { QuestPage } from "../../../src/ui/page/quest";
import { QuestMap } from "../../../src/ui/kit/quest-map";
import { juno, richDetails, registry } from "../page/scenes";

const detail = richDetails.vault!;
const report = { ...detail.reports[0]!, memberThreadId: juno.threadId, confidence: { intent: 90, safe: 60 }, outcome: "The shared grid is ready." };
const estimate = "Member’s own estimate";
const view = () => renderSlot({ component: () => <div className="tavern tv-page">
  <div id="card"><ReportCard report={report} /></div>
  <div id="report"><ReportView report={report} /></div>
  <ul id="history"><ReportItem report={report} detail={detail} registry={registry} /></ul>
  <div id="verdict"><QuestMap quest={detail.quest} mode="live" rowsOnly /></div>
</div> }, {}, {});

it("names confidence as the member's own estimate in chat, full reports and quest report rows", () => {
  const slot = view();
  try {
    const estimates = slot.getAllByRole("group", { name: estimate });
    expect(estimates).toHaveLength(3);
    for (const element of estimates) expect(element.textContent).toMatch(/matches intent 90%.*safe to ship 60%/);
    const verdict = slot.container.querySelector("#verdict")!;
    expect(verdict.textContent).toMatch(/verified|Warden check/i);
    expect(estimates.every(el => !verdict.contains(el))).toBe(true);
  } finally { slot.lifecycle.unmount(); }
});

it("separates the estimate from the verified mark on the same waypoint", () => {
  const verified = detail.quest.waypoints.find(waypoint => waypoint.state === "verified")!;
  const slot = renderSlot({ component: () => <div className="tavern tv-page"><QuestPage detail={{ ...detail, reports: [{ ...report, waypointId: verified.id }] }} registry={registry} /></div> }, {}, {});
  try {
    fireEvent.click(slot.getByRole("button", { name: /^Done ·/ }));
    const row = slot.getAllByText("verified by the Warden").map(mark => mark.closest("li")!).find(el => el.textContent?.includes(verified.title))!;
    const group = within(row).getByRole("group", { name: estimate });
    expect(group.textContent).toContain("matches intent 90%");
    expect(within(group).queryByText("verified by the Warden")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_UI_ITEMS_HARNESS === "1")("exports the three report surfaces and the separate waypoint verdicts", () => {
  const slot = view();
  try { process.stdout.write("MEMBER_ESTIMATE=" + JSON.stringify(slot.container.innerHTML) + "\n"); }
  finally { slot.lifecycle.unmount(); }
});
