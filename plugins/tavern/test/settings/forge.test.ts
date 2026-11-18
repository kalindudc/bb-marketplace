import { describe, expect, it } from "vitest";
import { placementSettingsSchema } from "../../src/shared/placement-settings";
import { isGuardrailSetting } from "../../src/shared/settings";
const oldRule = { id: "work", label: "Work", enabled: true, match: {}, target: { kind: "current" } };
describe("forge placement settings", () => {
  it("keeps saved rules on the member machine", () => {
    expect(placementSettingsSchema.parse({ rules: [oldRule] }).rules[0]?.pullRequests).toEqual({ at: "member" });
    expect(placementSettingsSchema.parse({}).forges).toEqual([]);
  });
  it("requires an enabled named profile", () => {
    const rule = { ...oldRule, pullRequests: { at: "home", profile: "forge" } };
    expect(placementSettingsSchema.safeParse({ rules: [rule] }).success).toBe(false);
    const forge = { id: "forge", name: "Forge", kind: "command", open: "forge open" };
    expect(placementSettingsSchema.safeParse({ rules: [rule], forges: [forge] }).success).toBe(true);
    expect(placementSettingsSchema.safeParse({ rules: [rule], forges: [{ ...forge, enabled: false }] }).success).toBe(false);
  });
  it("keeps forge commands behind the machines guardrail", () => {
    expect(isGuardrailSetting("machines.forges")).toBe(true);
  });
});
