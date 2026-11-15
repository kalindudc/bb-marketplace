// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PartyPicture, memberSummary } from "../../../src/ui/kit";
import { memberSchema } from "../../../src/shared/schema";
import { fixtureMember, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);
const member = (over: Record<string, unknown>) => memberSchema.parse({ ...fixtureMember, role: "member", keeperThreadId: "keeper-1", boardQuestId: "vault", place: "road", state: "working", ...over });
const w1 = fixtureQuest.waypoints[0]!;

describe("party member summaries", () => {
  it("names people, quests and waypoints in place of ids", () => {
    const juno = member({ threadId: "thr_juno1" });
    const vex = member({ threadId: "thr_vex22", doing: `Verified maker thr_juno1 entry for board quest vault, waypoint ${w1.id}. Then more.` });
    const quest = { ...fixtureQuest, id: "quest_vault1", members: [juno, vex] };
    const line = memberSummary({ ...vex, doing: `Verified maker thr_juno1 entry for board quest quest_vault1, waypoint ${w1.id}. Then more.` }, [juno, vex], fixtureRegistry, [quest]);
    expect(line).toBe(`Verified maker Wren entry for board quest Vault, waypoint ${w1.title}.`);
    expect(line).not.toMatch(/thr_|quest_/);
  });

  it("falls back to the state word when an id cannot be resolved, never showing it", () => {
    const vex = member({ threadId: "thr_vex22", doing: "Checked the work of thr_somebody_else and found it sound." });
    expect(memberSummary(vex, [vex], fixtureRegistry, [])).toBe("working");
  });

  it("leaves a waypoint id unresolved when two of the member's quests title it differently", () => {
    const vex = member({ threadId: "thr_vex22", doing: `Finished waypoint ${w1.id} and attached the evidence for it.` });
    const a = { ...fixtureQuest, id: "quest_a", members: [vex] };
    const b = { ...fixtureQuest, id: "quest_b", members: [vex], waypoints: fixtureQuest.waypoints.map(w => ({ ...w, title: `${w.title} (other)` })) };
    expect(memberSummary(vex, [vex], fixtureRegistry, [a])).toBe(`Finished waypoint ${w1.title} and attached the evidence for it.`);
    expect(memberSummary(vex, [vex], fixtureRegistry, [a, b])).toBe("working");
  });

  it("draws the cleaned line in the party picture and its tooltip", () => {
    const vex = member({ threadId: "thr_vex22", doing: "Reviewed thr_vex22 output and the tests pass on both instances." });
    const view = render(<div className="tavern"><PartyPicture members={[vex]} registry={fixtureRegistry} onOpen={() => {}} quests={[{ ...fixtureQuest, members: [vex] }]} /></div>);
    expect(view.container.textContent).toContain("Reviewed Wren output and the tests pass on both instances.");
    // What a person reads or hears: text, tooltips and accessible names. Data attributes (motion keys) may carry the id.
    const read = [view.container.textContent ?? "", ...[...view.container.querySelectorAll("[title], [aria-label]")].flatMap(el => [el.getAttribute("title") ?? "", el.getAttribute("aria-label") ?? ""])].join("\n");
    expect(read).not.toMatch(/thr_vex22/);
  });
});

import { DecidedForYou } from "../../../src/ui/kit";
import { decisionSchema } from "../../../src/shared/schema";
import { fireEvent } from "@testing-library/react";
describe("DecidedForYou limit", () => {
  const decision = (i: number) => decisionSchema.parse({ id: `d${i}`, keeperThreadId: "keeper-1", boardQuestId: null, text: `Decision ${i}`, why: `Because ${i}`, reversible: true, undone: false, createdAt: 1000 + i, source: "keeper", sourceRef: null });
  it("shows the first rows, then Show all N in place, and marks agent text as content", () => {
    const list = [1, 2, 3, 4, 5].map(decision);
    const view = render(<div className="tavern"><DecidedForYou decisions={list} onUndo={() => {}} limit={3} /></div>);
    expect(view.container.querySelectorAll("li.di")).toHaveLength(3);
    const more = view.getByRole("button", { name: "Show all 5" });
    fireEvent.click(more);
    expect(view.container.querySelectorAll("li.di")).toHaveLength(5);
    expect(view.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector("li.di b")?.hasAttribute("data-content")).toBe(true);
  });
  it("heads the list with a focusable h3 named by its title and count, without the Mark all seen button", () => {
    const view = render(<div className="tavern"><DecidedForYou decisions={[1, 2].map(decision)} onUndo={() => {}} headingId="decided-h" /></div>);
    const heading = view.getByRole("heading", { level: 3 });
    expect(heading.id).toBe("decided-h");
    expect(heading.textContent).toMatch(/Decided for you/);
    expect(heading.textContent).not.toMatch(/Mark all seen/);
    heading.focus();
    expect(document.activeElement).toBe(heading);
  });
  it("draws no Show all without a limit, or when everything fits", () => {
    const view = render(<div className="tavern"><DecidedForYou decisions={[1, 2].map(decision)} onUndo={() => {}} limit={3} /></div>);
    expect(view.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

import { reportLabels, summaryNames } from "../../../src/ui/kit";
import { nameReportIds } from "../../../src/shared/report-headline";
describe("reportLabels", () => {
  const authors = new Map([["thr_vex", "Vex"], ["thr_juno", "Juno"]]);
  const quest = { id: "q1", waypoints: [{ id: "w1", title: "Add the test" }, { id: "w2", title: "Check the duration" }] } as never;
  const rep = (id: string, who: string, w: string | null) => ({ id, memberThreadId: who, boardQuestId: "q1", waypointId: w });
  it("names a lone report by its author, and adds the waypoint only when that author filed more than one", () => {
    const labels = reportLabels([rep("report_a", "thr_vex", "w2"), rep("report_b", "thr_juno", "w1"), rep("report_c", "thr_juno", "w2")], authors, [quest]);
    expect(labels.get("report_a")).toBe("Vex’s report");
    expect(labels.get("report_b")).toBe("Juno’s report for Add the test");
    expect(labels.get("report_c")).toBe("Juno’s report for Check the duration");
  });
  it("leaves unnamed authors out, so the shared namer says a report and never the id", () => {
    const labels = reportLabels([rep("report_x", "thr_nobody", "w1")], authors, [quest]);
    expect(labels.has("report_x")).toBe(false);
    expect(nameReportIds("Matches report_x and report_a.", { reportNames: labels }).text).toBe("Matches a report and a report.");
  });
  it("feeds summaryNames only when reports are given", () => {
    expect(summaryNames({ threadId: "t" }, [], { classes: [], characters: [], problems: [] } as never, []).reportNames).toBeUndefined();
  });
});

import { questNames } from "../../../src/ui/kit";
describe("questNames", () => {
  it("names the Keeper as the Keeper, every waypoint, and each report by its author", () => {
    const reg = { classes: [{ id: "smith" }], characters: [{ id: "juno", name: "Juno" }], problems: [] } as never;
    const quest = { id: "q1", short: "Vault", title: "Vault cutover", keeperThreadId: "thr_k", members: [{ threadId: "thr_j", classId: "smith", characterId: "juno" }], waypoints: [{ id: "w1", title: "Staging test", ownerMember: null }] } as never;
    const names = questNames(quest, reg, [{ id: "report_1", memberThreadId: "thr_j", boardQuestId: "q1", waypointId: "w1" }]);
    expect(nameReportIds("thr_k asked thr_j for w1; see report_1 in quest_q1.", names).text).toBe("the Keeper asked Juno for Staging test; see Juno’s report in quest_q1.");
  });
});
