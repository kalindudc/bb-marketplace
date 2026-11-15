import { z } from "zod";
import type { BoardQuestSummary } from "../shared/contract";
import type { Keeper } from "./keeper/service";

const skipSchema = z.object({ waypointId: z.string().min(1).max(120), reason: z.string().max(500) });
const wrapDataSchema = z.object({
  outcome: z.string().min(1).max(4000),
  left: z.string().max(4000).nullish(),
  skipped: z.array(skipSchema).max(24).optional(),
});

export function readTale(k: Keeper, quest: BoardQuestSummary) {
  const wrapped = k.store.db.prepare(
    `SELECT id,at,data FROM tavern_events WHERE board_quest_id=? AND type='quest.wrapped'
      ORDER BY id DESC LIMIT 1`,
  ).get(quest.id) as { id: number; at: number; data: string } | undefined;
  if (!wrapped) return null;
  const data = wrapDataSchema.parse(JSON.parse(wrapped.data));
  const skipped = data.skipped ?? (k.store.db.prepare(
    `SELECT data FROM tavern_events WHERE board_quest_id=? AND type='waypoint.skipped'
      AND id<? AND json_extract(data,'$.version')=? ORDER BY id DESC LIMIT 24`,
  ).all(quest.id, wrapped.id, quest.planVersion) as { data: string }[])
    .reverse().map(row => skipSchema.parse(JSON.parse(row.data)));
  const record = k.store.get("serviceRecords", quest.id);
  const levels = record?.credits.flatMap(credit => credit.level ? [{
    characterId: credit.characterId, role: credit.role, before: credit.level.before, after: credit.level.after, historyComplete: credit.level.historyComplete === true,
  }] : []) ?? [];
  const keptCharacterIds = k.store.all("taleKeeps").filter(keep => keep.questId === quest.id && keep.kept).map(keep => keep.characterId).sort();
  return { outcome: data.outcome, left: data.left?.trim() ? data.left : null, skipped, wrappedAt: wrapped.at, levels: levels.length ? levels : null, keptCharacterIds };
}

export function memberCredits(k: Keeper, quest: BoardQuestSummary) {
  const credits = new Map(quest.members.map(member => [member.threadId, {
    memberThreadId: member.threadId,
    madeWaypointIds: new Set<string>(),
    verifiedWaypointIds: new Set<string>(),
  }]));
  const entries = k.journal.linkedEntries(quest.id).filter(entry =>
    entry.link?.boardQuestId === quest.id && k.member(entry.threadId)?.classId !== "warden"
    && (!k.store.runtime(entry.threadId).released || entry.status === "verified"));
  for (const waypoint of quest.waypoints) {
    if (waypoint.state !== "reported" && waypoint.state !== "verified") continue;
    const linked = entries.filter(entry => entry.link?.waypointId === waypoint.id);
    for (const entry of linked) {
      if (entry.status === "done" || entry.status === "verified")
        credits.get(entry.threadId)?.madeWaypointIds.add(waypoint.id);
      if (waypoint.state !== "verified" || entry.status !== "verified") continue;
      const actor = entry.review?.actor ?? (
        entry.updatedBy.kind === "agent" && k.member(entry.updatedBy.threadId)?.classId === "warden"
          ? entry.updatedBy : null
      );
      if (actor?.kind === "agent") credits.get(actor.threadId)?.verifiedWaypointIds.add(waypoint.id);
    }
  }
  return [...credits.values()].map(credit => ({
    memberThreadId: credit.memberThreadId,
    madeWaypointIds: [...credit.madeWaypointIds],
    verifiedWaypointIds: [...credit.verifiedWaypointIds],
  }));
}
