// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { placementRecord } from "./placement-fixture";
import { placementLine, postureText, type PlacementView } from "../../src/shared/placement-view";
import { validatePlacementInputs } from "../../src/server/placement/inputs";
import { readStatus, statusInput } from "../../src/server/status";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { placementRuleSchema } from "../../src/shared/placement-settings";

describe("placement services and shared guidance", () => {
  it("builds one set of placement primitives per runtime with its existing source discovery", () => {
    const f = setup();
    const hostEntry = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true });
    Object.assign(f.bb, { hosts: hostEntry.bb.hosts });
    const services = f.runtime.placements();
    expect(f.runtime.placements()).toBe(services);
    expect(services.sources).toBe(f.runtime.placementSources());
    services.store.reserve(placementRecord(), { maxMakers: 2, maxCheckers: 2 });
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 1 });
    expect(services.controller).toBeDefined();
  });

  it("keeps the aggregate remote label and distinguishes observed Linux checker posture", () => {
    const posture = { ...placementRecord().posture, aggregate: "remote-detection-only" as const };
    expect(postureText(posture)).toEqual({ label: "Detection only (remote)", detail: null });
    expect(postureText({ ...posture, checker: "pre-exec-no-containment", toolGate: "pi-observed" })).toEqual({
      label: "Detection only (remote)", detail: "pre-exec checks only, no containment",
    });
    expect(postureText({ ...posture, checker: "pre-exec-no-containment" }).detail).toBe("detection only, no containment");
  });

  it("formats a single hire line without inventing a pending host", () => {
    const view: PlacementView = {
      placementId: "placement", generation: 1, where: { kind: "pending", label: "Compute, starting" },
      rule: { id: "shop-rule", label: "Shop rule" }, phase: "bootstrapping", hold: null, blocker: null,
      posture: { label: "Detection only (remote)", detail: null }, source: { includesUncommitted: true, from: "/source on Home" }, preservation: "not-needed", preservationReason: null,
    };
    expect(placementLine(view)).toBe('Compute, starting, rule "Shop rule" (shop-rule); setup bootstrapping; Detection only (remote). Includes uncommitted changes from /source on Home.');
  });

  it("lists every working class and keeps compact rule guidance in the Keeper ledger", async () => {
    const f = setup(), settings = new SettingsStore(f.k.store.db, f.time);
    const hostEntry = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true });
    Object.assign(f.bb, { hosts: hostEntry.bb.hosts });
    f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
    const rule = placementRuleSchema.parse({ id: "shop", label: "Shop members", enabled: true, match: { projectIds: ["project"] }, target: { kind: "current" } });
    settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Show the policy" });
    expect(f.k.restatement("lead")).toContain("Where your party runs");
    const text = f.k.restatement("lead");
    expect(text).toContain("Smith: where you run, rule Shop members (shop)");
    expect(text.indexOf("Where your party runs")).toBeGreaterThan(text.indexOf("Proposed, waiting for the user"));
    expect(text.indexOf("Where your party runs")).toBeLessThan(text.indexOf("Board quests"));
    expect(await readStatus(f.runtime, "lead", statusInput.parse({ section: "placement" }))).toMatchObject({
      classes: [{ classId: "keeper" }, { classId: "ranger" }, { classId: "smith" }, { classId: "warden" }, { classId: "wanderer" }],
      slots: { makers: { inUse: 0, limit: 2 }, checkers: { inUse: 0, limit: 2 } }, members: [],
    });
  });

  it("omits empty machine guidance and collapses unrelated project rules to one line", () => {
    const f = setup(), settings = new SettingsStore(f.k.store.db, f.time);
    f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
    expect(f.k.restatement("lead")).not.toContain("Where your party runs");
    settings.update({ revision: 0, patch: { machines: { rules: [placementRuleSchema.parse({ id: "other", label: "Other", enabled: true, match: { projectIds: ["elsewhere"] }, target: { kind: "current" } })] } }, why: "Other project" });
    const text = f.k.restatement("lead");
    expect(text).toContain("Where your party runs: where you run; no machine rule matches this project (tavern_status section=placement).");
    expect(text).not.toContain("Maker slots:");
    expect(text).not.toContain("no matching rule");
  });

  it("fills source.base and refuses an unavailable source base", () => {
    const provider = { id: "checkout", inputs: { type: "object", properties: { base: { type: "string" } }, required: ["base"] }, acceptsEmptyInputs: false };
    expect(validatePlacementInputs(provider, { base: "{source.base}" }, { "source.base": "a".repeat(40) })).toMatchObject({ state: "valid", inputs: { base: "a".repeat(40) } });
    expect(validatePlacementInputs(provider, { base: "{source.base}" })).toMatchObject({ state: "invalid", issues: [{ message: "Substitution {source.base} is unavailable; do not guess a value." }] });
  });
});
