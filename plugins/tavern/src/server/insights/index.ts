import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { insightsContract, type InsightsView } from "../../shared/insights";
import type { Ask, BoardQuest, GateRecord, KeeperNote, Member, Report, Route } from "../../shared/schema";
import type { Database } from "../ports";
import type { SettingsStore } from "../settings/store";
import { LIMITS } from "../limits";
import { aggregateInsights, type InsightData, type InsightCharacters, type Observation } from "./aggregate";
import { tuningSignals } from "./signals";

type EventRow = { id: string | number; at: number; type: string; text: string; data: string; keeper_thread_id: string | null; board_quest_id: string | null };
type SampleRow = Omit<EventRow, "type" | "text"> & { kind: string };
const jsonObject = z.record(z.string(), z.json());
export type CostReader = (data: InsightData, from: number, to: number) => Promise<InsightsView["cost"]>;
export class InsightsReader {
  constructor(readonly db: Database, readonly settings: SettingsStore, readonly now = Date.now, private readonly readCost?: CostReader, private readonly readCharacters?: () => InsightCharacters) {}
  record(kind: string, data: Record<string, unknown>, keeperId: string | null = null, questId: string | null = null, id: string = randomUUID(), at = this.now()) {
    const parsed = jsonObject.parse(data);
    return this.db.prepare("INSERT INTO tavern_insight_samples(id,at,kind,keeper_thread_id,board_quest_id,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(id, at, kind, keeperId, questId, JSON.stringify(parsed)).changes > 0;
  }
  prune() {
    const days = this.settings.read().data.historyDays;
    if (days === 0) return 0;
    return this.db.prepare("DELETE FROM tavern_insight_samples WHERE at<?").run(this.now() - days * LIMITS.dayMs).changes;
  }
  private records<T>(kind: string): T[] {
    return (this.db.prepare("SELECT data FROM tavern_records WHERE kind=?").all(kind) as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }
  data(from: number, to = this.now()): InsightData {
    const quests = this.records<BoardQuest>("quests");
    const native = this.db.prepare("SELECT * FROM tavern_events WHERE at>=? AND at<=? ORDER BY at,id").all(from, to) as EventRow[];
    const ids = [...new Set([...quests.filter(quest => quest.createdAt <= to && (quest.endedAt === null || quest.endedAt >= from)).map(quest => quest.id),
      ...native.filter(row => row.type === "waypoint.reviewed" && row.board_quest_id !== null).map(row => row.board_quest_id!)])];
    const older = this.db.prepare("SELECT * FROM tavern_events WHERE at<? AND board_quest_id IN (SELECT value FROM json_each(?)) AND type IN ('quest.phase','plan.proposed','waypoint.reviewed') ORDER BY at,id")
      .all(from, JSON.stringify(ids)) as EventRow[];
    const sampleRows = this.db.prepare("SELECT * FROM tavern_insight_samples WHERE (at>=? OR (board_quest_id IN (SELECT value FROM json_each(?)) AND kind='waypoint.reviewed')) AND at<=? ORDER BY at,id")
      .all(from, JSON.stringify(ids), to) as SampleRow[];
    const events: Observation[] = [...older, ...native].map(row => ({ id: `event:${row.id}`, at: row.at, type: row.type, text: row.text,
      keeperThreadId: row.keeper_thread_id, questId: row.board_quest_id, data: jsonObject.parse(JSON.parse(row.data)) }));
    events.push(...sampleRows.map(row => ({ id: `sample:${row.id}`, at: row.at, type: row.kind, text: row.kind,
      keeperThreadId: row.keeper_thread_id, questId: row.board_quest_id, data: jsonObject.parse(JSON.parse(row.data)) })));
    events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    return { quests, events, asks: this.records<Ask>("asks"), members: this.records<Member>("members"), reports: this.records<Report>("reports"),
      routes: this.records<Route>("routes"), gates: this.records<GateRecord>("gates"), notes: this.records<KeeperNote>("notes") };
  }
  signals() {
    const to = this.now(), from = to - LIMITS.tuningWindowDays * LIMITS.dayMs;
    return tuningSignals(this.data(from, to), from, to);
  }
  async view(range: InsightsView["range"]): Promise<InsightsView> {
    const now = this.now(), from = now - { "7d": 7, "30d": 30, "90d": 90 }[range] * LIMITS.dayMs;
    const data = this.data(from, now);
    const view = aggregateInsights(data, this.settings.snapshot(), range, now, this.settings.collectingSince(), this.settings.historySince(from, now), this.readCharacters?.() ?? null);
    if (this.readCost) view.cost = await this.readCost(data, from, now);
    return view;
  }
}
export function registerInsightsRpc(bb: BbPluginApi, reader: InsightsReader) {
  bb.rpc.register(insightsContract, { insights: input => reader.view(input.range) });
}
