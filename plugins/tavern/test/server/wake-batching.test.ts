// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { rpcHandlers } from "../../src/server/rpc";
import { reportSchema } from "../../src/shared/schema";

function fixture() {
  const f = setup();
  const settings = new SettingsStore(f.k.store.db, f.time);
  const insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights);
  return { ...f, settings, insights };
}
const sent = (f: ReturnType<typeof setup>) => f.harness.inspection.sdk.callsTo("threads.send").map(call =>
  (call.args[0] as { input: { text: string }[] }).input[0]!.text);
const holds = (f: ReturnType<typeof fixture>, reason: string) =>
  f.insights.data(0).events.filter(event => event.type === "tick.held" && event.data.reason === reason);
const enableWakeBatching = (f: ReturnType<typeof fixture>) =>
  f.settings.update({ revision: f.settings.snapshot().revision, patch: { tavern: { batchWakeEvents: true } }, why: "Batch wake events on" });

/** A quest with a prior delivered report and one routine report filed but unread, all within the batch window. */
async function routineReport(f: ReturnType<typeof fixture>) {
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  const report = (id: string, deliveredAt: number | null, createdAt = f.time()) => reportSchema.parse({
    id, memberThreadId: "maker", keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, status: "done",
    outcome: "Work outcome", evidence: [], artifacts: [], confidence: null, voice: null, createdAt, deliveredAt,
  });
  f.k.store.put("reports", "prior", report("prior", f.time()));
  f.k.store.put("reports", "new", report("new", null));
  f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)?.id ?? 0, userAt: null, typingAt: null, tickAt: null });
  return q;
}
/** File the routine report. `wake: false` silences the event-driven wake so a test can drive the tick itself. */
function fileReport(f: ReturnType<typeof fixture>, q: string, wake = true) {
  const hook = f.k.store.onEvent;
  if (!wake) f.k.store.onEvent = undefined;
  f.k.store.event(f.time(), "lead", q, "report.filed", "Report filed", { reportId: "new" });
  f.k.store.onEvent = hook;
}

describe("event-driven wake and wake batching", () => {
  it("coalesces submission news into the report wake", async () => {
    const f = fixture();
    const q = await routineReport(f);
    f.k.store.event(f.time(), "lead", q.id, "journal.submitted", "Journal work submitted");
    await f.runtime.settleWakes();
    expect(sent(f)).toHaveLength(0);
    fileReport(f, q.id);
    await f.runtime.settleWakes();
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0]).toContain("Journal work submitted");
    expect(sent(f)[0]).toContain("Report outcome");
  });

  it("delivers submission-only news on the next sweep", async () => {
    const f = fixture();
    const q = await routineReport(f);
    f.k.store.event(f.time(), "lead", q.id, "journal.submitted", "Journal work submitted");
    await f.runtime.settleWakes();
    expect(sent(f)).toHaveLength(0);
    await f.runtime.tick("lead");
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0]).toContain("Journal work submitted");
  });

  it("wakes an idle Keeper when a member files a report", async () => {
    const f = fixture();
    const q = await routineReport(f);
    fileReport(f, q.id);
    await f.runtime.settleWakes();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(sent(f)[0]).toContain("Report outcome");
  });

  it("wakes the Keeper when a party's hires are dispatched, but not on its own hire", async () => {
    const f = fixture();
    f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)?.id ?? 0, userAt: null, typingAt: null, tickAt: null });
    f.k.store.event(f.time(), "lead", null, "member.hired", "Hired Otto", { memberThreadId: "child" }, { kind: "tavern" });
    await f.runtime.settleWakes();
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0]).toContain("Hired Otto");

    const afterParty = sent(f).length;
    f.k.store.event(f.time(), "lead", null, "member.hired", "Hired Pip", { memberThreadId: "child2" }, { kind: "agent", threadId: "lead" });
    await f.runtime.settleWakes();
    expect(sent(f)).toHaveLength(afterParty);
  });

  it("delivers a routine report on a regular sweep tick even when wake batching is on", async () => {
    const f = fixture();
    const q = await routineReport(f);
    enableWakeBatching(f);
    expect(f.runtime.wakeBatching()).toBe(true);
    fileReport(f, q.id, false);
    await f.runtime.tick("lead");
    expect(sent(f)).toHaveLength(1);
  });

  it("holds a routine report burst on a wake only when batching is on, and logs the reason", async () => {
    const f = fixture();
    const q = await routineReport(f);
    // Batching is off by default: a wake delivers at once.
    fileReport(f, q.id, false);
    await f.runtime.tick("lead", "wake");
    expect(sent(f)).toHaveLength(1);

    const f2 = fixture();
    const q2 = await routineReport(f2);
    enableWakeBatching(f2);
    f2.k.store.event(f2.time(), "lead", q2.id, "journal.submitted", "Journal work submitted");
    await f2.runtime.settleWakes();
    fileReport(f2, q2.id, false);
    await f2.runtime.tick("lead", "wake");
    expect(sent(f2)).toHaveLength(0);
    expect(holds(f2, "report-batch")).toHaveLength(1);
  });

  it("caps the wake batch hold at the tick interval and records the release", async () => {
    const f = fixture();
    const q = await routineReport(f);
    enableWakeBatching(f);
    fileReport(f, q.id, false);
    expect(f.runtime.wakeBatchHold("lead")).toBe("hold");
    f.advance(61_000);
    expect(f.runtime.wakeBatchHold("lead")).toBe("capped");
    await f.runtime.tick("lead", "wake");
    expect(sent(f)).toHaveLength(1);
    expect(holds(f, "batch-capped")).toHaveLength(1);
  });

  it("records a report reaction time when the report is delivered", async () => {
    const f = fixture();
    const q = await routineReport(f);
    // The report was filed five seconds before the Keeper sees it.
    f.k.store.put("reports", "new", { ...f.k.store.get("reports", "new")!, createdAt: f.time() - 5000 });
    fileReport(f, q.id, false);
    await f.runtime.tick("lead", "wake");
    const reacted = f.insights.data(0).events.filter(event => event.type === "report.reacted");
    expect(reacted).toHaveLength(1);
    expect(reacted[0]!.data).toMatchObject({ reportId: "new", status: "done" });
    expect(reacted[0]!.data.seconds).toBeGreaterThanOrEqual(5);
  });

  it("reports available events and the wake batch setting through the thread decor", async () => {
    const f = fixture();
    await seedQuest(f.k, "lead", "Build", "Build");
    f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)?.id ?? 0 });
    // A non-waking news event so the pending count stays unread for the decor read.
    f.k.store.event(f.time(), "lead", null, "member.stale", "Otto is quiet");
    const handlers = rpcHandlers(f.runtime);
    const decor = await handlers.decor({ threadId: "lead" });
    expect(decor.pendingEvents).toBeGreaterThanOrEqual(1);
    expect(decor.wakeBatching).toBe(false);
    enableWakeBatching(f);
    const again = await handlers.decor({ threadId: "lead" });
    expect(again.wakeBatching).toBe(true);
  });
});
