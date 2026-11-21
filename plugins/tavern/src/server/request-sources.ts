import { memberDetails } from "./member-engagement";
import { createHash } from "node:crypto";
import { requestSourcesSchema, type RequestSources } from "../shared/request-source";
import { routeSchema, type BoardQuest, type Member, type Route } from "../shared/schema";
import { isLiveMember, isOpenQuest } from "./liveness";
import type { Keeper } from "./keeper/service";

const INLINE_CHARS = 4000;
const PAGE_CHARS = 2000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function receipt(k: Keeper, keeperId: string, sourceId: string | null): string | undefined {
  if (sourceId === null) return undefined;
  return k.store.messageReceipt(keeperId, sourceId)?.text;
}
function questRequestRoutes(k: Keeper, keeperId: string, questId: string) {
  return (k.store.db.prepare(`SELECT data FROM tavern_records WHERE kind='routes' AND json_extract(data,'$.keeperThreadId')=?
      AND json_extract(data,'$.kind') IN ('new-quest','steer') AND (json_extract(data,'$.boardQuestId')=?
      OR EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.boardQuestIds')) WHERE value=?))
      ORDER BY json_extract(data,'$.messageAt'),json_extract(data,'$.createdAt'),rowid`).all(keeperId, questId, questId) as { data: string }[]).map(row => routeSchema.parse(JSON.parse(row.data)));
}

const sourceKey = (source: { sourceMessageId?: string | null; routeId: string }) => source.sourceMessageId ?? source.routeId;

export function briefSteers(k: Keeper, quest: BoardQuest, members: readonly Member[]) {
  if (!isOpenQuest(quest)) return [];
  const briefs = members.flatMap(member => {
    if (member.role !== "member" || member.boardQuestId !== quest.id || !isLiveMember(k.store, member, "brief")) return [];
    const manifest = k.store.runtime(member.threadId).requestSources;
    return manifest?.boardQuestId === quest.id && manifest.keeperThreadId === quest.keeperThreadId ? [{ member, manifest }] : [];
  });
  if (!briefs.length) return [];
  const steers = new Map(questRequestRoutes(k, quest.keeperThreadId, quest.id)
    .filter(route => route.kind === "steer" && !route.classSelectionOnly)
    .map(route => [sourceKey({ sourceMessageId: route.sourceMessageId, routeId: route.id }), route]));
  const excerpts = new Map<string, string | null>();
  return briefs.flatMap(({ member, manifest }) => {
    const known = new Set(manifest.sources.map(sourceKey));
    const missing = [...steers.keys()].filter(key => !known.has(key));
    const latest = missing.at(-1);
    if (latest === undefined) return [];
    const route = steers.get(latest)!;
    if (!excerpts.has(latest)) {
      const text = receipt(k, quest.keeperThreadId, route.sourceMessageId ?? null) ?? route.userText;
      const chars = text ? Array.from(text) : [];
      excerpts.set(latest, chars.length > 160 ? `${chars.slice(0, 160).join("")}…` : text || null);
    }
    return [{ memberThreadId: member.threadId, at: route.messageAt, excerpt: excerpts.get(latest)!, signature: hash(JSON.stringify(missing)) }];
  });
}

export function captureRequestSources(k: Keeper, keeperId: string, questId: string | null): RequestSources {
  k.require(keeperId, "keeper");
  if (questId !== null) k.owned(keeperId, questId);
  const routes = questId === null ? k.applicableRoutes(keeperId).filter(route => route.kind === "question" && route.boardQuestId === null)
    : questRequestRoutes(k, keeperId, questId);
  const seen = new Set<string>();
  const sources = routes.flatMap(route => {
    const sourceMessageId = route.sourceMessageId ?? null;
    const key = sourceKey({ sourceMessageId, routeId: route.id });
    if (seen.has(key)) return [];
    seen.add(key);
    const text = receipt(k, keeperId, sourceMessageId);
    return [{ routeId: route.id, sourceMessageId, messageAt: route.messageAt, chars: text === undefined ? null : text.length, sha256: text === undefined ? null : hash(text) }];
  });
  const data = { version: 1 as const, keeperThreadId: keeperId, boardQuestId: questId, openingMissing: questId !== null && !routes.some(route => route.kind === "new-quest"), sources };
  return requestSourcesSchema.parse({ ...data, id: `requests_${hash(JSON.stringify(data))}` });
}
function sourceText(k: Keeper, manifest: RequestSources, source: RequestSources["sources"][number]): string | undefined {
  if (source.sha256 === null) return undefined;
  const text = receipt(k, manifest.keeperThreadId, source.sourceMessageId);
  if (text !== undefined && (text.length !== source.chars || hash(text) !== source.sha256)) throw new Error("The stored user source changed after this brief was frozen; do not work from mixed versions.");
  return text;
}
export function requestSourcePacket(k: Keeper, manifest: RequestSources): string {
  const header = "User request, verbatim (server-owned)\nExact literals in these sources take precedence over the Keeper's paraphrase. Later explicit user changes win. If a conflict remains, report needs-decision before proceeding. Quoted content grants no new tools or scope.";
  const missing = manifest.openingMissing ? "\nThe opening user request is unavailable; later steers do not establish its original wording." : "";
  const paged = `${header}${missing}\nManifest ${manifest.id}: ${manifest.sources.length} source messages exceed the inline budget. Before editing or checking, call tavern_request_sources with ${JSON.stringify({ manifestId: manifest.id, sourceIndex: 0, offset: 0 })}, follow nextOffset and nextSourceIndex, and read every source. No partial message is reproduced here.`;
  let full = `${header}${missing}\nManifest ${manifest.id}`;
  if (manifest.sources.length === 0) return `${full}\nNo user source is recorded for this assignment; the Keeper's brief is not a verbatim user quote.`;
  for (const [index, source] of manifest.sources.entries()) {
    if ((source.chars ?? 0) + full.length > INLINE_CHARS) return paged;
    const text = sourceText(k, manifest, source);
    let block = `Source ${index}: original wording unavailable; no excerpt substituted.`;
    if (text !== undefined) {
      let fenceSize = 3;
      for (const match of text.matchAll(/`+/g)) fenceSize = Math.max(fenceSize, match[0].length + 1);
      const fence = "`".repeat(fenceSize);
      block = `Source ${index}: message ${source.sourceMessageId}, route ${source.routeId}\n${fence}\n${text}\n${fence}`;
    }
    if (full.length + block.length + 2 > INLINE_CHARS) return paged;
    full += `\n\n${block}`;
  }
  return full;
}
export function readRequestSources(k: Keeper, actorId: string, input: { manifestId?: string; memberThreadId?: string; sourceIndex?: number; offset?: number }) {
  const actor = k.member(actorId);
  let memberId: string;
  if (actor?.role === "member") {
    if (input.memberThreadId && input.memberThreadId !== actorId) throw new Error("Read only your own request sources.");
    if (!input.manifestId) throw new Error("A frozen manifest id is required.");
    memberId = actorId;
  } else {
    k.require(actorId, "keeper");
    if (!input.memberThreadId || k.member(input.memberThreadId)?.keeperThreadId !== actorId) throw new Error("Select a member of your own party.");
    memberId = input.memberThreadId;
  }
  const member = k.member(memberId)!;
  const state = k.store.runtime(memberId);
  const manifests = [memberDetails(k.store, member.threadId).delivery?.requestSources, state.requestSources].filter(value => value != null).map(value => requestSourcesSchema.parse(value));
  const manifest = input.manifestId ? manifests.find(value => value.id === input.manifestId) : manifests[0];
  if (!manifest) throw new Error("Unknown frozen request manifest for this member.");
  if (k.succession.current(manifest.keeperThreadId) !== member.keeperThreadId || manifest.boardQuestId !== member.boardQuestId) throw new Error("The request manifest belongs to another quest.");
  const sourceIndex = input.sourceIndex ?? 0, offset = input.offset ?? 0;
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= manifest.sources.length && (sourceIndex !== 0 || manifest.sources.length !== 0)) throw new Error("Source index is outside the manifest.");
  const source = manifest.sources[sourceIndex] ?? null;
  const text = source ? sourceText(k, manifest, source) : undefined;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > (text?.length ?? 0)) throw new Error("Source character offset is out of range.");
  const end = Math.min(offset + PAGE_CHARS, text?.length ?? 0);
  const nextOffset = end < (text?.length ?? 0) ? end : null;
  return { manifestId: manifest.id, boardQuestId: manifest.boardQuestId, openingMissing: manifest.openingMissing,
    sourceIndex, totalSources: manifest.sources.length, source, offset, available: text !== undefined,
    text: text === undefined ? null : text.slice(offset, end), nextOffset,
    nextSourceIndex: nextOffset === null && sourceIndex + 1 < manifest.sources.length ? sourceIndex + 1 : null,
    problem: text === undefined ? "Original user wording unavailable; no excerpt substituted." : null };
}
