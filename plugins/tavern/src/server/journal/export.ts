import { currency, TRACKER_GROUPS, trackerGroups, delegated } from "../../shared/journal-tracker";
import type { JournalEntry } from "../../shared/schema";
import { ago } from "./engine";

const closed = (e: JournalEntry) => e.status === "done" || e.status === "verified";
const lastLine = (text: string | null) => text?.split("\n").filter(Boolean).at(-1)?.replace(/^\d\d:\d\d /, "") ?? null;

/** The journal as the panel's tracker shows it, as Markdown to hand to an agent: the same groups, owners and reports, nothing more. */
export function trackerMarkdown(entries: JournalEntry[], { title, name, now }: { title: string; name: (owner: string) => string; now: number }): string {
  const byId = new Map(entries.map(e => [e.id, e]));
  const c = currency(entries, now);
  const head = [`${entries.filter(closed).length} of ${entries.length} done`];
  if (c.lastDoneAt !== null) head.push(`last done ${ago(c.lastDoneAt, now)}`);
  if (c.reported) head.push(`${c.reported} ${c.reported === 1 ? "report" : "reports"} in`);
  const out = [`# Journal: ${title}`, "", head.join(" · "), ""];
  const line = (e: JournalEntry) => {
    const parent = e.parentId ? byId.get(e.parentId) : null;
    const who = [delegated(e) ? name(e.owner!) : null, parent ? `step of [${parent.id}] ${parent.description}` : null].filter(Boolean).join(", ");
    let text = `- [${e.id}] ${e.description}${who ? ` (${who})` : ""}`;
    const r = e.report;
    if (r) {
      const quote = r.summary ? `: ${JSON.stringify(r.summary)}` : "";
      text += r.kind === "settled" ? `: reported settled ${ago(r.at, now)}${quote}` : r.kind === "idle" ? `: went idle ${ago(r.at, now)}${quote}` : `: its thread was ${r.kind} ${ago(r.at, now)}`;
    } else if (e.status === "blocked" || e.status === "rejected") {
      const why = e.status === "rejected" ? e.review?.reason ?? null : lastLine(e.note);
      text += `: ${e.status}${why ? `: ${why}` : ""}`;
    }
    if (r && e.evidence.length) text += `. Evidence: ${e.evidence.map(x => x.ref).join(", ")}`;
    return text;
  };
  for (const g of trackerGroups(entries)) out.push(`## ${TRACKER_GROUPS[g.id].label} (${g.entries.length})`, "", ...g.entries.map(line), "");
  const own = entries.filter(e => !closed(e) && !delegated(e)).sort((a, b) => a.order - b.order);
  const ordered = own.filter(e => e.parentId === null || !own.some(p => p.id === e.parentId)).flatMap(e => [e, ...own.filter(s => s.parentId === e.id)]);
  if (ordered.length) out.push(`## Your own open entries (${ordered.length})`, "", ...ordered.map(e => `${line(e)} (${e.status})`), "");
  return out.join("\n");
}
