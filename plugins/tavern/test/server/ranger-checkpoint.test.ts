// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { registerTools } from "../../src/server/tools";
import { renderRestatement } from "../../src/server/keeper/restatement";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";

const minute = 60_000;
const brief = { outcome: "Find the source", doneWhen: "Evidence", mode: "make-it-work" as const, outOfScope: "Edits", context: [], questions: ["Where is it?", "Who owns it?"], timeboxMinutes: 5 };
const findings = { outcome: "1. The source is in the manual.", evidence: [{ kind: "file" as const, ref: "MANUAL.md", detail: "", exitCode: null }], artifacts: [] };
const checkpoint = { ...findings, status: "checkpoint", checkpoint: { left: "2. Find the owner.", moreMinutes: 4 } };

async function scout(errand = false) {
  const f = setup();
  const q = errand ? null : await seedQuest(f.k, "lead", "Read", "Read");
  const settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights);
  registerTools(f.bb, f.runtime);
  const member = await f.runtime.hire("lead", "project", { classId: "ranger", title: "Read", boardQuestId: q?.id, errand, brief });
  const invoke = (name: string, input: unknown, threadId = "lead") => f.harness.behavior.invokeAgentTool(name, input, { threadId });
  const sendReport = (input: object = checkpoint) => invoke("tavern_report", input, member.threadId);
  const reportId = () => f.k.store.query("reports", "memberThreadId", member.threadId, 1)[0]!.id;
  const current = () => f.k.member(member.threadId)!;
  const accept = () => invoke("tavern_judge", { op: "accept", reportId: reportId() });
  return { ...f, q, member, current, insights, sendReport, reportId, invoke, accept };
}

it("files a Ranger checkpoint without completing or archiving the errand, and shows who has the move", async () => {
  const f = await scout(true);
  f.advance(5 * minute);
  expect(await f.sendReport()).toContain("wait for the Keeper");
  expect(f.current().engagement).toBe("active");
  expect(f.insights.signals().rangerMinutes).toEqual([]);
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  expect(await f.invoke("tavern_status", { section: "errands" })).toContain("checkpoint, waiting for the Keeper");
  expect(renderRestatement(f.k, "lead")).toContain("checkpoint, waiting for the Keeper");
  f.advance(60 * minute);
  f.k.stale("lead");
  expect(f.current().strikes).toBe(0);
  await expect(f.invoke("tavern_tell", { memberThreadId: f.member.threadId, text: "Keep looking" })).rejects.toThrow(/tavern_judge/);
  expect(await f.invoke("tavern_status", { reportId: f.reportId() })).toContain("Find the owner");
});

it("holds a done errand for the owning Keeper, then records completion once and archives it", async () => {
  const f = await scout(true);
  f.advance(8 * minute);
  await f.sendReport({ ...findings, status: "done" });
  expect(f.current().engagement).toBe("active");
  expect(f.insights.signals().rangerMinutes).toEqual([]);
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  f.k.bind("other", "keeper", "wren", "project");
  await expect(f.invoke("tavern_judge", { op: "accept", reportId: f.reportId() }, "other")).rejects.toThrow(/own party/);
  f.advance(10 * minute);
  await f.accept();
  expect(f.insights.signals()).toMatchObject({ rangerMinutes: [8], rangerOverruns: 1 });
  expect(f.current().engagement).toBe("archived");
  await expect(f.accept()).rejects.toThrow(/no longer waiting/);
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  expect(f.insights.signals().rangerMinutes).toEqual([8]);
});

it("continues the current report with a new box, narrowed questions, and a fresh next-news deadline", async () => {
  const f = await scout();
  expect(f.k.summary(f.q!.id).nextNewsBy).toBe(f.time() + 5 * minute);
  f.advance(5 * minute);
  await f.sendReport();
  expect(f.k.summary(f.q!.id).nextNewsBy).toBeNull();
  expect(await f.invoke("tavern_status", { boardQuestId: f.q!.id })).toContain("checkpoint, waiting for the Keeper");
  f.advance(3 * minute);
  const reportId = f.reportId();
  await f.invoke("tavern_judge", { op: "continue", reportId, minutes: 4, reason: "Identify the owner", questionNumbers: [2] });
  expect(f.k.store.runtime(f.member.threadId).brief).toMatchObject({ questions: ["Who owns it?"], timeboxMinutes: 4 });
  expect(f.k.summary(f.q!.id).nextNewsBy).toBe(f.time() + 4 * minute);
  expect(f.harness.inspection.sdk.callsTo("threads.send").at(-1)).toMatchObject({ args: [{ input: [{ text: expect.stringContaining("Identify the owner") }] }] });
  await expect(f.invoke("tavern_judge", { op: "accept", reportId })).rejects.toThrow(/no longer waiting/);
  f.advance(3 * minute);
  await f.sendReport({ ...findings, status: "done" });
  await f.accept();
  expect(f.insights.signals()).toMatchObject({ rangerMinutes: [8], rangerOverruns: 0 });
  expect(f.current().engagement).toBe("resting");
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
});

it("refuses boxes above the ceiling and counts continued boxes against the class budget", async () => {
  const f = await scout();
  const extend = (minutes: number) => f.invoke("tavern_judge", { op: "continue", reportId: f.reportId(), minutes, reason: "Check the second source" });
  await f.sendReport();
  await expect(extend(13)).rejects.toThrow(/check-in interval.*12/);
  await extend(5);
  await f.sendReport();
  const sends = f.harness.inspection.sdk.callsTo("threads.send").length;
  await expect(extend(3)).rejects.toThrow(/10.*12.*release/i);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(sends);
  expect(f.k.summary(f.q!.id).nextNewsBy).toBeNull();
});

it("starts the next box only when bb accepts the continued brief", async () => {
  const f = await scout();
  await f.sendReport();
  const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
  await f.invoke("tavern_judge", { op: "continue", reportId: f.reportId(), minutes: 4, reason: "Check the index" });
  expect(send).toHaveBeenCalled();
  expect(f.k.summary(f.q!.id).nextNewsBy).toBeNull();
  await expect(f.accept()).rejects.toThrow(/Ranger brief.*pending/);
  f.advance(10 * minute);
  f.runtime.dispatched({ threadId: f.member.threadId, originPluginId: "tavern", content: send.mock.calls[0]![0].input } as never);
  expect(f.k.summary(f.q!.id).nextNewsBy).toBe(f.time() + 4 * minute);
  expect(f.current().rangerCheckpointReportId).toBeUndefined();
});

it("releases or replaces a Ranger at a checkpoint using the existing release operation", async () => {
  const f = await scout();
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  await f.sendReport();
  expect(await f.invoke("tavern_release", { memberThreadId: f.member.threadId, reason: "Try another source", replace: true })).toContain("Replaced");
  expect(f.current().engagement).toBe("released");
  expect(f.current().rangerCheckpointReportId).toBeUndefined();
  expect(f.insights.signals().rangerMinutes).toEqual([]);
  await expect(f.accept()).rejects.toThrow(/no longer waiting/);
});

it("still reads old Ranger reports and dates an original box from the initial brief", async () => {
  const f = await scout();
  const id = "report-old";
  f.k.store.put("reports", id, { ...findings, id, status: "done", memberThreadId: f.member.threadId, keeperThreadId: "lead", boardQuestId: f.q!.id, waypointId: null, confidence: null, voice: null, createdAt: f.time(), deliveredAt: f.time() });
  expect(await f.invoke("tavern_status", { reportId: id })).toContain('"status":"done"');
  expect(f.k.summary(f.q!.id).nextNewsBy).toBe(f.time() + 5 * minute);
  expect(f.current().rangerCheckpointReportId).toBeUndefined();
});
