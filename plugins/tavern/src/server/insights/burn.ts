import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { InsightsView } from "../../shared/insights";
import type { InsightData } from "./aggregate";
import { LIMITS } from "../limits";

const count = z.number().finite().nonnegative();
const tokensSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count });
export const burnUsageSchema = z.object({
  report: z.object({ startedAt: count, updatedAt: count, calls: count, tokens: tokensSchema,
    cost: z.object({ total: count }), estimated: z.boolean(), byModel: z.array(z.object({ key: z.string(), cost: count })),
    turns: z.array(z.object({ n: count, at: count, calls: count, cost: count, tokens: tokensSchema, models: z.array(z.string()) })),
  }).nullable(), family: z.object({ children: z.array(z.object({ threadId: z.string() })) }),
});
type BurnUsage = z.infer<typeof burnUsageSchema>;
const missing = (error: unknown) => (error as { status?: number })?.status === 404 || /unknown plugin|not running|disabled/iu.test(String(error));
export class BurnCosts {
  private presence: { value: boolean; at: number } | null = null;
  private cache = new Map<string, { at: number; usage: BurnUsage }>();
  constructor(private readonly bb: BbPluginApi, private readonly now = Date.now) {}
  async read(data: InsightData, from: number, to: number): Promise<InsightsView["cost"]> {
    const quests = data.quests.filter(quest => quest.createdAt <= to && (quest.endedAt === null || quest.endedAt >= from));
    const ids = new Set(quests.map(quest => quest.id));
    const targets = new Map<string, string | null>();
    for (const quest of quests) targets.set(quest.keeperThreadId, null);
    for (const member of data.members) if (member.role === "member" && member.boardQuestId && ids.has(member.boardQuestId)) targets.set(member.threadId, member.boardQuestId);
    const known = new Map<string, BurnUsage>();
    let estimated = false, failed = false;
    const signal = AbortSignal.timeout(LIMITS.burnTimeoutMs);
    try {
      if (!this.presence || this.now() - this.presence.at >= LIMITS.burnCacheMs) {
        const list = await this.bb.sdk.plugins.list({ signal });
        this.presence = { at: this.now(), value: list.plugins.some(plugin => plugin.id === "burn" && plugin.enabled) };
      }
      if (!this.presence.value) return null;
      const queue = [...targets.keys()];
      let reads = 0;
      for (let index = 0; index < queue.length && !signal.aborted; index++) {
        const threadId = queue[index]!, cached = this.cache.get(threadId);
        let usage: BurnUsage;
        if (cached && this.now() - cached.at < LIMITS.burnCacheMs) usage = cached.usage;
        else {
          if (reads >= LIMITS.burnReadBudget) break;
          reads++;
          const answer = await this.bb.sdk.plugins.callRpc({ pluginId: "burn", method: "usage", input: { threadId },
            outputSchema: burnUsageSchema as unknown as Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["outputSchema"], signal });
          usage = burnUsageSchema.parse(answer);
          this.cache.delete(threadId);
          this.cache.set(threadId, { at: this.now(), usage });
          if (this.cache.size > LIMITS.burnCacheEntries) this.cache.delete(this.cache.keys().next().value!);
        }
        known.set(threadId, usage);
        const questId = targets.get(threadId);
        if (questId) for (const child of usage.family.children) if (!targets.has(child.threadId)) {
          targets.set(child.threadId, questId); queue.push(child.threadId);
        }
      }
    } catch (error) {
      if (missing(error)) { this.presence = { value: false, at: this.now() }; return null; }
      failed = true;
      this.bb.log.warn(`Tavern Insights could not read Burn usage: ${String(error)}`);
    }
    const totals = new Map(quests.map(quest => [quest.id, { cost: 0, tokens: 0, seen: false }]));
    for (const [threadId, usage] of known) {
      if (!usage.report) continue;
      estimated ||= usage.report.estimated;
      const assigned = targets.get(threadId);
      for (const turn of usage.report.turns) {
        if (turn.at < from || turn.at > to) continue;
        const active = quests.filter(quest => (!assigned || quest.id === assigned) && quest.createdAt <= turn.at && (quest.endedAt === null || turn.at <= quest.endedAt));
        if (active.length > 1) estimated = true;
        for (const quest of active) {
          const total = totals.get(quest.id)!;
          total.cost += turn.cost / active.length;
          total.tokens += (turn.tokens.input + turn.tokens.output + turn.tokens.cacheRead + turn.tokens.cacheWrite) / active.length;
          total.seen = true;
        }
      }
    }
    const rows = quests.map(quest => {
      const total = totals.get(quest.id)!;
      const threads = [...targets].filter(([threadId, assigned]) => assigned === quest.id || (assigned === null && threadId === quest.keeperThreadId)).map(([threadId]) => threadId);
      const complete = threads.every(threadId => {
        const report = known.get(threadId)?.report;
        return report != null && report.turns.reduce((calls, turn) => calls + turn.calls, 0) >= report.calls;
      });
      return { questId: quest.id, title: quest.title, cost: total.seen ? total.cost : null, tokens: total.seen ? total.tokens : null,
        seconds: (Math.min(quest.endedAt ?? to, to) - quest.createdAt) / 1000, complete };
    });
    const measured = rows.filter(row => row.cost !== null), titleIds = new Map<string, string[]>(), labels = new Map<string, string>();
    for (const row of rows) titleIds.set(row.title, [...(titleIds.get(row.title) ?? []), row.questId]);
    for (const [title, ids] of titleIds) {
      const suffixes = new Map<string, number>();
      for (const id of ids) suffixes.set(id.slice(-8), (suffixes.get(id.slice(-8)) ?? 0) + 1);
      for (const id of ids) labels.set(id, ids.length === 1 ? title : `${title} · ${suffixes.get(id.slice(-8))! > 1 ? id : id.slice(-8)}`);
    }
    return {
      caption: `${failed ? "The current Burn read failed; figures below may be partial. " : ""}Recorded usage from Burn's public RPC. Member turns belong to their quest; shared Keeper turns are split evenly across quests active at the turn's start. Shared allocations and Burn's list-price figures are estimates. Unknown usage is not zero.`,
      series: [{ id: "cost-recorded", label: "Recorded cost in range", unit: "usd", value: measured.length ? measured.reduce((sum, row) => sum + row.cost!, 0) : null },
        { id: "cost-per-quest", label: "Recorded cost per quest", unit: "usd", points: rows.map(row => ({ x: row.questId, label: labels.get(row.questId)!, y: row.cost })) },
        { id: "time-per-quest", label: "Elapsed time per quest", unit: "s", points: rows.map(row => ({ x: row.questId, label: labels.get(row.questId)!, y: row.seconds })) }],
      quests: rows, estimated, threadsKnown: [...known.values()].filter(usage => usage.report !== null).length, threadsTotal: targets.size,
    };
  }
}
