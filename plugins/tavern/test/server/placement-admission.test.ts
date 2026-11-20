// @vitest-environment node
import { patchThreadFixture, putMemberFixture, runtimeFixture } from "./member-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { PlacementStore } from "../../src/server/placement/store";
import { placementRecord } from "./placement-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const hire = {
  classId: "ranger", title: "Scout", errand: true,
  brief: { outcome: "Read", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Read", context: [], questions: ["What exists?"], timeboxMinutes: 1 },
};
function fixture(sdkOverrides: Record<string, unknown> = {}) {
  const f = setup(sdkOverrides);
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  return { ...f, settings };
}
const rule = placementRuleSchema.parse({
  id: "local", label: "Explicit local route", enabled: true, match: {}, target: { kind: "current" },
});

describe("inert machine placement foundation", () => {
  it.each(["absent", "empty", "disabled"] as const)("preserves today's hires with %s rules, without creating placements", async kind => {
    const f = fixture();
    if (kind !== "absent") f.settings.update({ revision: 0, patch: { machines: { rules: kind === "empty" ? [] : [{ ...rule, enabled: false }] } }, why: "Compatibility route" });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await f.runtime.hire("lead", "project", hire);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders")).toEqual([]);
  });

  it("blocks a present-corrupt policy even though ordinary settings remain readable", async () => {
    const f = fixture();
    f.k.store.db.prepare("UPDATE tavern_settings SET data=json_set(data,'$.user.machines',json(?)) WHERE id=1")
      .run(JSON.stringify({ rules: "corrupt" }));
    expect(f.settings.read().machines.rules).toEqual([]);
    expect(f.settings.placementPolicy().state).toBe("invalid");
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow(/machine.*policy.*invalid/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(f.k.store.all("hires")).toEqual([]);
  });

  it("blocks unsupported provider targets instead of using a later current fallback", async () => {
    const f = fixture();
    const provider = placementRuleSchema.parse({ ...rule, target: {
      kind: "provider", environmentProviderId: "vendor-workspace", machine: { type: "keeper" }, workspace: "linked-worktree",
    } });
    f.settings.update({ revision: 0, patch: { machines: { rules: [provider, { ...rule, id: "fallback" }] } }, why: "Explicit route" });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toMatchObject({ message: "This rule's target isn't supported in this version." });
    expect(spawn).not.toHaveBeenCalled();
    expect(f.k.store.all("hires")).toEqual([]);
  });

  it("a matching current exception ignores occupied machine caps and records only its legacy routing note", async () => {
    const f = fixture(), placements = new PlacementStore(f.k.store.db);
    placements.reserve(placementRecord({ keeperThreadId: "lead", questId: null }), { maxMakers: 1, maxCheckers: 1 });
    f.settings.update({ revision: 0, patch: { machines: { maxMakers: 1, maxCheckers: 1, rules: [rule] } }, why: "Keep this work here" });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    const hired = await f.runtime.hire("lead", "project", hire);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].environment).toEqual({ type: "reuse", environmentId: "env" });
    expect(placements.counts("lead")).toEqual({ makers: 1, checkers: 0 });
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 1 });
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placement_discoveries").get()).toEqual({ n: 0 });
    expect(hired.executionNotes).toContain("Rule local matched: kept where its Keeper is.");
    expect(runtimeFixture(f.k.store, hired.threadId).executionNotes).toContain("Rule local matched: kept where its Keeper is.");
    expect(f.harness.inspection.sdk.callsTo("environments.listProviders")).toEqual([]);
  });

  it("blocks a scoped current-rule member of a remote Keeper without pretending it is unruled", async () => {
    const f = fixture({ environments: { get: async () => ({ id: "env", hostId: "remote", isGitRepo: true, environmentProviderId: "vendor-workspace", branchName: "main" }) } });
    const root = mkdtempSync(join(tmpdir(), "placement-scoped-admission-")); roots.push(root);
    f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
    f.settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Use current behavior" });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toMatchObject({
      message: "Rule Explicit local route keeps Ranger members where the Keeper runs, but this Keeper runs on another machine, and Tavern can't scope a member there in this version. Use a rule that gives members their own machines.",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
    expect(f.k.store.all("asks")).toEqual([]);
  });

  it("enabled rules that miss known class facts preserve legacy without probing source paths", async () => {
    const f = fixture();
    f.settings.update({ revision: 0, patch: { machines: { rules: [{ ...rule, match: { classes: ["smith"], keeperPathGlobs: ["/**"] } }] } }, why: "Only builders" });
    await f.runtime.hire("lead", "project", hire);
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placement_discoveries").get()).toEqual({ n: 0 });
  });

  it("keeps the ordinary party ceiling for a matched current target", async () => {
    const f = fixture(), keeper = f.k.member("lead")!;
    f.settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Legacy limit" });
    for (let i = 0; i < 5; i++) putMemberFixture(f.k.store, `busy-${i}`, { ...keeper, threadId: `busy-${i}`, role: "member", keeperThreadId: "lead", classId: "smith", state: "idle" });
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow("The live party budget is full");
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
  });

  it("does not reserve or spawn from a rule changed while preparing the hire", async () => {
    const f = fixture();
    f.settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Current route" });
    const original = f.runtime.registry.character.bind(f.runtime.registry);
    vi.spyOn(f.runtime.registry, "character").mockImplementation((...args) => {
      f.settings.update({ revision: 1, patch: { machines: { rules: [] } }, why: "Changed while preparing" });
      return original(...args);
    });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow(/placement settings changed.*reserved/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(f.k.store.all("hires")).toEqual([]);
  });

  it("retains the old active-party semantics for released, ended and pending-brief members", () => {
    const f = fixture(), keeper = f.k.member("lead")!;
    for (const [threadId, state] of [["active", "idle"], ["released", "idle"], ["ended", "done"], ["pending", "failed"]] as const) {
      putMemberFixture(f.k.store, threadId, { ...keeper, threadId, role: "member", keeperThreadId: "lead", classId: "smith", state });
    }
    patchThreadFixture(f.k.store, "released", { released: { reason: "Done", decisionId: "decision" } });
    patchThreadFixture(f.k.store, "pending", { pendingBrief: {
      id: "brief", text: "Work", attempts: 0, nextAttemptAt: 1, attemptedAt: null, hostAfterSeq: null, error: null,
    } });
    expect(f.k.store.activeStaffing("lead").map(member => member.threadId)).toEqual(["active", "pending"]);
  });

  it("enforces partyMax1000 against the complete party, not the latest500 rows", async () => {
    const f = fixture();
    f.settings.update({ revision: 0, patch: { keepers: { partyMax: 1000 } }, why: "Large party" });
    const keeper = f.k.member("lead")!;
    f.k.store.atomic(() => {
      for (let i = 0; i < 1000; i++) {
        const threadId = `maker-${i}`;
        putMemberFixture(f.k.store, threadId, { ...keeper, threadId, role: "member", keeperThreadId: "lead", classId: "smith", state: "idle" });
      }
    });
    const spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow(/live party budget is full/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
