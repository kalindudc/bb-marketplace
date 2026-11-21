import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../ports";
import { KeeperStore } from "../keeper/store";
import { AWAY_STOP_LIST, PRODUCTION_WAKE_HOURS, awayCloseSchema, awayCompletedWindowSchema, awayReturnCauseSchema, awayStateSchema, awayWindowSchema, type AwayCloseInput, type AwayReturnCause, type AwaySnapshot, type AwayStopKind, type AwayState, type AwayWindow } from "../../shared/away";

export class AwayConflict extends Error {
  constructor(readonly revision: number) { super("Closing time changed; refresh before trying again."); }
}
type Row = { id: string; data: string };
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export class AwayStore {
  private readonly records: KeeperStore;
  constructor(readonly db: Database, private readonly now: () => number = Date.now) { this.records = new KeeperStore(db); }

  private state(): AwayState {
    try {
      const rows = this.db.prepare("SELECT id,data FROM tavern_records WHERE kind='away'").all() as Row[];
      if (rows.length === 0) {
        if (this.db.prepare("SELECT 1 FROM tavern_records WHERE kind='awayWindows' LIMIT 1").get())
          throw new Error("Completed away windows exist but their current state is missing");
        return { revision: 0, window: null };
      }
      if (rows.length !== 1 || rows[0]!.id !== "current") throw new Error("Expected one current away state");
      return awayStateSchema.parse(JSON.parse(rows[0]!.data));
    } catch (error) {
      throw new Error(`Closing time state is invalid: ${String(error)}`);
    }
  }
  private openAskIds() {
    return (this.db.prepare("SELECT id FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.state')='open' ORDER BY id").all() as { id: string }[]).map(row => row.id);
  }
  private maxEvent() {
    return cursor.parse((this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM tavern_events").get() as { id: number }).id);
  }
  private save(state: AwayState) {
    const parsed = awayStateSchema.parse(state);
    this.records.writeRecords("INSERT INTO tavern_records(kind,id,data) VALUES('away','current',?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", JSON.stringify(parsed));
  }
  private event(at: number, type: string, text: string, data: Record<string, unknown>) {
    return cursor.parse(Number(this.db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(?,NULL,NULL,?, ?,?,?)")
      .run(at, JSON.stringify({ kind: "user" }), type, text, JSON.stringify(data)).lastInsertRowid));
  }
  private view(state: AwayState): AwaySnapshot {
    const window = state.window, closed = window !== null && window.returnedAt === null;
    return { ...state, status: { closed, until: closed ? window.until : null,
      dueBack: closed && this.now() >= window.until, windowId: window?.id ?? null } };
  }
  snapshot(): AwaySnapshot { return this.view(this.state()); }

  close(input: AwayCloseInput, stopList: readonly AwayStopKind[] = AWAY_STOP_LIST, productionWakeHours: number = PRODUCTION_WAKE_HOURS.default): AwaySnapshot {
    const parsed = awayCloseSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.state();
      if (current.revision !== parsed.revision) throw new AwayConflict(current.revision);
      if (current.window !== null && current.window.returnedAt === null) throw new Error("The tavern is already closed; return before starting another window.");
      const at = this.now();
      if (parsed.until <= at) throw new Error("Back at must be in the future.");
      const id = `away_${randomUUID()}`, version = current.revision + 1;
      const eventFloor = this.event(at, "away.closed", "Closed the tavern", { windowId: id, until: parsed.until, quests: parsed.quests, allowWatched: parsed.allowWatched, openAskIds: this.openAskIds() });
      const trimmed = parsed.note?.trim();
      const window = awayWindowSchema.parse({ id, version, closedAt: at, until: parsed.until,
        quests: parsed.quests, allowWatched: parsed.allowWatched, wakeRules: parsed.wakeRules, productionWakeHours,
        note: trimmed ? trimmed : null, guardPolicy: "selected", stopList: AWAY_STOP_LIST.filter(kind => (parsed.stopList ?? stopList).includes(kind)), eventFloor, eventCeiling: null, returnedAt: null, returnCause: null });
      const state = { revision: version, window };
      this.save(state);
      return this.view(state);
    })();
  }

  finish(windowId: string, cause: AwayReturnCause): { changed: boolean; snapshot: AwaySnapshot } {
    const parsed = awayReturnCauseSchema.parse(cause);
    return this.db.transaction(() => {
      const current = this.state();
      if (current.window === null || current.window.id !== windowId) throw new AwayConflict(current.revision);
      if (current.window.returnedAt !== null) return { changed: false, snapshot: this.view(current) };
      const version = current.revision + 1;
      const window = awayCompletedWindowSchema.parse({ ...current.window, version, returnedAt: this.now(), returnCause: parsed, eventCeiling: this.maxEvent() });
      const state = { revision: version, window };
      this.save(state);
      this.records.writeRecords("INSERT INTO tavern_records(kind,id,data) VALUES('awayWindows',?,?)", window.id, JSON.stringify(window));
      this.event(window.returnedAt!, "away.returned", "The tavern reopened", { windowId, cause: parsed, openAskIds: this.openAskIds() });
      return { changed: true, snapshot: this.view(state) };
    })();
  }

  window(id?: string): AwayWindow | null {
    const current = this.state().window;
    if (id === undefined || current?.id === id) return current;
    const row = this.db.prepare("SELECT id,data FROM tavern_records WHERE kind='awayWindows' AND id=?").get(id) as Row | undefined;
    if (row === undefined) return null;
    const window = awayCompletedWindowSchema.parse(JSON.parse(row.data));
    if (window.id !== row.id) throw new Error("Closing time history has a mismatched window id");
    return window;
  }
  history(limit = 20): AwayWindow[] {
    z.number().int().min(1).max(100).parse(limit);
    const rows = this.db.prepare("SELECT id,data FROM tavern_records WHERE kind='awayWindows' ORDER BY json_extract(data,'$.version') DESC LIMIT ?").all(limit) as Row[];
    return rows.map(row => {
      const window = awayCompletedWindowSchema.parse(JSON.parse(row.data));
      if (window.id !== row.id) throw new Error("Closing time history has a mismatched window id");
      return window;
    });
  }
  eventRange(windowId?: string) {
    return this.db.transaction(() => {
      const window = this.window(windowId);
      if (window === null) return null;
      return { after: window.eventFloor, through: window.eventCeiling ?? this.maxEvent(), closedAt: window.closedAt, returnedAt: window.returnedAt };
    })();
  }
}
