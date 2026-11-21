import { KeeperStore } from "../keeper/store";
import { JOURNAL_ACTION_PHRASES } from "../journal/action-phrases";
import { SEED_QUEST_CHANGE_SEEN } from "../quest-change-attention";
import { transitionQuest } from "../keeper/quest-lifecycle";
import { z } from "zod";
import { pullRequestSchema } from "../../shared/pull-request";
import { serviceQuestRecordSchema, serviceVerdictSchema, serviceRecordStateSchema, taleKeepSchema, taleKeepKey } from "../../shared/service-record";
import type { Database } from "../ports";
import { databaseConnection } from "../prepared-database";
import type { SettingsStore } from "../settings/store";
import { LIMITS } from "../limits";
import { sparseTunablesSchema } from "../../shared/settings";
import { shellGrantSchema } from "../../shared/shell-grant";
import { awayHoldSchema, type AwayHold } from "../away/holds";
import { awayCompletedWindowSchema, awayStateSchema, type AwayState, type AwayWindow } from "../../shared/away";
import { isCloseEffect } from "../../shared/closing";
import { migrateMemberEngagement } from "../member-engagement-migration";
import { actorSchema, readStoredActor, askSchema, boardQuestSchema, decisionSchema, gateRecordSchema, journalEntrySchema, keeperNoteSchema, memberSchema, planSchema, reportSchema, routeSchema, ruleSchema, summarySchema } from "../../shared/schema";

import { taleDeliverySchema, taleDeliveryAttemptSchema } from "../tale";

const scalar = z.union([z.string(), z.number().finite(), z.null()]);
const tableSchema = z.object({ columns: z.array(z.string()).min(1), rows: z.array(z.record(z.string(), scalar)) }).strict();
export const recordsSnapshotSchema = z.object({ format: z.literal("tavern-records/1"), collectingSince: z.number().int().nonnegative(), overrides: z.record(z.string(), sparseTunablesSchema), sequences: z.record(z.string(), z.number().int().nonnegative()), tables: z.record(z.string(), tableSchema) }).strict();
export type RecordsSnapshot = z.infer<typeof recordsSnapshotSchema>;
type Column = { name: string; type: string; notnull: number; pk: number; dflt_value: unknown };
const legacyMemberSchema = memberSchema.extend({ state: z.union([memberSchema.shape.state, z.literal("done"), z.literal("stopped")]) });
const recordSchemas: Record<string, z.ZodType> = { pullRequests: pullRequestSchema, taleDeliveries: taleDeliverySchema, taleDeliveryAttempts: taleDeliveryAttemptSchema, taleKeeps: taleKeepSchema, serviceRecords: serviceQuestRecordSchema, serviceVerdicts: serviceVerdictSchema, serviceRecordState: serviceRecordStateSchema, members: memberSchema, quests: boardQuestSchema, plans: planSchema, asks: askSchema, decisions: decisionSchema, rules: ruleSchema, reports: reportSchema, summaries: summarySchema, routes: routeSchema, notes: keeperNoteSchema, gates: gateRecordSchema };
const jsonColumns = new Set(["data", "actor", "entry_ids", "before_data", "after_data", "snapshot", "changes", "undo_data", "evidence"]);
const privateRecordKinds = new Set(["placementArtifactManifests", "stopAll", "scopeInputs"]);
const privateAuthorityTables = ["tavern_placements", "tavern_source_snapshots", "tavern_placement_discoveries", "tavern_snapshot_owners"];
// Setup proposals hold agent-named commands against a past settings revision; a restore never revives them.
const excluded = new Set(["tavern_settings", "tavern_insight_meta", "tavern_setup_proposals", ...privateAuthorityTables]);
const supported = new Set(["tavern_records", "tavern_runtime", "tavern_events", "tavern_messages", "tavern_outbox", "tavern_setting_changes", "tavern_tuning_runs", "tavern_tuning_suggestions", "tavern_insight_samples", "questlog_logs", "questlog_entries", "questlog_reserved", "questlog_changes", "questlog_history", "questlog_imports", "questlog_archive", "questlog_mirrors"]);
function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsupported database identifier: ${value}`);
  return `"${value}"`;
}
export class BackupRecords {
  constructor(readonly db: Database, readonly settings: SettingsStore, private readonly now = Date.now) {}
  private schema() {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const owned = tables.filter(table => /^(?:tavern|questlog)_/.test(table.name) && !excluded.has(table.name));
    for (const table of owned) if (!supported.has(table.name)) throw new Error(`Unsupported Tavern records table: ${table.name}`);
    for (const name of supported) if (!owned.some(table => table.name === name)) throw new Error(`Required Tavern records table is missing: ${name}`);
    return new Map(owned.map(table => [table.name,
      this.db.prepare(`PRAGMA table_info(${identifier(table.name)})`).all() as Column[]]));
  }
  counts() {
    return Object.fromEntries([...this.schema()].map(([name]) => [name, (this.db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(name)}`).get() as { n: number }).n]));
  }
  empty() {
    if (!Object.values(this.counts()).every(count => count === 0)) return false;
    return privateAuthorityTables.every(name => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      return !exists || (this.db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(name)}`).get() as { n: number }).n === 0;
    });
  }
  estimateBytes() {
    let bytes = 1024;
    for (const [name, columns] of this.schema()) {
      const fields = columns.flatMap(column => [`'${column.name}'`, identifier(column.name)]).join(",");
      bytes += (this.db.prepare(`SELECT COALESCE(SUM(LENGTH(CAST(JSON_OBJECT(${fields}) AS BLOB))),0) AS n FROM ${identifier(name)}`).get() as { n: number }).n;
    }
    return Math.ceil(bytes * 1.5);
  }
  capture(): RecordsSnapshot {
    if (this.estimateBytes() > LIMITS.backupBundleBytes) throw new Error(`Tavern records exceed the ${LIMITS.backupBundleBytes}-byte snapshot safety limit.`);
    const result: RecordsSnapshot = this.db.transaction(() => {
      const schema = [...this.schema()], names = schema.map(([name]) => name);
      const sequences = this.db.prepare(`SELECT name,seq FROM sqlite_sequence WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY name`).all(...names) as { name: string; seq: number }[];
      return { format: "tavern-records/1" as const, collectingSince: this.settings.collectingSince(), overrides: this.settings.questOverrides(), sequences: Object.fromEntries(sequences.map(row => [row.name, row.seq])), tables: Object.fromEntries(schema.map(([name, columns]) => [name, { columns: columns.map(column => column.name), rows: this.db.prepare(`SELECT * FROM ${identifier(name)}`).all() as RecordsSnapshot["tables"][string]["rows"] }])) };
    })();
    if (result.tables.tavern_records) result.tables.tavern_records.rows = result.tables.tavern_records.rows.filter(row => !privateRecordKinds.has(String(row.kind)));
    for (const row of result.tables.tavern_events?.rows ?? []) if (typeof row.actor === "string") row.actor = JSON.stringify(readStoredActor(row.actor));
    return this.checkRows(result);
  }
  private portableDelivery(snapshot: RecordsSnapshot, restoredAt: number | null): RecordsSnapshot {
    const deliveryAsks = new Map<string, string>();
    const runtimes = snapshot.tables.tavern_runtime;
    if (runtimes) for (const row of runtimes.rows) {
      const data = z.record(z.string(), z.json()).parse(JSON.parse(String(row.data)));
      if (typeof data.tickDeliveryAskId === "string") deliveryAsks.set(data.tickDeliveryAskId, String(row.thread_id));
      for (const key of ["tickDeliveryAskId", "tickRefusalCount", "queuedTickResetId", "tickRetryAt"]) delete data[key];
      row.data = JSON.stringify(data);
    }
    const outbox = snapshot.tables.tavern_outbox;
    if (outbox) for (const row of outbox.rows) {
      const data = z.record(z.string(), z.json()).parse(JSON.parse(String(row.data)));
      const states = z.enum(["prepared", "queued", "delivered", "cancelled"]);
      const storedState = states.parse(row.state), batchState = states.parse(data.state);
      const state = storedState === "delivered" && batchState === "delivered" ? "delivered" : "cancelled";
      for (const key of ["sendPending", "resendCount", "lastSendAt", "measurements", "admittedResendCount"]) delete data[key];
      row.state = state; row.data = JSON.stringify({ ...data, state, text: "" });
    }
    const records = snapshot.tables.tavern_records;
    if (records) for (const row of records.rows) {
      if (row.kind === "shellGrants") {
        const grant = shellGrantSchema.parse(JSON.parse(String(row.data)));
        if (grant.state === "issued") row.data = JSON.stringify({ ...grant, state: "expired", changedAt: restoredAt ?? grant.changedAt });
        continue;
      }
      if (row.kind !== "asks") continue;
      const ask = askSchema.parse(JSON.parse(String(row.data)));
      if (ask.state === "open" && (deliveryAsks.get(ask.id) === ask.keeperThreadId || ask.effect?.type === "grant-shell-act") ||
        ask.state === "withdrawn" && ask.withdrawnCause === "backup-restored" && ask.withdrawnAt == null) {
        row.data = JSON.stringify(askSchema.parse({ ...ask, state: "withdrawn", withdrawnCause: "backup-restored", withdrawnAt: restoredAt }));
      }
    }
    return snapshot;
  }
  private checkRows(input: unknown, restoredAt: number | null = null): RecordsSnapshot {
    const snapshot = recordsSnapshotSchema.parse(input), schema = this.schema();
    let away: AwayState | null = null;
    const awayHistory = new Map<string, AwayWindow>();
    const awayHolds: AwayHold[] = [];
    for (const name of Object.keys(snapshot.sequences)) {
      if (!schema.has(name)) throw new Error(`Snapshot sequence is not a Tavern table: ${name}`);
      const definition = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string };
      if (!/\bAUTOINCREMENT\b/i.test(definition.sql)) throw new Error(`Snapshot sequence is not an autoincrement table: ${name}`);
    }
    for (const [name, table] of Object.entries(snapshot.tables)) {
      const columns = schema.get(name);
      if (!columns) throw new Error(`Snapshot table is not a Tavern records table: ${name}`);
      if (new Set(table.columns).size !== table.columns.length || table.columns.some(name => !columns.some(column => column.name === name))) throw new Error(`Snapshot has unknown or duplicate columns in ${name}`);
      for (const column of columns) if (!table.columns.includes(column.name) && (column.pk || column.notnull) && column.dflt_value === null) throw new Error(`Snapshot is missing required column ${name}.${column.name}`);
      for (const row of table.rows) {
        if (Object.keys(row).length !== table.columns.length || table.columns.some(name => !Object.hasOwn(row, name))) throw new Error(`Snapshot row does not match the columns of ${name}`);
        for (const column of columns) {
          if (!table.columns.includes(column.name)) continue;
          const value = row[column.name];
          if (value === null && (column.pk || column.notnull)) throw new Error(`Required value missing in ${name}.${column.name}`);
          if (value === null) continue;
          if (/INT/i.test(column.type) && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error(`Expected an integer in ${name}.${column.name}`);
          if (/(?:TEXT|CHAR|CLOB)/i.test(column.type) && typeof value !== "string") throw new Error(`Expected text in ${name}.${column.name}`);
          if (jsonColumns.has(column.name) && typeof value === "string") z.json().parse(JSON.parse(value));
        }
        if (typeof row.actor === "string") actorSchema.parse(JSON.parse(row.actor));
        if (name === "tavern_records") {
          if (privateRecordKinds.has(String(row.kind))) throw new Error("Private placement preservation manifests, live brake state and scope inputs cannot be restored from portable records");
          const data = JSON.parse(String(row.data));
          z.record(z.string(), z.json()).parse(data);
          if (row.kind === "away") {
            if (row.id !== "current" || away !== null) throw new Error("Closing time needs one current away record");
            away = awayStateSchema.parse(data);
          } else if (row.kind === "awayWindows") {
            const window = awayCompletedWindowSchema.parse(data);
            if (row.id !== window.id || awayHistory.has(window.id)) throw new Error("Closing time history has a mismatched or duplicate window id");
            awayHistory.set(window.id, window);
          } else if (row.kind === "awayHolds") {
            const hold = awayHoldSchema.parse(data);
            if (hold.threadId !== row.id) throw new Error("Closing time hold has a mismatched thread id");
            awayHolds.push(hold);
          } else if (row.kind === "awayWakes") z.object({ at: z.number().int().nonnegative() }).strict().parse(data);
          else if (typeof row.kind === "string" && Object.hasOwn(recordSchemas, row.kind)) {
            if (row.kind === "members" && data.engagement === undefined) legacyMemberSchema.parse(data);
            else recordSchemas[row.kind]!.parse(data);
            if (row.kind === "summaries" && row.id !== data.id) throw new Error("Summary identity does not match its payload.");
            if (row.kind === "serviceRecords" && row.id !== data.questId || row.kind === "serviceVerdicts" && row.id !== data.id || row.kind === "serviceRecordState" && row.id !== "v1" || row.kind === "taleKeeps" && row.id !== taleKeepKey(String(data.questId), String(data.characterId)))
              throw new Error(`Service record identity does not match its payload: ${row.kind}`);
          }
        }
        if (name === "questlog_entries") journalEntrySchema.parse(JSON.parse(String(row.data)));
      }
    }
    const contentTokens = new Set<string>();
    for (const hold of awayHolds) {
      const windows = new Set(hold.windowId === null ? [] : [hold.windowId]);
      for (const reason of hold.reasons ?? []) {
        if (reason.kind === "away") windows.add(reason.windowId);
        else {
          if (contentTokens.has(reason.token)) throw new Error("Member hold content token is duplicated");
          contentTokens.add(reason.token);
        }
      }
      for (const windowId of windows) if (away?.window?.id !== windowId && !awayHistory.has(windowId))
        throw new Error("Closing time hold is missing its away window");
    }
    if (awayHistory.size > 0 && away === null) throw new Error("Closing time history is missing its current away record");
    if (away !== null) {
      for (const window of awayHistory.values()) {
        if (away.window === null || window.version > away.revision || window.version === away.revision && window.id !== away.window.id)
          throw new Error("Closing time history is newer than its current away record");
      }
      if (away.window !== null) {
        const completed = awayHistory.get(away.window.id);
        if (away.window.returnedAt !== null) {
          if (completed === undefined || JSON.stringify(completed) !== JSON.stringify(away.window))
            throw new Error("Closing time is missing matching completed-window history");
        } else if (completed !== undefined) throw new Error("Closing time cannot be active and completed at once");
      }
    }
    return this.portableDelivery(snapshot, restoredAt);
  }
  private insert(snapshot: RecordsSnapshot) {
    this.db.pragma("defer_foreign_keys = ON");
    for (const [name, table] of Object.entries(snapshot.tables)) {
      // Snapshot column orders vary by bundle, not by query shape in Tavern.
      const statement = databaseConnection(this.db).prepare(`INSERT INTO ${identifier(name)} (${table.columns.map(identifier).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`);
      for (const row of table.rows) statement.run(...table.columns.map(column => row[column]));
    }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Snapshot has invalid journal references");
    for (const [name, value] of Object.entries(snapshot.sequences)) {
      const updated = this.db.prepare("UPDATE sqlite_sequence SET seq=MAX(COALESCE(seq,0),?) WHERE name=?").run(value, name);
      if (!updated.changes) this.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(name, value);
    }
    this.settings.restoreOverrides(snapshot.overrides);
    this.db.prepare("UPDATE tavern_insight_meta SET value=? WHERE key='collecting_since'").run(String(snapshot.collectingSince));
  }
  validate(input: unknown) {
    const snapshot = this.checkRows(input);
    if (!this.empty()) return snapshot;
    const rollback = new Error("Rollback snapshot validation");
    const store = new KeeperStore(this.db);
    try { store.atomic(() => { store.importRows(() => this.insert(snapshot)); migrateMemberEngagement(store, this.now()); throw rollback; }); }
    catch (error) { if (error !== rollback) throw error; }
    return snapshot;
  }
  restore(input: unknown) {
    const snapshot = this.checkRows(input, this.now());
    this.db.transaction(() => {
      if (!this.empty()) throw new Error("Records restore requires an empty Tavern database");
      const store = new KeeperStore(this.db);
      store.importRows(() => {
        this.insert(snapshot);
        this.db.exec(JOURNAL_ACTION_PHRASES);
        if (!this.db.prepare("SELECT 1 FROM tavern_records WHERE kind='attentionSeen' AND id GLOB 'quest-change:[0-9]*' LIMIT 1").get())
          this.db.exec(SEED_QUEST_CHANGE_SEEN);
      });
      migrateMemberEngagement(store, this.now());
      for (const ask of store.all("asks")) {
        if (ask.kind !== "conclude" || ask.state !== "withdrawn" || ask.withdrawnCause !== "backup-restored" || !ask.boardQuestId) continue;
        const quest = store.get("quests", ask.boardQuestId);
        if (quest?.phase === "closing") transitionQuest(store, quest, isCloseEffect(ask.effect) ? ask.effect.draft.returnTo ?? "build" : "build", "conclude-withdrawn", { kind: "tavern" }, { kind: "ask", id: ask.id }, this.now());
      }
    })();
  }
}
