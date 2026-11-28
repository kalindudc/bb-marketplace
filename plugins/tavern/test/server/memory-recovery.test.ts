// @vitest-environment node
import { withMemberFixtures } from "./member-fixture";
import { seedLegacyQuest, seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import {
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "./host";
import { Keeper } from "../../src/server/keeper/service";
import { TavernRuntime } from "../../src/server/runtime";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { planInput } from "./support";

function observeEvents(f: ReturnType<typeof setup>, events: unknown[]) {
  f.bb.sdk.threads.events.list = async () => events as never;
  return f.runtime.observe(
    makeThreadResponse({ id: "lead" }),
    Math.max(...events.map((e) => (e as { seq: number }).seq)),
  );
}
const interrupted = (at: number, reason = "manual-stop") => ({
  seq: 1,
  type: "system/thread/interrupted",
  data: { reason },
  scope: { kind: "thread" },
  createdAt: at,
});
const sends = (f: ReturnType<typeof setup>) =>
  f.harness.inspection.sdk
    .callsTo("threads.send")
    .map(
      (call) => (call.args[0] as { input: { text: string }[] }).input[0]!.text,
    );

describe("Keeper context-loss recovery", () => {
  it("keeps a manually stopped Keeper quiet for five minutes despite mailbox facts, then restates after the user speaks", async () => {
    const f = setup();
    await seedQuest(f.k,"lead", "Live goal", "Live");
    await observeEvents(f, [interrupted(f.time())]);
    f.k.store.event(
      f.time(),
      "lead",
      null,
      "member.failed",
      "Member needs attention",
    );
    const reloaded = new TavernRuntime(
      f.bb,
      withMemberFixtures(new Keeper(f.k.store, f.port, f.time)),
      f.runtime.registry,
    );
    for (let i = 0; i < 5; i++) {
      f.advance(61_000);
      await reloaded.tick("lead");
    }
    expect(sends(f)).toHaveLength(0);
    f.k.receiveUser("lead", "What happened?");
    f.k.route("lead", {
      kind: "question",
      summary: "Explain current work",
      notes: [],
    });
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(1);
    expect(sends(f)[0]).toContain("after you stopped me");
    expect(sends(f)[0]).toContain("Member needs attention");
    expect(sends(f)[0]).toContain("Call tavern_status for each quest");
  });
  it.each(["host-daemon-restarted", "provider-turn-idle"])(
    "keeps immediate re-anchors for %s",
    async (reason) => {
      const f = setup();
      await observeEvents(f, [interrupted(f.time(), reason)]);
      await f.runtime.tick("lead");
      expect(sends(f)).toHaveLength(1);
    },
  );
  it("backs off after two failed turns, offers one blocker, and only resumes retries on an explicit answer", async () => {
    const f = setup();
    f.bb.sdk.threads.get = async () =>
      makeThreadResponse({ id: "lead", status: "error" });
    for (let i = 0; i < 10; i++) {
      f.runtime.failed("lead", "API offline", `request-${i}`);
      f.advance(61_000);
      await f.runtime.tick("lead");
    }
    expect(sends(f).length).toBeLessThanOrEqual(2);
    expect(sends(f)[0]).toContain("after a failed turn");
    const asks = f.k.store.openAsks("lead").filter((a) => a.kind === "blocker");
    expect(asks).toHaveLength(1);
    expect(asks[0]!.why).toContain("API offline");
    expect(asks[0]!.options.map((o) => o.id)).toEqual([
      "retry",
      "switch-model",
    ]);
    await f.runtime.answerAsk(asks[0]!.id, "retry", null, "page");
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").failureCount).toBe(0);
    expect(sends(f).at(-1)).toContain("retry");
  });
  it("deduplicates a failed request and resets the failure count only on a successful completed turn", async () => {
    const f = setup();
    f.runtime.failed("lead", "API offline", "r1");
    f.runtime.failed("lead", "API offline", "r1");
    expect(f.k.store.runtime("lead").failureCount).toBe(1);
    await observeEvents(f, [
      {
        seq: 1,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "t1" },
        data: { status: "failed" },
        createdAt: f.time(),
      },
    ]);
    expect(f.k.store.runtime("lead").failureCount).toBe(1);
    await observeEvents(f, [
      {
        seq: 2,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "t2" },
        data: { status: "completed" },
        createdAt: f.time(),
      },
    ]);
    expect(f.k.store.runtime("lead").failureCount).toBe(0);
  });
  const news = (f: ReturnType<typeof setup>) => f.k.store.event(f.time(), "lead", null, "route.corrected", "A factual notification");
  it("sends added and removed ledger lines, never a periodic full refresh", async () => {
    const f = setup();
    await seedQuest(f.k, "lead", "Live goal", "Live");
    f.k.store.patch("lead", { userAt: null });
    f.k.memory.note("lead", { kind: "fact", text: "Remember this ``` fence safely" });
    const expiring = f.k.memory.note("lead", { kind: "fact", text: "This note will expire", validUntil: f.time() + 180_000 });
    news(f);
    await f.runtime.tick("lead");
    const first = sends(f)[0]!;
    expect(first).toContain("Ledger as of");
    expect(first).toContain("```text\nStanding rules:");
    expect(first).toContain("Remember this `\u200b`` fence safely");
    const version = /Ledger as of .*version (\d+)/.exec(first)![1];
    f.advance(61_000);
    news(f);
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain(`You last saw version ${version}`);
    expect(sends(f).at(-1)).toContain("No ledger changes");
    expect(f.k.ledger("lead").version).toBe(Number(version));
    f.advance(600_001);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(2);
    f.k.memory.note("lead", { kind: "fact", text: "A new durable fact" });
    news(f);
    await f.runtime.tick("lead");
    const delta = sends(f).at(-1)!;
    expect(delta).toContain(`Facts, promises and hand-backs:\n- ${expiring.id}`);
    expect(delta).toContain("A new durable fact");
    expect(delta).not.toContain("Remember this");
    expect(delta).not.toContain("Live goal");
    expect(delta).not.toContain("Ledger as of");
  });
  it("holds a compaction re-anchor until actionable news or an unrouted user message", async () => {
    const f = setup();
    news(f);
    await f.runtime.tick("lead");
    await observeEvents(f, [{ seq: 1, type: "thread/compacted", data: {}, createdAt: f.time() }]);
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(1);
    expect(f.k.store.runtime("lead").reanchor).toBe("after compaction");
    await seedQuest(f.k, "lead", "New live title", "Live");
    f.k.receiveUser("lead", "Read the updated ledger");
    const humanContext = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions;
    expect(humanContext).toContain("New live title");
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain('Not yet routed: "Read the updated ledger"');
    expect(sends(f).at(-1)).toContain("after compaction");
    expect(sends(f).at(-1)).toContain("Ledger as of");
    expect(f.k.store.runtime("lead").reanchor).toBeNull();
  });
  it("restates on plugin reload and when the Keeper gets another provider session", async () => {
    const f = setup();
    news(f);
    await f.runtime.tick("lead");
    f.advance(61_000);
    news(f);
    const reloaded = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await reloaded.tick("lead");
    expect(sends(f)[1]).toContain("Ledger as of");
    f.advance(61_000);
    await observeEvents({ ...f, runtime: reloaded }, [{ seq: 1, type: "thread/started", data: { threadId: "lead" }, createdAt: f.time() }]);
    news(f);
    await reloaded.tick("lead");
    expect(sends(f)[2]).toContain("Ledger as of");
  });
  it("uses the full ledger when the delta is larger or clipping changes", async () => {
    const f = setup();
    const snapshot = f.k.ledger("lead");
    const ledger = vi.spyOn(f.k, "ledger");
    const large = "Test:\n" + Array.from({ length: 20 }, (_, i) => `Unchanged fact ${i}`).join("\n");
    for (const [index, text] of ["Test:\nOld fact", "Test:\nNew fact", large, `${large}\n[Truncated; call tavern_status for the rest.]`].entries()) {
      f.advance(61_000);
      ledger.mockReturnValue({ ...snapshot, text, version: index + 1 });
      news(f);
      await f.runtime.tick("lead");
      expect(sends(f).at(-1)).toContain("Ledger as of");
    }
  });
  it("sends a delta when windowed notes or decisions overflow and treats lines leaving the window as out of view", async () => {
    const f = setup();
    for (let i = 0; i < 20; i++) {
      f.advance(1);
      f.k.memory.note("lead", { kind: "fact", text: `Unchanged note ${i}: ${"context ".repeat(36)}` });
      f.k.decide("lead", { text: `Prior choice ${i}: ${"detail ".repeat(25)}`, why: "Keep the recorded result", reversible: true, source: "keeper" });
    }
    const before = f.k.ledger("lead");
    expect(before.text).toMatch(/\d+ more notes/);
    expect(before.text).toMatch(/\d+ more decisions/);
    news(f);
    await f.runtime.tick("lead");
    f.advance(61_000);
    const decision = f.k.decide("lead", { text: `New visible decision: ${"detail ".repeat(25)}`, why: "Keep the recorded result", reversible: true, source: "keeper" });
    f.k.memory.note("lead", { kind: "fact", text: `New visible note: ${"context ".repeat(36)}` });
    news(f);
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain(`You last saw version ${before.version}`);
    expect(sends(f).at(-1)).toContain("out of view");
    expect(sends(f).at(-1)).toMatch(/- note_/);
    expect(sends(f).at(-1)).toContain(`+ ${decision.id}`);
    expect(sends(f).at(-1)).not.toContain("Unchanged note 19");
  });
  it("does not advance the delivered ledger or consume a report or answer when a queued tick is cancelled", async () => {
    const f = setup();
    f.k.store.onEvent = undefined;
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    news(f);
    await f.runtime.tick("lead");
    const basis = f.k.store.runtime("lead").lastLedger;
    const ask = f.k.ask("lead", { kind: "decision", effect: { type: "decision" }, question: "Pick a result", why: "Test delivery", options: [{ id: "yes", label: "Yes", detail: "Accept", recommended: true }], meanwhile: "Wait", holds: [] });
    f.k.answerAsk(ask.id, "yes", null, "page", "user");
    f.k.bind("maker", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Check the result",
      brief: { outcome: "Check it", mode: "make-it-work", doneWhen: "Report", outOfScope: "", questions: [], context: [], timeboxMinutes: null } });
    const report = f.k.report("maker", { status: "blocked", outcome: "A new report", evidence: [], artifacts: [], confidence: null, voice: null });
    f.k.memory.note("lead", { kind: "fact", text: "New state in queued tick" });
    f.advance(61_000);
    send.mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.runtime.tick("lead");
    const queued = f.k.store.pendingTick("lead")!;
    expect(queued.text).toContain(ask.id);
    expect(queued.text).toContain("New state in queued tick");
    expect(f.k.store.runtime("lead").lastLedger).toEqual(basis);
    expect(f.k.store.get("reports", report.id)?.deliveredAt).toBeNull();
    f.runtime.cancelTick(queued.text);
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain("Ask answer (data)");
    expect(sends(f).at(-1)).toContain(ask.id);
    expect(sends(f).at(-1)).toContain("New state in queued tick");
    expect(sends(f).at(-1)).toContain("A new report");
    expect(f.k.store.get("reports", report.id)?.deliveredAt).toBe(f.time());
    expect(f.k.store.runtime("lead").lastLedger).not.toEqual(basis);
  });
  it("rebuilds a queued delta rather than delivering it after compaction", async () => {
    const f = setup();
    const send = vi.spyOn(f.bb.sdk.threads, "send");
    news(f);
    await f.runtime.tick("lead");
    f.advance(61_000);
    news(f);
    send.mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.runtime.tick("lead");
    const queued = f.k.store.pendingTick("lead")!;
    expect(queued.fullLedger).toBe(false);
    await observeEvents(f, [{ seq: 1, type: "thread/compacted", data: {}, createdAt: f.time() }]);
    const row = queued049("queued-tick", queued.text, f.time(), { pluginId: "tavern" });
    expect(await f.runtime.dispatch(dispatch049({ rows: [row] }))).toMatchObject({ action: "wait" });
    expect(f.k.store.runtime("lead").queuedTickResetId).toBe(queued.id);
    f.bb.sdk.threads.queuedMessages.list = vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]);
    f.bb.sdk.threads.queuedMessages.delete = vi.fn().mockResolvedValue({ ok: true });
    await f.runtime.tick("lead");
    expect(f.k.store.tick(queued.id)?.state).toBe("cancelled");
    expect(sends(f).at(-1)).toContain("after compaction");
    expect(sends(f).at(-1)).toContain("Ledger as of");
  });
  it("does not treat an old drained row or a queue announcement as permission to resume manual Stop", async () => {
    const f = setup();
    const old = queued049("old", "Before Stop", f.time());
    f.runtime.queued(old);
    f.advance(10);
    await observeEvents(f, [interrupted(f.time())]);
    f.advance(61_000);
    f.runtime.dispatched(old);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(0);
    f.runtime.queued(queued049("later", "New queued row", f.time()));
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(0);
    expect(f.k.store.runtime("lead").manualStopAt).not.toBeNull();
  });
  it("warns about an unasked gate only when ready and its details change", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Outside work", "Outside");
    f.k.plan("lead", {
      ...planInput(q.id),
      waypoints: [
        {
          ...planInput(q.id).waypoints[0]!,
          actor: "outside",
          owner: "Luc",
          title: "Vault approval",
          leadTime: "2 days",
        },
      ],
    });
    f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page", "user");
    for (let i = 0; i < 2; i++) {
      f.advance(61_000);
      f.k.store.event(
        f.time(),
        "lead",
        null,
        "member.failed",
        `Real news ${i}`,
      );
      await f.runtime.tick("lead");
      const warning = "Outside gate Vault approval not asked yet (lead time 2 days)";
      if (i === 0) expect(sends(f).at(-1)).toContain(warning);
      else expect(sends(f).at(-1)).not.toContain(warning);
    }
    const plan = f.k.summary(q.id).plan!;
    f.k.plan("lead", { ...planInput(q.id), waypoints: [{ ...plan.waypoints[0]!, leadTime: "3 days" }] });
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain("Outside gate Vault approval not asked yet (lead time 3 days)");
    f.k.memory.gate("lead", {
      boardQuestId: q.id,
      waypointId: "w1",
      askedWho: "Luc",
      via: "Asked through the user",
    });
    f.k.store.event(
      f.time(),
      "lead",
      q.id,
      "member.stale",
      "A new external fact",
    );
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).not.toContain("not asked yet");
    expect(sends(f).at(-1)).toContain("asked Luc at");
  });
  it("keeps every current quest's last three steers in the user's own words", async () => {
    const f = setup();
    const a = await seedQuest(f.k,"lead", "A", "A");
    const b = seedLegacyQuest(f.k,"lead", "B", "B");
    for (let i = 0; i < 4; i++) {
      f.advance(1);
      f.k.receiveUser("lead", `Exact user steer ${i}`);
      f.k.route("lead", {
        kind: "steer",
        boardQuestId: a.id,
        summary: "Keeper paraphrase",
        notes: [],
      });
    }
    f.k.receiveUser("lead", "Never alter B's rollback");
    f.k.route("lead", {
      kind: "steer",
      boardQuestId: b.id,
      summary: "Different paraphrase",
      notes: [],
    });
    const text = f.k.restatement("lead");
    expect(text).not.toContain("Exact user steer 0");
    for (const wanted of [
      "Exact user steer 1",
      "Exact user steer 2",
      "Exact user steer 3",
      "Never alter B's rollback",
    ])
      expect(text).toContain(wanted);
  });
});
