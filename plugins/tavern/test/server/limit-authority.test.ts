// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { LimitPolicy } from "../../src/server/limit-policy";
import { rpcHandlers } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";

const scout = { classId: "ranger", errand: true, title: "Scout", brief: { outcome: "Read", doneWhen: "Evidence", outOfScope: "Changes", mode: "make-it-work" as const, context: [], questions: ["1. What changed?"], timeboxMinutes: 1 } };

it("only a client may lift review once, with its surface recorded", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Review", "Review");
  const limits = new LimitPolicy(f.k), handlers = rpcHandlers(f.runtime);
  expect(limits.reviewAvailable(q.id)).toBe(false);
  await expect(async () => handlers.allowReview({ id: q.id }, { experimental_caller: { kind: "plugin", pluginId: "tavern" } } as never)).rejects.toThrow(/client/);
  await handlers.allowReview({ id: q.id }, { experimental_caller: { kind: "client" } } as never);
  expect(f.k.store.events().find(e => e.type === "review.allowed")?.data.surface).toBe("client (unattested)");
  expect(limits.reviewAvailable(q.id)).toBe(true);
  limits.claimReview(q.id, "hire");
  expect(limits.reviewAvailable(q.id)).toBe(false);
  expect(() => limits.claimReview(q.id, "hire2")).toThrow();
});
it.each(["party", "rangers"] as const)("enforces the %s grant in the real hire path", async limit => {
  const f = setup(), snapshot = f.runtime.snapshot();
  snapshot.classes = snapshot.classes.map(role => role.id === "keeper" ? { ...role, source: "global" as const, budget: { rangerMinutes: 5, ...role.budget, members: limit === "party" ? 1 : 5, rangers: limit === "rangers" ? 1 : 5 } } : role);
  vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
  const input = { classId: "ranger", errand: true, title: "Scout", brief: { outcome: "Read", doneWhen: "Evidence", outOfScope: "Changes", mode: "make-it-work" as const, context: [], questions: ["1. What changed?"], timeboxMinutes: 1 } };
  await f.runtime.hire("lead", "project", input);
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(limit === "party" ? "party budget" : "Ranger budget");
  f.k.decide("lead", { text: "One extra", why: "Bounded scout", reversible: true, source: "keeper", exceeds: limit });
  await expect(f.runtime.hire("lead", "project", input)).resolves.toBeTruthy();
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(limit === "party" ? "party budget" : "Ranger budget");
});
it("shares one Ranger exception between the class time box and count, below the settings ceiling", async () => {
  const f = setup(), snapshot = f.runtime.snapshot();
  snapshot.classes = snapshot.classes.map(role => role.id === "keeper" ? { ...role, source: "global" as const, budget: { members: 5, rangers: 1, rangerMinutes: 2 } } : role);
  vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
  const timebox = (timeboxMinutes: number) => ({ ...scout, brief: { ...scout.brief, timeboxMinutes } });
  await f.runtime.hire("lead", "project", scout);
  await expect(f.runtime.hire("lead", "project", scout)).rejects.toThrow(/Ranger budget.*tavern_decide.*rangers/);
  await expect(f.runtime.hire("lead", "project", timebox(3))).rejects.toThrow(/2 minutes.*tavern_decide.*rangers/);
  const decision = f.k.decide("lead", { text: "One longer scout", why: "Check another source", reversible: true, source: "keeper", exceeds: "rangers" });
  await expect(f.runtime.hire("lead", "project", timebox(f.runtime.config().knobs.rangerTimeboxMaxMinutes + 1))).rejects.toThrow(/settings.*ceiling/i);
  expect(f.k.store.get("decisions", decision.id)?.usedBy).toBeUndefined();
  await expect(f.runtime.hire("lead", "project", timebox(3))).resolves.toBeTruthy();
  expect(f.k.store.get("decisions", decision.id)?.usedBy).toBeTruthy();
  await expect(f.runtime.hire("lead", "project", timebox(3))).rejects.toThrow(/tavern_decide.*rangers/);
});
it("a class time box by itself triggers a Ranger exception", async () => {
  const f = setup(), snapshot = f.runtime.snapshot();
  snapshot.classes = snapshot.classes.map(role => role.id === "keeper" ? { ...role, source: "global" as const, budget: { members: 5, rangers: 5, rangerMinutes: 2 } } : role);
  vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
  const input = { ...scout, brief: { ...scout.brief, timeboxMinutes: 3 } };
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/2 minutes.*tavern_decide.*rangers/);
  const decision = f.k.decide("lead", { text: "One longer scout", why: "Check another source", reversible: true, source: "keeper", exceeds: "rangers" });
  await expect(f.runtime.hire("lead", "project", input)).resolves.toBeTruthy();
  expect(f.k.store.get("decisions", decision.id)?.usedBy).toBeTruthy();
});
it("a Ranger exception cannot pass the user's party ceiling", async () => {
  const f = setup(), config = f.runtime.config.bind(f.runtime), snapshot = f.runtime.snapshot();
  f.runtime.config = q => { const current = config(q); return { ...current, keepers: { ...current.keepers, partyMax: 1 } }; };
  snapshot.classes = snapshot.classes.map(role => role.id === "keeper" ? { ...role, source: "global" as const, budget: { ...role.budget, members: 1, rangers: 1, rangerMinutes: 5 } } : role);
  vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
  await f.runtime.hire("lead", "project", scout);
  const one = f.k.decide("lead", { text: "One extra scout", why: "Finish the research", reversible: true, source: "keeper", exceeds: "rangers" });
  await expect(f.runtime.hire("lead", "project", scout)).rejects.toThrow(/party budget/i);
  expect(f.k.store.get("decisions", one.id)?.usedBy).toBeUndefined();
});
it("does not offer a Keeper review-budget exception", async () => {
  const f = setup(); registerTools(f.bb, f.runtime);
  await expect(f.harness.behavior.invokeAgentTool("tavern_decide", { text: "One more review", why: "Finish checking", source: "keeper", reversible: true, exceeds: "review" }, { threadId: "lead" })).rejects.toThrow(/party.*rangers/s);
  expect(f.k.store.all("decisions")).toEqual([]);
});
it("rechecks the hard ceiling when simultaneous hires try to reserve the last slot", async () => {
  const f = setup(), config = f.runtime.config.bind(f.runtime);
  f.runtime.config = q => { const current = config(q); return { ...current, keepers: { ...current.keepers, partyMax: 1 } }; };
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  let resolving = 0;
  f.runtime.scopes = { api: { shouldScope: () => true }, resolve: async () => { if (++resolving === 2) unblock(); await gate; return null; }, pending: () => null } as never;
  const results = await Promise.allSettled([f.runtime.hire("lead", "project", scout), f.runtime.hire("lead", "project", scout)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/party budget/i) }) });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
it.each(["party", "rangers"] as const)("consumes a recorded %s soft limit decision once", limit => {
  const f = setup(), policy = new LimitPolicy(f.k);
  expect(policy.softDecision("lead", null, limit)).toBeNull();
  const d = f.k.decide("lead", { text: "One extra", why: "Bounded work", reversible: true, source: "keeper", exceeds: limit });
  expect(policy.softDecision("lead", null, limit)).toBe(d.id);
  policy.claimSoft(d.id, "hire");
  expect(policy.softDecision("lead", null, limit)).toBeNull();
  expect(() => policy.claimSoft(d.id, "second")).toThrow();
});
