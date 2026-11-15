// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { rpcContract, registrySchema, type Room, type ThreadDecor } from "../../src/shared/contract";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { exportToml, previewToml } from "../../src/server/settings/toml";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "../server/runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(enabled = true) {
  const f = setup(); databases.push(f.k.store.db);
  const settings = new SettingsStore(f.k.store.db, f.time);
  if (enabled) f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  registerRpc(f.bb, f.runtime);
  const call = (method: string, input: unknown) => f.harness.invokeRpc(method, input);
  const flags = async (threadId = "lead") => ({
    levels: registrySchema.parse(await call("registry", {})).levels,
    widgetRow: (await call("decor", { threadId }) as ThreadDecor).widgetRow,
    hearthFlicker: (await call("room", {}) as Room).hearthFlicker,
  });
  return { ...f, settings, call, flags };
}
const defaults = { levels: true, widgetRow: true, hearthFlicker: true };
function agentText(f: ReturnType<typeof fixture>) {
  return {
    keeper: f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions,
    member: f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "child" } })).instructions,
    restatement: f.k.restatement("lead"), brief: f.k.store.runtime("child").brief,
    snapshot: f.runtime.snapshot(),
  };
}

describe("presentation settings on existing UI reads", () => {
  it.each([true, false])("preserves default-on flags (settings registered: %s)", async enabled => {
    expect(await fixture(enabled).flags()).toEqual(defaults);
  });
  it.each(["levels", "widgetRow", "hearthFlicker"] as const)("applies saved %s independently without changing agent text", async key => {
    const f = fixture();
    f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Draft", brief: { outcome: "Draft", doneWhen: "Proof", mode: "make-it-work", outOfScope: "Publish", context: [], questions: [], timeboxMinutes: null } });
    const before = agentText(f); expect(before.keeper).toBeTruthy(); expect(before.member).toBeTruthy();
    for (const value of [false, true]) {
      f.settings.update({ revision: f.settings.snapshot().revision, patch: { tavern: { [key]: value } }, why: "Display preference" });
      expect(await f.flags()).toEqual({ ...defaults, [key]: value });
      expect(agentText(f)).toEqual(before);
    }
  });
  it("returns the saved flags for project registry reads and untyped decor without overriding thread hiding", async () => {
    const f = fixture();
    f.settings.update({ revision: 0, patch: { tavern: { levels: false, widgetRow: false } }, why: "Quiet presentation" });
    expect(await f.call("registry", { projectId: "project" })).toMatchObject({ levels: false });
    expect(await f.call("decor", { threadId: "plain" })).toMatchObject({ widgetRow: false, member: null, hidden: false });
    f.k.store.patch("lead", { hidden: true });
    f.settings.update({ revision: 1, patch: { tavern: { widgetRow: true } }, why: "Show rows by default" });
    expect(await f.call("decor", { threadId: "lead" })).toMatchObject({ widgetRow: true, hidden: true });
  });
  it("subscribes all three reads to the existing settings-change signal, including untyped decor", async () => {
    const f = fixture(), registry = registrySchema.parse(await f.call("registry", {}));
    const decor = await f.call("decor", { threadId: "plain" }) as ThreadDecor, room = await f.call("room", {}) as Room;
    expect(rpcContract.registry.tags?.({}, registry)).toContain("tavern:settings");
    expect(rpcContract.decor.tags?.({ threadId: "plain" }, decor)).toContain("tavern:settings");
    expect(rpcContract.room.tags?.({}, room)).toContain("tavern:settings");
  });
  it("round-trips the new hearth preference through validated TOML", () => {
    const f = fixture();
    f.settings.update({ revision: 0, patch: { tavern: { hearthFlicker: false } }, why: "Stop ongoing decorative motion" });
    const toml = exportToml(f.settings.snapshot());
    expect(toml).toContain("hearth_flicker = false");
    const target = fixture(), preview = previewToml(toml, target.settings.snapshot());
    expect(preview.problems).toEqual([]);
    expect(preview.user).toEqual({ tavern: { hearthFlicker: false } });
    target.settings.replace(preview.user, preview.pinned, undefined, 0, "Restore display preference");
    expect(target.settings.read().tavern.hearthFlicker).toBe(false);
  });
});
