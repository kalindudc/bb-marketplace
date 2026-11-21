import type { KeeperStore } from "./keeper/store";
import { fromStoppedKeeper, type Attention, type AttentionCounts, type AttentionItem, type SinceVisit } from "../shared/attention";
import type { Ask, BoardQuest, Decision, KeeperNote, Rule, Summary } from "../shared/schema";
import { AUTHORITY } from "./authority";
import { ASK_EFFECTS, legacyAskEffect } from "./ask-effects";
import { undoAskProjection } from "./undo-record";
import { isLiveKeeper, isOpenQuest } from "./liveness";
import { UNSEEN_SUMMARY_SQL } from "./summaries";
import { unseenQuestChanges } from "./quest-change-attention";
import { usd } from "../shared/spend";

export const DECIDED_FOR_YOU_SQL = "(json_extract(r.data,'$.source')='keeper' OR json_type(r.data,'$.checkChange')='object')";

export type AttentionScope = { keeperThreadId?: string; boardQuestId?: string };
export function askNeedsUser(store: KeeperStore, ask: Ask) {
  if (ask.lane === "keeper") return false;
  const effect = ask.effect ?? legacyAskEffect(ask, store.get("askMeta", ask.id), store.runtime(ask.keeperThreadId));
  return AUTHORITY[ASK_EFFECTS[effect.type].act].level === "user-explicit";
}
export function decisionUndoProjection(store: KeeperStore) {
  const open = new Map<string, boolean>();
  return (decision: Decision): Decision => {
    const id = decision.boardQuestId;
    if (decision.pullRequestReady && !decision.undone) {
      const pr = store.get("pullRequests", decision.pullRequestReady);
      if (pr?.state !== "ready" || pr.readyDecisionId !== decision.id || pr.owner === "user") return { ...decision, undoUnavailable: true };
    }
    if (!id || !(decision.waypointCall || decision.checkChange) || !decision.reversible || decision.undone) return decision;
    if (!open.has(id)) open.set(id, isOpenQuest(store.get("quests", id)));
    return open.get(id) ? decision : { ...decision, undoUnavailable: true };
  };
}
const isNew = (item: AttentionItem) => item.kind === "decided" || item.kind === "summary";
export class AttentionSnapshot {
  readonly asks: Ask[];
  readonly notes: KeeperNote[];
  readonly rules: Rule[];
  readonly decisions: Decision[];
  private groups = new Map<string, { need: AttentionItem[]; held: AttentionItem[]; changes: AttentionItem[]; summaries: AttentionItem[]; calls: AttentionItem[] }>();
  private decisionById = new Map<string, Decision>();
  private summaryQuestTitles = new Map<string, string>();
  constructor(store: KeeperStore, scope: AttentionScope = {}) {
    const visible = "NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND (q.archived_at IS NOT NULL OR json_extract(q.data,'$.deletedAt') IS NOT NULL))";
    const origin = "COALESCE(json_extract(r.data,'$.keeperThreadId'),CASE json_extract(r.data,'$.scope') WHEN 'keeper' THEN json_extract(r.data,'$.scopeId') WHEN 'quest' THEN (SELECT json_extract(q.data,'$.keeperThreadId') FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.scopeId')) END,(SELECT keeper_thread_id FROM tavern_events WHERE type='rule.added' AND json_extract(data,'$.ruleId')=r.id ORDER BY id DESC LIMIT 1))";
    const ordinals = new Map<string, number>();
    const rows = <T>(kind: string, state: string, quest = false, extra = "", data = "r.data"): T[] => {
      const args = [kind];
      const questField = kind === "rules" ? "CASE WHEN json_extract(r.data,'$.scope')='quest' THEN json_extract(r.data,'$.scopeId') END" : "json_extract(r.data,'$.boardQuestId')";
      let where = `r.kind=? AND ${state} AND ${quest ? "r.archived_at IS NULL AND json_extract(r.data,'$.deletedAt') IS NULL" : visible.replace("json_extract(r.data,'$.boardQuestId')", questField)}`;
      if (scope.keeperThreadId) { where += ` AND ${kind === "rules" ? origin : "json_extract(r.data,'$.keeperThreadId')"}=?`; args.push(scope.keeperThreadId); }
      if (scope.boardQuestId) { where += ` AND ${quest ? "r.id" : questField}=?`; args.push(scope.boardQuestId); }
      return (store.db.prepare(`SELECT ${data} AS data${extra},r.id,r.rowid AS ordinal FROM tavern_records r WHERE ${where} ORDER BY r.rowid`).all(...args) as { id: string; ordinal: number; data: string; origin?: string | null }[]).map(row => {
        if (kind === "decisions" || kind === "summaries") ordinals.set(row.id, row.ordinal);
        return { ...JSON.parse(row.data), ...(row.origin ? { keeperThreadId: row.origin } : {}) } as T;
      });
    };
    const quests = rows<BoardQuest>("quests", "json_extract(r.data,'$.phase') NOT IN ('done','stopped','stopping') AND (json_extract(r.data,'$.phase')='held' OR json_type(r.data,'$.spendBudget.reached')='object' OR (json_extract(r.data,'$.checkerHandoffHold') IS NOT NULL AND json_extract(r.data,'$.checkerHandoffHold.release') IS NULL))", true);
    this.asks = rows<Ask>("asks", "json_extract(r.data,'$.state')='open'").map(undoAskProjection(store)).filter(ask => askNeedsUser(store, ask));
    this.notes = rows<KeeperNote>("notes", "json_extract(r.data,'$.state')='open' AND json_extract(r.data,'$.kind')='waiting-on-user'");
    this.rules = rows<Rule>("rules", "json_extract(r.data,'$.active')=0 AND json_extract(r.data,'$.source')='keeper-proposed' AND json_extract(r.data,'$.confirmedAt') IS NULL", false, `, ${origin} AS origin`);
    this.decisions = rows<Decision>("decisions", `${DECIDED_FOR_YOU_SQL} AND json_extract(r.data,'$.reversible')=1 AND json_extract(r.data,'$.undone')=0 AND json_extract(r.data,'$.seenAt') IS NULL AND NOT EXISTS (SELECT 1 FROM tavern_records seen WHERE seen.kind='attentionSeen' AND seen.id=r.id)`).map(decisionUndoProjection(store));
    const summaries = rows<Pick<Summary, "id" | "boardQuestId" | "keeperThreadId" | "title" | "createdAt"> & { questTitle: string | null }>("summaries", UNSEEN_SUMMARY_SQL, false, "",
      `json_object('id',r.id,'boardQuestId',json_extract(r.data,'$.boardQuestId'),'keeperThreadId',json_extract(r.data,'$.keeperThreadId'),'title',json_extract(r.data,'$.title'),'createdAt',json_extract(r.data,'$.createdAt'),
      'questTitle',(SELECT json_extract(q.data,'$.title') FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId')))`);
    const items: AttentionItem[] = [];
    const roomFields = !scope.keeperThreadId && !scope.boardQuestId;
    const knownKeepers = new Map<string, { name: string; state: NonNullable<AttentionItem["who"]>["state"]; startedAt: number } | null>();
    const knownQuests = new Map(quests.map(quest => [quest.id, quest.title]));
    const questTitle = (id: string | null) => {
      if (!id) return null;
      if (!knownQuests.has(id)) knownQuests.set(id, store.get("quests", id)?.title ?? "");
      return knownQuests.get(id) || null;
    };
    const keeper = (id: string | null) => {
      if (!id) return null;
      if (!knownKeepers.has(id)) {
        const member = store.get("members", id);
        const label = member?.characterId ?? "keeper";
        const archived = !isLiveKeeper(store, member, "present");
        const quiet = !isLiveKeeper(store, member);
        knownKeepers.set(id, member ? {
          name: member.displayName ?? label.charAt(0).toUpperCase() + label.slice(1),
          state: archived ? "archived" : quiet ? "quiet" : member.state === "working" ? "running" : "idle",
          startedAt: store.runtime(id).threadCreatedAt ?? member.createdAt,
        } : null);
      }
      return knownKeepers.get(id) ?? null;
    };
    const add = (item: Omit<AttentionItem, "seen">) => {
      const origin = roomFields && item.kind !== "decided" && item.kind !== "summary" && item.kind !== "quest-changed" ? keeper(item.keeperThreadId) : null;
      items.push({
        ...item,
        ...(origin ? { who: { state: origin.state, startedAt: origin.startedAt, questTitle: questTitle(item.questId) } } : {}),
        seen: false,
      });
    };
    const releases = new Set(this.asks.flatMap(ask => ask.effect?.type === "release-hold" ? [ask.effect.holdId] : ask.releaseHoldId ? [ask.releaseHoldId] : []));
    for (const ask of this.asks) add({ id: ask.id, kind: "ask", questId: ask.boardQuestId, keeperThreadId: ask.keeperThreadId, title: ask.question, action: "Answer", since: ask.createdAt });
    for (const q of quests) {
      const hold = q.checkerHandoffHold;
      if (hold && !hold.release && !releases.has(hold.id)) add({ id: hold.id, kind: "hold", questId: q.id, keeperThreadId: q.keeperThreadId, title: hold.reason, action: "Review", since: hold.createdAt });
      if (q.phase === "held") add({ id: q.id, kind: "held", questId: q.id, keeperThreadId: q.keeperThreadId, title: q.title, action: "Resume", since: q.held!.since });
      if (q.spendBudget?.reached) add({ id: `spend:${q.id}`, kind: "hold", questId: q.id, keeperThreadId: q.keeperThreadId,
        title: `The quest reached its ${usd(q.spendBudget.cents / 100)} spend budget. New hires and briefs wait until you raise or remove it.`, action: "Open quest", since: q.spendBudget.reached.at });
    }
    for (const rule of this.rules) add({
      id: rule.id, kind: "rule", questId: rule.scope === "quest" ? rule.scopeId : null,
      keeperThreadId: rule.keeperThreadId ?? (rule.scope === "keeper" ? rule.scopeId : null),
      title: rule.text, action: "Confirm", since: rule.createdAt,
      ...(roomFields ? { scope: { kind: rule.scope, label: rule.scope === "keeper" ? keeper(rule.scopeId)?.name ?? null : rule.scope === "quest" ? questTitle(rule.scopeId) : null } } : {}),
    });
    for (const note of this.notes) add({ detail: { text: note.text, ...("why" in note && typeof note.why === "string" ? { why: note.why } : {}), sourceMessageId: note.sourceMessageId ?? null, validUntil: note.validUntil ?? null }, id: note.id, kind: "hand-back", questId: note.boardQuestId, keeperThreadId: note.keeperThreadId, title: note.action ?? note.text, ...(roomFields ? { need: note.need ?? `${keeper(note.keeperThreadId)?.name ?? "The Keeper"} handed this back to you.` } : {}), action: "Done", since: note.createdAt });
    for (const d of this.decisions) add({ id: d.id, kind: "decided", questId: d.boardQuestId, keeperThreadId: d.keeperThreadId, title: d.text, action: "OK", since: d.createdAt });
    for (const summary of summaries) {
      if (summary.questTitle !== null) this.summaryQuestTitles.set(summary.boardQuestId, summary.questTitle);
      add({ id: summary.id, kind: "summary", questId: summary.boardQuestId, keeperThreadId: summary.keeperThreadId, title: summary.title, action: "Open", since: summary.createdAt });
    }
    if (!scope.keeperThreadId) for (const change of unseenQuestChanges(store, scope.boardQuestId)) add(change);
    items.sort((a, b) => Number(isNew(a)) - Number(isNew(b)) || (isNew(a) ? ordinals.get(a.id)! - ordinals.get(b.id)! : a.since - b.since || a.id.localeCompare(b.id)));
    this.decisionById = new Map(this.decisions.map(decision => [decision.id, decision]));
    for (const item of items) for (const key of ["room", item.keeperThreadId && `keeper:${item.keeperThreadId}`, item.questId && `quest:${item.questId}`]) {
      if (!key) continue;
      const group = this.groups.get(key) ?? { need: [], held: [], changes: [], summaries: [], calls: [] };
      (item.kind === "summary" ? group.summaries : item.kind === "decided" ? group.calls : item.kind === "held" ? group.held : item.kind === "quest-changed" ? group.changes : group.need).push(item);
      this.groups.set(key, group);
    }
  }
  view(scope: AttentionScope = {}, needLimit = Infinity, newLimit = 20, withItems = true): Attention {
    const { need, held, calls, summaries, changes } = this.group(scope) ?? { need: [], held: [], changes: [], summaries: [], calls: [] };
    const counts: AttentionCounts = { ask: 0, hold: 0, "hand-back": 0, rule: 0, stopped: 0 };
    const roomCounts = withItems && !scope.keeperThreadId && !scope.boardQuestId;
    if (roomCounts) for (const item of need) {
      if (fromStoppedKeeper(item)) counts.stopped++;
      else if (item.kind === "ask" || item.kind === "hold" || item.kind === "hand-back" || item.kind === "rule") counts[item.kind]++;
    }
    return { ...(roomCounts ? { counts } : {}), items: withItems ? [...need.slice(0, needLimit), ...(newLimit > 0 ? [...summaries.slice(-newLimit), ...calls.slice(-newLimit), ...changes.slice(-newLimit)] : []), ...held] : [], needYou: need.length, new: summaries.length + calls.length, heldByYou: held.length, decided: calls.length, summaries: summaries.length, changedQuests: changes.length, oldest: need[0]?.since ?? null };
  }
  sinceVisit(): SinceVisit {
    const group = this.group({});
    if (!group) return { summaries: 0, decided: 0, changedQuests: 0, quests: [] };
    const { summaries, calls, changes } = group;
    const quests = new Map<string, SinceVisit["quests"][number]>();
    for (const item of [...summaries.slice(-20).reverse(), ...changes.slice(-20).reverse()].sort((a, b) => b.since - a.since)) {
      const id = item.questId!;
      const quest = quests.get(id) ?? { id, title: this.summaryQuestTitles.get(id) ?? item.title, summaries: [], change: null };
      if (item.kind === "summary") quest.summaries.push(item);
      else quest.change = item;
      quests.set(id, quest);
    }
    return { summaries: summaries.length, decided: calls.length, changedQuests: changes.length, quests: [...quests.values()] };
  }
  private group(scope: AttentionScope) {
    return this.groups.get(scope.boardQuestId ? `quest:${scope.boardQuestId}` : scope.keeperThreadId ? `keeper:${scope.keeperThreadId}` : "room");
  }
  calls(scope: AttentionScope = {}, limit = 20) {
    const group = this.group(scope);
    const calls = group?.calls.slice(-limit).map(item => this.decisionById.get(item.id)!).reverse() ?? [];
    return { decidedForYou: calls, decidedCount: group?.calls.length ?? 0, decidedThroughId: calls[0]?.id ?? null };
  }
}
export function attention(store: KeeperStore, scope: AttentionScope = {}, _now = Date.now()): Attention { return new AttentionSnapshot(store, scope).view(scope); }
