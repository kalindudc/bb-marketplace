import { rebindLeadSeat } from "./lead-seat-rebind";
import { isKeeperIdentity } from "../liveness";
import type { JournalEntry } from "../../shared/schema";
import type { Keeper } from "./service";
import type { Cutover, RebindStep } from "./succession-store";

export function ownershipSteps(k: Keeper): readonly RebindStep[] {
  const { store } = k;
  const { db } = store;
  function chargeAssignments({ predecessor, successor, at }: Cutover) {
    const keeper = k.member(predecessor);
    if (!keeper || !isKeeperIdentity(store, keeper) || k.member(successor)) throw new Error("The successor cannot take this Keeper identity.");
    if (!keeper.leadLinkId) store.put("members", successor, { ...keeper, threadId: successor, state: "idle", createdAt: at, lastActiveAt: at });
    store.patch(successor, { projectId: store.runtime(predecessor).projectId, threadTitle: store.runtime(predecessor).threadTitle, threadCreatedAt: at });
    const quests = db.prepare("SELECT id FROM tavern_records WHERE kind='quests' AND json_extract(data,'$.keeperThreadId')=?").all(predecessor) as { id: string }[];
    for (const { id } of quests) store.put("quests", id, { ...store.get("quests", id)!, keeperThreadId: successor });
    store.writeRecords(`UPDATE tavern_records SET data=json_set(data,'$.keeperThreadId',?)
      WHERE (kind='members' OR kind IN ('plans','notes','gates','gateReminders','decisions','reports','summaries','autoGreenlights','scopeRequests','scopeViolations','awayHolds','rules'))
        AND json_extract(data,'$.keeperThreadId')=?`, successor, predecessor);
    store.writeRecords(`UPDATE tavern_records SET data=json_set(data,'$.scopeId',?)
      WHERE kind='rules' AND json_extract(data,'$.scope')='keeper' AND json_extract(data,'$.scopeId')=?`, successor, predecessor);
    store.writeRecords(`UPDATE tavern_records SET data=json_set(data,'$.keeperThreadId',?,'$.owner',
      CASE WHEN json_extract(data,'$.owner')=? THEN ? ELSE json_extract(data,'$.owner') END)
      WHERE kind='pullRequests' AND json_extract(data,'$.keeperThreadId')=?`, successor, predecessor, successor, predecessor);
  }

  function requestReceipts({ predecessor, successor }: Cutover) {
    const { pending, lastRouteId, routes, openingGoal } = store.runtime(predecessor);
    store.writeRecords("UPDATE tavern_records SET data=json_set(data,'$.keeperThreadId',?) WHERE kind='routes' AND json_extract(data,'$.keeperThreadId')=?", successor, predecessor);
    store.patch(successor, { pending, lastRouteId, routes, openingGoal });
  }

  function liveAsks({ predecessor, successor }: Cutover) {
    store.writeRecords("UPDATE tavern_records SET data=json_set(data,'$.keeperThreadId',?) WHERE kind='asks' AND json_extract(data,'$.keeperThreadId')=?", successor, predecessor);
  }

  function journalOwnership({ predecessor, successor }: Cutover) {
    const source = db.prepare("SELECT 1 FROM questlog_logs WHERE thread_id=?").get(predecessor);
    if (!source) return;
    db.prepare(`INSERT INTO questlog_logs(thread_id,next_id,hydrated,agent_changed_at,noted_at,last_tool_at)
      SELECT ?,next_id,hydrated,agent_changed_at,noted_at,last_tool_at FROM questlog_logs WHERE thread_id=?`).run(successor, predecessor);
    const relocate = (entry: JournalEntry) => ({ ...entry, threadId: successor, owner: entry.owner === predecessor ? successor : entry.owner });
    const entries = db.prepare("SELECT id,data FROM questlog_entries WHERE thread_id=?").all(predecessor) as { id: string; data: string }[];
    const entryUpdate = db.prepare("UPDATE questlog_entries SET thread_id=?, data=? WHERE thread_id=? AND id=?");
    for (const entry of entries) entryUpdate.run(successor, JSON.stringify(relocate(JSON.parse(entry.data))), predecessor, entry.id);
    const history = db.prepare("SELECT id,before_data,after_data FROM questlog_history WHERE thread_id=?").all(predecessor) as { id: number; before_data: string; after_data: string }[];
    const historyUpdate = db.prepare("UPDATE questlog_history SET thread_id=?, before_data=?, after_data=? WHERE id=?");
    for (const row of history) historyUpdate.run(successor, JSON.stringify(JSON.parse(row.before_data).map(relocate)), JSON.stringify(JSON.parse(row.after_data).map(relocate)), row.id);
    db.prepare("UPDATE questlog_reserved SET thread_id=? WHERE thread_id=?").run(successor, predecessor);
    db.prepare("UPDATE questlog_changes SET thread_id=? WHERE thread_id=?").run(successor, predecessor);
    db.prepare("UPDATE questlog_imports SET thread_id=? WHERE thread_id=?").run(successor, predecessor);
    db.prepare("UPDATE questlog_archive SET thread_id=? WHERE thread_id=?").run(successor, predecessor);
    db.prepare("UPDATE questlog_mirrors SET thread_id=? WHERE thread_id=?").run(successor, predecessor);
    db.prepare("DELETE FROM questlog_logs WHERE thread_id=?").run(predecessor);
  }

  function placements({ predecessor }: Cutover) {
    const pending = db.prepare(`SELECT id FROM tavern_placements WHERE json_extract(data,'$.keeperThreadId') IN
      (SELECT value FROM json_each(?)) AND json_extract(data,'$.phase')<>'released' AND json_extract(data,'$.memberThreadId') IS NULL LIMIT 1`);
    if (pending.get(JSON.stringify(store.keeperEventOwners(predecessor)))) throw new Error("Resolve the unbound placement before refreshing this Keeper.");
  }

  function spendIntervals({ chargeId, predecessor, successor, expectedGeneration, at }: Cutover) {
    const prior = store.get("keeperSpendIntervals", predecessor);
    if (prior ? prior.chargeId !== chargeId || prior.until !== null || (prior.from !== null && prior.from > at) : expectedGeneration !== 0)
      throw new Error("The Keeper's open spend interval does not match this generation.");
    const runtime = store.runtime(predecessor);
    store.put("keeperSpendIntervals", predecessor, { chargeId, threadId: predecessor, from: prior?.from ?? null, until: at, activityAt: runtime.lastSpendActivityAt ?? runtime.lastReply?.at });
    store.put("keeperSpendIntervals", successor, { chargeId, threadId: successor, from: at, until: null });
  }

  function unreadTicks({ predecessor, successor }: Cutover) {
    const { cursor, heldNewsCursors, factContinuation, tickAt } = store.runtime(predecessor);
    store.patch(successor, { cursor, heldNewsCursors, factContinuation, tickAt, reanchor: "Keeper succession", reanchorVersion: 1 });
    const pendingTick = store.pendingTick(predecessor);
    if (pendingTick) {
      if (pendingTick.sendPending) throw new Error("Confirm the predecessor's outstanding tick delivery before refreshing.");
      store.putTick({ ...pendingTick, state: "cancelled" });
    }
  }

  return [chargeAssignments, requestReceipts, liveAsks, journalOwnership, placements, spendIntervals, rebindLeadSeat(k), unreadTicks];
}
