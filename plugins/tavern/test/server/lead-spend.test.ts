// @vitest-environment node
import { expect, it } from "vitest";
import { projectLeadSpendSubtree } from "../../src/server/keeper/lead-spend";
import type { KeeperStore } from "../../src/server/keeper/store";
import type { LeadLink } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

it("projects live and retired child quests once and excludes unbound seats", () => {
  const edges = new Map<string, Partial<LeadLink>[]>([
    ["root", [{ childQuestId: "child", state: "retired" }, { childQuestId: "child", state: "linked" }, { childQuestId: null, state: "reserved" }]],
    ["child", [{ childQuestId: "grandchild", state: "stopped" }]],
  ]);
  const store: Pick<KeeperStore, "leadLinksBy"> = { leadLinksBy: (_field, id) => (edges.get(id) ?? []) as LeadLink[] };
  expect(projectLeadSpendSubtree(store, "root")).toEqual(["root", "child", "grandchild"]);
  expect(projectLeadSpendSubtree(store, "child")).toEqual(["child", "grandchild"]);
});

it("counts descendant member spend and both lead generations once against the parent cap", async () => {
  const f = setup({ plugins: { callRpc: async () => ({ report: null }) } }), { k } = f;
  const root = await seedQuest(k, "lead", "Coordinate tracks", "Tracks");
  const input = planInput(root.id);
  k.plan("lead", { ...input, waypoints: [{ ...input.waypoints[0]!, owner: "keeper" }],
    party: [{ classId: "keeper", characterId: null, model: "anthropic/claude-sonnet-5-5", purpose: "Coordinate", waypointIds: ["w1"], leadEnvelope: { depth: 1, members: 2, rangers: 0 } }] });
  k.answerAsk(k.store.openAsks("lead", root.id)[0]!.id, "approve", null, "page", "user");
  const brief = { outcome: "Coordinate", mode: "make-it-work" as const, outOfScope: "Deployment", doneWhen: "Tracks pass", context: [], questions: [], timeboxMinutes: null };
  const lead = await f.runtime.hire("lead", "project", { classId: "keeper", boardQuestId: root.id, waypointId: "w1", title: "Child work", brief });
  const child = await k.openQuest(lead.threadId, "Child work", "Child");
  k.bind("maker", "smith", null, "project", { keeperThreadId: lead.threadId, boardQuestId: child.id, waypointId: null, errand: false, title: "Make", brief });
  const spend = f.runtime.spend;
  k.store.put("quests", root.id, { ...k.quest(root.id), spendBudget: { cents: 100, reached: null } });
  const entry = (threadId: string, id: string, usdNanos: number) => spend.ledger.ingest(threadId, [{ source: "Guarded local session", session: threadId, entry: id, at: f.time(), usdNanos }]);
  entry(lead.threadId, "before", 200_000_000);
  f.advance(10);
  const at = f.time();
  k.bind("successor", "keeper", null, "project");
  k.store.put("keeperSpendIntervals", lead.threadId, { chargeId: lead.threadId, threadId: lead.threadId, from: null, until: at });
  k.store.put("keeperSpendIntervals", "successor", { chargeId: lead.threadId, threadId: "successor", from: at, until: null });
  k.store.put("quests", child.id, { ...k.quest(child.id), keeperThreadId: "successor" });
  entry(lead.threadId, "out-of-window", 999_000_000);
  entry("successor", "after", 100_000_000);
  expect(await spend.refresh(root.id)).toMatchObject({ usdNanos: 300_000_000, reachedAt: null });
  entry("maker", "member", 700_000_000);
  await spend.refreshForThread("maker");
  expect(k.quest(root.id).spendBudget?.reached).toEqual({ usdNanos: 1_000_000_000, at });
  expect(await spend.refresh(root.id)).toMatchObject({ usdNanos: 1_000_000_000, reachedAt: at });
  expect(k.store.events().filter(event => event.type === "spend-budget.reached")).toHaveLength(1);
  await expect(f.runtime.sendRebrief("maker", "New work")).rejects.toThrow(/spend budget/);
  const link = k.store.get("leadLinks", lead.leadLinkId!)!;
  k.store.put("leadLinks", link.id, { ...link, state: "retired" });
  expect((await spend.refresh(root.id)).usdNanos).toBe(1_000_000_000);
});
