import { memberHost } from "./member-engagement";
import { createHash } from "node:crypto";
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { tags } from "../shared/contract";
import { verifiedWaypoint } from "../shared/waypoint";
import { levelFromCount, earnedCount } from "../shared/level";
import { journalEntrySchema, type JournalEntry, type Member } from "../shared/schema";
import { serviceQuestRecordSchema, serviceVerdictSchema, taleKeepKey, type CharacterServiceRecord, type ServiceQuestRecord, type ServiceRecordState, type ServiceVerdict } from "../shared/service-record";
import { modelFamily } from "./execution";
import type { Keeper } from "./keeper/service";
import type { JournalReview } from "./ports";

const key = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checkKey = (r: ServiceVerdict) => key([r.checker.key, r.waypointId, r.verdict, r.at, r.checkerEvidence]);
const verdictKey = (entry: JournalEntry) => {
  const review = entry.review;
  return review?.actor.kind === "agent" ? key([entry.threadId, entry.id, review.actor.threadId, entry.status, review.at, review.reason, review.evidence]) : null;
};

export class ServiceRecords {
  private unknownExecutions = new Map<string, { since: number; until: number | null }[]>();

  constructor(private k: Keeper, private invalidate: (tags: string[]) => void) {}

  private state(): ServiceRecordState {
    const existing = this.k.store.get("serviceRecordState", "v1");
    if (existing) return existing;
    const state: ServiceRecordState = { version: 1, recordingSince: this.k.now(), backfilledAt: null };
    this.k.store.put("serviceRecordState", "v1", state);
    return state;
  }
  private verdicts(questId: string): ServiceVerdict[] {
    return (this.k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='serviceVerdicts' AND json_extract(data,'$.questId')=?").all(questId) as { data: string }[])
      .map(row => serviceVerdictSchema.parse(JSON.parse(row.data)));
  }
  executionRecordingFailed(threadId: string, at: number): void {
    const periods = this.unknownExecutions.get(threadId) ?? [];
    if (periods.at(-1)?.until === null) return;
    periods.push({ since: at, until: null });
    this.unknownExecutions.set(threadId, periods);
  }
  executionRecordingSucceeded(threadId: string, at: number): void {
    const latest = this.unknownExecutions.get(threadId)?.at(-1);
    if (latest?.until === null) latest.until = at;
  }
  private family(member: Member, at: number): { value: string | null; uncertain: boolean } {
    if (this.unknownExecutions.get(member.threadId)?.some(period => period.since <= at && (period.until === null || at < period.until))) return { value: null, uncertain: true };
    const hired = this.k.store.db.prepare("SELECT at,data FROM tavern_events WHERE board_quest_id IS ? AND type='member.hired' AND at<=? AND json_extract(data,'$.memberThreadId')=? ORDER BY id DESC LIMIT 1").get(member.boardQuestId, at, member.threadId) as { at: number; data: string } | undefined;
    const execution = hired ? (JSON.parse(hired.data) as { execution?: { providerId: string; model?: string | null } }).execution : undefined;
    const choice = this.k.store.runtime(member.threadId).classExecutionChoice;
    const current = choice?.recordedAt !== undefined && choice.recordedAt <= at && (!hired || choice.recordedAt >= hired.at) ? choice : null;
    const pair = current ?? execution;
    const value = pair?.providerId && pair.model ? modelFamily(pair.providerId, pair.model) : null;
    return { value, uncertain: current !== null && value === null };
  }
  private subject(member: Member, family: string | null = null): ServiceVerdict["maker"] {
    const runtime = this.k.store.runtime(member.threadId);
    return { key: key(member.threadId), threadId: memberHost(this.k.store, member).deletedAt != null ? null : member.threadId, characterId: member.characterId, family };
  }
  private receipt({ before, after, sequence }: JournalReview, id: string): ServiceVerdict | null {
    const review = after.review;
    if (!after.link || !review || review.actor.kind !== "agent" || !["verified", "rejected"].includes(after.status)) return null;
    const maker = this.k.member(after.threadId), checker = this.k.member(review.actor.threadId);
    if (!maker || maker.classId === "warden" || !checker || checker.classId !== "warden" || checker.boardQuestId !== after.link.boardQuestId || maker.boardQuestId !== after.link.boardQuestId) return null;
    const makerFamily = this.family(maker, review.at), checkerFamily = this.family(checker, review.at);
    const makerSubject = this.subject(maker, makerFamily.value), checkerSubject = this.subject(checker, checkerFamily.value);
    let fixesRejectionId: string | null = null;
    const previous = before.review;
    if (after.status === "verified" && before.status === "done" && before.doneBy?.kind === "agent" && before.doneBy.threadId === before.threadId
      && previous?.reason && previous.actor.kind === "agent" && previous.memberEvidenceAt !== null && previous.memberEvidenceAt >= previous.at && previous.memberEvidenceAt <= review.at) {
      const rejected = this.verdicts(after.link.boardQuestId).find(r => r.entryKey === key([after.threadId, after.id]) && r.verdict === "rejected" && !r.withdrawn
        && r.checker.key === key(previous.actor.kind === "agent" ? previous.actor.threadId : "") && r.at === previous.at && r.reason === previous.reason && JSON.stringify(r.checkerEvidence) === JSON.stringify(previous.evidence));
      if (rejected && before.evidence.some(e => !rejected.makerEvidence.some(old => JSON.stringify(old) === JSON.stringify(e)))) fixesRejectionId = rejected.id;
    }
    return serviceVerdictSchema.parse({ version: 1, id, questId: after.link.boardQuestId, waypointId: after.link.waypointId, entryId: after.id,
      entryKey: key([after.threadId, after.id]), sequence, at: review.at, verdict: after.status,
      maker: makerSubject, checker: checkerSubject,
      independence: makerSubject.family !== null && makerSubject.family === checkerSubject.family ? "same-family" : makerFamily.uncertain || checkerFamily.uncertain ? "not-established" : checker.checkIndependence ?? "not-established",
      makerEvidence: after.evidence, checkerEvidence: review.evidence, reason: review.reason, fixesRejectionId });
  }
  reviewed(input: JournalReview): void {
    const { after } = input, id = verdictKey(after);
    if (id === null) return;
    if (input.undone !== undefined && after.link && this.k.store.get("serviceRecords", after.link.boardQuestId))
      throw new Error("This quest has ended and its record is written, so this verdict can't be undone.");
    const existing = this.k.store.get("serviceVerdicts", id);
    if (existing) {
      if (input.undone !== undefined && !!existing.withdrawn !== input.undone) this.k.store.put("serviceVerdicts", id, { ...existing, withdrawn: input.undone });
      return;
    }
    const receipt = this.receipt(input, id);
    if (!receipt) return;
    this.state();
    this.k.store.put("serviceVerdicts", receipt.id, { ...receipt, withdrawn: input.undone ?? false });
  }
  superseded({ entry, version, at }: { entry: JournalEntry; version: number; at: number }): void {
    try {
      const id = verdictKey(entry);
      if (entry.status !== "verified" || !entry.link || id === null || this.k.store.get("serviceRecords", entry.link.boardQuestId)) return;
      if (!this.k.store.get("serviceVerdicts", id)) this.survivingVerdicts(entry.link.boardQuestId, [entry]);
      const receipt = this.k.store.get("serviceVerdicts", id);
      if (!receipt || receipt.superseded) return;
      this.k.store.put("serviceVerdicts", id, serviceVerdictSchema.parse({ ...receipt, superseded: { at, reason: `superseded by brief v${version}` } }));
    } catch (error) {
      this.k.store.log?.("warn", `Tavern verdict supersession: ${String(error)}`);
    }
  }
  private survivingVerdicts(questId: string, entries: JournalEntry[]): void {
    const threads = new Set([...this.k.store.query("members", "boardQuestId", questId, 500).map(m => m.threadId), ...entries.map(e => e.threadId)]);
    for (const threadId of threads) {
      const history = this.k.store.db.prepare("SELECT id,before_data,after_data,action,state FROM questlog_history WHERE thread_id=? AND action IN ('verify','reject') ORDER BY id").all(threadId) as { id: number; before_data: string; after_data: string; action: string; state: "undo" | "redo" }[];
      for (const row of history) {
        const before = journalEntrySchema.array().parse(JSON.parse(row.before_data));
        const after = journalEntrySchema.array().parse(JSON.parse(row.after_data));
        for (const entry of after) {
          if (entry.link?.boardQuestId !== questId || entry.status !== (row.action === "verify" ? "verified" : "rejected")) continue;
          const prior = before.find(e => e.id === entry.id);
          if (!prior || JSON.stringify(prior.review) === JSON.stringify(entry.review)) continue;
          this.reviewed({ before: prior, after: entry, sequence: row.id, undone: row.state === "redo" });
        }
      }
    }
    for (const entry of entries) {
      if (!entry.review || !["verified", "rejected"].includes(entry.status)) continue;
      this.reviewed({ before: entry, after: entry, sequence: 0 });
    }
  }
  private hasLegacyService(credit: ServiceQuestRecord["credits"][number], since: number): boolean {
    const membership = credit.role === "keeper" ? "json_extract(q.data,'$.keeperThreadId')=m.id" : "q.id=json_extract(m.data,'$.boardQuestId')";
    return this.k.store.db.prepare(`SELECT 1 FROM tavern_records m LEFT JOIN tavern_records q ON q.kind='quests' AND ${membership}
      WHERE m.kind='members' AND json_extract(m.data,'$.characterId')=?
      AND CASE json_extract(m.data,'$.classId') WHEN 'keeper' THEN 'keeper' WHEN 'warden' THEN 'warden' ELSE 'maker' END=?
      AND (json_extract(q.data,'$.createdAt')<? OR (q.id IS NULL AND json_extract(m.data,'$.boardQuestId') IS NOT NULL)) LIMIT 1`)
      .get(credit.characterId, credit.role, since) !== undefined;
  }
  record(questId: string, backfilledAt: number | null = null): boolean {
    if (this.k.store.get("serviceRecords", questId)) return false;
    const q = this.k.quest(questId);
    if (q.phase !== "done" && q.phase !== "stopped") throw new Error("Service records belong only to returned or stopped quests");
    const state = this.state();
    const summary = this.k.summary(questId);
    const entries = this.k.journal.linkedEntries(questId).filter(e => e.link?.boardQuestId === questId);
    this.survivingVerdicts(questId, entries);
    const receipts = this.verdicts(questId);
    const verdicts = receipts.filter(receipt => !receipt.withdrawn);
    const superseded = new Set(receipts.filter(receipt => receipt.superseded).map(receipt => receipt.id));
    const verified = new Set(summary.waypoints.filter(verifiedWaypoint).map(w => w.id));
    const credits = new Map<string, ServiceQuestRecord["credits"][number]>();
    const credit = (characterId: string, role: ServiceQuestRecord["credits"][number]["role"]) => {
      const id = JSON.stringify([characterId, role]);
      let value = credits.get(id);
      if (!value) { value = { characterId, role, verifiedWaypoints: 0, checks: 0, independentChecks: 0, sameFamilyChecks: 0, caught: 0, threadIds: [] }; credits.set(id, value); }
      return value;
    };
    const addThread = (value: ServiceQuestRecord["credits"][number], threadId: string | null) => {
      if (threadId !== null && !value.threadIds.includes(threadId)) value.threadIds.push(threadId);
    };
    const made = new Map<string, Set<string>>();
    for (const entry of entries) {
      const member = this.k.member(entry.threadId);
      const id = verdictKey(entry);
      if (entry.status !== "verified" || id !== null && superseded.has(id) || !entry.link || !verified.has(entry.link.waypointId) || !member?.characterId || member.classId === "warden") continue;
      const waypoints = made.get(member.characterId) ?? new Set<string>(); waypoints.add(entry.link.waypointId); made.set(member.characterId, waypoints);
      addThread(credit(member.characterId, "maker"), this.subject(member).threadId);
    }
    for (const receipt of verdicts) {
      if (receipt.verdict !== "verified" || receipt.superseded || receipt.maker.threadId !== null || !receipt.maker.characterId || !verified.has(receipt.waypointId)) continue;
      const waypoints = made.get(receipt.maker.characterId) ?? new Set<string>(); waypoints.add(receipt.waypointId); made.set(receipt.maker.characterId, waypoints);
    }
    for (const [characterId, waypoints] of made) credit(characterId, "maker").verifiedWaypoints = waypoints.size;
    if (backfilledAt !== null) {
      const legacy = new Map<string, number>();
      for (const member of summary.members) {
        if (!member.characterId || member.classId === "warden" || member.verifiedWins <= 0) continue;
        legacy.set(member.characterId, Math.max(legacy.get(member.characterId) ?? 0, member.verifiedWins));
        addThread(credit(member.characterId, "maker"), this.subject(member).threadId);
      }
      for (const [id, wins] of legacy) { const value = credit(id, "maker"); value.verifiedWaypoints = Math.max(value.verifiedWaypoints, wins); }
    }
    const checks = new Map<string, ServiceVerdict[]>();
    for (const receipt of verdicts) { const id = checkKey(receipt); checks.set(id, [...checks.get(id) ?? [], receipt]); }
    for (const group of checks.values()) {
      const receipt = group[0]!;
      if (!receipt.checker.characterId) continue;
      const value = credit(receipt.checker.characterId, "warden"); value.checks++;
      if (group.some(r => r.independence === "same-family")) value.sameFamilyChecks++;
      else if (group.every(r => r.independence === "independent")) value.independentChecks++;
      addThread(value, receipt.checker.threadId);
    }
    const caught = new Set<string>();
    for (const receipt of verdicts) {
      if (!receipt.fixesRejectionId) continue;
      const rejected = verdicts.find(r => r.id === receipt.fixesRejectionId);
      if (!rejected?.checker.characterId || caught.has(checkKey(rejected))) continue;
      caught.add(checkKey(rejected)); credit(rejected.checker.characterId, "warden").caught++;
    }
    const keeper = this.k.member(q.keeperThreadId);
    if (keeper?.characterId) {
      const value = credit(keeper.characterId, "keeper");
      value.verifiedWaypoints = Math.max(verified.size, ...[...credits.values()].filter(c => c.role === "maker").map(c => c.verifiedWaypoints));
      addThread(value, this.subject(keeper).threadId);
    }
    if (backfilledAt === null) {
      const previous = new Map(this.read().map(record => [record.characterId, record]));
      for (const credit of credits.values()) {
        const prior = previous.get(credit.characterId);
        const before = earnedCount(prior ?? null, credit.role);
        const gained = credit.role === "maker" ? credit.verifiedWaypoints : credit.role === "warden" ? credit.independentChecks : Number(q.phase === "done" && credit.verifiedWaypoints > 0);
        credit.level = { before: levelFromCount(before), after: levelFromCount(before + gained), historyComplete: q.createdAt >= state.recordingSince && (prior?.[credit.role]?.completeSince ?? null) === null && !this.hasLegacyService(credit, state.recordingSince) };
      }
    }
    const waypoints: NonNullable<ServiceQuestRecord["waypoints"]> = { verified: verified.size, total: summary.waypoints.length };
    if (backfilledAt === null) waypoints.skipped = summary.waypoints.filter(waypoint => waypoint.state === "skipped").length;
    if (q.outcome === "closed-early") {
      waypoints.waived = q.waivers?.length ?? 0;
      waypoints.accepted = summary.waypoints.filter(w => w.state === "accepted").length;
    }
    const record = serviceQuestRecordSchema.parse({ version: 1, questId: q.id, title: q.title, short: q.short, phase: q.phase,
      endedAt: q.endedAt, keeperThreadId: this.k.store.runtime(q.keeperThreadId).deletedAt != null ? null : q.keeperThreadId,
      backfilledAt, completeSince: backfilledAt !== null || q.createdAt < state.recordingSince ? state.recordingSince : null,
      credits: [...credits.values()], waypoints, ...(q.outcome ? { outcome: q.outcome } : {}), ...(q.waivers?.length ? { waivers: q.waivers } : {}) });
    this.k.store.put("serviceRecords", questId, record);
    return true;
  }
  backfill(): void {
    let changed = false;
    this.k.store.atomic(() => {
      const state = this.state();
      if (state.backfilledAt !== null) return;
      const now = this.k.now();
      for (const q of this.k.store.all("quests")) if (q.phase === "done" || q.phase === "stopped") changed = this.record(q.id, now) || changed;
      this.k.store.put("serviceRecordState", "v1", { ...state, backfilledAt: now });
    });
    if (changed) this.invalidate([tags.registry()]);
  }
  dropThreadLinks(threadId: string): boolean {
    let changed = false;
    this.k.store.atomic(() => {
      for (const record of this.k.store.all("serviceRecords")) {
        if (record.keeperThreadId !== threadId && !record.credits.some(c => c.threadIds.includes(threadId))) continue;
        this.k.store.put("serviceRecords", record.questId, { ...record, keeperThreadId: record.keeperThreadId === threadId ? null : record.keeperThreadId,
          credits: record.credits.map(c => ({ ...c, threadIds: c.threadIds.filter(id => id !== threadId) })) });
        changed = true;
      }
      for (const receipt of this.k.store.all("serviceVerdicts")) {
        if (receipt.maker.threadId !== threadId && receipt.checker.threadId !== threadId) continue;
        this.k.store.put("serviceVerdicts", receipt.id, { ...receipt,
          maker: { ...receipt.maker, threadId: receipt.maker.threadId === threadId ? null : receipt.maker.threadId },
          checker: { ...receipt.checker, threadId: receipt.checker.threadId === threadId ? null : receipt.checker.threadId } });
      }
    });
    if (changed) this.invalidate([tags.registry()]);
    return changed;
  }
  setTaleKept(input: { questId: string; characterId: string; kept: boolean }): { kept: boolean } {
    const id = taleKeepKey(input.questId, input.characterId), existing = this.k.store.get("taleKeeps", id);
    if (input.kept) {
      const record = this.k.store.get("serviceRecords", input.questId), quest = this.k.store.get("quests", input.questId);
      const told = this.k.store.db.prepare("SELECT 1 FROM tavern_events WHERE board_quest_id=? AND type='quest.wrapped' LIMIT 1").get(input.questId);
      if (record?.phase !== "done" || quest?.phase !== "done" || !told) throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Only a returned quest with a told tale can be kept." });
      if (!record.credits.some(credit => credit.characterId === input.characterId)) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "This character has no credit in that tale." });
      if (!existing) this.k.store.put("taleKeeps", id, { ...input, kept: true });
    } else if (existing) this.k.store.remove("taleKeeps", id);
    if (!!existing !== input.kept) this.invalidate([tags.registry(), tags.boardQuest(input.questId)]);
    return { kept: input.kept };
  }
  read(): CharacterServiceRecord[] {
    const characters = new Map<string, CharacterServiceRecord>();
    const undated = new Set<string>(), undatedRoles = new Set<string>();
    const keeps = new Set(this.k.store.all("taleKeeps").filter(row => row.kept).map(row => taleKeepKey(row.questId, row.characterId)));
    const rows = this.k.store.db.prepare("SELECT r.data, (q.id IS NOT NULL AND json_extract(q.data,'$.deletedAt') IS NULL) AS available, json_extract(q.data,'$.deletedAt') IS NOT NULL AS deleted, EXISTS(SELECT 1 FROM tavern_events e WHERE e.board_quest_id=r.id AND e.type='quest.wrapped') AS told FROM tavern_records r LEFT JOIN tavern_records q ON q.kind='quests' AND q.id=r.id WHERE r.kind='serviceRecords'").all() as { data: string; available: number; deleted: number; told: number }[];
    const records = rows.map(row => ({ ...row, record: serviceQuestRecordSchema.parse(JSON.parse(row.data)) })).sort((a, b) => (b.record.endedAt ?? -1) - (a.record.endedAt ?? -1) || a.record.questId.localeCompare(b.record.questId));
    const recent = new Map<string, number>();
    for (const { record, available, deleted, told } of records) for (const credit of record.credits) {
      let value = characters.get(credit.characterId);
      if (!value) {
        value = { characterId: credit.characterId, firstEarnedAt: null, lastEarnedAt: null, completeSince: null, backfilledAt: null, recordsTotal: 0, records: [] };
        characters.set(credit.characterId, value);
      }
      if (record.endedAt === null) undated.add(credit.characterId);
      else {
        value.firstEarnedAt = Math.min(value.firstEarnedAt ?? record.endedAt, record.endedAt);
        value.lastEarnedAt = Math.max(value.lastEarnedAt ?? record.endedAt, record.endedAt);
      }
      if (record.completeSince !== null) value.completeSince = Math.max(value.completeSince ?? 0, record.completeSince);
      if (record.backfilledAt !== null) value.backfilledAt = Math.max(value.backfilledAt ?? 0, record.backfilledAt);
      if (credit.role === "maker") {
        value.maker ??= { verifiedWaypoints: 0, quests: 0 }; value.maker.verifiedWaypoints += credit.verifiedWaypoints; value.maker.quests++;
      } else if (credit.role === "warden") {
        value.warden ??= { checks: 0, independentChecks: 0, sameFamilyChecks: 0, caughtDefects: 0, caughtSince: null };
        value.warden.checks += credit.checks; value.warden.independentChecks += credit.independentChecks;
        value.warden.sameFamilyChecks += credit.sameFamilyChecks; value.warden.caughtDefects += credit.caught;
        if (record.completeSince !== null) value.warden.caughtSince = Math.max(value.warden.caughtSince ?? 0, record.completeSince);
      } else {
        value.keeper ??= { returnedQuests: 0, verifiedReturns: 0, stoppedQuests: 0, verifiedWaypoints: 0 };
        value.keeper.returnedQuests += Number(record.phase === "done");
        value.keeper.verifiedReturns += Number(record.phase === "done" && credit.verifiedWaypoints > 0);
        value.keeper.stoppedQuests += Number(record.phase === "stopped"); value.keeper.verifiedWaypoints += credit.verifiedWaypoints;
      }
      const roleValue = value[credit.role]!, coverage = record.completeSince ?? record.backfilledAt;
      roleValue.completeSince = coverage === null ? roleValue.completeSince ?? null : Math.max(roleValue.completeSince ?? 0, coverage);
      if (record.endedAt === null) undatedRoles.add(JSON.stringify([credit.characterId, credit.role]));
      else roleValue.firstEarnedAt = Math.min(roleValue.firstEarnedAt ?? record.endedAt, record.endedAt);
      const position = recent.get(credit.characterId) ?? 0; recent.set(credit.characterId, position + 1);
      const kept = keeps.has(taleKeepKey(record.questId, credit.characterId));
      value.recordsTotal++;
      if (position < 20 || kept) value.records.push({ questId: record.questId, title: deleted ? "a deleted quest" : record.title, short: deleted ? "a deleted quest" : record.short, phase: record.phase,
        endedAt: record.endedAt, keeperThreadId: available ? record.keeperThreadId : null, role: credit.role, verifiedWaypoints: credit.verifiedWaypoints,
        told: record.phase === "done" && !!told, kept, available: !!available, waypoints: record.waypoints ?? null, ...(record.outcome ? { outcome: record.outcome } : {}),
        ...(credit.role === "warden" ? { checks: credit.checks, caught: credit.caught, independentChecks: credit.independentChecks, sameFamilyChecks: credit.sameFamilyChecks } : {}), threadIds: available ? [...credit.threadIds] : [] });
    }
    for (const id of undated) { const value = characters.get(id)!; value.firstEarnedAt = null; value.lastEarnedAt = null; }
    for (const value of characters.values()) for (const role of ["maker", "warden", "keeper"] as const) {
      const earned = value[role];
      if (earned && undatedRoles.has(JSON.stringify([value.characterId, role]))) earned.firstEarnedAt = null;
    }
    return [...characters.values()].sort((a, b) => a.characterId.localeCompare(b.characterId));
  }
}
