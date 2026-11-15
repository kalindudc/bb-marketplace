import { z } from "zod";
import { awayDigestInputSchema, type AwayDigest } from "../../shared/away-rpc";
import { askSchema, eventSchema } from "../../shared/schema";
import type { Keeper } from "../keeper/service";
import type { AwayStore } from "./store";

type EventRow = { id: number; at: number; keeper_thread_id: string | null; board_quest_id: string | null; actor: string; type: string; text: string; data: string };
const askIds = z.object({ openAskIds: z.array(z.string().min(1)) }).passthrough();
export function readAwayDigest(k: Keeper, store: AwayStore, input: z.input<typeof awayDigestInputSchema>): AwayDigest {
  const parsed = awayDigestInputSchema.parse(input), db = k.store.db;
  return db.transaction(() => {
    const window = store.window(parsed.windowId);
    if (!window) {
      if (parsed.windowId) throw new Error("Closing time window not found");
      return { window: null, totalEvents: 0, nextCursor: null, events: [], totalAsks: 0, nextAskCursor: null, asks: [], quests: [] };
    }
    const range = store.eventRange(window.id)!;
    const opening = db.prepare("SELECT data FROM tavern_events WHERE id=? AND type='away.closed'").get(window.eventFloor) as { data: string } | undefined;
    if (!opening) throw new Error("Closing time digest is missing its opening boundary");
    const startedWaiting = askIds.parse(JSON.parse(opening.data)).openAskIds;
    let waitingAtEnd: string[];
    if (window.returnedAt === null) {
      waitingAtEnd = (db.prepare("SELECT id FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.state')='open'").all() as { id: string }[]).map(row => row.id);
    } else {
      const end = db.prepare("SELECT data FROM tavern_events WHERE id>? AND type='away.returned' AND json_extract(data,'$.windowId')=? ORDER BY id LIMIT 1").get(range.through, window.id) as { data: string } | undefined;
      if (!end) throw new Error("Closing time digest is missing its return boundary");
      waitingAtEnd = askIds.parse(JSON.parse(end.data)).openAskIds;
    }
    const during = db.prepare("SELECT data FROM tavern_events WHERE id>? AND id<=? AND type='ask.opened'").all(range.after, range.through) as { data: string }[];
    const waited = new Set([...startedWaiting, ...waitingAtEnd, ...during.map(row => z.object({ askId: z.string() }).passthrough().parse(JSON.parse(row.data)).askId)]);
    const allAsks = (db.prepare("SELECT data FROM tavern_records WHERE kind='asks' AND id IN (SELECT value FROM json_each(?)) ORDER BY id").all(JSON.stringify([...waited])) as { data: string }[]).map(row => askSchema.parse(JSON.parse(row.data)));
    const waiting = new Set(waitingAtEnd), remainingAsks = allAsks.filter(ask => parsed.askCursor === null || ask.id > parsed.askCursor);
    const asks = remainingAsks.slice(0, parsed.limit).map(ask => ({ ask, waitingAtEnd: waiting.has(ask.id) }));
    const groups = db.prepare("SELECT board_quest_id AS questId, COUNT(*) AS events, SUM(type='report.filed') AS reports, SUM(type='decision.made') AS decisions FROM tavern_events WHERE id>? AND id<=? AND type NOT LIKE 'away.%' GROUP BY board_quest_id").all(range.after, range.through) as { questId: string | null; events: number; reports: number; decisions: number }[];
    const ids = new Set([...window.quests.map(quest => quest.questId), ...groups.flatMap(group => group.questId === null ? [] : [group.questId]), ...allAsks.flatMap(ask => ask.boardQuestId === null ? [] : [ask.boardQuestId])]);
    const wrapped = db.prepare("SELECT board_quest_id AS questId,data FROM tavern_events WHERE id>? AND id<=? AND type='quest.wrapped' ORDER BY id DESC").all(range.after, range.through) as { questId: string; data: string }[];
    const quests = [...ids].map(questId => {
      const quest = k.store.get("quests", questId), group = groups.find(group => group.questId === questId);
      const receipt = wrapped.find(row => row.questId === questId);
      const cleanup = receipt ? z.object({ awayWindowId: z.string().optional(), deferredMemberThreadIds: z.array(z.string()).optional() }).passthrough().parse(JSON.parse(receipt.data)) : null;
      const returnedWhileAway = cleanup?.awayWindowId === window.id;
      const deferredCleanup = (cleanup?.deferredMemberThreadIds ?? []).map(threadId => {
        const state = k.store.runtime(threadId);
        return { threadId, action: "archive-member-thread" as const, pending: state.archivePending !== false, error: state.archivePending === undefined ? "Cleanup state is unavailable; review this thread" : state.archiveError ?? null };
      });
      return { ...(returnedWhileAway ? { returnedWhileAway: true, deferredCleanup } : {}), questId, title: quest ? quest.title : "Unavailable quest", short: quest ? quest.short : "Unavailable quest", missing: quest === null,
        events: group ? group.events : 0, reports: group ? group.reports : 0, decisions: group ? group.decisions : 0, asks: allAsks.filter(ask => ask.boardQuestId === questId).length };
    });
    const rows = db.prepare("SELECT * FROM tavern_events WHERE id>? AND id<=? AND type NOT LIKE 'away.%' ORDER BY id LIMIT ?").all(Math.max(range.after, parsed.cursor), range.through, parsed.limit + 1) as EventRow[];
    const events = rows.slice(0, parsed.limit).map(row => eventSchema.parse({ id: row.id, at: row.at, keeperThreadId: row.keeper_thread_id, boardQuestId: row.board_quest_id, actor: JSON.parse(row.actor), type: row.type, text: row.text, data: JSON.parse(row.data) }));
    return { window, totalEvents: groups.reduce((sum, group) => sum + group.events, 0), nextCursor: rows.length > parsed.limit ? events.at(-1)!.id : null, events,
      totalAsks: allAsks.length, nextAskCursor: remainingAsks.length > parsed.limit ? asks.at(-1)!.ask.id : null, asks, quests };
  })();
}
