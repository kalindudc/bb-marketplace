// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
const slot = {
  classId: "smith",
  characterId: null,
  model: null,
  purpose: "A reversible slice",
  waypointIds: ["w1"],
};
const policy = (f: ReturnType<typeof setup>) => {
  f.k.settings = () => ({
    ...DEFAULT_SETTINGS,
    keepers: { ...DEFAULT_SETTINGS.keepers, greenlight: "by-size" },
  });
};
describe("Explicitly selected by-size greenlights", () => {
  it("keeps the default explicit even for a reversible single-member plan", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Small", "Small");
    f.k.plan("lead", { ...planInput(q.id), reversible: true, party: [slot] });
    expect(f.k.quest(q.id).greenlitVersion).toBeNull();
    expect(f.k.store.openAsks("lead")[0]?.kind).toBe("greenlight");
  });
  it("records a reversible automatic decision; undo resets approval and releases unreported members", async () => {
    const f = setup();
    policy(f);
    const q = await seedQuest(f.k,"lead", "Small", "Small");
    f.k.plan("lead", { ...planInput(q.id), reversible: true, party: [slot] });
    expect(f.k.quest(q.id)).toMatchObject({
      phase: "build",
      greenlitVersion: 1,
    });
    const decision = f.k.store.query("decisions", "boardQuestId", q.id)[0]!;
    expect(decision).toMatchObject({ reversible: true, source: "keeper" });
    const m = f.k.bind("child", "smith", "juno", "project", {
      keeperThreadId: "lead",
      boardQuestId: q.id,
      waypointId: "w1",
      errand: false,
      title: "Slice",
      brief: {
        outcome: "Slice",
        outOfScope: "Rest",
        doneWhen: "Checked",
        mode: "make-it-work",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    await f.runtime.undoDecision(decision.id);
    expect(f.k.quest(q.id)).toMatchObject({
      phase: "greenlight",
      greenlitVersion: null,
    });
    expect(f.k.store.runtime(m.threadId).released).toBeTruthy();
    expect(f.k.store.openAsks("lead")[0]?.kind).toBe("greenlight");
  });
  it.each(["irreversible", "party", "questions", "outside", "user", "ask"])(
    "refuses automatic approval with %s",
    async (condition) => {
      const f = setup();
      policy(f);
      const q = await seedQuest(f.k,"lead", "Small", "Small");
      if (condition === "ask")
        f.k.ask("lead", { effect: {type:"decision"},
          question: "Clarify?",
          why: "Unresolved",
          kind: "decision",
          options: [{ id: "a", label: "A", detail: "", recommended: true }],
          meanwhile: "Wait",
          holds: [],
        });
      const base = planInput(q.id);
      f.k.plan("lead", {
        ...base,
        reversible: condition !== "irreversible",
        party: condition === "party" ? [slot, slot] : [slot],
        questions:
          condition === "questions"
            ? [
                {
                  id: "q1",
                  text: "Unresolved?",
                  options: [],
                  recommended: null,
                  reversible: true,
                },
              ]
            : [],
        waypoints: base.waypoints.map((w) => ({
          ...w,
          actor:
            condition === "outside"
              ? "outside"
              : condition === "user"
                ? "user"
                : "agent",
        })),
      });
      expect(f.k.quest(q.id).greenlitVersion).toBeNull();
    },
  );
});
