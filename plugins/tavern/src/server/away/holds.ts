import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../ports";

const id = z.string().min(1).max(100);
export const contentHoldTokenSchema = z.string().max(100).regex(/^hold_[0-9a-z]+_[0-9a-f-]{36}$/).brand<"ContentHoldToken">();
// This identifies a passive latch, never a placement or operation capability.
export type ContentHoldToken = z.infer<typeof contentHoldTokenSchema>;
const holdReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("away"), windowId: id }).strict(),
  z.object({ kind: z.literal("content"), operationId: id, token: contentHoldTokenSchema, idleOnly: z.boolean().optional(), preservation: z.boolean().optional() }).strict(),
]);
export const awayHoldSchema = z.object({
  threadId: id, keeperThreadId: id, questId: id.nullable(), windowId: id.nullable(),
  heldAt: z.number().int().nonnegative(), resumeRequired: z.boolean(), stopPending: z.boolean(),
  error: z.string().max(1000).nullable(),
  cancelledBrief: z.object({ id, text: z.string() }).strict().nullable(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  token: contentHoldTokenSchema.nullable().optional(),
  reasons: z.array(holdReasonSchema).optional(),
  resumeAfterContent: z.boolean().optional(),
}).strict().superRefine((hold, ctx) => {
  if (hold.reasons === undefined) {
    if (hold.windowId === null || hold.version !== undefined || hold.token !== undefined) ctx.addIssue({ code: "custom", message: "Legacy hold needs its away window and no partial token state" });
    return;
  }
  if (hold.version === undefined || !hold.token) ctx.addIssue({ code: "custom", message: "A reasoned hold needs its versioned token" });
  const identities = hold.reasons.map(reason => reason.kind === "away" ? `away:${reason.windowId}` : `content:${reason.operationId}`);
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: "custom", message: "Hold reasons must have unique identities" });
  const tokens = hold.reasons.filter(reason => reason.kind === "content").map(reason => reason.token);
  if (new Set(tokens).size !== tokens.length) ctx.addIssue({ code: "custom", message: "Content hold tokens must be unique" });
  if (!hold.resumeRequired && hold.reasons.some(reason => reason.kind === "content")) ctx.addIssue({ code: "custom", message: "An active content hold must require fresh instructions" });
});
export type AwayHold = z.infer<typeof awayHoldSchema>;
// Reason tokens survive other reasons; the row token fences mutations and late stop ACKs.
type Hold = Omit<AwayHold, "version" | "token" | "reasons"> & { version: number; token: ContentHoldToken | null; reasons: z.infer<typeof holdReasonSchema>[] };
type Owner = Pick<Hold, "threadId" | "keeperThreadId" | "questId" | "heldAt" | "cancelledBrief">;
export type HeldInspection = { state: "pending" | "confirmed" | "stale"; error: string | null };
function normalize(input: unknown): Hold {
  const hold = awayHoldSchema.parse(input);
  if (hold.reasons !== undefined) return { ...hold, version: hold.version!, token: hold.token!, reasons: hold.reasons };
  return { ...hold, version: 0, token: null, reasons: [{ kind: "away", windowId: hold.windowId! }] };
}
function token(version: number): ContentHoldToken { return contentHoldTokenSchema.parse(`hold_${version.toString(36)}_${randomUUID()}`); }
export class AwayHolds {
  constructor(private readonly db: Database) {}
  private read(row: { id: string; data: string }): Hold {
    const hold = normalize(JSON.parse(row.data));
    if (hold.threadId !== row.id) throw new Error("Member hold has a mismatched thread id");
    return hold;
  }
  all(): Hold[] { return (this.db.prepare("SELECT id,data FROM tavern_records WHERE kind='awayHolds'").all() as { id: string; data: string }[]).map(row => this.read(row)); }
  pending(): Hold[] { return (this.db.prepare("SELECT id,data FROM tavern_records WHERE kind='awayHolds' AND json_extract(data,'$.stopPending')=1").all() as { id: string; data: string }[]).map(row => this.read(row)); }
  get(threadId: string): Hold | null {
    const row = this.db.prepare("SELECT id,data FROM tavern_records WHERE kind='awayHolds' AND id=?").get(threadId) as { id: string; data: string } | undefined;
    return row ? this.read(row) : null;
  }
  private write(hold: Hold) {
    awayHoldSchema.parse(hold);
    this.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('awayHolds',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(hold.threadId, JSON.stringify(hold));
    return hold;
  }
  put(input: AwayHold): Hold {
    return this.db.transaction(() => {
      const hold = normalize(input), version = (this.get(hold.threadId)?.version ?? 0) + 1;
      return this.write({ ...hold, version, token: token(version) });
    })();
  }
  private request(owner: Owner, reason: { kind: "away"; windowId: string } | { kind: "content"; operationId: string; idleOnly?: boolean; preservation?: boolean }): Hold {
    return this.db.transaction(() => {
      const previous = this.get(owner.threadId);
      const found = previous?.reasons.find(value => reason.kind === "away" ? value.kind === "away" && value.windowId === reason.windowId : value.kind === "content" && value.operationId === reason.operationId);
      if (found?.kind === "content" && reason.kind === "content" && (!!found.idleOnly !== !!reason.idleOnly || !!found.preservation !== !!reason.preservation)) throw new Error("A content hold cannot change its idle-only policy");
      if (found && previous?.resumeRequired) return previous;
      const version = (previous?.version ?? 0) + 1, nextToken = token(version);
      const reasons = previous?.reasons ?? [];
      return this.write({ ...owner, heldAt: previous?.resumeRequired ? previous.heldAt : owner.heldAt,
        cancelledBrief: previous?.resumeRequired ? previous.cancelledBrief : owner.cancelledBrief,
        windowId: reason.kind === "away" ? reason.windowId : (previous?.resumeRequired || previous?.stopPending) ? previous.windowId : null,
        version, token: nextToken, resumeRequired: true, stopPending: true, error: null,
        resumeAfterContent: reason.kind === "content" && reason.idleOnly
          ? previous?.resumeRequired || previous?.stopPending ? previous.resumeAfterContent ?? true : false
          : true,
        reasons: found ? reasons : [...reasons, reason.kind === "away" ? reason : { ...reason, token: nextToken }] });
    })();
  }
  requestAway(owner: Owner, windowId: string) { return this.request(owner, { kind: "away", windowId: id.parse(windowId) }); }
  requestContent(owner: Owner, operationId: string, idleOnly?: boolean, preservation?: boolean): ContentHoldToken {
    if (preservation && !idleOnly) throw new Error("Preservation content holds must be idle-only");
    const hold = this.request(owner, { kind: "content", operationId: id.parse(operationId), ...(idleOnly === undefined ? {} : { idleOnly }), ...(preservation === undefined ? {} : { preservation }) });
    const reason = hold.reasons.find(reason => reason.kind === "content" && reason.operationId === operationId);
    if (reason?.kind !== "content") throw new Error("Content hold reason was not persisted");
    return reason.token;
  }
  compareAndSet(expected: Hold, patch: Partial<Pick<Hold, "stopPending" | "error" | "reasons" | "resumeRequired" | "cancelledBrief">>): Hold | null {
    const version = expected.version + 1, next = { ...expected, ...patch, version, token: token(version) };
    awayHoldSchema.parse(next);
    const result = this.db.prepare("UPDATE tavern_records SET data=? WHERE kind='awayHolds' AND id=? AND COALESCE(json_extract(data,'$.version'),0)=? AND json_extract(data,'$.token') IS ?")
      .run(JSON.stringify(next), expected.threadId, expected.version, expected.token);
    return result.changes ? next : null;
  }
  prepareStop(threadId: string): Hold | null {
    const hold = this.get(threadId);
    if (!hold?.stopPending || hold.token !== null) return hold;
    return this.compareAndSet(hold, {});
  }
  findContent(input: ContentHoldToken): Hold | null {
    contentHoldTokenSchema.parse(input);
    const rows = this.db.prepare("SELECT id,data FROM tavern_records r WHERE kind='awayHolds' AND EXISTS (SELECT 1 FROM json_each(r.data,'$.reasons') reason WHERE json_extract(reason.value,'$.kind')='content' AND json_extract(reason.value,'$.token')=?)").all(input) as { id: string; data: string }[];
    if (rows.length > 1) throw new Error("Content hold token is ambiguous");
    return rows[0] ? this.read(rows[0]) : null;
  }
  finishContent(input: ContentHoldToken): boolean {
    const hold = this.findContent(input);
    if (!hold) return false;
    const removed = hold.reasons.find(reason => reason.kind === "content" && reason.token === input);
    const reasons = hold.reasons.filter(reason => reason.kind !== "content" || reason.token !== input);
    return this.compareAndSet(hold, { reasons, ...(removed?.kind === "content" && removed.idleOnly && !reasons.length ? { stopPending: false, error: null, resumeRequired: hold.resumeAfterContent ?? true } : {}) }) !== null;
  }
  finishAway(windowId: string, eligibleThreadIds: ReadonlySet<string>) {
    for (const hold of this.all()) {
      if (!eligibleThreadIds.has(hold.threadId)) continue;
      const reasons = hold.reasons.filter(reason => reason.kind !== "away" || reason.windowId !== windowId);
      if (reasons.length !== hold.reasons.length && !this.compareAndSet(hold, { reasons })) throw new Error("Away hold changed while returning; retry");
    }
  }
}
