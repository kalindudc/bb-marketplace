// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import type { Route, Rule } from "../../src/shared/schema";
import { tags } from "../../src/shared/contract";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";

function party() {
  const f = setup();
  f.k.bind("other", "keeper", "moss", "project");
  f.k.bind("remote", "keeper", "ada", "another-project");
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  return f;
}
async function stated(f: ReturnType<typeof party>, text: string, scope?: Rule["scope"]) {
  f.k.receiveUser("lead", text);
  const route = f.k.route("lead", { kind: "rule", summary: text, notes: [] });
  const result = await f.harness.behavior.invokeAgentTool("tavern_rule", { text, source: "message", ...(scope ? { scope } : {}) }, { threadId: "lead" });
  return { route, rule: JSON.parse(result as string) as Rule };
}

describe("Keeper-local standing rules and explicit widening", () => {
  it("defaults a stated rule to this Keeper and shows its scope on the route", async () => {
    const f = party();
    const { route, rule } = await stated(f, "Keep Ranger time boxes under eight minutes.");
    expect(rule).toMatchObject({ scope: "keeper", scopeId: "lead", active: true, source: "message" });
    expect(f.k.rules("lead").map(rule => rule.id)).toContain(rule.id);
    expect(f.k.rules("other")).toHaveLength(0);
    expect(f.k.rules("remote")).toHaveLength(0);
    expect(f.k.store.events("other").some(event => event.type === "rules.changed")).toBe(false);
    expect(f.k.store.get("routes", route.id)).toMatchObject({ ruleId: rule.id });
    const receipt = await f.harness.invokeRpc("routes", { threadId: "lead" }) as { routes: Route[]; rules: Rule[] };
    expect(receipt.routes[0]).toMatchObject({ ruleId: rule.id });
    expect(receipt.rules).toEqual([rule]);
  });

  it.each([
    "All Keepers must keep Ranger time boxes under eight minutes.",
    "Use eight-minute Ranger time boxes across all Tavern threads.",
    "For every Keeper, retain the original test evidence.",
  ])("honors explicit global scope in the user's own words: %s", async text => {
    const f = party();
    const { rule } = await stated(f, text, "global");
    expect(rule).toMatchObject({ scope: "global", scopeId: null, active: true });
    expect(f.k.rules("other").map(rule => rule.id)).toContain(rule.id);
    expect(f.k.rules("remote").map(rule => rule.id)).toContain(rule.id);
  });

  it.each([
    "Keep Ranger time boxes under eight minutes.",
    "Only this Keeper should use eight-minute time boxes, not all Keepers.",
    "Do not apply this to all Keepers: keep Ranger time boxes under eight minutes.",
  ])("refuses a global tool scope without affirmative broad user wording: %s", async text => {
    const f = party();
    await expect(stated(f, text, "global")).rejects.toThrow(/this Keeper|all Keepers/);
    expect(f.k.store.all("rules")).toHaveLength(0);
  });

  it("keeps an omitted-scope Keeper proposal local and inactive", async () => {
    const f = party();
    const result = await f.harness.behavior.invokeAgentTool("tavern_rule", { text: "Prefer one review at a time" }, { threadId: "lead" });
    const rule = JSON.parse(result as string) as Rule;
    expect(rule).toMatchObject({ scope: "keeper", scopeId: "lead", active: false });
    const ledger = await f.harness.invokeRpc("ledger", { threadId: "lead" }) as { rules: Rule[] };
    expect(ledger.rules).toContainEqual(rule);
    expect(f.k.rules("other", null, true)).toHaveLength(0);
  });

  it("widens an existing local rule with stable identity, user audit and every affected Keeper invalidated", async () => {
    const f = party();
    const { rule } = await stated(f, "Keep Ranger time boxes under eight minutes.");
    const invalidate = vi.mocked(f.bb.rpc.experimental_invalidate);
    invalidate.mockClear();
    f.k.store.patch("lead", { manualStopAt: f.time() });
    f.advance(1000);
    expect(await f.harness.invokeRpc("widenRule", { ruleId: rule.id, scope: "global" })).toEqual({ ok: true });
    const widened = f.k.store.get("rules", rule.id)!;
    expect(widened).toMatchObject({ id: rule.id, text: rule.text, active: true, scope: "global", scopeId: null, widenedAt: f.time(), widenedBy: { kind: "user" } });
    expect(f.k.store.runtime("lead").manualStopAt).toBeNull();
    expect(f.k.rules("other").map(rule => rule.id)).toContain(rule.id);
    expect(f.k.rules("remote").map(rule => rule.id)).toContain(rule.id);
    const invalidated = invalidate.mock.calls.flatMap(([values]) => values);
    for (const id of ["lead", "other", "remote"]) expect(invalidated).toContain(tags.thread(id));
    expect(f.k.store.events("lead").find(event => event.type === "rule.widened")).toMatchObject({ actor: { kind: "user" }, data: { ruleId: rule.id, previousScope: "keeper", scope: "global" } });
    const receipt = await f.harness.invokeRpc("routes", { threadId: "lead" }) as { routes: Route[]; rules: Rule[] };
    expect(receipt.rules).toEqual([widened]);
    expect(receipt.routes[0]?.ruleId).toBe(rule.id);
  });

  it("preserves inactive state while widening a proposal", async () => {
    const f = party();
    const rule = f.k.addRule({ scope: "keeper", scopeId: "lead", text: "Prefer one review", source: "keeper-proposed" }, "lead");
    await f.harness.invokeRpc("widenRule", { ruleId: rule.id, scope: "global" });
    expect(f.k.store.get("rules", rule.id)).toMatchObject({ active: false, scope: "global" });
    expect(f.k.rules("other")).toHaveLength(0);
    expect(f.k.rules("other", null, true).map(rule => rule.id)).toContain(rule.id);
  });

  it("derives quest, Keeper and project identities while widening, and refuses equal or narrower scopes", async () => {
    const f = party();
    const quest = await seedQuest(f.k,"lead", "Build", "Build");
    const rule = f.k.addRule({ scope: "quest", scopeId: quest.id, text: "Keep test evidence", source: "user" }, "lead");
    await f.harness.invokeRpc("widenRule", { ruleId: rule.id, scope: "keeper" });
    expect(f.k.store.get("rules", rule.id)).toMatchObject({ scope: "keeper", scopeId: "lead" });
    await f.harness.invokeRpc("widenRule", { ruleId: rule.id, scope: "project" });
    expect(f.k.store.get("rules", rule.id)).toMatchObject({ scope: "project", scopeId: "project" });
    expect(f.k.rules("other").map(rule => rule.id)).toContain(rule.id);
    expect(f.k.rules("remote")).toHaveLength(0);
    await expect(f.harness.invokeRpc("widenRule", { ruleId: rule.id, scope: "project" })).rejects.toThrow(/wider/);
    await expect(f.harness.invokeRpc("widenRule", { ruleId: rule.id, scope: "keeper" })).rejects.toThrow(/wider/);
    await expect(f.harness.invokeRpc("widenRule", { ruleId: "missing", scope: "global" })).rejects.toThrow("Unknown rule");
  });
});
