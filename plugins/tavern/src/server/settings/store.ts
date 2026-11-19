import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settingsSchema, settingsPatchSchema, settingsUpdateSchema, sparseTunablesSchema, settingsEvidenceSchema, tuningSuggestionSchema,
  TUNABLE_KEYS, TUNABLES, QUEST_TUNABLE_KEYS, type SettingsPatch, type SettingsUpdate, type SettingsEvidence, type SettingsSnapshot,
  type SparseTunables, type TunableKey, type SettingDecision, type SettingsChange, type TuningSuggestion, type TavernSettings } from "../../shared/settings";
import type { Database } from "../ports";
import { LIMITS } from "../limits";
import { readStored } from "./stored";
import { placementSettingsSchema, settingsJsonValueSchema, type PlacementPolicyRead } from "../../shared/placement-settings";
import { encodeSettingsToml } from "./format";

const stateSchema = z.object({ user: settingsPatchSchema, pinned: sparseTunablesSchema, tuned: sparseTunablesSchema,
  overrides: z.record(z.string(), sparseTunablesSchema) }).strict();
type State = z.infer<typeof stateSchema>;
type Json = z.infer<ReturnType<typeof z.json>>;
type Diff = { path: string; from: Json; to: Json; hadBefore: boolean; hadAfter: boolean };
type UndoData = { changes: Diff[]; reversible: boolean };
type ChangeRow = { id: string; at: number; by: SettingDecision["by"]; reason: string; evidence: string | null;
  quest_id: string | null; thread_id: string | null; changes: string; undo_data: string; undone_at: number | null };
const reasonSchema = z.string().trim().min(1).max(2000);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function mergeSettings(base: unknown, patch: unknown): unknown {
  if (!record(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = record(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`Forbidden settings key: ${key}`);
    result[key] = record(value) ? mergeSettings(result[key], value) : structuredClone(value);
  }
  return result;
}
function flatten(value: unknown, prefix = "", result: Record<string, Json> = {}): Record<string, Json> {
  if (record(value)) for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, result);
  else result[prefix] = settingsJsonValueSchema.parse(value);
  return result;
}
function diff(before: unknown, after: unknown): Diff[] {
  const a = flatten(before), b = flatten(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(path =>
    own(a, path) && own(b, path) && JSON.stringify(a[path]) === JSON.stringify(b[path]) ? [] : [{
      path, from: a[path] ?? null, to: b[path] ?? null, hadBefore: own(a, path), hadAfter: own(b, path),
    }]);
}
export function displayChanges(before: unknown, after: unknown): SettingsChange[] {
  return diff(before, after).map(item => ({ key: item.path.replace(/^user\./, ""), from: item.from, to: item.to,
    kind: item.path.startsWith("pinned.") ? item.hadAfter ? "pin" : "unpin" : item.hadAfter ? "set" : "unset" }));
}
function setPath(target: Record<string, unknown>, path: string, value: Json, exists: boolean) {
  const keys = path.split(".");
  let cursor = target;
  const parents: { object: Record<string, unknown>; key: string }[] = [];
  for (const key of keys.slice(0, -1)) {
    if (!record(cursor[key])) cursor[key] = {};
    parents.push({ object: cursor, key });
    cursor = cursor[key] as Record<string, unknown>;
  }
  if (exists) cursor[keys.at(-1)!] = structuredClone(value);
  else delete cursor[keys.at(-1)!];
  for (const parent of parents.reverse()) {
    const value = parent.object[parent.key];
    if (parent.object !== target && record(value) && !Object.keys(value).length) delete parent.object[parent.key];
  }
}
export class SettingsConflict extends Error {
  readonly code = "stale";
  constructor(readonly revision: number) { super("Settings changed. Refresh the preview before applying it."); }
}
export class SettingsStore {
  private cached: { raw: string; value: State; policy: PlacementPolicyRead; machine: { value: unknown } | null; readable: boolean } | undefined;
  private notificationDepth = 0;
  private pendingNotification = false;
  private readonly warned = new Set<string>();
  private warn = (message: string) => { if (!this.warned.has(message)) { this.warned.add(message); this.warning(message); } };
  private json(text: string, path: string): unknown {
    try { return JSON.parse(text); }
    catch { this.warn(`Tavern ignored stored ${path} that is not valid JSON; defaults or inheritance apply.`); return undefined; }
  }
  private validate: (settings: TavernSettings) => void = () => {};
  setValidator(validate: (settings: TavernSettings) => void) { this.validate = validate; }
  constructor(readonly db: Database, readonly now = Date.now, private readonly changed: () => void = () => {}, private readonly warning: (message: string) => void = message => console.warn(message)) {
    db.prepare("INSERT INTO tavern_settings(id,revision,data) VALUES(1,0,?) ON CONFLICT(id) DO NOTHING")
      .run(JSON.stringify({ user: {}, pinned: {}, tuned: {}, overrides: {} }));
    db.prepare("INSERT INTO tavern_insight_meta(key,value) VALUES('collecting_since',?) ON CONFLICT(key) DO NOTHING").run(String(now()));
  }
  atomic<T>(action: () => T): T {
    const pending = this.pendingNotification;
    this.notificationDepth++;
    try { return this.db.transaction(action)(); }
    catch (error) { this.pendingNotification = pending; throw error; }
    finally {
      this.notificationDepth--;
      if (!this.notificationDepth && this.pendingNotification) {
        this.pendingNotification = false;
        try { this.changed(); }
        catch (error) { this.warning(`Tavern settings transaction committed, but its live update hook failed: ${String(error)}`); }
      }
    }
  }
  private notifyChanged() {
    if (this.notificationDepth) this.pendingNotification = true;
    else this.changed();
  }
  private state() {
    const row = this.db.prepare("SELECT revision,data FROM tavern_settings WHERE id=1").get() as { revision: number; data: string };
    let cached = this.cached;
    if (!cached || cached.raw !== row.data) {
      const raw = this.json(row.data, "settings"), value: Record<string, unknown> = { user: {}, pinned: {}, tuned: {}, overrides: {} };
      const readable = record(raw) && (raw.user === undefined || record(raw.user));
      const user = record(raw) && record(raw.user) ? raw.user : {};
      const machine = own(user, "machines") ? { value: user.machines } : null;
      let policy: PlacementPolicyRead;
      if (!readable) policy = { state: "invalid", revision: row.revision,
        problems: [{ path: "machines", message: "Stored settings are unreadable. Load a valid replacement before placing members." }] };
      else {
        const parsed = placementSettingsSchema.safeParse(machine === null ? {} : machine.value);
        policy = parsed.success ? { state: "valid", revision: row.revision, settings: parsed.data }
          : { state: "invalid", revision: row.revision, problems: parsed.error.issues.slice(0, 50).map(issue => ({
            path: ["machines", ...issue.path].join(".").slice(0, 500), message: issue.message.slice(0, 1000),
          })) };
      }
      if (record(raw)) {
        for (const [key, item] of Object.entries(raw)) {
          if (!own(stateSchema.shape, key)) { this.warn(`Tavern ignored obsolete stored setting ${key}; defaults or inheritance apply.`); continue; }
          const parsed = readStored(stateSchema.shape[key as keyof typeof stateSchema.shape], item, key, this.warn);
          if (parsed !== undefined) value[key] = parsed;
        }
      } else this.warn("Tavern ignored invalid stored settings; defaults apply.");
      const parsed = stateSchema.parse(value);
      if (machine !== null && policy.state === "valid") {
        try { encodeSettingsToml(parsed, true); }
        catch (error) { policy = { state: "invalid", revision: row.revision, problems: [{ path: "machines",
          message: error instanceof Error ? error.message : String(error) }] }; }
      }
      if (policy.state === "invalid") this.warn("Tavern machine placement is blocked by invalid stored policy; other settings remain available.");
      cached = { raw: row.data, value: parsed, policy, machine, readable }; this.cached = cached;
    }
    return { revision: row.revision, value: cached.value, policy: { ...cached.policy, revision: row.revision } as PlacementPolicyRead,
      machine: cached.machine, readable: cached.readable };
  }
  placementPolicy(): PlacementPolicyRead { return structuredClone(this.state().policy); }
  placementRepair(): { placementPolicy: PlacementPolicyRead; placementRawJson: string | null } {
    const { policy, machine } = this.state();
    return { placementPolicy: structuredClone(policy),
      placementRawJson: policy.state === "invalid" && machine !== null ? JSON.stringify(machine.value) : null };
  }
  read(questId?: string | null) {
    const { value } = this.state();
    const result = settingsSchema.parse(mergeSettings(settingsSchema.parse({}), value.user));
    if (result.tuning.mode !== "off") {
      Object.assign(result.knobs, value.tuned);
      if (questId) Object.assign(result.knobs, value.overrides[questId]);
    }
    Object.assign(result.knobs, value.pinned);
    return result;
  }
  hasUser(path: string) { return own(flatten(this.state().value.user), path); }
  private decision(row: ChangeRow, state: State, policyInvalid = false): SettingDecision {
    const undo = JSON.parse(row.undo_data) as UndoData;
    const current = flatten(state);
    return { id: row.id, at: row.at, by: row.by, reason: row.reason,
      evidence: row.evidence === null ? null : readStored(settingsEvidenceSchema, this.json(row.evidence, "audit evidence"), "audit evidence", this.warn) ?? null,
      questId: row.quest_id, threadId: row.thread_id, changes: JSON.parse(row.changes) as SettingsChange[], undoneAt: row.undone_at,
      undoable: undo.reversible && !(policyInvalid && undo.changes.some(item => item.path.startsWith("user.machines"))) && row.undone_at === null && undo.changes.every(item => own(current, item.path) === item.hadAfter && (!item.hadAfter || JSON.stringify(current[item.path]) === JSON.stringify(item.to))),
    };
  }
  snapshot(questId?: string | null): SettingsSnapshot {
    const { revision, value, policy } = this.state(), effective = this.read(questId);
    const history = (this.db.prepare("SELECT * FROM tavern_setting_changes ORDER BY at DESC,rowid DESC LIMIT ?").all(LIMITS.auditRows) as ChangeRow[])
      .map(row => this.decision(row, value, policy.state === "invalid"));
    return { revision, effective, placementPolicy: this.placementPolicy(), user: structuredClone(value.user), pinned: { ...value.pinned }, tuned: { ...value.tuned }, history,
      suggestions: (this.db.prepare("SELECT key,data FROM tavern_tuning_suggestions ORDER BY key").all() as { key: string; data: string }[]).flatMap(row => {
        const parsed = readStored(tuningSuggestionSchema, this.json(row.data, `suggestions.${row.key}`), `suggestions.${row.key}`, this.warn);
        return parsed === undefined ? [] : [parsed];
      }),
      rows: TUNABLE_KEYS.map(key => {
        let source: "default" | "user" | "tavern" | "keeper" = value.user.knobs?.[key] === undefined ? "default" : "user";
        if (effective.tuning.mode !== "off" && value.tuned[key] !== undefined) source = "tavern";
        if (effective.tuning.mode !== "off" && questId && value.overrides[questId]?.[key] !== undefined) source = "keeper";
        if (value.pinned[key] !== undefined) source = "user";
        const paths = [`knobs.${key}`, `pinned.${key}`, `tuned.${key}`, ...(questId ? [`overrides.${questId}.${key}`] : [])];
        const row = this.db.prepare("SELECT * FROM tavern_setting_changes WHERE EXISTS (SELECT 1 FROM json_each(changes) WHERE json_extract(value,'$.key') IN (SELECT value FROM json_each(?))) ORDER BY at DESC,rowid DESC LIMIT 1").get(JSON.stringify(paths)) as ChangeRow | undefined;
        const last = row ? this.decision(row, value) : null;
        const change = last?.changes.find(item => paths.includes(item.key));
        return { key, ...TUNABLES[key], value: effective.knobs[key], source, pinned: value.pinned[key] !== undefined,
          lastChange: last && change ? { id: last.id, at: last.at, from: typeof change.from === "number" ? change.from : null,
            to: typeof change.to === "number" ? change.to : null, by: last.by, reason: last.reason, evidence: last.evidence, undoable: last.undoable } : null };
      }),
    };
  }
  private commit(revision: number, next: State, by: SettingDecision["by"], reason: string, evidence: SettingsEvidence | null = null, questId: string | null = null, threadId: string | null = null, reversible = true, repairMachines = false) {
    const why = reasonSchema.parse(reason);
    if (evidence !== null) settingsEvidenceSchema.parse(evidence);
    const result = this.db.transaction(() => {
      const current = this.state();
      if (current.revision !== revision) throw new SettingsConflict(current.revision);
      const parsed = stateSchema.parse(next), repaired = current.policy.state === "invalid" && repairMachines;
      if (!current.readable && !repairMachines) throw new Error("Stored settings are unreadable. Load a valid replacement to repair them.");
      const persisted = { ...parsed, user: { ...parsed.user } } as Record<string, unknown>;
      if (current.policy.state === "invalid" && !repairMachines && current.machine !== null)
        (persisted.user as Record<string, unknown>).machines = current.machine.value;
      else encodeSettingsToml(parsed, true);
      this.validate(settingsSchema.parse(mergeSettings(settingsSchema.parse({}), parsed.user)));
      const undo = diff(current.value, parsed);
      if (!undo.length && !repaired) return null;
      const changes = displayChanges(current.value, parsed);
      if (repaired) changes.push({ key: "machines", from: "Invalid stored policy", to: parsed.user.machines ?? null,
        kind: parsed.user.machines === undefined ? "unset" : "set" });
      const id = randomUUID(), at = this.now();
      this.db.prepare("INSERT INTO tavern_setting_changes(id,at,by,reason,evidence,quest_id,thread_id,changes,undo_data) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, at, by, why, evidence === null ? null : JSON.stringify(evidence), questId, threadId,
          JSON.stringify(changes), JSON.stringify({ changes: undo, reversible: reversible && !repaired } satisfies UndoData));
      this.db.prepare("UPDATE tavern_settings SET revision=revision+1,data=? WHERE id=1").run(JSON.stringify(persisted));
      const row = this.db.prepare("SELECT * FROM tavern_setting_changes WHERE id=?").get(id) as ChangeRow;
      return this.decision(row, parsed, current.policy.state === "invalid" && !repairMachines);
    })();
    if (result) this.notifyChanged();
    return result;
  }
  update(input: SettingsUpdate, threadId: string | null = null) {
    const parsed = settingsUpdateSchema.parse(input), current = this.state();
    if (parsed.patch.tavern?.ambientMotion !== undefined) parsed.patch.tavern.hearthFlicker = parsed.patch.tavern.ambientMotion !== "off";
    if (current.revision !== parsed.revision) throw new SettingsConflict(current.revision);
    if (current.policy.state === "invalid" && (parsed.patch.machines && !own(parsed.patch.machines, "rules") || parsed.reset?.some(key => key.startsWith("machines."))))
      throw new Error("Repair machine placement with an explicit replacement rules array.");
    const next = structuredClone(current.value);
    next.user = settingsPatchSchema.parse(mergeSettings(next.user, parsed.patch));
    for (const key of parsed.reset ?? []) {
      setPath(next, `user.${key}`, null, false);
      if (key === "tavern.ambientMotion" || key === "tavern.hearthFlicker") {
        setPath(next, "user.tavern.ambientMotion", null, false);
        setPath(next, "user.tavern.hearthFlicker", null, false);
      }
      const knob = key.startsWith("knobs.") ? key.slice(6) as TunableKey : null;
      if (knob && TUNABLE_KEYS.includes(knob)) {
        delete next.tuned[knob];
        delete next.pinned[knob];
      }
    }
    if (parsed.patch.classes && next.user.classes) {
      for (const [id, override] of Object.entries(parsed.patch.classes)) {
        if (Object.keys(override).length) next.user.classes[id] = structuredClone(override);
        else delete next.user.classes[id];
      }
      if (!Object.keys(next.user.classes).length) delete next.user.classes;
    }
    for (const key of TUNABLE_KEYS) {
      const value = parsed.patch.knobs?.[key];
      if (value === undefined) continue;
      delete next.tuned[key];
      if (next.pinned[key] !== undefined) next.pinned[key] = value;
    }
    for (const [key, value] of Object.entries(parsed.pins ?? {})) {
      if (value === null) delete next.pinned[key as TunableKey];
      else if (value !== undefined) next.pinned[key as TunableKey] = value;
    }
    return this.commit(parsed.revision, next, "user", parsed.why, parsed.evidence ?? null, null, threadId, true, parsed.patch.machines?.rules !== undefined);
  }
  replace(user: SettingsPatch, pinned: SparseTunables, tuned: SparseTunables | undefined, revision: number, why: string, threadId: string | null = null) {
    const current = this.state();
    if (user.tavern?.ambientMotion !== undefined) user = { ...user, tavern: { ...user.tavern, hearthFlicker: user.tavern.ambientMotion !== "off" } };
    return this.commit(revision, { ...current.value, user, pinned, tuned: tuned ?? current.value.tuned }, "user", why, null, null, threadId, true, true);
  }
  applyTuned(values: SparseTunables, why: string, evidence: SettingsEvidence, by: "tavern" | "user" = "tavern") {
    if (this.read().tuning.mode === "off") throw new Error("Tuning is off; only your settings and pins apply.");
    const current = this.state(), next = structuredClone(current.value);
    for (const [key, value] of Object.entries(sparseTunablesSchema.parse(values))) {
      if (next.pinned[key as TunableKey] === undefined) next.tuned[key as TunableKey] = value;
    }
    return this.commit(current.revision, next, by, why, evidence);
  }
  override(questId: string, threadId: string, values: SparseTunables, why: string) {
    if (this.read().tuning.mode !== "apply") throw new Error("Keeper overrides require tuning mode apply; ask the user to enable it.");
    if (!questId || !threadId) throw new Error("A quest and its Keeper are required.");
    const current = this.state(), next = structuredClone(current.value), parsed = sparseTunablesSchema.parse(values);
    if (!Object.keys(parsed).length) throw new Error("Supply at least one bounded override.");
    for (const key of Object.keys(parsed) as TunableKey[]) {
      if (!(QUEST_TUNABLE_KEYS as readonly string[]).includes(key))
        throw new Error(`${key} is thread-wide and cannot apply to one quest; change the global setting instead.`);
      if (next.pinned[key] !== undefined) throw new Error(`${key} is pinned by the user.`);
    }
    next.overrides[questId] = { ...next.overrides[questId], ...parsed };
    return this.commit(current.revision, next, "keeper", why, null, questId, threadId);
  }
  endOverride(questId: string, key: typeof QUEST_TUNABLE_KEYS[number], revision: number) {
    const current = this.state();
    if (current.revision !== revision) throw new SettingsConflict(current.revision);
    if (current.value.overrides[questId]?.[key] === undefined) throw new Error("This quest override has already ended.");
    const next = structuredClone(current.value), values = next.overrides[questId]!;
    delete values[key];
    if (!Object.keys(values).length) delete next.overrides[questId];
    return this.commit(revision, next, "user", "Ended the quest override on the settings page.", null, questId, null, false);
  }
  lastChangers(): Record<string, Pick<SettingDecision, "at" | "by" | "threadId">> {
    const rows = this.db.prepare(`WITH changes AS (
      SELECT json_extract(change.value,'$.key') AS key, at, by, thread_id AS threadId,
        ROW_NUMBER() OVER (PARTITION BY json_extract(change.value,'$.key') ORDER BY at DESC, audit.rowid DESC) AS position
      FROM tavern_setting_changes audit, json_each(audit.changes) change
      WHERE json_extract(change.value,'$.key') NOT LIKE 'overrides.%'
    ) SELECT key, at, by, threadId FROM changes WHERE position=1`).all() as (Pick<SettingDecision, "at" | "by" | "threadId"> & {key: string})[];
    return Object.fromEntries(rows.map(({key, ...row}) => [key, row]));
  }
  expire(questId: string) {
    const current = this.state();
    if (!own(current.value.overrides, questId)) return null;
    const next = structuredClone(current.value);
    delete next.overrides[questId];
    return this.commit(current.revision, next, "tavern", "Quest ended; its tuning overrides no longer apply.", null, questId, null, false);
  }
  undo(id: string, why: string, revision?: number) {
    return this.db.transaction(() => {
      const current = this.state();
      if (revision !== undefined && current.revision !== revision) throw new SettingsConflict(current.revision);
      const row = this.db.prepare("SELECT * FROM tavern_setting_changes WHERE id=?").get(id) as ChangeRow | undefined;
      if (!row) throw new Error("Settings decision not found.");
      if (row.undone_at !== null) throw new Error("This decision was already undone.");
      const undo = JSON.parse(row.undo_data) as UndoData;
      if (current.policy.state === "invalid" && undo.changes.some(item => item.path.startsWith("user.machines")))
        throw new Error("Repair machine placement before undoing changes to its policy.");
      if (!undo.reversible) throw new Error("This lifecycle decision cannot be undone; quest overrides end with the quest.");
      if (!this.decision(row, current.value).undoable) throw new Error("These settings changed since that decision. Review the current values instead.");
      const next = structuredClone(current.value);
      for (const item of undo.changes) setPath(next, item.path, item.from, item.hadBefore);
      const result = this.commit(current.revision, next, "user", why, null, row.quest_id);
      this.db.prepare("UPDATE tavern_setting_changes SET undone_at=? WHERE id=?").run(this.now(), id);
      return result;
    })();
  }
  saveSuggestions(suggestions: TuningSuggestion[]) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM tavern_tuning_suggestions").run();
      for (const suggestion of suggestions) this.db.prepare("INSERT INTO tavern_tuning_suggestions(key,data) VALUES(?,?)")
        .run(suggestion.key, JSON.stringify(suggestion));
    })();
    this.notifyChanged();
  }
  /**
   * Records a change made outside the settings (a class file saved or removed on the Classes page) in the same history, so an unexpected
   * change can be traced. It is not a setting: it never touches the stored settings or their revision, and it cannot be undone from here.
   */
  recordExternal(by: SettingDecision["by"], reason: string, changes: SettingsChange[]) {
    const id = randomUUID(), at = this.now();
    this.db.prepare("INSERT INTO tavern_setting_changes(id,at,by,reason,evidence,quest_id,thread_id,changes,undo_data) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, at, by, reasonSchema.parse(reason), null, null, null, JSON.stringify(changes), JSON.stringify({ changes: [], reversible: false } satisfies UndoData));
    this.notifyChanged();
    return id;
  }
  historySince(from: number, to = this.now(), limit = 300) {
    const state = this.state();
    return (this.db.prepare("SELECT * FROM tavern_setting_changes WHERE at>=? AND at<=? ORDER BY at DESC,rowid DESC LIMIT ?").all(from, to, limit) as ChangeRow[])
      .map(row => this.decision(row, state.value, state.policy.state === "invalid"));
  }
  questOverrides() { return structuredClone(this.state().value.overrides); }
  collectingSince() {
    const row = this.db.prepare("SELECT value FROM tavern_insight_meta WHERE key='collecting_since'").get() as { value: string };
    return Number(row.value);
  }
}
