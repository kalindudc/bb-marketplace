// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractReportHeadline, nameReportIds } from "../../src/shared/report-headline";

const questId = "quest_c4151d86-1feb-4271-a91c-0f66c285047e";
const vexOutcome = `Verified maker thr_test000023 entry [00] for board quest ${questId}, waypoint w1.`;
const reportId = "report_64aaf554";
const names = {
  threadNames: new Map([["thr_test000023", "Otto"]]),
  questNames: new Map([[questId, "isZeroDuration"]]),
  waypointTitles: new Map([["w1", "Check the duration"]]),
};

describe("report identifier naming", () => {
  it("names a known real report with the caller's complete member and waypoint label", () => {
    const reportNames = new Map([[reportId, "Vex's report for Check the duration"]]);
    const outcome = `Reviewed ${reportId} and the evidence.`;
    const text = "Reviewed Vex's report for Check the duration and the evidence.";
    expect(nameReportIds(outcome, { ...names, reportNames })).toEqual({ text, unresolved: [] });
    expect(extractReportHeadline({ outcome }, { ...names, reportNames })).toBe(text);
    expect(extractReportHeadline({ headline: outcome, outcome: "Another outcome." }, { reportNames })).toBe(text);
  });

  it("calls an unknown report a report, never exposing the id or dropping the headline", () => {
    const outcome = `Reviewed ${reportId}, then report_unknown and ${reportId}.`;
    const text = "Reviewed a report, then a report and a report.";
    expect(nameReportIds(outcome)).toEqual({ text, unresolved: [] });
    expect(extractReportHeadline({ outcome })).toBe(text);
  });

  it.each(["thr_someone's report", "Vex's report_reported", "Vex's report on w1", "  "])(
    "does not let a report label reintroduce raw ids: %s", label => {
      const reportNames = new Map([[reportId, label]]);
      expect(nameReportIds(`Read ${reportId} carefully.`, { ...names, reportNames })).toEqual({
        text: "Read a report carefully.", unresolved: [],
      });
    },
  );

  it("matches whole report tokens rather than a known prefix", () => {
    expect(nameReportIds(`Read ${reportId}-more and ${reportId}.`, {
      reportNames: new Map([[reportId, "Vex's report"]]),
    })).toEqual({ text: "Read a report and Vex's report.", unresolved: [] });
  });

  it("names the whole outcome without trimming, sentence selection or a length cap", () => {
    const text = `  ${vexOutcome}\nSecond sentence. ${"Full evidence. ".repeat(30)} `;
    const result = nameReportIds(text, names);
    expect(result.text).toBe(`  Verified maker Otto entry [00] for board quest isZeroDuration, waypoint Check the duration.\nSecond sentence. ${"Full evidence. ".repeat(30)} `);
    expect(result.text.length).toBeGreaterThan(160);
    expect(result.unresolved).toEqual([]);
  });

  it("leaves unresolved ids in the text and reports each once in first-occurrence order", () => {
    const text = "thr_missing checked quest_missing, waypoint w404. thr_missing cannot find w9.";
    expect(nameReportIds(text, names)).toEqual({ text, unresolved: ["thr_missing", "quest_missing", "w404"] });
    expect(nameReportIds("Checked thr_test000023 beside thr_missing.", names)).toEqual({
      text: "Checked Otto beside thr_missing.", unresolved: ["thr_missing"],
    });
  });

  it("does not replace partial identities or names that still contain raw ids", () => {
    const text = "Checked thr_test000023-more and thr_test000023.";
    expect(nameReportIds(text, { threadNames: new Map([["thr_test000023", "thr_someone_else"]]) })).toEqual({
      text, unresolved: ["thr_test000023-more", "thr_test000023"],
    });
    expect(nameReportIds("Checked build-1 and build-10.", { waypointTitles: new Map([["build-1", "Build the feature"]]) })).toEqual({
      text: "Checked Build the feature and build-10.", unresolved: [],
    });
  });

  it.each([
    "/Users/me/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_test000023-1/app",
    "thr_test000023/app", "/logs/quest_missing", "/logs/w1/results",
    "C:\\work\\thr_test000023\\app", "/logs/report_64aaf554/evidence", "report_64aaf554/evidence",
    "C:\\work\\report_64aaf554\\evidence",
  ])("preserves path references rather than treating their segments as people: %s", path => {
    const outcome = `Checked ${path} without changing it.`;
    expect(nameReportIds(outcome, names)).toEqual({ text: outcome, unresolved: [] });
    expect(extractReportHeadline({ outcome }, names)).toBe(outcome);
    expect(extractReportHeadline({ outcome })).toBe(outcome);
  });
});

describe("legacy report headline extraction", () => {
  it("replaces the real Vex receipt's thread, quest and waypoint ids with known names", () => {
    const headline = extractReportHeadline({ outcome: vexOutcome }, names);
    expect(headline).toBe("Verified maker Otto entry [00] for board quest isZeroDuration, waypoint Check the duration.");
    expect(headline).not.toMatch(/thr_|quest_|\bw1\b/);
  });

  it.each([
    {},
    { ...names, threadNames: new Map() },
    { ...names, questNames: new Map() },
    { ...names, waypointTitles: new Map() },
  ])("returns no headline when any id cannot be resolved", lookup => {
    expect(extractReportHeadline({ outcome: vexOutcome }, lookup)).toBeNull();
  });

  it("sanitizes stored headlines too and never changes the original report", () => {
    const report = { headline: `Checked thr_test000023 on ${questId} at w1.`, outcome: "Full outcome stays exactly as written." };
    const original = { ...report };
    expect(extractReportHeadline(report, names)).toBe("Checked Otto on isZeroDuration at Check the duration.");
    expect(extractReportHeadline(report)).toBeNull();
    expect(report).toEqual(original);
  });

  it("recognizes arbitrary known waypoint ids and refuses names that still contain raw ids", () => {
    expect(extractReportHeadline({ outcome: "Checked waypoint make-readme exactly." }, { waypointTitles: new Map([["make-readme", "Update the README"]]) })).toBe("Checked waypoint Update the README exactly.");
    expect(extractReportHeadline({ outcome: vexOutcome }, { ...names, threadNames: new Map([["thr_test000023", "thr_someone_else"]]) })).toBeNull();
    expect(extractReportHeadline({ outcome: vexOutcome }, { ...names, waypointTitles: new Map([["w1", "w99"]]) })).toBeNull();
  });

  it("does not confuse an id prefix with a known identity or keep unknown waypoints", () => {
    expect(extractReportHeadline({ outcome: `Checked thr_test000023-more on ${questId} at w1.` }, names)).toBeNull();
    expect(extractReportHeadline({ outcome: "Verified waypoint w404 with the check." }, names)).toBeNull();
  });

  it("keeps clean explicit headlines, verdict stripping and file names intact", () => {
    expect(extractReportHeadline({ headline: "All three lists match the file.", outcome: "VERIFIED w1. Long text." })).toBe("All three lists match the file.");
    expect(extractReportHeadline({ outcome: "VERIFIED w1. I derived all three lists and each matches /tmp/tavern-smoke/missing-plugins.md exactly. (1) Missing from the table: None." })).toBe("I derived all three lists and each matches /tmp/tavern-smoke/missing-plugins.md exactly.");
    expect(extractReportHeadline({ outcome: "No plugins/* folder is missing from the README.md plugin table. The result list is empty." })).toBe("No plugins/* folder is missing from the README.md plugin table.");
    expect(extractReportHeadline({ outcome: "Entry 02 verified. The repo is clean and the table has 17 rows." })).toBe("The repo is clean and the table has 17 rows.");
    expect(extractReportHeadline({ outcome: "VERIFIED w1." })).toBeNull();
    expect(extractReportHeadline({ outcome: "(1) a (2) b" })).toBeNull();
  });

  it("does not truncate a replacement or raw id at the legacy display limit", () => {
    expect(extractReportHeadline({ outcome: `Checked thr_test000023 in the repository.` }, { threadNames: new Map([["thr_test000023", "x".repeat(160)]]) })).toBeNull();
    expect(extractReportHeadline({ headline: "x".repeat(160), outcome: "" })).toHaveLength(160);
    expect(extractReportHeadline({ headline: "x".repeat(161), outcome: "" })).toBeNull();
  });
});
