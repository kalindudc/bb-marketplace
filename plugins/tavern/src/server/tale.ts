import { z } from "zod";
import { taleResultsSchema } from "../shared/tale-results";
import { questOutcomeSchema, waypointWaiverSchema } from "../shared/closing";
import type { BoardQuestSummary } from "../shared/contract";
import type { Keeper } from "./keeper/service";

export const taleDeliverySchema = z.object({
  text: z.string().max(24000), capturedAt: z.number().int().nonnegative(),
  threadId: z.string(), truncated: z.boolean(),
  questId: z.string().optional(), tellingId: z.number().int().optional(),
  companionThreadId: z.string().optional(), companionReady: z.boolean().optional(), companionFailed: z.boolean().optional(),
  companionArchived: z.boolean().optional(), companionReplacementAttempted: z.boolean().optional(),
});
export const taleDeliveryAttemptSchema = z.object({ attemptedAt: z.number().int().nonnegative() });

function hasDirective(text: string, questId: string) {
  return text.split(/\r?\n/).some(line => line.trim() === `::tavern-tale{quest="${questId}"}`);
}

function latestTelling(k: Keeper, questId: string) {
  return k.store.db.prepare("SELECT id,at,type,data FROM tavern_events WHERE board_quest_id=? AND type IN ('quest.wrapped','quest.retold') ORDER BY id DESC LIMIT 1").get(questId) as { id: number; at: number; type: string; data: string } | undefined;
}

function newestDelivery(k: Keeper, questId: string) {
  const row = k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='taleDeliveries' AND (id=? OR json_extract(data,'$.questId')=?) ORDER BY json_extract(data,'$.tellingId') DESC LIMIT 1").get(questId, questId) as { data: string } | undefined;
  return row ? taleDeliverySchema.parse(JSON.parse(row.data)) : null;
}

function saveDelivery(k: Keeper, questId: string, threadId: string, text: string, telling: NonNullable<ReturnType<typeof latestTelling>>) {
  const key = telling.type === "quest.wrapped" ? questId : `${questId}:${telling.id}`;
  if (k.store.get("taleDeliveries", key)) return;
  const truncated = text.length > 24000;
  let end = Math.min(text.length, 24000), closingFence = "";
  if (truncated) {
    let fence: string | null = null, boundary = 0, offset = 0;
    for (const line of text.split(/(?<=\n)/)) {
      if (offset + line.length > 24000) break;
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1]!;
        else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null;
      }
      offset += line.length;
      if (!fence && !line.trim()) boundary = offset;
    }
    if (boundary) end = boundary;
    else {
      closingFence = fence ? `\n${fence}` : "";
      const limit = 24000 - closingFence.length;
      const lineBreak = text.lastIndexOf("\n", limit);
      end = lineBreak > 0 && (!fence || lineBreak > text.indexOf("\n")) ? lineBreak : limit;
    }
  }
  k.store.put("taleDeliveries", key, { text: text.slice(0, end).trimEnd() + closingFence, capturedAt: k.now(), threadId, truncated, questId, tellingId: telling.id });
  k.changed(threadId, questId);
  return true;
}

export function captureTaleDelivery(k: Keeper, threadId: string, text?: string | null) {
  if (!text || k.member(threadId)?.role !== "keeper") return;
  const ids = [...text.matchAll(/^\s*::tavern-tale\{quest="([^"\r\n]+)"\}\s*$/gm)].map(match => match[1]!);
  const captured: string[] = [];
  for (const id of new Set(ids)) {
    const quest = k.store.get("quests", id);
    if (quest?.keeperThreadId !== threadId) continue;
    const telling = latestTelling(k, id);
    if (!telling || k.now() < telling.at || k.now() - telling.at > 86400000) continue;
    if (saveDelivery(k, id, threadId, text, telling)) captured.push(id);
  }
  return captured;
}

export async function backfillTaleDelivery(k: Keeper, quest: Pick<BoardQuestSummary, "id" | "keeperThreadId">, output: (args: { threadId: string }) => Promise<{ output: string | null }>) {
  if (newestDelivery(k, quest.id) || k.store.get("taleDeliveryAttempts", quest.id)) return;
  const telling = latestTelling(k, quest.id);
  if (!telling) return;
  k.store.put("taleDeliveryAttempts", quest.id, { attemptedAt: k.now() });
  const result = await output({ threadId: quest.keeperThreadId });
  if (result.output && hasDirective(result.output, quest.id)) saveDelivery(k, quest.id, quest.keeperThreadId, result.output, telling);
}

const skipSchema = z.object({ waypointId: z.string().min(1).max(120), reason: z.string() });
const wrapDataSchema = z.object({
  outcome: z.string().min(1),
  left: z.string().nullish(),
  skipped: z.array(skipSchema).optional(),
  closure: questOutcomeSchema.optional(),
  closeReason: z.string().min(1).optional(),
  waivers: z.array(waypointWaiverSchema).optional(),
  next: z.array(z.string()).optional(),
  results: z.unknown().optional(),
});

export function readTale(k: Keeper, quest: BoardQuestSummary) {
  const wrapped = k.store.db.prepare(
    `SELECT id,at,data FROM tavern_events WHERE board_quest_id=? AND type='quest.wrapped'
      ORDER BY id DESC LIMIT 1`,
  ).get(quest.id) as { id: number; at: number; data: string } | undefined;
  if (!wrapped) return null;
  const telling = latestTelling(k, quest.id)!;
  const data = wrapDataSchema.parse(JSON.parse(telling.data));
  const wrapData = wrapDataSchema.parse(JSON.parse(wrapped.data));
  const results = taleResultsSchema.safeParse(data.results);
  const skipped = wrapData.skipped ?? (k.store.db.prepare(
    `SELECT data FROM tavern_events WHERE board_quest_id=? AND type='waypoint.skipped'
      AND id<? AND json_extract(data,'$.version')=? ORDER BY id ASC`,
  ).all(quest.id, wrapped.id, quest.planVersion) as { data: string }[])
    .map(row => skipSchema.parse(JSON.parse(row.data)));
  const record = k.store.get("serviceRecords", quest.id);
  const levels = record?.credits.flatMap(credit => credit.level ? [{
    characterId: credit.characterId, role: credit.role, before: credit.level.before, after: credit.level.after, historyComplete: credit.level.historyComplete === true,
  }] : []) ?? [];
  const keptCharacterIds = k.store.all("taleKeeps").filter(keep => keep.questId === quest.id && keep.kept).map(keep => keep.characterId).sort();
  const delivery = newestDelivery(k, quest.id);
  return { ...(results.success ? { results: results.data } : {}), ...(delivery ? { delivery } : {}), ...(data.next ? { next: data.next } : {}), outcome: data.outcome, left: data.left?.trim() ? data.left : null, skipped,
    ...(wrapData.closure ? { closure: wrapData.closure } : {}), ...(wrapData.closeReason ? { closeReason: wrapData.closeReason } : {}), ...(wrapData.waivers?.length ? { waivers: wrapData.waivers } : {}), wrappedAt: wrapped.at, levels: levels.length ? levels : null, keptCharacterIds };
}

export function memberCredits(quest: BoardQuestSummary) {
  const credits = new Map(quest.members.map(member => [member.threadId, {
    memberThreadId: member.threadId,
    madeWaypointIds: new Set<string>(),
    verifiedWaypointIds: new Set<string>(),
  }]));
  for (const waypoint of quest.waypoints) {
    for (const threadId of waypoint.madeBy ?? []) credits.get(threadId)?.madeWaypointIds.add(waypoint.id);
    for (const threadId of waypoint.checkedBy ?? []) credits.get(threadId)?.verifiedWaypointIds.add(waypoint.id);
  }
  return [...credits.values()].map(credit => ({
    memberThreadId: credit.memberThreadId,
    madeWaypointIds: [...credit.madeWaypointIds],
    verifiedWaypointIds: [...credit.verifiedWaypointIds],
  }));
}
