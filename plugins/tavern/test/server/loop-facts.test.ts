// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { registerRpc } from "../../src/server/rpc";
import { TavernRuntime } from "../../src/server/runtime";
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
function news(f: ReturnType<typeof setup>, text = "A pending fact", type = "promise.due") {
  return f.k.store.event(f.time(), "lead", null, type, text);
}

describe("Keeper tick facts, sampling and admission", () => {
  it.each(["typing", "after-message", "busy", "queue", "cooldown"] as const)("records one %s hold episode and measures only the delivered batch", async reason => {
    const f = fixture(); news(f);
    const rows = reason === "queue" ? [queued049("user", "Human message", f.time())] : [];
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockImplementation(async () => rows);
    vi.spyOn(f.bb.sdk.threads, "get").mockResolvedValue(makeThreadResponse({ id: "lead", status: reason === "busy" ? "active" : "idle" }));
    if (reason === "typing") f.k.store.patch("lead", { typingAt: f.time() });
    if (reason === "after-message") f.k.store.patch("lead", { userAt: f.time() });
    if (reason === "cooldown") f.k.store.patch("lead", { tickAt: f.time() });
    for (let i = 0; i < 4; i++) { await f.runtime.tick("lead"); f.advance(5000); }
    const samples = () => f.insights.data(0).events.filter(event => event.id.startsWith("sample:"));
    expect(samples().filter(event => event.type === "tick.held")).toHaveLength(1);
    expect(samples().filter(event => event.type === "facts.measured" || event.type === "restatement.measured")).toHaveLength(0);
    rows.length = 0;
    vi.spyOn(f.bb.sdk.threads, "get").mockResolvedValue(makeThreadResponse({ id: "lead" }));
    f.k.store.patch("lead", { typingAt: null, userAt: null }); f.advance(61_000);
    await f.runtime.tick("lead");
    expect(samples().filter(event => event.type === "facts.measured")).toHaveLength(1);
    expect(samples().filter(event => event.type === "restatement.measured")).toHaveLength(1);
  });

  it("does not measure a refused batch as delivered", async () => {
    const f = fixture(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("HTTP 403 refused"));
    await f.runtime.tick("lead");
    expect(f.insights.data(0).events.filter(event => event.type.endsWith(".measured"))).toHaveLength(0);
  });

  it("measures a queued batch once only when dispatch is acknowledged", async () => {
    const f = fixture(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "queued" } as never);
    await f.runtime.tick("lead");
    const batch = f.k.store.pendingTick("lead")!;
    expect(f.insights.data(0).events.filter(event => event.type.endsWith(".measured"))).toHaveLength(0);
    f.runtime.acknowledgeTick(batch.id); f.runtime.acknowledgeTick(batch.id);
    expect(f.insights.data(0).events.filter(event => event.type === "facts.measured")).toHaveLength(1);
  });

  it("delivers member.brief-refused as news", async () => {
    const f = setup(); news(f, "The queued brief was dropped", "member.brief-refused");
    await f.runtime.tick("lead");
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0]).toContain("The queued brief was dropped");
  });

  it.each(["done", "blocked", "needs-decision"] as const)("delivers a %s report on a regular sweep tick, which never batches", async status => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    const report = (id: string, deliveredAt: number | null) => reportSchema.parse({ id, memberThreadId: "maker", keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, status, outcome: "Work outcome", evidence: [], artifacts: [], confidence: null, voice: null, createdAt: f.time(), deliveredAt });
    f.k.store.put("reports", "prior", report("prior", f.time() - 1000));
    f.k.store.put("reports", "new", report("new", null));
    f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)!.id, userAt: null });
    f.k.store.event(f.time(), "lead", q.id, "report.filed", "Report filed", { reportId: "new" });
    await f.runtime.tick("lead");
    expect(sent(f)).toHaveLength(1);
  });

  it("does not tick or sample a hold for news belonging only to an archived quest", async () => {
    const f = fixture();
    const q = await seedQuest(f.k,"lead", "Archived", "Old");
    f.k.store.put("quests", q.id, { ...q, archivedAt: f.time() });
    f.k.store.event(f.time(), "lead", q.id, "member.failed", "Archived-only news");
    await f.runtime.tick("lead");
    expect(sent(f)).toHaveLength(0);
    f.k.store.patch("lead", { typingAt: f.time() }); await f.runtime.tick("lead");
    expect(f.insights.data(0).events.filter(e => e.type === "tick.held")).toHaveLength(0);
  });

  it("reads visible facts past100 archived quest events without counting hidden overflow", async () => {
    const f = setup(); const q = await seedQuest(f.k, "lead", "Archived", "Old");
    f.k.store.patch("lead", { userAt: null });
    f.k.store.put("quests", q.id, { ...q, archivedAt: f.time() });
    for (let i = 0; i < 101; i++) f.k.store.event(f.time(), "lead", q.id, "member.failed", `Hidden-${i}`);
    news(f, "Visible fact");
    await f.runtime.tick("lead");
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0]).toContain("Visible fact");
    expect(sent(f)[0]).not.toContain("Hidden-");
    expect(sent(f)[0]).not.toContain("more; call tavern_status");
  });

  it("rebuilds a queued tick after two minutes of waiting with current facts", async () => {
    const f = setup(); news(f, "Original fact");
    const rows: ReturnType<typeof queued049>[] = [];
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockImplementation(async () => rows.slice());
    f.bb.sdk.threads.queuedMessages.delete = vi.fn().mockImplementation(async () => { rows.length = 0; return {}; });
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never).mockResolvedValue({ delivery: "sent" } as never);
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    rows.push(queued049("old", batch.text, f.time(), { pluginId: "tavern" }));
    f.advance(120_001); news(f, "Fresh fact while waiting");
    expect((await f.runtime.dispatch(dispatch049({ rows, status: "active" }))).action).toBe("wait");
    expect(f.k.store.runtime("lead").queuedTickResetId).toBeTruthy();
    await f.runtime.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("cancelled");
    expect(sent(f)).toHaveLength(2);
    expect(sent(f)[1]).toContain("Fresh fact while waiting");
    expect(sent(f)[1]).toContain("Original fact");
  });

  it("does not delete queued rows after the current host record becomes archived", async () => {
    const f = setup(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "queued" } as never);
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockResolvedValue([queued049("old", batch.text, f.time(), { pluginId: "tavern" })]);
    const remove = f.bb.sdk.threads.queuedMessages.delete = vi.fn();
    vi.spyOn(f.bb.sdk.threads, "get").mockResolvedValue(makeThreadResponse({ id: "lead", archivedAt: f.time() }));
    f.k.store.patch("lead", { queuedTickResetId: "reset" });
    await f.runtime.tick("lead");
    expect(remove).not.toHaveBeenCalled();
  });

  it("rechecks host liveness after listing the queue and before deleting each tick row", async () => {
    const f = setup(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "queued" } as never);
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    let archived = false;
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockImplementation(async () => {
      archived = true;
      return [queued049("old", batch.text, f.time(), { pluginId: "tavern" })];
    });
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async () => makeThreadResponse({ id: "lead", archivedAt: archived ? f.time() : null }));
    const remove = f.bb.sdk.threads.queuedMessages.delete = vi.fn();
    f.k.store.patch("lead", { queuedTickResetId: "reset" });
    await f.runtime.tick("lead");
    expect(remove).not.toHaveBeenCalled();
  });

  it("continues an oversized fact without advancing its event until complete", async () => {
    const f = setup();
    const event = f.k.store.event(f.time(), "lead", null, "promise.due", "Large fact", { payload: `BEGIN-${"x".repeat(20_000)}-END` });
    await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").cursor).toBeLessThan(event);
    expect(f.k.store.runtime("lead").factContinuation?.eventId).toBe(event);
    expect(sent(f)[0]).toContain("Oversized fact"); expect(sent(f)[0]).not.toContain("-END");
    f.advance(61_000); await f.runtime.tick("lead");
    expect(sent(f)[1]).toContain("Continuation of fact"); expect(sent(f)[1]).toContain("-END");
    expect(f.k.store.runtime("lead").cursor).toBe(event);
    expect(f.k.store.runtime("lead").factContinuation).toBeNull();
  });

  it("pages facts after the first100 events without consuming overflow", async () => {
    const f = setup();
    const events = Array.from({ length: 101 }, (_, i) => news(f, `fact-${i + 1}`));
    await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").cursor).toBe(events[99]!);
    expect(sent(f)[0]).not.toContain('"text":"fact-101"');
    f.advance(61_000); await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").cursor).toBe(events[100]!);
    expect(sent(f)[1]).toContain('"text":"fact-101"');
  });

  it("recovers accepted-input history beyond100 events without replaying a sent tick", async () => {
    const f = setup(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("response lost"));
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    const events = Array.from({ length: 101 }, (_, i) => ({ seq: i + 1, type: "client/turn/requested", createdAt: f.time(), data: { text: i === 100 ? batch.text : `other-${i}` } }));
    const history = vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async args => args.types?.includes("client/turn/requested") ? events.filter(event => event.seq > Number(args.afterSeq ?? 0)).slice(0, 100) as never : []);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.reconcile();
    expect(f.k.store.tick(batch.id)?.hostAfterSeq).toBe(100);
    await restarted.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(history.mock.calls.some(([args]) => args.afterSeq === "100")).toBe(true);
    expect(sent(f)).toHaveLength(1);
  });

  it("retires a legacy unconfirmed batch at60s while retaining its facts", async () => {
    const f = setup(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never).mockResolvedValue({ delivery: "sent" } as never);
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    f.k.store.putTick({ ...batch, state: "prepared", sendPending: undefined, lastSendAt: undefined, resendCount: undefined });
    f.advance(59_999); await f.runtime.tick("lead"); expect(f.k.store.pendingTick("lead")?.id).toBe(batch.id);
    f.advance(1); await f.runtime.tick("lead"); expect(f.k.store.tick(batch.id)?.state).toBe("cancelled");
    expect(f.k.store.runtime("lead").cursor).toBe(0);
    await f.runtime.tick("lead"); expect(sent(f)).toHaveLength(2); expect(sent(f)[1]).toContain("A pending fact");
  });

  it("rejects duplicate and already-delivered tick admissions", async () => {
    const f = setup(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "queued" } as never);
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    const ctx = dispatch049({ text: batch.text, pluginId: "tavern" });
    expect((await f.runtime.dispatch(ctx)).action).toBe("proceed");
    expect((await f.runtime.dispatch(ctx)).action).toBe("reject");
    f.runtime.acknowledgeTick(batch.id);
    expect((await f.runtime.dispatch(ctx)).action).toBe("reject");
  });

  it("records a failed queued tick fact and redelivers its unread facts", async () => {
    const f = setup(); news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never).mockResolvedValue({ delivery: "sent" } as never);
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    const row = { ...queued049("failed", batch.text, f.time(), { pluginId: "tavern" }), failureReason: "host rejected queued input" };
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockResolvedValueOnce([row]);
    f.bb.sdk.threads.queuedMessages.delete = vi.fn().mockResolvedValue({});
    await f.runtime.tick("lead");
    expect(f.k.store.events("lead").some(e => e.type === "tick.failed" && e.data.tickId === batch.id)).toBe(true);
    expect(f.k.store.runtime("lead").cursor).toBe(0);
    await f.runtime.tick("lead"); expect(sent(f)[1]).toContain("host rejected queued input"); expect(sent(f)[1]).toContain("A pending fact");
  });

  it("sets the actual typing hold through the RPC", async () => {
    const f = setup(); registerRpc(f.bb, f.runtime); news(f);
    await f.harness.invokeRpc("typing", { threadId: "lead" });
    expect(f.k.store.runtime("lead").typingAt).toBe(f.time());
    await f.runtime.tick("lead"); expect(sent(f)).toHaveLength(0);
    f.advance(45_001); await f.runtime.tick("lead"); expect(sent(f)).toHaveLength(1);
  });

  it("expires the hold display only once without losing its user receipt", async () => {
    const f = setup();
    f.k.store.patch("lead", { userAt: f.time(), heldAt: f.time() });
    const receipt = f.time(); f.advance(60_001);
    const patch = vi.spyOn(f.k.store, "patch");
    await f.runtime.sweep(); await f.runtime.sweep();
    expect(patch.mock.calls.filter(([, value]) => value.holdExpiredAt !== undefined)).toHaveLength(1);
    expect(f.k.store.runtime("lead").userAt).toBe(receipt);
    expect(f.k.store.runtime("lead").heldAt).toBeNull();
  });
});
