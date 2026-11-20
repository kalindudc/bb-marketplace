import type { KeeperStore } from "./keeper/store";
import type { Attention, AttentionItem } from "../shared/attention";
import type { Ask, BoardQuest, Decision, KeeperNote, Rule } from "../shared/schema";
import { AUTHORITY } from "./authority";
import { ASK_EFFECTS, legacyAskEffect } from "./ask-effects";
import { undoAskProjection } from "./undo-record";
import { isOpenQuest } from "./liveness";

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
  private groups = new Map<string, { need: AttentionItem[]; fresh: AttentionItem[]; held: AttentionItem[]; decided: number }>();
  private decisionById = new Map<string, Decision>();
  constructor(store: KeeperStore, scope: AttentionScope = {}) {
    const visible = "NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND (q.archived_at IS NOT NULL OR json_extract(q.data,'$.deletedAt') IS NOT NULL))";
    const origin = "COALESCE(json_extract(r.data,'$.keeperThreadId'),CASE json_extract(r.data,'$.scope') WHEN 'keeper' THEN json_extract(r.data,'$.scopeId') WHEN 'quest' THEN (SELECT json_extract(q.data,'$.keeperThreadId') FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.scopeId')) END,(SELECT keeper_thread_id FROM tavern_events WHERE type='rule.added' AND json_extract(data,'$.ruleId')=r.id ORDER BY id DESC LIMIT 1))";
    const rows = <T>(kind: string, state: string, quest = false, extra = ""): T[] => {
      const args = [kind];
      const questField = kind === "rules" ? "CASE WHEN json_extract(r.data,'$.scope')='quest' THEN json_extract(r.data,'$.scopeId') END" : "json_extract(r.data,'$.boardQuestId')";
      let where = `r.kind=? AND ${state} AND ${quest ? "r.archived_at IS NULL AND json_extract(r.data,'$.deletedAt') IS NULL" : visible.replace("json_extract(r.data,'$.boardQuestId')", questField)}`;
      if (scope.keeperThreadId) { where += ` AND ${kind === "rules" ? origin : "json_extract(r.data,'$.keeperThreadId')"}=?`; args.push(scope.keeperThreadId); }
      if (scope.boardQuestId) { where += ` AND ${quest ? "r.id" : questField}=?`; args.push(scope.boardQuestId); }
      return (store.db.prepare(`SELECT r.data${extra} FROM tavern_records r WHERE ${where} ORDER BY r.rowid`).all(...args) as { data: string; origin?: string | null }[]).map(row => ({ ...JSON.parse(row.data), ...(row.origin ? { keeperThreadId: row.origin } : {}) }) as T);
    };
    const quests = rows<BoardQuest>("quests", "json_extract(r.data,'$.phase') NOT IN ('done','stopped','stopping') AND (json_extract(r.data,'$.phase')='held' OR (json_extract(r.data,'$.checkerHandoffHold') IS NOT NULL AND json_extract(r.data,'$.checkerHandoffHold.release') IS NULL))", true);
    this.asks = rows<Ask>("asks", "json_extract(r.data,'$.state')='open'").map(undoAskProjection(store)).filter(ask => askNeedsUser(store, ask));
    this.notes = rows<KeeperNote>("notes", "json_extract(r.data,'$.state')='open' AND json_extract(r.data,'$.kind')='waiting-on-user'");
    this.rules = rows<Rule>("rules", "json_extract(r.data,'$.active')=0 AND json_extract(r.data,'$.source')='keeper-proposed' AND json_extract(r.data,'$.confirmedAt') IS NULL", false, `, ${origin} AS origin`);
    this.decisions = rows<Decision>("decisions", `${DECIDED_FOR_YOU_SQL} AND json_extract(r.data,'$.reversible')=1 AND json_extract(r.data,'$.undone')=0 AND json_extract(r.data,'$.seenAt') IS NULL AND NOT EXISTS (SELECT 1 FROM tavern_records seen WHERE seen.kind='attentionSeen' AND seen.id=r.id)`).map(decisionUndoProjection(store));
    const items: AttentionItem[] = [];
    const add = (item: Omit<AttentionItem, "seen">) => items.push({ ...item, seen: false });
    const releases = new Set(this.asks.flatMap(ask => ask.effect?.type === "release-hold" ? [ask.effect.holdId] : ask.releaseHoldId ? [ask.releaseHoldId] : []));
    for (const ask of this.asks) add({ id: ask.id, kind: "ask", questId: ask.boardQuestId, keeperThreadId: ask.keeperThreadId, title: ask.question, action: "Answer", since: ask.createdAt });
    for (const q of quests) {
      const hold = q.checkerHandoffHold;
      if (hold && !hold.release && !releases.has(hold.id)) add({ id: hold.id, kind: "hold", questId: q.id, keeperThreadId: q.keeperThreadId, title: hold.reason, action: "Review", since: hold.createdAt });
      if (q.phase === "held") add({ id: q.id, kind: "held", questId: q.id, keeperThreadId: q.keeperThreadId, title: q.title, action: "Resume", since: q.held!.since });
    }
    for (const rule of this.rules) add({ id: rule.id, kind: "rule", questId: rule.scope === "quest" ? rule.scopeId : null, keeperThreadId: rule.keeperThreadId ?? (rule.scope === "keeper" ? rule.scopeId : null), title: rule.text, action: "Confirm", since: rule.createdAt });
    for (const note of this.notes) add({ detail: { text: note.text, ...("why" in note && typeof note.why === "string" ? { why: note.why } : {}), sourceMessageId: note.sourceMessageId ?? null, validUntil: note.validUntil ?? null }, id: note.id, kind: "hand-back", questId: note.boardQuestId, keeperThreadId: note.keeperThreadId, title: (note as KeeperNote & { action?: string }).action ?? note.text, action: "Done", since: note.createdAt });
    for (const d of this.decisions) add({ id: d.id, kind: "decided", questId: d.boardQuestId, keeperThreadId: d.keeperThreadId, title: d.text, action: "OK", since: d.createdAt });
    const ordinals = new Map(this.decisions.map((decision, index) => [decision.id, index]));
    items.sort((a, b) => isNew(a) && isNew(b) ? (ordinals.get(a.id) ?? 0) - (ordinals.get(b.id) ?? 0) : a.since - b.since || a.id.localeCompare(b.id));
    this.decisionById = new Map(this.decisions.map(decision => [decision.id, decision]));
    for (const item of items) for (const key of ["room", item.keeperThreadId && `keeper:${item.keeperThreadId}`, item.questId && `quest:${item.questId}`]) {
      if (!key) continue;
      const group = this.groups.get(key) ?? { need: [], fresh: [], held: [], decided: 0 };
      (isNew(item) ? group.fresh : item.kind === "held" ? group.held : group.need).push(item);
      if (item.kind === "decided") group.decided++;
      this.groups.set(key, group);
    }
  }
  view(scope: AttentionScope = {}, needLimit = Infinity, newLimit = 20, withItems = true): Attention {
    const { need, fresh, held, decided } = this.groups.get(scope.boardQuestId ? `quest:${scope.boardQuestId}` : scope.keeperThreadId ? `keeper:${scope.keeperThreadId}` : "room") ?? { need: [], fresh: [], held: [], decided: 0 };
    return { items: withItems ? [...need.slice(0, needLimit), ...fresh.slice(-newLimit), ...held] : [], needYou: need.length, new: fresh.length, heldByYou: held.length, decided, oldest: need[0]?.since ?? null };
  }
  calls(scope: AttentionScope = {}, limit = 20) {
    const list = this.view(scope, 0, limit);
    const calls = list.items.filter(item => item.kind === "decided").map(item => this.decisionById.get(item.id)!).reverse();
    return { decidedForYou: calls, decidedCount: list.decided ?? 0, decidedThroughId: calls[0]?.id ?? null };
  }
}
export function attention(store: KeeperStore, scope: AttentionScope = {}, _now = Date.now()): Attention { return new AttentionSnapshot(store, scope).view(scope); }
