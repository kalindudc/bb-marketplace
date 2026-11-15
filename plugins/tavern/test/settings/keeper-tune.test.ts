// @vitest-environment node
import { seedQuest } from "../server/support";
import { expect, it } from "vitest";
import { setup } from "../server/runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { registerTools } from "../../src/server/tools/index";
it("registers a Keeper-only quest override, rejects thread-wide knobs, pins and ended quests", async () => {
  const f = setup(), settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  settings.update({ revision: 0, patch: { tuning: { mode: "apply" } }, why: "Permit bounded overrides" });
  registerTools(f.bb, f.runtime);
  expect(f.harness.inspection.registrations.agentTools.map(tool => tool.name)).toContain("tavern_tune");
  const q = await seedQuest(f.k,"lead", "Read", "Read");
  const call = (values: Record<string, number>) => f.harness.behavior.invokeAgentTool("tavern_tune", { boardQuestId: q.id, values, why: "Long measured reports" }, { threadId: "lead" });
  await expect(call({ tickSeconds: 90 })).rejects.toThrow(/thread-wide/);
  await call({ staleMinutes: 40 }); expect(settings.read(q.id).knobs.staleMinutes).toBe(40); expect(settings.read().knobs.staleMinutes).toBe(20);
  expect(settings.snapshot().history[0]).toMatchObject({ by: "keeper", questId: q.id, threadId: "lead" });
  settings.update({ revision: settings.snapshot().revision, patch: {}, pins: { staleMinutes: 30 }, why: "Pin it" });
  await expect(call({ staleMinutes: 50 })).rejects.toThrow(/pinned/);
  await f.runtime.stop(q.id); f.runtime.settingsMaintenance();
  await expect(call({ reportBatchSeconds: 90 })).rejects.toThrow(/ended|active|closed/i);
});
