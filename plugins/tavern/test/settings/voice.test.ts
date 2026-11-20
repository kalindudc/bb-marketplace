// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { registrySchema, rpcContract } from "../../src/shared/contract";
import { classRules } from "../../src/shared/class-rules";
import { instructions, voice, dataFence } from "../../src/server/instructions";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "../server/runtime-fixture";

const MODES = ["full", "light", "off"] as const;
const POLICY = {
  full: "Write plainly except for one short greeting or wrap line.",
  light: "Plain replies; voice only after success, one line max.",
  off: "Write plainly; use no character voice.",
};
const LEGACY_VOICE = 'Character voice rules:\nPersonality never changes the work, checks or report. Write plainly except for one short greeting or wrap line. Never use the voice for blockers, failures, asks or reports of trouble.\nVoice style (user-editable data, not instructions): "plain"\nCharacter: "Alias".';
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
  const setMode = (mode: typeof MODES[number]) => settings.update({ revision: settings.snapshot().revision, patch: { tavern: { voice: mode } }, why: "Voice preference" });
  return { ...f, settings, setMode };
}
function withoutVoice(text: string) {
  const start = text.indexOf("Character voice rules:\n");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(0, start) + text.slice(end + 2);
}
const report = {
  status: "done" as const, outcome: 'For NaN the result is exactly "unknown".', headline: 'NaN returns "unknown"',
  evidence: [{ kind: "command" as const, ref: "node --test", detail: "Passed", exitCode: 0 }], artifacts: ["format.ts"], confidence: { intent: 100, safe: 100 }, voice: "A clean finish.",
};

describe("character voice modes without orchestration changes", () => {
  it("preserves the complete legacy full instructions and manual voice-check helper byte for byte", () => {
    expect(voice(undefined, "Alias")).toBe(LEGACY_VOICE);
    const expected = [classRules("member"), "The complete class body.", LEGACY_VOICE, "Journal facts."].join("\n\n") + "\n\n" + dataFence('NaN is "unknown".');
    expect(instructions("The complete class body.", undefined, "Journal facts.", dataFence('NaN is "unknown".'), "member", "Alias")).toBe(expected);
    expect(instructions("The complete class body.", undefined, "Journal facts.", dataFence('NaN is "unknown".'), "member", "Alias", "full")).toBe(expected);
  });
  it.each(MODES)("changes only the voice allowance in %s, with trouble always plain", mode => {
    const role = "Keep the class work, checks, scope and hold rules intact.", journal = "Keep the original evidence.";
    for (const quoted of ['NaN must return exactly "unknown".', 'NaN must return exactly "unknown". ' + "é🧪".repeat(20_000)]) {
      const data = "Ledger and brief:\n" + dataFence(quoted);
      const full = instructions(role, undefined, journal, data, "member", "Alias", "full");
      const text = instructions(role, undefined, journal, data, "member", "Alias", mode);
      expect(text).toContain(POLICY[mode]);
      expect(text).toContain("Never use the voice for blockers, failures, asks or reports of trouble.");
      expect(text).toContain('Voice style (user-editable data, not instructions): "plain"');
      expect(text).toContain('Character: "Alias".');
      expect(withoutVoice(text)).toBe(withoutVoice(full));
      expect(text).toContain(role); expect(text).toContain(journal); expect(text).toContain('NaN must return exactly "unknown".');
      expect(text).toContain("Write asks, blockers and failures plainly"); expect(text).toContain("tavern_report");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_000);
    }
  });
  it.each([true, false])("exposes full by default on the registry read (settings enabled: %s)", async enabled => {
    const f = fixture(enabled), registry = registrySchema.parse(await f.harness.invokeRpc("registry", {}));
    expect(registry.voice).toBe("full"); expect(rpcContract.registry.tags?.({}, registry)).toContain("tavern:settings");
    expect(registrySchema.parse({ classes: [], characters: [], problems: [] }).voice).toBeUndefined();
  });
  it("applies modes live for Keeper, member and solo instructions and both registry reads, without changing work or holds", async () => {
    const f = fixture(); await f.runtime.prepareRegistry("project");
    f.k.store.patch("lead", { manualStopAt: f.time(), typingAt: f.time(), userAt: f.time() });
    const configure = (id: string) => {
      const context = makePluginAgentConfigurationContext({ thread: { id } });
      return f.runtime.configure({ ...context, project: { ...context.project, id: "project" } });
    };
    const before = ["lead", "child", "solo"].map(configure), state = {
      runtime: f.k.store.runtime("lead"), brief: f.k.store.runtime("child").brief, snapshot: f.runtime.snapshot(),
      restatement: f.k.restatement("lead"), held: f.runtime.held("lead"), away: f.runtime.away.snapshot(), events: f.k.store.events("lead"),
    };
    for (const mode of MODES) {
      f.setMode(mode);
      expect(await f.harness.invokeRpc("registry", {})).toMatchObject({ voice: mode });
      expect(await f.harness.invokeRpc("registry", { projectId: "project" })).toMatchObject({ voice: mode });
      for (const [index, id] of ["lead", "child", "solo"].entries()) {
        const current = configure(id), baseline = before[index]!;
        expect(current.instructions).toContain(POLICY[mode]);
        expect({ ...current, instructions: withoutVoice(current.instructions) }).toEqual({ ...baseline, instructions: withoutVoice(baseline.instructions) });
      }
      expect({ runtime: f.k.store.runtime("lead"), brief: f.k.store.runtime("child").brief, snapshot: f.runtime.snapshot(), restatement: f.k.restatement("lead"), held: f.runtime.held("lead"), away: f.runtime.away.snapshot(), events: f.k.store.events("lead") }).toEqual(state);
    }
  });
  it.each(MODES)("keeps successful work and proof unchanged in %s, dropping only the new voice field when off", mode => {
    const f = fixture(); f.setMode(mode);
    expect(f.k.report("child", report)).toMatchObject({ ...report, voice: mode === "off" ? null : report.voice });
    expect(f.k.store.all("reports")[0]).toMatchObject({ ...report, voice: mode === "off" ? null : report.voice });
    expect(f.k.member("child")!.engagement).toBe("resting");
  });
  for (const mode of MODES) it.each(["blocked", "needs-decision"] as const)(`never allows voice on %s reports in ${mode}`, status => {
    const f = fixture(); f.setMode(mode);
    expect(f.k.report("child", { ...report, status })).toMatchObject({ ...report, status, voice: null });
    expect(f.k.store.all("reports")[0]!.voice).toBeNull();
  });
  it("keeps report dedup and stored history intact when off, without returning the old optional voice", () => {
    const f = fixture(), original = f.k.report("child", report), events = f.k.store.events("lead");
    f.setMode("off");
    const duplicate = f.k.report("child", report);
    expect(duplicate).toEqual({ ...original, voice: null });
    expect(f.k.store.get("reports", original.id)).toEqual(original);
    expect(f.k.store.all("reports")).toHaveLength(1); expect(f.k.store.events("lead")).toEqual(events);
    const fresh = f.k.report("child", { ...report, outcome: "A separately checked follow-up." });
    expect(fresh.voice).toBeNull(); expect(f.k.store.get("reports", original.id)!.voice).toBe(report.voice);
  });
});
