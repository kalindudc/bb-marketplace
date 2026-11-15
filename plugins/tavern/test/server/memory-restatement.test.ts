// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { makePluginAgentConfigurationContext } from "./host";
import { readStatus, statusInput } from "../../src/server/status";
import { journalEntrySchema } from "../../src/shared/schema";
import { criticalWaypoints } from "../../src/server/keeper/restatement";
import { localClock } from "../../src/server/clock";

const brief = {
  outcome: "Bounded task",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Evidence",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
const pad = (prefix: string, length: number) =>
  (prefix + " detail".repeat(length)).slice(0, length);
function approve(f: ReturnType<typeof setup>) {
  for (const ask of f.k.store
    .openAsks("lead")
    .filter((a) => a.kind === "greenlight"))
    f.k.answerAsk(ask.id, "approve", null, "page");
}

describe("Complete Keeper restatement", () => {
  it("puts newest standing rules first, labels proposals, and pages every overflow rule", () => {
    const f = setup();
    for (let i = 0; i < 12; i++)
      f.k.addRule(
        {
          scope: "keeper",
          scopeId: "lead",
          text: pad(`RULE-${i}-END`, 300),
          source: "user",
        },
        "lead",
      );
    f.k.addRule(
      {
        scope: "keeper",
        scopeId: "lead",
        text: "PROPOSED-RULE Ranger time boxes under 8 minutes",
        source: "keeper-proposed",
      },
      "lead",
    );
    const text = f.k.restatement("lead");
    expect(text.startsWith("Standing rules:")).toBe(true);
    expect(text.indexOf("RULE-11-END")).toBeLessThan(
      text.indexOf("RULE-10-END"),
    );
    expect(text).toContain("older rules; call tavern_status section=rules");
    expect(text).toContain("Proposed, waiting for the user");
    expect(text).toContain("PROPOSED-RULE");
    const rows = [0, 10].flatMap(
      (offset) =>
        (
          readStatus(
            f.runtime,
            "lead",
            statusInput.parse({ section: "rules", limit: 10, offset }),
          ) as { rules: { text: string }[] }
        ).rules,
    );
    expect(rows).toHaveLength(13);
    expect(rows.some((row) => row.text.startsWith("RULE-0-END"))).toBe(true);
  });
  it("orders ready work by remaining critical-path lead time without putting dependants first", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Cutover", "Cutover");
    const base = planInput(q.id).waypoints[0]!;
    f.k.plan("lead", {
      ...planInput(q.id),
      waypoints: [
        {
          ...base,
          id: "w1",
          title: "Five-minute optional task",
          leadTime: "5 min",
        },
        {
          ...base,
          id: "w2",
          title: "Two-day gate",
          actor: "outside",
          owner: "Luc",
          leadTime: "2 days",
        },
        {
          ...base,
          id: "w3",
          title: "A day of work after the gate",
          dependsOn: ["w2"],
          leadTime: "1 day",
        },
      ],
    });
    const sorted = criticalWaypoints(f.k.summary(q.id).waypoints).map(
      (w) => w.id,
    );
    expect(sorted).toEqual(["w2", "w3", "w1"]);
    const text = f.k.restatement("lead");
    expect(text.indexOf("w2 [")).toBeLessThan(text.indexOf("w1 ["));
    expect(text).toContain(
      "Next link: w2: Two-day gate; outside Luc; lead time 2 days",
    );
  });
  it.each([false, true])("fits the design maximum with every quest, waypoint, party member and open ask in configure (holds: %s)", async held => {
    const f = setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const title = pad(`QUEST-${i}-END`, 180);
      let q;
      if (held) {
        f.k.receiveUser("lead", pad("Hold the checker handoff until my explicit signal", 2000));
        f.k.route("lead", { kind: "new-quest", summary: title, notes: [], checkerHandoffHold: { reason: pad("Wait for my signal", 1000) } });
        q = await f.k.openQuest("lead", title, `Q${i}`);
      } else q = await seedQuest(f.k, "lead", title, `Q${i}`);
      ids.push(q.id);
      const base = planInput(q.id).waypoints[0]!;
      f.k.plan("lead", {
        ...planInput(q.id),
        doneWhen: pad(`DONE-${i}-END`, 600),
        waypoints: Array.from({ length: 6 }, (_, j) => ({
          ...base,
          id: `w${j}`,
          title: pad(`WAYPOINT-${i}-${j}-END`, 150),
          actor: j === 2 ? "outside" : "agent",
          owner: j === 2 ? "Luc (Vault approver)" : "smith",
          leadTime: j === 2 ? "release train Thursday 10:00" : "20 min",
          dependsOn: j ? [`w${j - 1}`] : [],
          doneWhen: pad("Evidence", 300),
        })),
      });
      approve(f);
      for (let j = 0; j < 3; j++)
        f.k.bind(`member-${i}-${j}`, "smith", "juno", "project", {
          displayName: `Juno ${i}-${j}`,
          keeperThreadId: "lead",
          boardQuestId: q.id,
          waypointId: `w${j}`,
          errand: false,
          title: "Bounded work",
          brief,
        });
    }
    for (let i = 0; i < 6; i++)
      f.k.ask("lead", {
        boardQuestId: ids[i % 4],
        kind: "decision",
        question: pad(`ASK-${i}-END`, 380),
        why: "A reversible choice",
        options: [
          { id: "a", label: "Small option", detail: "", recommended: true },
        ],
        meanwhile: pad("Continue unrelated work", 280),
        holds: ["w4"],
        proceedInMinutes: 30,
        reversible: true,
      });
    for (let i = 0; i < 14; i++)
      f.k.addRule(
        {
          scope: "keeper",
          scopeId: "lead",
          text: pad(`RULE-${i}-END`, 200),
          source: "user",
        },
        "lead",
      );
    f.k.addRule(
      {
        scope: "keeper",
        scopeId: "lead",
        text: "PROPOSED-RULE",
        source: "keeper-proposed",
      },
      "lead",
    );
    for (let i = 0; i < 8; i++)
      f.k.decide("lead", {
        text: pad(`DECISION-${i}-END`, 250),
        why: pad("Because", 200),
        reversible: true,
        source: "keeper",
      });
    f.k.bind("errand-1", "wanderer", "otto", "project", {
      keeperThreadId: "lead",
      boardQuestId: null,
      waypointId: null,
      errand: true,
      title: "Lunch menus",
      brief,
    });
    const text = f.k.restatement("lead");
    const configured = f.runtime.configure(
      makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
    ).instructions!;
    expect(Buffer.byteLength(configured)).toBeLessThanOrEqual(32_000);
    expect(configured).not.toContain("�");
    expect(configured).toContain("see Recent decisions below");
    if (held) for (const id of ids) expect(configured).not.toContain(f.k.quest(id).checkerHandoffHold!.id);
    for (const output of [text, configured]) {
      for (let i = 0; i < 4; i++) {
        expect(output).toContain(`QUEST-${i}-END`);
        expect(output).toContain(`DONE-${i}-END`);
        for (let j = 0; j < 6; j++)
          expect(output).toContain(`WAYPOINT-${i}-${j}-END`);
        for (let j = 0; j < 3; j++)
          expect(output).toContain(`Juno ${i}-${j} (smith)`);
      }
      for (let i = 0; i < 6; i++) expect(output).toContain(`ASK-${i}-END`);
      for (const wanted of [
        "RULE-13-END",
        "PROPOSED-RULE",
        "Luc (Vault approver)",
        "release train Thursday 10:00",
        "Lunch menus",
        "defaults at",
        "Review queue:",
        "Decided for you since the last tick",
      ])
        expect(output).toContain(wanted);
    }
  });
  it("rebuilds Jim's 01:33 state without depending on a compactor's chat summary", async () => {
    const f = setup();
    const missing = await seedQuest(f.k,
      "lead",
      "Missing plugins in README",
      "Missing",
    );
    const loc = await seedQuest(f.k,"lead", "TypeScript line totals", "LOC");
    const entries = new Map<
      string,
      ReturnType<typeof journalEntrySchema.parse>[]
    >();
    for (const [q, id, title, leadTime] of [
      [
        missing,
        "thr_z5k6x43jc2",
        "Write the three-section missing-plugins.md",
        "done",
      ],
      [
        loc,
        "thr_4d5aferz3e",
        "loc.md with total, source and test per plugin",
        "7 min (file written; Warden check left)",
      ],
    ] as const) {
      const owner = f.k.bind(id, "ranger", "lark", "project", {
        keeperThreadId: "lead",
        boardQuestId: q.id,
        waypointId: "w1",
        errand: false,
        title,
        displayName: "Lark",
        brief,
      });
      f.k.store.put("members", id, {
        ...owner,
        state: "stopped",
        doing: "File written; independent Warden check remains",
      });
      f.k.plan("lead", {
        ...planInput(q.id),
        doneWhen:
          q.id === loc.id
            ? "A Warden re-counts git ls-files: 237,382 lines in 1,084 files"
            : "A Warden checks the three sections, missing install lines and missing folders",
        waypoints: [
          { ...planInput(q.id).waypoints[0]!, title, owner: id, leadTime },
        ],
        party: [
          {
            classId: "warden",
            characterId: "rook",
            model: null,
            purpose: "Check w1 with independent evidence",
            waypointIds: ["w1"],
          },
        ],
      });
      approve(f);
      entries.set(q.id, [
        journalEntrySchema.parse({
          threadId: id,
          id: "a1",
          parentId: null,
          description: title,
          status: "done",
          owner: id,
          note: null,
          evidence: [
            {
              kind: "file",
              ref: q.id === loc.id ? "loc.md" : "missing-plugins.md",
            },
          ],
          link: { boardQuestId: q.id, waypointId: "w1" },
          order: 0,
          createdBy: { kind: "agent", threadId: id },
          createdAt: f.time(),
          updatedAt: f.time(),
          updatedBy: { kind: "agent", threadId: id },
        }),
      ]);
    }
    f.port.linkedEntries = (qid) => entries.get(qid) ?? [];
    f.k.addRule(
      {
        scope: "keeper",
        scopeId: "lead",
        text: "From now on, keep every Ranger time box under 8 minutes",
        source: "keeper-proposed",
      },
      "lead",
    );
    const vex = f.k.bind("thr_f8kheswkzk", "warden", "vex", "project", {
      keeperThreadId: "lead",
      boardQuestId: missing.id,
      waypointId: null,
      errand: false,
      title: "Warden check",
      displayName: "Vex",
      brief,
    });
    f.k.report(vex.threadId, {
      status: "blocked",
      outcome:
        "Tavern refused to let me verify entry 02 (w1). The exact error was: Only a Warden assigned to this board quest and waypoint can verify or reject this entry. Assign this thread as Warden for w1 before verifying.",
      evidence: [
        { kind: "note", ref: "assignment refusal", detail: "", exitCode: null },
      ],
      artifacts: [],
      confidence: null,
      voice: null,
    });
    f.k.memory.lastReply(
      "lead",
      "Send one line for the missing-plugins quest and I'll hire it straight away.",
    );
    f.k.receiveUser(
      "lead",
      "Also list README links that point to missing plugin folders",
    );
    f.k.route("lead", {
      kind: "steer",
      boardQuestId: missing.id,
      summary: "Widen missing plugins",
      notes: [],
    });
    f.k.receiveUser(
      "lead",
      "Close LOC like missing-plugins: a plan and Warden check of loc.md",
    );
    f.k.route("lead", {
      kind: "steer",
      boardQuestId: loc.id,
      summary: "Close LOC properly",
      notes: [],
    });
    let text = f.k
      .restatement("lead")
      .replaceAll(missing.id, "Q-MISSING")
      .replaceAll(loc.id, "Q-LOC")
      .replace(/(?:ask|rule|note)_[0-9a-f-]+/g, "RECORD")
      .replaceAll(localClock(f.time()), "01:33 (local with offset)");
    expect(text).toContain("237,382 lines in 1,084 files");
    expect(text).toContain("Lark (ranger, stopped)");
    expect(text).toContain("w1 [reported]");
    await expect(text).toMatchFileSnapshot("./fixtures/keeper-0133.txt");
  });
});
