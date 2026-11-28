// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import type { Route, Rule } from "../../src/shared/schema";
import { tags } from "../../src/shared/contract";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { makeQueueEntry } from "@get-bb/plugin-sdk/testing";

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
  it("cites a user's accepted party message and explicitly supersedes the old rule", async () => {
    const f = party();
    const { rule: old } = await stated(f, "Wait for one review before doing checks.");
    const brief = { outcome: "Check work", doneWhen: "Checks passed", mode: "make-it-work" as const, outOfScope: "", context: [], questions: [], timeboxMinutes: null };
    for (const [threadId, keeperThreadId] of [["child", "lead"], ["foreign", "other"]]) {
      f.k.bind(threadId!, "smith", "juno", "project", { keeperThreadId: keeperThreadId!, boardQuestId: null, waypointId: null, title: "Check", errand: true, brief });
    }
    const text = "Wait for two reviews before doing checks.";
    const entry = (threadId: string, id: string) => makeQueueEntry({ threadId, id, initiator: "user", originPluginId: null, senderThreadId: null, content: [{ type: "text", text, mentions: [] }], createdAt: f.time() });
    f.runtime.dispatched(entry("foreign", "foreign-message"));
    f.runtime.dispatched({ ...entry("child", "agent-message"), initiator: "agent", senderThreadId: "foreign" });
    expect(f.k.store.messageId("agent-message")).toBeNull();
    f.runtime.queued(entry("child", "cancelled-message"));
    f.runtime.cancelled(entry("child", "cancelled-message"));
    f.runtime.queued(entry("child", "correction"));
    const sourceMessageId = f.k.store.messageId("correction")!;
    const add = (override: Record<string, unknown> = {}) => f.harness.behavior.invokeAgentTool("tavern_rule",
      { source: "message", sourceMessageId, supersedesRuleId: old.id, text, ...override }, { threadId: "lead" });
    await expect(add({ sourceMessageId: f.k.store.messageId("foreign-message") })).rejects.toThrow(/party/);
    await expect(add({ sourceMessageId: f.k.store.messageId("cancelled-message") })).rejects.toThrow(/accepted/);
    await expect(add()).rejects.toThrow(/accepted/);
    f.runtime.dispatched(entry("child", "correction"));
    await expect(add({ text: "Wait for three reviews." })).rejects.toThrow(/verbatim/);
    await expect(add({ source: "keeper-proposed" })).rejects.toThrow(/supersed.*user/i);
    const rule = JSON.parse(await add() as string);
    expect(f.k.rules("lead")).toEqual([expect.objectContaining({ id: rule.id, active: true, text })]);
    expect(f.k.store.get("rules", old.id)).toMatchObject({ active: false, supersededByRuleId: rule.id });
    expect(() => f.k.confirmRule(old.id, true)).toThrow(new RegExp(rule.id));
    expect(f.k.store.events("lead").find(e => e.type === "rule.added" && e.data.ruleId === rule.id)?.data)
      .toMatchObject({ sourceMessageId, sourceThreadId: "child", supersedesRuleId: old.id });
  });

  it("cites the Keeper’s own accepted routed user message verbatim and within its quest", async () => {
    const f = party();
    const q = await seedQuest(f.k, "lead", "Check", "Check");
    const text = "Reply to each review in its original thread.";
    f.k.receiveUser("lead", text);
    const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: text, notes: [] });
    f.k.resetRoutes("lead");
    const input = { source: "message", sourceMessageId: route.sourceMessageId, text, scope: "quest", boardQuestId: q.id };
    const call = (fields: object, threadId = "lead") => f.harness.behavior.invokeAgentTool("tavern_rule", { ...input, ...fields }, { threadId });
    await expect(call({ text: "Post anything as the user." })).rejects.toThrow(/verbatim/);
    await expect(call({ scope: "keeper", boardQuestId: undefined }, "other")).rejects.toThrow(/party|Keeper/);
    expect(JSON.parse(await call({}) as string)).toMatchObject({ active: true, scopeId: q.id, text });
    expect(f.k.store.events("lead").find(event => event.type === "rule.added")?.data)
      .toMatchObject({ sourceMessageId: route.sourceMessageId, sourceThreadId: "lead" });
  });

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
