import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DAY_MS, type CardSignal } from "../shared/study-events";
import type { Member } from "../shared/schema";
import type { KeeperStore } from "./keeper/store";

export const studyMigration = `CREATE TABLE tavern_study_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL,
  thread_id TEXT, quest_id TEXT, dedup TEXT UNIQUE, data TEXT NOT NULL
 );
 CREATE INDEX tavern_study_events_at ON tavern_study_events(at);
 CREATE INDEX tavern_study_refusals ON tavern_study_events(thread_id, at)
   WHERE type='tool.refused' AND json_type(data,'$.nextCall')='null';
 CREATE TABLE tavern_study_state (thread_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id,kind));`;

type Execution = { providerId: string; model: string | null; reasoningLevel: string | null };
export class StudyRefusal extends Error {
  constructor(readonly ruleId: string, message?: string) { super(message); }
}
function ruleId(tool: string, error: unknown) {
  if (error instanceof StudyRefusal) return error.ruleId;
  if (error instanceof z.ZodError) return "tool.arguments";
  return `${tool}.action`;
}

export class StudyEvents {
  private pruned: { day: number; days: number } | undefined;
  constructor(private readonly store: KeeperStore, private readonly now: () => number,
    private readonly followupSeconds: () => number, private readonly warn: (message: string) => void) {}

  get db() { return this.store.db; }
  attempt<T>(operation: () => T): T | undefined {
    try { return operation(); }
    catch { this.warn("Tavern could not write a local study measurement."); }
  }
  record(type: string, threadId: string | null, questId: string | null, data: Record<string, unknown>, at = this.now(), dedup: string | null = null) {
    this.db.prepare("INSERT INTO tavern_study_events(at,type,thread_id,quest_id,data,dedup) VALUES (?,?,?,?,?,?) ON CONFLICT(dedup) DO NOTHING")
      .run(at, type, threadId, questId, JSON.stringify(data), dedup);
  }
  state<T>(threadId: string, kind: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM tavern_study_state WHERE thread_id=? AND kind=?").get(threadId, kind) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  setState(threadId: string, kind: string, value: unknown) {
    this.db.prepare("INSERT INTO tavern_study_state VALUES (?,?,?) ON CONFLICT(thread_id,kind) DO UPDATE SET data=excluded.data")
      .run(threadId, kind, JSON.stringify(value));
  }
  execution(member: Member, { providerId, model, reasoningLevel }: Execution, keeper = member.role === "keeper") {
    this.attempt(() => this.store.atomic(() => {
      const prior = this.state<Execution>(member.threadId, "execution");
      if (prior?.providerId === providerId && prior.model === model && prior.reasoningLevel === reasoningLevel) return;
      const data = { providerId, model, reasoningLevel };
      if (keeper) this.record(prior ? "keeper.execution-changed" : "keeper.bound", member.threadId, member.boardQuestId, data);
      this.setState(member.threadId, "execution", data);
    }));
  }
  async tool<T>(tool: string, threadId: string, input: unknown, call: (refused: (ruleId: string) => void) => T | Promise<T>): Promise<T> {
    const at = this.now();
    const followup = this.attempt(() => {
      const seconds = this.followupSeconds();
      if (!seconds) return [];
      return (this.db.prepare(`UPDATE tavern_study_events SET data=json_set(data,'$.nextCall',json_object('tool',?,'succeeded',NULL,'afterMs',?-at))
        WHERE type='tool.refused' AND thread_id=? AND json_type(data,'$.nextCall')='null' AND at BETWEEN ? AND ? RETURNING id`)
        .all(tool, at, threadId, at - seconds * 1000, at) as { id: number }[]).map(row => row.id);
    });
    let refused: string | undefined;
    try { return await call(id => { refused = id; }); }
    catch (error) { refused ??= ruleId(tool, error); throw error; }
    finally {
      this.attempt(() => this.store.atomic(() => {
        if (followup?.length) this.db.prepare(`UPDATE tavern_study_events SET data=json_set(data,'$.nextCall.succeeded',json(?))
          WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(!refused), JSON.stringify(followup));
        if (!refused) return;
        const member = this.store.get("members", threadId);
        const model = this.state<Execution>(threadId, "execution")?.model ?? this.store.runtime(threadId).classExecutionChoice?.model ?? null;
        this.record("tool.refused", threadId, member?.boardQuestId ?? null, {
          tool, ruleId: refused, classId: member?.classId ?? null, model,
          argumentBytes: Buffer.byteLength(JSON.stringify(input) ?? ""), nextCall: null,
        });
      }));
    }
  }
  cards(entries: readonly CardSignal[]) {
    this.store.atomic(() => {
      for (const { threadId, questId, messageId, cardId, cardType, action } of entries) {
        this.record("card.engagement", threadId, questId, { messageId, cardId, cardType, action }, this.now(),
          JSON.stringify(["card", threadId, messageId, cardType, questId, cardId, action]));
      }
    });
  }
  prune(days: number) {
    // Sweep once per calendar day or when the setting changes, not on every turn.
    const now = this.now(), day = Math.floor(now / DAY_MS);
    if (this.pruned?.day === day && this.pruned.days === days) return;
    if (!days || this.attempt(() => this.db.prepare("DELETE FROM tavern_study_events WHERE at < ?").run(now - days * DAY_MS))) this.pruned = { day, days };
  }
  page(after: number) {
    const read = this.db.prepare(`SELECT id,at,type,thread_id AS threadId,quest_id AS questId,data
      FROM tavern_study_events WHERE id>? ORDER BY id`);
    const events: { id: number; at: number; type: string; threadId: string | null; questId: string | null; data: Record<string, unknown> }[] = [];
    let bytes = 0, cursor = after;
    const envelope = Buffer.byteLength(JSON.stringify({ events: [], next: Number.MAX_SAFE_INTEGER }));
    for (const row of read.iterate(after) as Iterable<Omit<typeof events[number], "data"> & { data: string }>) {
      const event = { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size + envelope > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
        if (!events.length) throw new Error(`Study event ${event.id} exceeds the BB CLI output limit.`);
        return { events, next: cursor };
      }
      events.push(event);
      bytes += size + 1;
      cursor = row.id;
    }
    return { events, next: null };
  }
}
