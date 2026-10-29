import type { SourceRepository } from "../sources/model.ts";
import type { ActivityRepository, ThreadScope } from "./activity.ts";

const DIRECTIVE = /::forage-cite\{([^}\n]{1,600})\}/gu;
const ATTRIBUTE = /([a-z]+)="([^"\n]{0,300})"/gu;
const SNAPSHOT_ID = /^[\w.-]{1,200}$/u;

export interface ReplyCitation { snapshotId: string; lines?: [number, number]; find?: string }

export function parseCitations(text: string): ReplyCitation[] {
 const out: ReplyCitation[] = [];
 for (const match of text.matchAll(DIRECTIVE)) {
  const attrs = Object.fromEntries([...match[1]!.matchAll(ATTRIBUTE)].map((m) => [m[1]!, m[2]!]));
  if (!SNAPSHOT_ID.test(attrs.snapshot ?? "")) continue;
  const range = /^\s*(\d{1,7})\s*(?:[-–]\s*(\d{1,7}))?\s*$/u.exec(attrs.lines ?? "");
  if (range) {
   const a = Number(range[1]); const b = Number(range[2] ?? range[1]);
   if (a >= 1 && b >= 1) out.push({ snapshotId: attrs.snapshot!, lines: [Math.min(a, b), Math.min(Math.max(a, b), Math.min(a, b) + 40)] });
  } else if (attrs.find?.trim()) out.push({ snapshotId: attrs.snapshot!, find: attrs.find.trim().slice(0, 200) });
  if (out.length >= 50) break;
 }
 return out;
}

// Cards record their citation when they render; recording from the finished reply too keeps Cited right for replies nobody has opened.
export function recordReplyCitations(input: { scope: ThreadScope; text: string; messageId: string; sources: SourceRepository; activity: ActivityRepository }): number {
 let noted = 0;
 for (const cite of parseCitations(input.text)) {
  const doc = input.sources.getSnapshot(input.scope, cite.snapshotId);
  if (!doc) continue;
  const lines = doc.content.split("\n");
  let range = cite.lines;
  if (!range && cite.find) {
   const needle = cite.find.toLowerCase();
   const at = lines.findIndex((line) => line.toLowerCase().includes(needle));
   if (at >= 0) range = [at + 1, Math.min(lines.length, at + 3)];
  }
  if (!range || range[0] > lines.length) continue;
  if (input.activity.noteCitation({ scope: input.scope, snapshotId: cite.snapshotId, messageId: input.messageId, startLine: range[0], endLine: Math.min(range[1], lines.length) })) noted++;
 }
 return noted;
}
