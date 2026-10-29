import { useEffect, useRef, useState } from "react";
import { experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import type { ResearchSourceView } from "../research/contract.ts";
import type { SourceScope } from "../web/contracts.ts";
import type { ThreadScope } from "../research/activity.ts";
import { rpcContract } from "./contract.ts";
import { Chip, Count, cx, ErrorLine, Glyph, hostOf, Loading, plural, shortUrl, Spinner, Tag, Tile, when } from "./kit.tsx";

type Filter = "all" | "cited" | "changed" | "problems";
export interface SourcesProps { scope: SourceScope; projectName?: string; selected?: string | null; onOpen(scope: SourceScope, sourceId: string): void; initialCrawl?: string | null }

function useDebounced(value: string, ms = 250): string {
 const [out, setOut] = useState(value);
 useEffect(() => { const t = setTimeout(() => setOut(value), ms); return () => clearTimeout(t); }, [value, ms]);
 return out;
}

export function SourceRow({ source, selected, onOpen }: { source: ResearchSourceView; selected?: boolean; onOpen(): void }) {
 const extra = source.arrival === "person" ? (source.via === "browser" ? "saved from the Browser" : "read by you") : "";
 return <button type="button" onClick={onOpen} aria-current={selected ? "true" : undefined}
  className={cx("grid w-full cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover", selected && "bg-surface-selected")}>
  <span className="row-span-2"><Tile label={hostOf(source.url)} /></span>
  <span className="truncate text-[12.5px] font-medium text-foreground">{source.title || shortUrl(source.url)}</span>
  <span className="justify-self-end whitespace-nowrap text-[11px] text-subtle-foreground">{when(source.lastRetrievedAt ?? source.updatedAt)}</span>
  <span className="truncate text-[11.5px] text-muted-foreground">{shortUrl(source.url)}{extra && ` · ${extra}`}</span>
  <span className="flex justify-end gap-1">
   {source.cited > 0 && <Tag tone="good"><Glyph name="quote" className="size-3" />Cited</Tag>}
   {source.shared && <Tag title="A copy is shared with the project">Shared</Tag>}
   {source.versions > 1 && <Tag>{plural(source.versions, "version")}</Tag>}
   {source.status === "failed" && <Tag tone="bad">Failed</Tag>}
   {source.status === "partial" && <Tag tone="warn">Partial</Tag>}
   {source.network === "private" && <Tag tone="warn">Private</Tag>}
  </span>
 </button>;
}

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
 return <section aria-label={label}><h4 className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">{label}<span className="font-medium">{count}</span></h4>{children}</section>;
}

function CrawlPages({ scope, jobId, onOpen }: { scope: ThreadScope; jobId: string; onOpen(id: string): void }) {
 const [limit, setLimit] = useState(30);
 const pages = useQuery({ contract: rpcContract, method: "listCrawlPages", input: { scope, jobId, limit } });
 if (pages.error) return <ErrorLine error={pages.error} />;
 if (!pages.data) return <Loading label="Loading pages…" />;
 return <div className="mb-1 ml-8 mr-2 border-l-2 border-border pl-2">
  {pages.data.pages.length === 0 && <p className="py-1 text-[11px] text-muted-foreground">No pages yet.</p>}
  {pages.data.pages.map((page) => {
   const icon = page.state === "saved" ? <span className="text-success"><Glyph name="check-circle" /></span> : page.state === "failed" ? <span className="text-destructive-text"><Glyph name="x-circle" /></span> : page.state === "fetching" ? <Spinner /> : <span className="text-subtle-foreground"><Glyph name="skip" /></span>;
   const label = <><span className="truncate font-mono text-[11.5px]">{shortUrl(page.url)}</span><span className="truncate text-right text-[11px] text-subtle-foreground">{page.state === "failed" ? page.error ?? "Failed" : page.state === "skipped" ? (page.error === "ROBOTS_DENIED" ? "robots.txt asks crawlers to skip it" : "Skipped") : page.state === "queued" ? "Waiting" : page.state === "fetching" ? "Reading…" : ""}</span></>;
   return page.sourceId
    ? <button key={page.id} type="button" onClick={() => onOpen(page.sourceId!)} className="grid w-full cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-2 rounded py-0.5 text-left hover:bg-state-hover">{icon}{label}</button>
    : <div key={page.id} className="grid grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-2 py-0.5">{icon}{label}</div>;
  })}
  {pages.data.nextCursor && <button type="button" className="cursor-pointer py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setLimit(200)}>Show more pages</button>}
 </div>;
}

const expanded = new Map<string, Record<string, boolean>>();
export function SourcesList({ scope, projectName, selected, onOpen, initialCrawl }: SourcesProps) {
 const [text, setText] = useState("");
 const query = useDebounced(text.trim());
 const [filter, setFilter] = useState<Filter>("all");
 const key = JSON.stringify(scope);
 const [open, setOpenState] = useState<Record<string, boolean>>(() => ({ ...expanded.get(key), ...(initialCrawl ? { [initialCrawl]: true } : {}) }));
 const setOpen = (update: (v: Record<string, boolean>) => Record<string, boolean>) => setOpenState((v) => { const next = update(v); expanded.set(key, next); return next; });
 useEffect(() => { if (initialCrawl) setOpen((v) => ({ ...v, [initialCrawl]: true })); }, [initialCrawl]);
 const list = useQuery({ contract: rpcContract, method: "listResearchSources", input: { scope, filter, limit: 200, ...(query ? { query } : {}) } });
 const projectScope: SourceScope = { kind: "project", projectId: scope.projectId };
 const sharedOn = scope.kind === "thread";
 const shared = useQuery({ contract: rpcContract, method: "listResearchSources", input: { scope: projectScope, filter, limit: 50, ...(query ? { query } : {}), ...(scope.kind === "thread" ? { exceptThreadId: scope.threadId } : {}) }, enabled: sharedOn });
 const kept = useRef(list.data);
 if (list.data) kept.current = list.data;
 if (list.error) return <ErrorLine error={list.error} />;
 const data = list.data ?? kept.current;
 const counts = data?.counts;
 const grouped = data && filter === "all" && !query && scope.kind === "thread";
 const by = (arrival: ResearchSourceView["arrival"]) => (data?.sources ?? []).filter((s) => s.arrival === arrival);
 const sharedRows = shared.data?.sources ?? [];
 const row = (s: ResearchSourceView, rowScope: SourceScope = scope) => <SourceRow key={s.id} source={s} selected={selected === s.id} onOpen={() => onOpen(rowScope, s.id)} />;
 return <div>
  <div className="flex gap-1.5 px-3 pt-2.5">
   <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-muted-foreground">
    <Glyph name="magnifier" /><input aria-label="Filter sources" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by title or address" className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground" />
   </label>
  </div>
  <div className="flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
   {(["all", "cited", "changed", "problems"] as const).map((id) => <Chip key={id} pressed={filter === id} onClick={() => setFilter(id)} tone={id === "problems" && counts?.problems ? "warn" : undefined}>
    {{ all: "All", cited: "Cited", changed: "Changed", problems: "Problems" }[id]}{counts && <Count n={counts[id]} />}
   </Chip>)}
  </div>
  {!data ? <Loading label="Loading sources…" /> : <div className="px-1.5 pb-4">
   {grouped ? <>
    {by("agent").length > 0 && <Group label="Read by the agent" count={by("agent").length}>{by("agent").map((s) => row(s))}</Group>}
    {data.crawlGroups.some((g) => g.sources > 0 || g.state === "running" || g.state === "queued") && <Group label="From crawls" count={data.crawlGroups.reduce((n, g) => n + g.sources, 0)}>
     {data.crawlGroups.filter((g) => g.sources > 0 || g.state === "running" || g.state === "queued").map((g) => {
      const key = g.jobId ?? "earlier";
      const running = g.state === "running" || g.state === "queued";
      return <div key={key}>
       <button type="button" aria-expanded={Boolean(open[key])} disabled={!g.jobId} onClick={() => setOpen((v) => ({ ...v, [key]: !v[key] }))}
        className="grid w-full cursor-pointer grid-cols-[0.75rem_0.875rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-state-hover disabled:cursor-default">
        <Glyph name={open[key] ? "chevron-down" : "chevron-right"} className={cx("size-3 text-subtle-foreground", !g.jobId && "invisible")} /><Glyph name="crawl" />
        <span className="truncate">{g.rootUrl ? `Crawl of ${shortUrl(g.rootUrl)}` : "Earlier crawls no longer kept"}</span>
        {running ? <Tag tone="info"><Spinner className="size-3" />Running</Tag> : <span />}
        <span className="text-[11.5px] text-muted-foreground">{plural(g.sources, "page")}</span>
       </button>
       {open[key] && g.jobId && scope.kind === "thread" && <CrawlPages scope={scope} jobId={g.jobId} onOpen={(id) => onOpen(scope, id)} />}
      </div>;
     })}
    </Group>}
    {by("person").length > 0 && <Group label="Saved by you" count={by("person").length}>{by("person").map((s) => row(s))}</Group>}
   </> : data.sources.map((s) => row(s))}
   {grouped && data.sources.length === 0 && data.crawlGroups.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No sources kept in this thread yet.</p>}
   {!grouped && data.sources.length === 0 && <p className="px-3 py-4 text-xs text-muted-foreground">No sources match.</p>}
   {sharedOn && sharedRows.length > 0 && <Group label={`Shared with ${projectName ?? "the project"}`} count={sharedRows.length}>{sharedRows.map((s) => row(s, projectScope))}</Group>}
   {data.nextCursor && <p className="px-3 pt-2 text-[11px] text-muted-foreground">Showing the first 200. Filter to narrow the list.</p>}
  </div>}
 </div>;
}
