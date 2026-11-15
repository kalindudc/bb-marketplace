// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";
import { registerCli } from "../../src/server/cli";
import { readStatus, statusInput } from "../../src/server/status";

async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Review the environment rules", "Environment");
  f.k.plan("lead", { ...planInput(q.id), waypoints: [{ ...planInput(q.id).waypoints[0]!, title: "Check the approved environment", doneWhen: "The sandbox checks pass" }] });
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page");
  f.k.bind("maker", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Environment rules", displayName: "Juno II", brief: { outcome: "Rules", mode: "make-it-work", outOfScope: "Production", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null } });
  const entry = waypointEntry("maker", q.id);
  f.port.linkedEntries = () => [entry];
  const get = f.port.get;
  f.port.get = threadId => ({ ...get(threadId), entries: threadId === "maker" ? [entry] : [] });
  const report = f.k.report("maker", { status: "done", outcome: "The environment rules are ready. ".repeat(12), evidence: [{ kind: "command", ref: "npm test", detail: "Passed", exitCode: 0 }], artifacts: ["https://example.com/review"], confidence: null, voice: null });
  return { ...f, q, report };
}
it("includes bounded review context without extra per-item queries", async () => {
  const f = await fixture();
  const query = vi.spyOn(f.k.store, "query");
  const item = f.runtime.review().items[0]!;
  expect(item).toMatchObject({ questTitle: f.q.title, waypoint: { id: "w1", title: "Check the approved environment", doneWhen: "The sandbox checks pass" }, member: { threadId: "maker", displayName: "Juno II", classId: "smith" }, reportId: f.report.id, headline: f.report.outcome, evidenceCount: 1, reportedAt: f.report.createdAt, waitingFor: { who: "keeper" } });
  expect(item.title).toBe(f.report.outcome.slice(0, 160));
  expect(query.mock.calls.filter(([kind]) => kind === "reports")).toHaveLength(1);
});
it.each(["working", "idle", "waiting"] as const)("names the assigned %s checker", async state => {
  const f = await fixture();
  f.k.bind("checker", "warden", "vex", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Check", displayName: "Vex III", brief: { outcome: "Check", mode: "make-it-work", outOfScope: "Production", doneWhen: "Verified", context: [], questions: [], timeboxMinutes: null } });
  f.k.activity("checker", state);
  expect(f.runtime.review().items[0]).toMatchObject({ waitingFor: { who: "checker", name: "Vex III", working: state === "working" } });
});
it("does not label an unrelated user gate as waiting for you", async () => {
  const f = await fixture();
  const summary = f.k.summary(f.q.id);
  vi.spyOn(f.k, "summary").mockReturnValue({ ...summary, move: { who: "you", text: "Another waypoint needs you" } });
  expect(f.runtime.review().items[0]).toMatchObject({ waitingFor: { who: "keeper" } });
});
it("caps room text and keeps long outcomes out of default agent status", async () => {
  const f = await fixture();
  f.k.store.put("reports", f.report.id, { ...f.report, outcome: "Long outcome. ".repeat(280) });
  const review = f.runtime.review();
  expect(review.items[0]!.title).toHaveLength(160);
  expect(review.items[0]!.headline).toHaveLength(500);
  expect(review.items[0]!.headlineTruncated).toBe(true);
  const legacy = { ...review, items: review.items.map(({ title, url, boardQuestId }) => ({ title, url, boardQuestId })) };
  const mock = vi.spyOn(f.runtime, "review").mockReturnValue(legacy);
  registerCli(f.bb, f.runtime);
  const cli = f.harness.inspection.registrations.cli[0]!;
  const cliBefore = await cli.run(["status"], {});
  const before = JSON.stringify(readStatus(f.runtime, "lead", statusInput.parse({})));
  mock.mockReturnValue(review);
  const after = JSON.stringify(readStatus(f.runtime, "lead", statusInput.parse({})));
  expect(after).toBe(before);
  const cliAfter = await cli.run(["status"], {});
  expect(cliAfter.exitCode).toBe(0);
  expect(cliAfter.stdout).toBe(cliBefore.stdout);
});
it.each(["hold", "user"])("waits for you when the gate is %s", async gate => {
  const f = await fixture();
  const summary = f.k.summary(f.q.id);
  vi.spyOn(f.k, "summary").mockReturnValue({ ...summary, ...(gate === "hold" ? { checkerHandoffHold: { id: "h", routeId: "r", sourceMessageId: "m", sourceText: "Hold", reason: "Wait", createdAt: f.time(), release: null } } : { waypoints: summary.waypoints.map(w => ({ ...w, actor: "user" as const })) }) });
  expect(f.runtime.review().items[0]).toMatchObject({ waitingFor: { who: "you" } });
});
