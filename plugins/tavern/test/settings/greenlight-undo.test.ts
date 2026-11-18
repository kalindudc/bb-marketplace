// @vitest-environment node
import { putQuestFixture } from "../server/support";
import { expect, it, vi } from "vitest";
import { setup } from "../server/runtime-fixture";
import { planInput } from "../server/support";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";

async function fixture() {
  const f = setup(), settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  settings.update({ revision: 0, patch: { keepers: { greenlight: "by-size" } }, why: "Allow one reversible member" });
  f.k.receiveUser("lead", "Build"); f.k.route("lead", { kind: "new-quest", summary: "Build", notes: [] });
  const quest = await f.k.openQuest("lead", "Build", "Build");
  await f.runtime.plan("lead", { ...planInput(quest.id), reversible: true,
    party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  const decision = f.k.store.all("decisions").find(d => f.k.store.get("autoGreenlights", d.id))!;
  f.k.bind("child", "smith", "ash", "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: "w1", errand: false, title: "Build", brief: { outcome: "Build", doneWhen: "Pass", mode: "make-it-work", outOfScope: "", context: [], questions: [], timeboxMinutes: null } });
  return { ...f, quest, decision };
}
it("does not release a later explicitly approved party when Undo targets an old automatic approval", async () => {
  const f = await fixture(), release = vi.spyOn(f.runtime, "release").mockResolvedValue(true);
  putQuestFixture(f.k.store, f.quest.id, { ...f.k.quest(f.quest.id), planVersion: 2, greenlitVersion: 2, phase: "build" });
  await f.runtime.undoDecision(f.decision.id);
  expect(release).not.toHaveBeenCalled();
  expect(f.k.quest(f.quest.id).greenlitVersion).toBe(2);
});
it("records the actual reset version so a failed release can be retried without resetting or releasing later plans", async () => {
  const f = await fixture(), release = vi.spyOn(f.runtime, "release").mockResolvedValue(false);
  await f.runtime.undoDecision(f.decision.id);
  expect(f.k.store.get("autoGreenlights", f.decision.id)?.undonePlanVersion).toBe(1);
  expect(release).toHaveBeenCalledTimes(1);
  await f.runtime.undoDecision(f.decision.id);
  expect(release).toHaveBeenCalledTimes(2);
  putQuestFixture(f.k.store, f.quest.id, { ...f.k.quest(f.quest.id), planVersion: 2, greenlitVersion: 2, phase: "build" });
  await f.runtime.undoDecision(f.decision.id);
  expect(release).toHaveBeenCalledTimes(2);
});
