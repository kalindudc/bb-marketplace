import { useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { BUTTON, ErrorNote, Segmented } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { ReferenceFeedback } from "./reference-feedback";

export function ReferenceInsights({ onOpenThread }: { onOpenThread(id: string): void }) {
  const log = useShuttleQuery("referenceLog", { limit: 200 });
  const [filter, setFilter] = useState("attention");
  const rows = log.data?.rows.filter((r) => filter === "all" || (filter === "attention" ? ["ambiguous", "flagged", "unresolved"].includes(r.status) : ["corrected", "suppressed"].includes(r.status))) ?? [];
  return <section aria-label="Reference resolutions" className="space-y-4">
    <p className="max-w-3xl text-sm text-muted-foreground">Review bare-number matches before trusting them. Conflicts stay unlinked. Flagging a match removes its popover until you correct or reset it.</p>
    {log.error && <ErrorNote>{messageOf(log.error)}</ErrorNote>}
    {!log.data && !log.error && <p role="status">Loading reference resolutions…</p>}
    {log.data && <>
      <div className="flex flex-wrap gap-4 text-sm" aria-label="Reference counts">
        <span>{log.data.total} retained references</span>
        <span>{log.data.counts.automatic ?? 0} automatic</span>
        <span>{(log.data.counts.ambiguous ?? 0) + (log.data.counts.flagged ?? 0)} need review</span>
        <span>{log.data.counts.corrected ?? 0} corrected</span>
      </div>
      <Segmented label="Reference filter" value={filter} onChange={setFilter} options={[{ value: "attention", label: "Needs attention" }, { value: "all", label: "All matches" }, { value: "feedback", label: "Your corrections" }]} />
      <p className="text-xs text-muted-foreground">Showing {rows.length} of the latest {log.data.rows.length} records. Collected when messages are displayed, not from a background scan. Keeps the latest 2,000 unreviewed records and preserves records with feedback.</p>
      {rows.length === 0 && <p role="status" className="rounded-lg border border-border p-4 text-sm text-muted-foreground">No references in this view yet. Open a thread containing bare PR numbers to collect matches.</p>}
      <ul className="space-y-3">
        {rows.map((row) => <li key={row.id} className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4" data-reference={row.id}>
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-mono text-sm">#{row.number}</strong><span className="text-xs">{row.status}</span>
            <span className="text-xs text-muted-foreground">{new Date(row.at).toLocaleString()}</span>
            <button className={BUTTON} onClick={() => onOpenThread(row.threadId)}>Open source thread</button>
          </div>
          <blockquote className="break-words text-sm" data-content="">{row.excerpt}</blockquote>
          <p className="text-xs text-muted-foreground">{row.reason}</p>
          <div className="space-y-1 break-all text-xs">
            <div>Current target: {row.url ? <UrlLink href={row.url}>{row.url}</UrlLink> : "Not linked"}</div>
            <div>Automatic target: {row.automaticUrl ? <UrlLink href={row.automaticUrl}>{row.automaticUrl}</UrlLink> : "None"}</div>
          </div>
          {row.candidates.length > 1 && <details><summary className="cursor-pointer text-xs">Candidate evidence ({row.candidates.length})</summary><ul className="mt-2 space-y-1 break-all text-xs">{row.candidates.map((url) => <li key={url}><UrlLink href={url}>{url}</UrlLink></li>)}</ul></details>}
          <ReferenceFeedback id={row.id} url={row.url} />
        </li>)}
      </ul>
      {log.data.events.length > 0 && <details><summary className="cursor-pointer py-2 text-sm">Recent feedback history</summary><ul className="space-y-2 text-xs">{log.data.events.map((event) => <li key={event.id} className="break-all">{new Date(event.at).toLocaleString()} · {event.action}: {event.beforeUrl ?? "unlinked"} → {event.afterUrl ?? "unlinked"}</li>)}</ul></details>}
    </>}
  </section>;
}
