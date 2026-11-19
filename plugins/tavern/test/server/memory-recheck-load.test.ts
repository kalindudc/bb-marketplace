// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { makePluginAgentConfigurationContext } from "./host";
import { localClock } from "../../src/server/clock";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
const brief = {
  outcome: "Slice",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Evidence",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
const pad = (p: string, n: number) => (p + " detail".repeat(n)).slice(0, n);
const approve = (f: ReturnType<typeof setup>) => {
  for (const a of f.k.store
    .openAsks("lead")
    .filter((a) => a.kind === "greenlight"))
    f.k.answerAsk(a.id, "approve", null, "page", "user");
};
describe("Re-check load, last reply and paused ticks", () => {
  it("N-7 keeps all four quests and 40 waypoint markers at Samson's R1a load", async () => {
    const f = setup(),
      ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const q = await seedQuest(f.k,"lead", pad(`QUEST-${i}`, 120), `Q${i}`);
      ids.push(q.id);
      f.k.store.put("quests", q.id, { ...f.k.quest(q.id), delegations: Array.from({ length: 100 }, (_, n) => ({ id: `delegation-${n}`, kind: "credential", at: f.time(), surface: "client (unattested)", endedAt: null, revokedAt: n < 99 ? f.time() : null })), preapprovals: Array.from({ length: 100 }, (_, n) => ({ id: `preapproval-${n}`, at: f.time(), surface: "client (unattested)", endedAt: null, revokedAt: n < 99 ? f.time() : null, greenlight: null, placement: true, conclude: true, endsAt: null, retriesUsed: 0 })) });
      f.k.resetRoutes("lead");
      f.k.plan("lead", {
        ...planInput(q.id),
        doneWhen: pad(`DONE-${i}`, 400),
        assumptions: Array.from({ length: 5 }, (_, a) =>
          pad(`ASSUME-${i}-${a}`, 150),
        ),
        waypoints: Array.from({ length: 10 }, (_, j) => ({
          ...planInput(q.id).waypoints[0]!,
          id: `w${j + 1}`,
          title: pad(`WP-${i}-${j + 1}-END`, 120),
          actor: j === 3 ? "outside" : "agent",
          owner: j === 3 ? "Luc" : "smith",
          leadTime: j === 3 ? "2 days" : "30 min",
          dependsOn: j ? [`w${j}`] : [],
        })),
      });
      approve(f);
      for (let j = 0; j < 3; j++) {
        const m = f.k.bind(`m-${i}-${j}`, "smith", "juno", "project", {
          keeperThreadId: "lead",
          boardQuestId: q.id,
          waypointId: `w${j + 1}`,
          errand: false,
          title: "Work",
          brief,
        });
        f.k.store.put("members", m.threadId, {
          ...m,
          doing: pad("Doing", 200),
        });
      }
    }
    for (let i = 0; i < 4; i++)
      for (let s = 0; s < 3; s++) {
        f.k.receiveUser("lead", pad(`STEER-${i}-${s}`, 180));
        f.k.route("lead", {
          kind: "steer",
          boardQuestId: ids[i],
          summary: "s",
          notes: [],
        });
      }
    for (let i = 0; i < 8; i++)
      f.k.memory.note("lead", {
        kind: i % 2 ? "fact" : "waiting-on-user",
        text: pad(`NOTE-${i}`, 300),
        boardQuestId: ids[i % 4],
      });
    for (let i = 0; i < 14; i++)
      f.k.addRule(
        {
          scope: "keeper",
          scopeId: "lead",
          text: pad(`RULE-${i}`, 200),
          source: "user",
        },
        "lead",
      );
    for (let i = 0; i < 6; i++)
      f.k.ask("lead", { effect: {type:"decision"},
        boardQuestId: ids[i % 4],
        kind: "decision",
        question: pad(`ASK-${i}-END`, 300),
        why: "w",
        options: [{ id: "a", label: "A", detail: "", recommended: true }],
        meanwhile: pad("m", 200),
        holds: ["w5"],
        proceedInMinutes: 30,
        reversible: true,
      });
    const text = f.k.restatement("lead"),
      config = f.runtime.configure(
        makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
      ).instructions!;
    for (const t of [text, config]) {
      for (let i = 0; i < 4; i++) {
        expect(t).toContain(`QUEST-${i}`);
        for (let j = 1; j <= 10; j++) expect(t).toContain(`WP-${i}-${j}-END`);
      }
    }
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(28000);
    expect(Buffer.byteLength(config)).toBeLessThanOrEqual(32000);
    expect(text).not.toContain("more quests");
    expect(text).toContain("5 assumptions; call tavern_status");
  });
  it("orders an old outside gate before a more recently changed ordinary quest", async () => {
    const f = setup(),
      old = await seedQuest(f.k,"lead", "OLD-GATE", "Old");
    f.k.plan("lead", {
      ...planInput(old.id),
      waypoints: [
        { ...planInput(old.id).waypoints[0]!, actor: "outside", owner: "Luc" },
      ],
    });
    f.advance(60000);
    const recent = await seedQuest(f.k,"lead", "RECENT", "New");
    f.k.plan("lead", planInput(recent.id));
    const text = f.k.restatement("lead");
    expect(text.indexOf("OLD-GATE")).toBeLessThan(text.indexOf("RECENT"));
  });
  it("captures a real last reply, retains 300 characters of a blocked report, and uses one offset clock", async () => {
    const f = setup(),
      q = await seedQuest(f.k,"lead", "Review", "Review");
    f.k.plan("lead", planInput(q.id));
    approve(f);
    const m = f.k.bind("vex", "warden", "vex", "project", {
      keeperThreadId: "lead",
      boardQuestId: q.id,
      waypointId: null,
      errand: false,
      title: "Review",
      brief,
    });
    const outcome =
      "Blocked: " +
      "x".repeat(160) +
      " Assign this Warden to w1 before verifying it.";
    f.k.report(m.threadId, {
      status: "blocked",
      outcome,
      evidence: [],
      artifacts: [],
      confidence: null,
      voice: null,
    });
    f.k.memory.lastReply(
      "lead",
      "Send one line and I'll hire it straight away. " + "y".repeat(500),
    );
    const text = f.k.restatement("lead");
    expect(text).toContain("Last thing you told the user (");
    expect(text).toContain("straight away");
    expect(text).toContain("Assign this Warden to w1 before verifying it.");
    expect(f.k.store.runtime("lead").lastReply!.text).toHaveLength(400);
    expect(localClock(f.time())).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d$/,
    );
    expect(text).not.toContain(".000Z");
  });
  it("pausing holds re-anchors and failure blockers, keeps asks answerable, and unpauses with one full ledger", async () => {
    const f = setup();
    let paused = true;
    vi.spyOn(f.runtime, "config").mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      tavern: { ...DEFAULT_SETTINGS.tavern, paused },
    }));
    f.runtime.settingsChanged();
    const q = await seedQuest(f.k,"lead", "A", "A");
    f.k.plan("lead", planInput(q.id));
    f.k.reanchor("lead", "thread/compacted");
    f.runtime.failed("lead", "Provider failed", "r1");
    f.runtime.failed("lead", "Provider failed", "r2");
    approve(f);
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(
      f.k.store.openAsks("lead").filter((a) => a.kind === "blocker"),
    ).toHaveLength(0);
    expect(f.k.quest(q.id).greenlitVersion).toBe(1);
    paused = false;
    f.runtime.settingsChanged();
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    const text = (
      f.harness.inspection.sdk.callsTo("threads.send")[0]!.args[0] as {
        input: { text: string }[];
      }
    ).input[0]!.text;
    expect(text).toContain("Ledger as of");
    f.advance(601_000);
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
});
