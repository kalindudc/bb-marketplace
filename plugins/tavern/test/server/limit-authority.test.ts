// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { LimitPolicy } from "../../src/server/limit-policy";
import { rpcHandlers } from "../../src/server/rpc";

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
it.each(["party", "rangers"] as const)("consumes a recorded %s soft limit decision once", limit => {
  const f = setup(), policy = new LimitPolicy(f.k);
  expect(policy.softDecision("lead", null, limit)).toBeNull();
  const d = f.k.decide("lead", { text: "One extra", why: "Bounded work", reversible: true, source: "keeper", exceeds: limit });
  expect(policy.softDecision("lead", null, limit)).toBe(d.id);
  policy.claimSoft(d.id, "hire");
  expect(policy.softDecision("lead", null, limit)).toBeNull();
  expect(() => policy.claimSoft(d.id, "second")).toThrow();
});
