import { describe, expect, it } from "vitest";
import { z } from "zod";
import { placementMachineSchema, placementMatchSchema, placementRuleSchema, placementSettingsPatchSchema,
  placementSettingsSchema, placementTargetSchema, providerInputsSchema } from "../../src/shared/placement-settings";
import { settingsPatchSchema, settingsSchema } from "../../src/shared/settings";

const local = { id: "local", label: "Keep it here", enabled: true, match: {}, target: { kind: "current" } };
const consent = { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true };
const remote = { id: "remote", label: "Dedicated machine", enabled: true, match: { projectIds: ["p1"] }, consent,
  target: { kind: "provider", environmentProviderId: "checkout", workspace: "dedicated-machine",
    machine: { type: "new", machineProviderId: "machines" } } };

function opaque() {
  return JSON.parse('{"memoryGb":8,"OpaqueKey":{"kept":true},"nested":[{"fromLaptopBranch":"{keeper.branch}","mixedKey":{"nested":true}}]}');
}

describe("machine placement settings contract", () => {
  it("keeps placement inert by default and retains the existing party budget", () => {
    expect(placementSettingsSchema.parse({})).toEqual({ maxMakers: 2, maxCheckers: 2, rules: [] });
    expect(settingsSchema.parse({}).machines).toEqual({ maxMakers: 2, maxCheckers: 2, rules: [] });
    expect(settingsSchema.parse({}).keepers.partyMax).toBe(5);
    expect(settingsPatchSchema.parse({ keepers: { partyMax: 1000 } })).toEqual({ keepers: { partyMax: 1000 } });
    expect(settingsPatchSchema.safeParse({ keepers: { partyMax: 1001 } }).success).toBe(false);
  });
  it("keeps rules-only and caps-only patches sparse", () => {
    expect(placementSettingsPatchSchema.parse({ rules: [] })).toEqual({ rules: [] });
    expect(placementSettingsPatchSchema.parse({ maxMakers: 500 })).toEqual({ maxMakers: 500 });
    expect(settingsPatchSchema.parse({ machines: { rules: [] } })).toEqual({ machines: { rules: [] } });
  });
  it("defaults consent to false and requires explicit consent for enabled new machines", () => {
    expect(placementRuleSchema.parse(local).consent).toEqual({ guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false });
    expect(placementRuleSchema.safeParse({ ...remote, consent: undefined }).success).toBe(false);
    expect(placementRuleSchema.safeParse({ ...remote, enabled: false, consent: undefined }).success).toBe(true);
    for (const key of Object.keys(consent))
      expect(placementRuleSchema.safeParse({ ...remote, consent: { ...consent, [key]: false } }).success).toBe(false);
    expect(placementRuleSchema.parse(remote).consent).toEqual(consent);
  });
  it("requires new-machine ownership for dedicated checkouts", () => {
    for (const machine of [{ type: "keeper" }, { type: "project-checkout" }, { type: "existing", hostId: "h1" }])
      expect(placementRuleSchema.safeParse({ ...remote, target: { ...remote.target, machine } }).success).toBe(false);
    expect(placementRuleSchema.safeParse({ ...remote, target: { ...remote.target, workspace: "linked-worktree", machine: { type: "keeper" } } }).success).toBe(true);
  });
  it("accepts only bounded nonempty match lists and the six declared fields", () => {
    const match = { projectIds: ["p1"], repoRemotes: ["github.com/Owner/Repo"], keeperPathGlobs: ["~/trees/*/src"],
      keeperEnvironmentProviders: ["checkout"], classes: ["smith"], questIds: ["q1"] };
    expect(placementMatchSchema.parse(match)).toEqual(match);
    expect(placementMatchSchema.parse({})).toEqual({});
    for (const key of Object.keys(match)) expect(placementMatchSchema.safeParse({ [key]: [] }).success).toBe(false);
    expect(placementMatchSchema.safeParse({ prompt: "world" }).success).toBe(false);
    expect(placementMatchSchema.safeParse({ keeperPathGlobs: ["x".repeat(1001)] }).success).toBe(false);
  });
  it("bounds caps, rule count and stable unique ids without reordering", () => {
    expect(placementSettingsSchema.parse({ maxMakers: 1000, maxCheckers: 1000, rules: [remote, local] }).rules.map(rule => rule.id)).toEqual(["remote", "local"]);
    for (const schema of [placementSettingsSchema, placementSettingsPatchSchema]) {
      expect(schema.safeParse({ rules: [local, local] }).success).toBe(false);
      expect(schema.safeParse({ rules: Array.from({ length: 51 }, (_, index) => ({ ...local, id: `r-${index}` })) }).success).toBe(false);
      expect(schema.safeParse({ maxMakers: 0 }).success).toBe(false);
      expect(schema.safeParse({ maxCheckers: 1001 }).success).toBe(false);
      expect(schema.safeParse({ renamed: true }).success).toBe(false);
    }
  });
  it("preserves explicit null, allowed opaque keys and omitted inputs", () => {
    const input = opaque();
    expect(JSON.stringify(providerInputsSchema.parse(input))).toBe(JSON.stringify(input));
    for (const schema of [placementSettingsSchema, placementSettingsPatchSchema]) {
      const result = schema.parse({ rules: [{ ...remote, target: { ...remote.target, inputs: input,
        machine: { ...remote.target.machine, inputs: input } } }] });
      const target = result.rules![0]!.target;
      if (target.kind !== "provider" || target.machine.type !== "new") throw new Error("Wrong target");
      expect(JSON.stringify(target.inputs)).toBe(JSON.stringify(input));
      expect(JSON.stringify(target.machine.inputs)).toBe(JSON.stringify(input));
      expect(Object.getPrototypeOf(target.inputs)).toBe(Object.prototype);
    }
    expect(providerInputsSchema.parse(null)).toBeNull();
    const target = placementTargetSchema.parse(remote.target);
    expect(target).not.toHaveProperty("inputs");
    expect(Object.prototype).not.toHaveProperty("kept");
  });
  it("rejects non-JSON, cyclic, deep and oversized values before recursive JSON parsing", () => {
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    let deep: unknown = 0; for (let index = 0; index < 20_000; index++) deep = [deep];
    for (const input of [undefined, NaN, Infinity, 1n, Symbol("x"), () => 0, new Date(), new Map(), cyclic, deep,
      { value: undefined }, "x".repeat(32767), "🌍".repeat(8192)])
      expect(providerInputsSchema.safeParse(input).success).toBe(false);
    expect(providerInputsSchema.parse("x".repeat(32766))).toHaveLength(32766);
    expect(providerInputsSchema.safeParse(Object.create({ inherited: true })).success).toBe(false);
  });
  it("rejects reserved provider keys at every depth with their full configuration path", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const inputs = JSON.parse(`{"nested":[{"${key}":1}]}`);
      for (const machine of [false, true]) {
        const target = machine ? { ...remote.target, machine: { ...remote.target.machine, inputs } } : { ...remote.target, inputs };
        const result = settingsPatchSchema.safeParse({ machines: { rules: [{ ...remote, target }] } });
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Reserved key accepted");
        const prefix = machine ? "rules[0].target.machine.inputs.nested[0]" : "rules[0].target.inputs.nested[0]";
        expect(result.error.issues[0]!.message).toBe(`Provider inputs can't use the key ${key} (${prefix}): bb's RPC can't carry it`);
      }
      expect(providerInputsSchema.safeParse(inputs).success).toBe(false);
    }
  });
  it("exports strict settings schemas in both JSON-Schema directions", () => {
    for (const schema of [providerInputsSchema, placementMachineSchema, placementTargetSchema, placementRuleSchema,
      placementSettingsSchema, placementSettingsPatchSchema]) {
      for (const io of ["input", "output"] as const) expect(() => z.toJSONSchema(schema, { io })).not.toThrow();
    }
  });
});
