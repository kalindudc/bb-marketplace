// @vitest-environment node
import { readFileSync } from "node:fs";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "../../src/server/settings/store";
import { previewToml } from "../../src/server/settings/toml";
import { registerTools } from "../../src/server/tools";
import { rpcContract } from "../../src/shared/contract";
import { setup } from "./runtime-fixture";

const cases = [
  ["blocker: expired registry token (E403)", "smith", "bram", "tavern_report", /block(ed|er)/i],
  ["ask: open a draft now or wait for Luc", "keeper", "wren", "tavern_ask", /options.*recommendation/i],
  ["failed check: 2 of 14 tests fail", "warden", "vex", "tavern_report", /checks?|evidence/i],
  ["report: isZeroDuration with three passing tests", "smith", "bram", "tavern_report", /headline|evidence/i],
  ["wrap: verified cutover with a skipped load test", "keeper", "wren", "tavern_wrap", /remaining work|closing/i],
] as const;
const modelVoice = /Character voice rules|Voice style|one short greeting|Personality|Use voice only|voice is dropped|write in character/i;
const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

it.each(cases)("keeps the prompt plain for %s", async (_situation, cls, character, toolName, work) => {
  const f = setup(); dbs.push(f.k.store.db);
  if (cls !== "keeper") f.k.bind("member", cls, character, "project", {
    keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Work",
    brief: { outcome: "Check the result", doneWhen: "Proven", mode: "make-it-work", context: [], outOfScope: "Publish", questions: [], timeboxMinutes: null },
  });
  const ctx = makePluginAgentConfigurationContext({ thread: { id: cls === "keeper" ? "lead" : "member" } });
  await f.runtime.prepareRegistry("project");
  const config = await f.runtime.configure({ ...ctx, project: { ...ctx.project, id: "project" } });
  registerTools(f.bb, f.runtime);
  const tool = f.harness.inspection.registrations.agentTools.find(t => t.name === toolName)!;
  const body = readFileSync(new URL(`../../classes/${cls}.md`, import.meta.url), "utf8");
  expect(config.instructions).toMatch(/Character: "[^"]+"/);
  expect(body + config.instructions + tool.description).toMatch(work);
  expect(body + config.instructions + tool.description).not.toMatch(modelVoice);
});

it("keeps all shipped classes and Tavern tools free of writing-in-character instructions", () => {
  const f = setup(); dbs.push(f.k.store.db);
  registerTools(f.bb, f.runtime);
  for (const cls of ["keeper", "ranger", "smith", "wanderer", "warden"]) {
    expect(readFileSync(new URL(`../../classes/${cls}.md`, import.meta.url), "utf8")).not.toMatch(modelVoice);
  }
  for (const tool of f.harness.inspection.registrations.agentTools) expect(tool.description).not.toMatch(modelVoice);
});

it("removes voice from the report input and retires the voice-check RPCs", () => {
  const f = setup(); dbs.push(f.k.store.db);
  const registered = vi.spyOn(f.bb.agents, "registerTool");
  registerTools(f.bb, f.runtime);
  const tool = registered.mock.calls.find(([t]) => t.name === "tavern_report")![0];
  expect(tool.parameters).not.toHaveProperty("properties.voice");
  for (const method of ["voiceCheck", "voiceCheckStart", "voiceCheckCancel"]) expect(rpcContract).not.toHaveProperty(method);
});

it("imports a legacy file with the retired check limit and keeps current settings", () => {
  const f = setup(); dbs.push(f.k.store.db);
  const settings = new SettingsStore(f.k.store.db, f.time);
  const preview = previewToml('[tavern]\nvoice = "light"\nvoice_checks_per_hour = 7\n\n[keepers]\nparty_max = 8\n', settings.snapshot());
  expect(preview.problems).toEqual([]);
  expect(preview.user).toEqual({ tavern: { voice: "light" }, keepers: { partyMax: 8 } });
  expect(settings.read().tavern).not.toHaveProperty("voiceChecksPerHour");
  expect(previewToml("[tavern]\nvoice_check_per_hour = 7", settings.snapshot()).problems).toHaveLength(1);
});

it("reads the other choices from an older stored settings row", () => {
  const f = setup(); dbs.push(f.k.store.db);
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.k.store.db.prepare("UPDATE tavern_settings SET data=? WHERE id=1")
    .run(JSON.stringify({ user: { tavern: { voice: "light", voiceChecksPerHour: 7 }, keepers: { partyMax: 8 } } }));
  expect(settings.snapshot().user).toEqual({ tavern: { voice: "light" }, keepers: { partyMax: 8 } });
});
