// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { registrySchema, rpcContract } from "../../src/shared/contract";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { registerRpc } from "../../src/server/rpc";
import { reportSchema } from "../../src/shared/schema";
import { setup } from "../server/runtime-fixture";

const MODES = ["full", "light", "off"] as const;
const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(enabled = true) {
  const f = setup(); databases.push(f.k.store.db);
  const settings = new SettingsStore(f.k.store.db, f.time);
  if (enabled) f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Format", brief: {
    outcome: 'For NaN return exactly "unknown".', doneWhen: "Checked", mode: "make-it-work", outOfScope: "Production", context: ["Retain the literal <unknown>"], questions: [], timeboxMinutes: null,
  } });
  f.k.bind("solo", "smith", "juno", "project");
  registerRpc(f.bb, f.runtime);
  const setMode = (mode: typeof MODES[number]) => settings.update({ revision: settings.snapshot().revision, patch: { tavern: { voice: mode } }, why: "Speech bubble preference" });
  return { ...f, setMode };
}
const report = {
  status: "done" as const, outcome: 'For NaN the result is exactly "unknown".', headline: 'NaN returns "unknown"',
  evidence: [{ kind: "command" as const, ref: "node --test", detail: "Passed", exitCode: 0 }], artifacts: ["format.ts"], confidence: { intent: 100, safe: 100 },
};

it.each([true, false])("exposes Full by default on the registry read (settings enabled: %s)", async enabled => {
  const f = fixture(enabled), registry = registrySchema.parse(await f.harness.invokeRpc("registry", {}));
  expect(registry.voice).toBe("full"); expect(rpcContract.registry.tags?.({}, registry)).toContain("tavern:settings");
  expect(registrySchema.parse({ classes: [], characters: [], problems: [] }).voice).toBeUndefined();
});

it("applies modes to the registry without changing instructions, work or holds", async () => {
  const f = fixture(); await f.runtime.prepareRegistry("project");
  f.k.store.patch("lead", { manualStopAt: f.time(), typingAt: f.time(), userAt: f.time() });
  const configure = (id: string) => {
    const context = makePluginAgentConfigurationContext({ thread: { id } });
    return f.runtime.configure({ ...context, project: { ...context.project, id: "project" } });
  };
  const ids = ["lead", "child", "solo"], before = ids.map(configure);
  const snapshot = () => ({
    runtime: f.k.store.runtime("lead"), brief: f.k.store.runtime("child").brief, registry: f.runtime.snapshot(),
    restatement: f.k.restatement("lead"), held: f.runtime.held("lead"), away: f.runtime.away.snapshot(), events: f.k.store.events("lead"),
  });
  const state = snapshot();
  for (const mode of MODES) {
    f.setMode(mode);
    expect(await f.harness.invokeRpc("registry", {})).toMatchObject({ voice: mode });
    expect(await f.harness.invokeRpc("registry", { projectId: "project" })).toMatchObject({ voice: mode });
    expect(ids.map(configure)).toEqual(before);
    expect(snapshot()).toEqual(state);
  }
});

it.each(MODES)("keeps successful work and proof intact in %s without writing a line", mode => {
  const f = fixture(); f.setMode(mode);
  expect(f.k.report("child", report)).toMatchObject({ ...report, voice: null });
  expect(f.k.store.all("reports")[0]).toMatchObject({ ...report, voice: null });
  expect(f.k.member("child")!.engagement).toBe("resting");
});

it("deduplicates a retry of a historical report without rewriting the original line", () => {
  const f = fixture();
  const original = reportSchema.parse({ ...report, id: "old-report", memberThreadId: "child", keeperThreadId: "lead", boardQuestId: null, waypointId: null,
    createdAt: f.time(), deliveredAt: f.time(), voice: "A clean finish." });
  f.k.store.put("reports", original.id, original);
  const events = f.k.store.events("lead");
  for (const mode of MODES) {
    f.setMode(mode);
    expect(f.k.report("child", report)).toEqual({ ...original, voice: null });
    expect(f.k.store.get("reports", original.id)).toEqual(original);
    expect(f.k.store.all("reports")).toHaveLength(1);
    expect(f.k.store.events("lead")).toEqual(events);
  }
});
