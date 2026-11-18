// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import {
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "./host";
import { Keeper } from "../../src/server/keeper/service";
import { TavernRuntime } from "../../src/server/runtime";
import { queued049 } from "./dispatch-fixture";
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
      new Keeper(f.k.store, f.port, f.time),
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
  it("dates plain fenced snapshots, shares versions with configure and refreshes changed and ten-minute ledgers", async () => {
    const f = setup();
    await seedQuest(f.k, "lead", "Live goal", "Live");
    f.k.store.patch("lead", { userAt: null });
    f.k.memory.note("lead", {
      kind: "fact",
      text: "Remember this ``` fence safely",
    });
    const config = f.runtime.configure(
      makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
    ).instructions!;
    const version = /Ledger as of .*version (\d+)/.exec(config)![1];
    expect(config).toContain("highest ledger version wins");
    expect(config).toContain("```text\nStanding rules:");
    expect(config).not.toContain('"Standing rules:\\n');
    f.k.reanchor("lead", "thread/compacted");
    await f.runtime.tick("lead");
    expect(sends(f)[0]).toContain(`version ${version}`);
    expect(sends(f)[0]).toContain("after compaction");
    f.advance(61_000);
    f.k.store.event(
      f.time(),
      "lead",
      null,
      "route.corrected",
      "A factual notification",
    );
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain("Ledger unchanged since");
    expect(sends(f).at(-1)).toContain("Priorities");
    f.k.memory.note("lead", { kind: "fact", text: "A new durable fact" });
    f.advance(61_000);
    f.k.store.event(
      f.time(),
      "lead",
      null,
      "route.corrected",
      "Another notification",
    );
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).toContain("A new durable fact");
    expect(sends(f).at(-1)).not.toContain("Ledger unchanged since");
    expect(Number(/version (\d+)/.exec(sends(f).at(-1)!)![1])).toBeGreaterThan(
      Number(version),
    );
    f.advance(600_001);
    const count = sends(f).length;
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(count);
    f.k.store.event(
      f.time(),
      "lead",
      null,
      "member.failed",
      "Real news after quiet",
    );
    await f.runtime.tick("lead");
    expect(sends(f).at(-1)).not.toContain("Ledger unchanged since");
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
  it("repeats every unasked outside gate in ticks until actual contact is recorded", async () => {
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
      expect(sends(f).at(-1)).toContain(
        "Outside gate Vault approval not asked yet (lead time 2 days)",
      );
    }
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
    const b = await seedQuest(f.k,"lead", "B", "B");
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
