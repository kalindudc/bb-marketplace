import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BurnCosts } from "../../src/server/insights/burn";
import type { InsightData } from "../../src/server/insights/aggregate";
import { boardQuestSchema, memberSchema } from "../../src/shared/schema";
import { withEngagement } from "../ui/member-fixture";
const now = 1_800_000_000_000;
function data(): InsightData {
  const quests = ["q1", "q2"].map(id => boardQuestSchema.parse({ id, keeperThreadId: "keeper", title: id, short: id, phase: "done", planVersion: 1, greenlitVersion: 1, createdAt: now - 10000, updatedAt: now, endedAt: now, archivedAt: null }));
  const members = ["q1", "q2"].map((id, index) => memberSchema.parse(withEngagement({ threadId: `m${index}`, classId: "smith", characterId: "smith", role: "member", keeperThreadId: "keeper", boardQuestId: id, waypointId: "w1", errand: false, title: id, place: "rest", state: "done", doing: null, createdAt: now - 10000, lastActiveAt: now, lastReportAt: now, strikes: 0, verifiedWins: 1 })));
  return { quests, members, asks: [], reports: [], events: [], routes: [], gates: [], notes: [] };
}
function usage(cost: number) {
  const tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  return { report: { startedAt: now - 10000, updatedAt: now, calls: 1, cost: { total: cost }, estimated: false,
    tokens, byModel: [{ key: "model", cost }], turns: [{ n: 1, at: now - 5000, calls: 1, cost, tokens, models: ["model"] }] }, family: { children: [] } };
}
function fixture(present = true) {
  const rpc = vi.fn(async (input: { input: { threadId: string } }) => usage(input.input.threadId === "keeper" ? 4 : input.input.threadId === "m0" ? 1 : 3));
  const bb = { sdk: { plugins: { list: async () => ({ plugins: present ? [{ id: "burn", enabled: true }] : [] }), callRpc: rpc } }, log: { warn: vi.fn() } } as unknown as BbPluginApi;
  return { costs: new BurnCosts(bb, () => now), rpc };
}
describe("optional Burn costs", () => {
  it("hides the cost section when Burn is absent", async () => {
    const { costs, rpc } = fixture(false);
    expect(await costs.read(data(), now - 86400000, now)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("uses Burn's public usage RPC and allocates shared Keeper turns only once", async () => {
    const { costs, rpc } = fixture();
    const result = (await costs.read(data(), now - 86400000, now))!;
    expect(result.quests).toEqual(expect.arrayContaining([
      expect.objectContaining({ questId: "q1", cost: 3, complete: true }),
      expect.objectContaining({ questId: "q2", cost: 5, complete: true }),
    ]));
    expect(result.estimated).toBe(true);
    expect(result.threadsKnown).toBe(3);
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "burn", method: "usage" }));
    await costs.read(data(), now - 86400000, now);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it("uses shared usd units and distinct human labels for duplicate quest titles", async () => {
    const f = fixture(), input = data(); for (const quest of input.quests) quest.title = "Read the source";
    const result = (await f.costs.read(input, now - 86400000, now))!;
    expect(result.series.find(row => row.id === "cost-recorded")).toMatchObject({ unit: "usd", value: 8 });
    const chart = result.series.find(row => row.id === "cost-per-quest")!; expect(chart.unit).toBe("usd");
    if (!("points" in chart)) throw new Error("Expected points");
    expect(chart.points.map(point => point.x)).toEqual(["q1", "q2"]); expect(new Set(chart.points.map(point => point.label)).size).toBe(2);
    expect(chart.points.every(point => point.label?.startsWith("Read the source"))).toBe(true);
  });
  it("disambiguates duplicate titles even when quest ids have the same short suffix", async () => {
    const f = fixture(), input = data();
    input.quests.forEach((quest, index) => { quest.id = `${index}-same1234`; quest.title = "Same title"; input.members[index]!.boardQuestId = quest.id; });
    const result = (await f.costs.read(input, now - 86400000, now))!, chart = result.series.find(row => row.id === "cost-per-quest")!;
    if (!("points" in chart)) throw new Error("Expected points");
    expect(new Set(chart.points.map(point => point.label)).size).toBe(2);
  });
  it("keeps unknown usage unknown instead of reporting zero or complete totals", async () => {
    const { costs, rpc } = fixture();
    rpc.mockImplementation(async input => input.input.threadId === "m0" ? { report: null, family: { children: [] } } as unknown as ReturnType<typeof usage> : usage(4));
    const result = (await costs.read(data(), now - 86400000, now))!;
    expect(result.quests.find(row => row.questId === "q1")!.complete).toBe(false);
    expect(result.threadsKnown).toBe(2);
  });
});
