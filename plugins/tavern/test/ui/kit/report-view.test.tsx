import { withEngagement } from "../member-fixture";
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ReportView, SAME_FAMILY, memberReportNames, reportBlocks, summaryNames } from "../../../src/ui/kit";
import { boardQuestSummarySchema } from "../../../src/shared/contract";
import { reportSchema } from "../../../src/shared/schema";
import * as scenes from "../page/scenes";
import live from "./live-iszeroduration.json";

afterEach(cleanup);
// Captured from the live isZeroDuration quest (13:57 build): Vex's report names its maker and quest by raw id.
const quest = boardQuestSummarySchema.parse(withEngagement(live.quest));
const vexReport = reportSchema.parse(live.report);
const vex = quest.members.find((m) => m.threadId === vexReport.memberThreadId)!;
const names = summaryNames(vex, quest.members, scenes.registry, [quest]);

describe("ReportView", () => {
  it.each([false, true])("renders PR state and owner from records, not report text (compact: %s)", compact => {
    const pr = { id: "pr", keeperThreadId: "keeper", boardQuestId: null, projectId: "project", memberThreadId: vexReport.memberThreadId, owner: "keeper", url: "https://forge.example/pr/12", forge: null, head: "topic", base: "main", memberHead: "a".repeat(40), pushedHead: null, verifiedCommit: null, state: "ready" as const };
    const { container } = render(<ReportView report={vexReport} pullRequests={[pr]} compact={compact} />);
    expect(container.textContent).toContain("Draft PR: https://forge.example/pr/12 (ready; owner: keeper; head not verified)");
    expect(container.querySelector('a[href="https://forge.example/pr/12"]')).not.toBeNull();
  });
  it("names the live report's ids and shows none raw, with its numbered lines as a list", () => {
    const { container } = render(<ReportView report={vexReport} names={names} member={vex} />);
    // Paths keep the ids they contain (worktree folders); everywhere else no raw id shows.
    const text = (container.textContent ?? "").replace(/\/[\w./@-]+/g, "");
    expect(text).not.toMatch(/thr_|quest_c4151d86/);
    expect(container.querySelector(".rv-lead")!.textContent).toBe("Verified maker Juno entry [00] for board quest isZeroDuration, waypoint Add isZeroDuration and three tests.");
    expect(container.querySelectorAll(".rv-list > li")).toHaveLength(3);
    expect(container.querySelectorAll("[data-content]").length).toBeGreaterThan(2);
    expect(container.querySelector(".rv-voice")!.textContent).toBe(vexReport.voice);
    expect(container.querySelector(".glow, .lit, .tcard, .tv-card")).toBeNull();
  });
  it("words an id nobody can name, and leaves paths alone", () => {
    const report = { ...vexReport, headline: undefined, outcome: "Checked thr_nobody42 on quest_gone99 in /Users/k/worktrees/thr_test000023-1/app. Then done." };
    const { container } = render(<ReportView report={report} names={names} />);
    const body = container.textContent ?? "";
    expect(body).toContain("another thread");
    expect(body).toContain("another quest");
    expect(body).toContain("/Users/k/worktrees/thr_test000023-1/app");
  });
  it("turns inline and line-start numbering into lists, and a trailing command into code", () => {
    expect(reportBlocks("Lead. (1) one (2) two (3) three")).toEqual([{ kind: "p", text: "Lead." }, { kind: "list", items: ["one", "two", "three"] }]);
    expect(reportBlocks("Lead.\n\n1) one\n2) two\n\nAfter. Command used: npm test")).toEqual([{ kind: "p", text: "Lead." }, { kind: "list", items: ["one", "two"] }, { kind: "p", text: "After." }, { kind: "code", text: "npm test" }]);
  });
  it("folds long evidence output, groups commands before files and notes", () => {
    const report = { ...vexReport, artifacts: [], evidence: [{ kind: "note" as const, ref: "Journal entry [00]", detail: "noted", exitCode: null }, { kind: "file" as const, ref: "src/duration.js", detail: "x".repeat(400), exitCode: null }, { kind: "command" as const, ref: "npm test", detail: "8 passed", exitCode: 0 }] };
    const { container } = render(<ReportView report={report} names={names} />);
    expect([...container.querySelectorAll(".evidence-list .ek")].map((e) => e.textContent)).toEqual(["command", "file", "note"]);
    expect(container.querySelectorAll(".evidence-list .lg-clamp.ed")).toHaveLength(3);
  });
  it("labels a path artifact as a file and only a web address as a link", () => {
    const report = { ...vexReport, evidence: [], artifacts: ["/Users/k/app/src/duration.js", "https://github.com/shop/app/pull/7"] };
    const { container } = render(<ReportView report={report} names={names} />);
    expect([...container.querySelectorAll(".evidence-list .ek")].map((e) => e.textContent)).toEqual(["file", "url"]);
  });
  it("names the Keeper in notes, and leaves commands verbatim", () => {
    const keeper = quest.keeperThreadId;
    const report = { ...vexReport, artifacts: [], evidence: [{ kind: "note" as const, ref: `quest verify threadId=${keeper} id=03`, detail: "", exitCode: null }, { kind: "command" as const, ref: `tavern show ${keeper}`, detail: "", exitCode: 0 }] };
    const detail = { quest, reports: [report] } as never;
    const { container } = render(<ReportView report={report} names={memberReportNames(detail, vex, scenes.registry)} />);
    const refs = [...container.querySelectorAll(".evidence-list li")].map((li) => li.textContent ?? "");
    expect(refs.find((t) => t.includes("quest verify"))).toContain("threadId=the Keeper");
    expect(refs.find((t) => t.includes("tavern show"))).toContain(keeper);
  });
  it("names another report by who filed it", () => {
    const juno = quest.members.find((m) => m.characterId === "juno")!;
    const junoReport = { ...vexReport, id: "report_64aaf554-0000-4000-8000-000000000001", memberThreadId: juno.threadId };
    const report = { ...vexReport, headline: undefined, artifacts: [], outcome: `Checked ${junoReport.id} against the tests. All pass.` };
    const detail = { quest, reports: [report, junoReport] } as never;
    const { container } = render(<ReportView report={report} names={memberReportNames(detail, vex, scenes.registry)} />);
    expect(container.textContent).toContain("Checked Juno’s report against the tests.");
    expect(container.textContent).not.toContain("report_64aaf554");
  });
  it("shows a same-family Warden's exact label", () => {
    const { container } = render(<ReportView report={vexReport} names={names} member={{ checkIndependence: "same-family" }} />);
    expect(container.textContent).toContain(SAME_FAMILY);
  });
  it("draws the chat card's compact form with a View report link", () => {
    let viewed = 0;
    const { getByRole, container } = render(<ReportView report={vexReport} names={names} compact onView={() => { viewed++; }} />);
    expect(container.querySelector(".rv-lead")).toBeTruthy();
    expect(container.querySelector(".rv-list, .evidence-list")).toBeNull();
    getByRole("button", { name: "View report" }).click();
    expect(viewed).toBe(1);
  });
});
