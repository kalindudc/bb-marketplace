import { createHash } from "node:crypto";
import { z } from "zod";
import { journalEntrySchema, type JournalEntry } from "../../shared/schema";
import { closed, validateEntries } from "./engine";

const oldEntry = z.object({ id: z.string().regex(/^[0-9a-f]{2}$/), description: z.string().min(1), done: z.boolean(), createdAt: z.number().int().nonnegative() });
const oldLog = z.object({ version: z.literal(1), quests: z.array(oldEntry), steps: z.array(oldEntry.extend({ parentId: z.string() })), usedIds: z.array(z.string().regex(/^[0-9a-f]{2}$/)) });
const extras = z.object({ agentChangedAt: z.number().int().nonnegative().nullable().optional(), notedAt: z.number().int().nonnegative().nullable().optional(), pendingUserChanges: z.array(z.string()).optional() });
export type ArchivedLegacy = { id: string; data: string; reason: string };
export function normalizeLegacy(threadId: string, metadata: Record<string, unknown>) {
  const log = oldLog.parse(metadata.log), times = extras.parse(metadata);
  const actor = { kind: "import" as const, from: "pi-quests" };
  const archived: ArchivedLegacy[] = [];
  const rows = [...log.quests.map(e => ({ ...e, parentId: null })), ...log.steps];
  let entries = rows.map((e, order) => {
    const long = e.description.length > 500;
    if (long) archived.push({ id: e.id, data: JSON.stringify(e), reason: "Full description before truncation" });
    return journalEntrySchema.parse({ threadId, id: e.id, parentId: e.parentId, description: e.description.slice(0, 500), status: e.done ? "done" : "todo", owner: null,
      note: long ? `Imported description was shortened. Full original is preserved in the import archive.\n${e.description}`.slice(0, 2000) : null,
      evidence: [], link: null, order, createdAt: e.createdAt, updatedAt: e.createdAt, createdBy: actor, updatedBy: actor });
  });
  const reopened: string[] = [];
  for (const e of entries) if (closed(e) && entries.some(child => child.parentId === e.id && !closed(child))) { e.status = "todo"; reopened.push(e.id); }
  function archive(entry: JournalEntry, reason: string) {
    const ids = new Set([entry.id, ...entries.filter(e => e.parentId === entry.id).map(e => e.id)]);
    for (const id of ids) archived.push({ id, data: JSON.stringify(rows.find(e => e.id === id)), reason });
    entries = entries.filter(e => !ids.has(e.id));
  }
  for (const e of [...entries].filter(closed).sort((a, b) => a.createdAt - b.createdAt)) {
    if (entries.length <= 200) break;
    if (entries.some(x => x.id === e.id)) archive(e, "Old completed entry archived to keep the active log within 200 entries");
  }
  while (entries.length > 200) archive(entries.filter(e => e.parentId === null).at(-1)!, "Open overflow preserved outside the active 200-entry log");
  const active = validateEntries(entries);
  return { entries: active, archived, reserved: [...new Set([...log.usedIds, ...rows.map(e => e.id)])],
    fingerprint: createHash("sha256").update(JSON.stringify({ log: metadata.log, agentChangedAt: times.agentChangedAt })).digest("hex"),
    times: { agentChangedAt: times.agentChangedAt ?? null, notedAt: times.notedAt ?? null }, notes: times.pendingUserChanges ?? [],
    summary: `Imported ${active.length} legacy entries; reopened ${reopened.length} parents; archived ${rows.length - active.length} overflow entries and preserved ${archived.filter(e => e.reason.startsWith("Full")).length} long descriptions.` };
}
