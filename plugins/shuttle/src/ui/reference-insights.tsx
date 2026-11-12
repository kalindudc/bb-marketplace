import { useEffect, useMemo, useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { ReferenceLogOptions, ReferenceRecord } from "../contract";
import type { ServerConfig } from "../config";
import { prKey } from "../keys";
import { linkKey, parseGitLink } from "../links";
import { BUTTON, BUTTON_LARGE, BUTTON_PRIMARY_LARGE, ErrorNote, FIELD_SMALL, onCardClick, Segmented, SELECTED_ROW } from "./common";
import { messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { ago } from "./format";
import { KeywordField, useKeywordQuery } from "./keywords";
import { tapReference } from "./links/dom";
import { referenceView } from "./prefs";
import { useStored } from "./remember";
import { ReferenceFeedback } from "./reference-feedback";
import { GroupHeader } from "./row";
import { useViewport } from "./viewport";

const PAGE_SIZE = 100;
const STATUS_LABELS: Record<ReferenceRecord["status"], string> = { automatic: "Automatic", unresolved: "Unresolved", ambiguous: "Ambiguous", flagged: "Flagged", corrected: "Corrected", suppressed: "Not a git reference", confirmed: "Confirmed", dismissed: "Dismissed" };

function targetOf(row: ReferenceRecord, servers: ServerConfig[]) {
  const target = parseGitLink(row.url ?? row.automaticUrl ?? "", servers);
  return target?.kind === "pr" || target?.kind === "issue" ? target : null;
}

function ReferenceRow({ row, servers, onOpenThread, onOpenPr, selected = false }: { row: ReferenceRecord; servers: ServerConfig[]; onOpenThread(id: string): void; onOpenPr(key: string, referenceId?: string): void; selected?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const feedback = useShuttleMutation("referenceFeedback");
  useEffect(() => { if (selected) setExpanded(true); }, [selected]);
  const target = targetOf(row, servers);
  const pr = row.url && target?.kind === "pr" ? prKey(target.ref) : null;
  const open = () => { setExpanded(true); if (pr) onOpenPr(pr, row.id); };
  const title = target ? `${target.repo}#${target.kind === "pr" ? target.ref.number : target.number}` : "No target";
  const issue = row.url && target?.kind === "issue" ? target : null;
  return <li data-reference={row.id} aria-current={selected ? "true" : undefined} tabIndex={0} onClick={onCardClick(open)} onKeyDown={(event) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); }
  }} className={`min-w-0 cursor-pointer border-t border-border px-3 py-3 first:border-t-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${selected ? SELECTED_ROW : "hover:bg-state-hover"}`}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {issue ? <UrlLink href={row.url!} data-shuttle-reference-id={row.id} onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); tapReference({ el: event.currentTarget, url: row.url!, key: linkKey(issue), kind: "issue", referenceId: row.id });
      }} className="inline-flex min-h-9 items-center rounded-md border border-input px-3 font-mono text-base font-semibold text-primary">#{row.number}</UrlLink> : <button type="button" onClick={open} title={pr ? `Open ${title} in Shuttle` : "Inspect this reference"} className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-input px-3 font-mono text-base font-semibold text-primary">#{row.number}</button>}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={title}>{title}</span>
      <span className="text-xs">{STATUS_LABELS[row.status]}</span>
      <span className="text-[11px] text-muted-foreground" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span>
      <div className="flex shrink-0 gap-1">
        <button className={BUTTON_PRIMARY_LARGE} title="Accept this match and move it to Handled" disabled={feedback.isPending || !row.url} onClick={() => void feedback.run({ id: row.id, action: "confirm", query: null })}>Mark correct</button>
        <button className={BUTTON_LARGE} disabled={feedback.isPending} onClick={() => void feedback.run({ id: row.id, action: "dismiss", query: null })}>Dismiss</button>
      </div>
    </div>
    <p className="my-1 truncate text-xs text-muted-foreground" title={row.excerpt}>{row.excerpt.replace(/\s+/gu, " ")}</p>
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={row.reason}>{row.reason}</span>
      <button type="button" title={row.threadTitle ?? row.threadId} className={`${BUTTON_LARGE} max-w-48 truncate`} onClick={() => onOpenThread(row.threadId)}>{row.threadTitle ?? "Open source thread"}</button>
      {row.url && <UrlLink href={row.url} title={row.url} className={BUTTON_LARGE}>Open externally ↗</UrlLink>}
      <button type="button" aria-label={`Details for #${row.number}`} aria-expanded={expanded} className={BUTTON_LARGE} onClick={() => expanded ? setExpanded(false) : open()}>{expanded ? "Less" : "Details"}</button>
    </div>
    {expanded && <div className="mt-2 space-y-3 border-t border-border pt-3" onClick={(event) => event.stopPropagation()}>
      <blockquote className="break-words text-sm" data-content="">{row.excerpt}</blockquote>
      <p className="text-xs text-muted-foreground">{row.reason}</p>
      <div className="break-all text-xs">Automatic target: {row.automaticUrl ?? "None"}</div>
      {row.candidates.length > 1 && <ul className="space-y-1 break-all text-xs" aria-label="Candidate evidence">{row.candidates.map((url) => <li key={url}><UrlLink href={url}>{url} ↗</UrlLink></li>)}</ul>}
      <ReferenceFeedback key={row.id} id={row.id} url={row.url} showTriage={false} />
    </div>}
  </li>;
}

export function ReferenceInsights({ onOpenThread, onOpenPr, selectedReference }: { onOpenThread(id: string): void; onOpenPr(key: string, referenceId?: string): void; selectedReference?: string | null }) {
  const prefs = useStored(referenceView);
  const [query, setQuery] = useKeywordQuery("references");
  const [offset, setOffset] = useState(0);
  const [folded, setFolded] = useState(new Set<string>());
  const [handledOpen, setHandledOpen] = useState(false);
  const [handledExpanded, setHandledExpanded] = useState(new Set<string>());
  const phone = useViewport() === "phone";
  const config = useShuttleQuery("getConfig", {});
  const servers = config.data?.config.servers ?? [];
  const filter = prefs.filter as ReferenceLogOptions["filter"];
  const status = prefs.status as ReferenceLogOptions["status"];
  const sort = prefs.sort as ReferenceLogOptions["sort"];
  const key = JSON.stringify([filter, status, sort, query]);
  const [pageKey, setPageKey] = useState(key);
  const currentOffset = pageKey === key ? offset : 0;
  useEffect(() => { setOffset(0); setPageKey(key); }, [key]);
  const log = useShuttleQuery("referenceLog", { limit: PAGE_SIZE, offset: currentOffset, filter, status, query: query.slice(0, 200), sort });
  const handled = useShuttleQuery("referenceLog", { limit: PAGE_SIZE, filter: "handled", status: "all", query: query.slice(0, 200), sort }, prefs.filter === "pending" || prefs.filter === "attention");
  useEffect(() => {
    const selected = handled.data?.rows.find((row) => row.id === selectedReference);
    if (!selected) return;
    setHandledOpen(true);
    setHandledExpanded((old) => old.has(selected.status) ? old : new Set([...old, selected.status]));
  }, [selectedReference, handled.data]);
  const rows = log.data?.rows ?? [];
  const handledGroups = Object.entries(STATUS_LABELS).flatMap(([status, title]) => {
    const items = handled.data?.rows.filter((row) => row.status === status) ?? [];
    return items.length ? [{ status, title, items }] : [];
  });
  useEffect(() => {
    if (log.data && currentOffset >= log.data.filteredTotal && currentOffset > 0) setOffset(Math.max(0, currentOffset - PAGE_SIZE));
  }, [currentOffset, log.data]);
  const groups = useMemo(() => {
    const found = new Map<string, ReferenceRecord[]>();
    for (const row of rows) {
      const target = targetOf(row, servers);
      const title = prefs.group === "status" ? STATUS_LABELS[row.status] : prefs.group === "thread" ? row.threadTitle ?? row.threadId : prefs.group === "repo" ? target ? `${target.server}: ${target.repo}` : "No repository target" : "References";
      const id = prefs.group === "thread" ? row.threadId : title;
      const existing = found.get(id);
      if (existing) existing.push(row); else found.set(id, [row]);
    }
    return [...found].map(([id, items]) => ({ id, title: prefs.group === "thread" ? items[0]!.threadTitle ?? id : id, items }));
  }, [rows, servers, prefs.group]);
  const change = (next: Partial<typeof prefs>) => referenceView.set({ ...prefs, ...next });
  const filters = [{ value: "pending", label: "Pending" }, { value: "attention", label: "Needs attention" }, { value: "handled", label: "Handled" }, { value: "all", label: "All matches" }];
  return <section aria-label="Reference resolutions" className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <KeywordField value={query} onChange={(value) => setQuery(value.slice(0, 200))} label="Search references" placeholder="Number, repo, thread or excerpt" phone={phone} className="w-72 @max-[560px]:w-full" />
      <Segmented label="Reference filter" value={prefs.filter} onChange={(filter) => change({ filter, status: "all" })} options={filters} />
      <span className="ml-auto flex flex-wrap gap-2">
        <select aria-label="Reference status" className={FIELD_SMALL} value={prefs.status} onChange={(event) => change({ status: event.target.value })}><option value="all">Any status</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Group references" className={FIELD_SMALL} value={prefs.group} onChange={(event) => change({ group: event.target.value })}><option value="status">Group by status</option><option value="repo">Group by repository</option><option value="thread">Group by source thread</option><option value="none">No grouping</option></select>
        <select aria-label="Sort references" className={FIELD_SMALL} value={prefs.sort} onChange={(event) => change({ sort: event.target.value })}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
      </span>
    </div>
    <p className="text-xs text-muted-foreground">Mark correct accepts the current match; Correct this reference chooses another PR. Handled items stay collapsed below.</p>
    {log.error && <ErrorNote>{messageOf(log.error)}</ErrorNote>}
    {config.error && <ErrorNote>Could not load reference targets: {messageOf(config.error)}</ErrorNote>}
    {!log.data && !log.error && <p role="status">Loading reference resolutions…</p>}
    {log.data && <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{log.data.filteredTotal} matching of {log.data.total} retained references</span>{query && <button className="text-primary" onClick={() => setQuery("")}>Clear search</button>}</div>
      {rows.length === 0 && <p role="status" className="py-6 text-center text-sm text-muted-foreground">{log.data.total ? "Nothing matches these filters." : "Open a thread containing bare PR numbers to collect references."}</p>}
      {groups.map((group) => <section key={group.id} aria-label={group.title}>
        {prefs.group !== "none" && <GroupHeader title={group.title} count={group.items.length} layout={{ compact: false, phone }} folded={folded.has(group.id)} onFold={() => setFolded((old) => { const next = new Set(old); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })} />}
        {(prefs.group === "none" || !folded.has(group.id)) && <ul className="overflow-hidden rounded-lg border border-border bg-card">{group.items.map((row) => <ReferenceRow key={row.id} row={row} servers={servers} onOpenThread={onOpenThread} onOpenPr={onOpenPr} selected={row.id === selectedReference} />)}</ul>}
      </section>)}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{rows.length ? `${currentOffset + 1}–${currentOffset + rows.length} of ${log.data.filteredTotal}` : "No results"}</span>
        {log.data.filteredTotal > PAGE_SIZE && <><button className={BUTTON} disabled={currentOffset === 0} onClick={() => setOffset(Math.max(0, currentOffset - PAGE_SIZE))}>Previous</button><button className={BUTTON} disabled={currentOffset + PAGE_SIZE >= log.data.filteredTotal} onClick={() => setOffset(currentOffset + PAGE_SIZE)}>Next</button></>}
        <span className="ml-auto">Collected from displayed messages</span>
      </div>
      {(prefs.filter === "pending" || prefs.filter === "attention") && <section className="rounded-lg border border-border bg-card" aria-label="Handled references">
        <button type="button" aria-expanded={handledOpen} onClick={() => setHandledOpen((value) => !value)} className="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-3 text-left text-sm font-semibold">{handledOpen ? "▾" : "▸"} Handled references ({handled.data?.filteredTotal ?? 0})</button>
        {handled.error && <ErrorNote>{messageOf(handled.error)}</ErrorNote>}
        {handledOpen && handledGroups.map((group) => <section key={group.status} className="border-t border-border" aria-label={group.title}>
          <button type="button" aria-expanded={handledExpanded.has(group.status)} className="flex min-h-9 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm" onClick={() => setHandledExpanded((old) => { const next = new Set(old); if (next.has(group.status)) next.delete(group.status); else next.add(group.status); return next; })}>{handledExpanded.has(group.status) ? "▾" : "▸"} {group.title} ({group.items.length})</button>
          {handledExpanded.has(group.status) && <ul>{group.items.map((row) => <ReferenceRow key={row.id} row={row} servers={servers} onOpenThread={onOpenThread} onOpenPr={onOpenPr} selected={row.id === selectedReference} />)}</ul>}
        </section>)}
        {handledOpen && handled.data && handled.data.filteredTotal > PAGE_SIZE && <button className={BUTTON} onClick={() => change({ filter: "handled", group: "status", status: "all" })}>View all {handled.data.filteredTotal} handled references</button>}
      </section>}
      {log.data.events.length > 0 && <details><summary className="cursor-pointer py-2 text-xs">Feedback history</summary><ul className="space-y-2 text-xs">{log.data.events.map((event) => <li key={event.id} className="break-all">{new Date(event.at).toLocaleString()} · {event.action}: {event.beforeUrl ?? "unlinked"} → {event.afterUrl ?? "unlinked"}</li>)}</ul></details>}
    </>}
  </section>;
}
