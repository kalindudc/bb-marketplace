import { useMemo, useRef, useState } from "react";
import { experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import type { ActivityEntryView } from "../research/contract.ts";
import type { ThreadScope } from "../research/activity.ts";
import type { CrawlJobView } from "../jobs/model.ts";
import { rpcContract } from "./contract.ts";
import { Bar, Button, Chip, Count, cx, ErrorLine, Glyph, hostOf, Loading, plainError, plural, providerName, safeHref, shortUrl, Spinner, Tag, when } from "./kit.tsx";

type Filter = "all" | "search" | "pages" | "crawls" | "problems";
const BURST_GAP = 10 * 60_000;
const category = (entry: ActivityEntryView): Exclude<Filter, "all" | "problems"> => entry.operation === "search" ? "search" : entry.operation === "map" || entry.operation === "crawl" ? "crawls" : "pages";
export const isProblem = (entry: ActivityEntryView) => entry.status === "failure" || entry.status === "partial" || ("pages" in entry.summary && entry.summary.pages.some((page) => page.error));
const ICON: Record<ActivityEntryView["operation"], string> = { search: "search", fetch: "fetch", save: "bookmark", map: "map", extract: "extract", crawl: "crawl", diff: "diff" };
const TINT: Record<ActivityEntryView["operation"], string> = { search: "text-primary", fetch: "text-success", save: "text-success", map: "text-foreground", crawl: "text-foreground", extract: "text-warning-text", diff: "text-warning-text" };

export function describe(entry: ActivityEntryView, job?: CrawlJobView): { title: string; meta: string } {
 const you = entry.actor === "person";
 const s = entry.summary;
 if (s.kind === "search") {
  const total = s.queries.reduce((n, q) => n + q.total, 0);
  const failed = s.queries.filter((q) => q.error).length;
  const providers = [...new Set(s.queries.map((q) => providerName(q.provider)).filter(Boolean))].join(", ");
  const title = s.queries.length === 1 ? `${you ? "You searched" : "Searched"} “${s.queries[0]!.query}”` : `${you ? "You searched" : "Searched"} ${s.queries.length} queries`;
  return { title, meta: failed === s.queries.length ? plainError(s.queries[0]?.error ?? entry.error ?? "The search failed") : [plural(total, "result"), providers, failed ? `${failed} failed` : ""].filter(Boolean).join(" · ") };
 }
 if (s.kind === "fetch" || s.kind === "save" || s.kind === "extract") {
  const failed = s.pages.filter((p) => p.error).length;
  const one = s.pages.length === 1 ? s.pages[0]! : null;
  const name = one ? one.title || shortUrl(one.url) : plural(s.pages.length, "page");
  const verb = s.kind === "save" ? "Saved" : s.kind === "extract" ? "Pulled fields from" : you ? "You read" : "Read";
  const title = s.kind === "save" ? `Saved ${name} from the Browser` : `${verb} ${name}`;
  const meta = one?.error ? plainError(one.error) : failed ? `${failed} of ${s.pages.length} failed` : one ? hostOf(one.url) : [...new Set(s.pages.map((p) => hostOf(p.url)))].slice(0, 3).join(", ");
  return { title, meta: s.kind === "fetch" && s.find ? `${meta} · looked for “${s.find}”` : meta };
 }
 if (s.kind === "map") return { title: `Mapped ${hostOf(s.root)}`, meta: entry.status === "failure" ? plainError(entry.error ?? "The map failed") : `${plural(s.total, "address", "addresses")}${s.truncated ? ", stopped at its limit" : ""}` };
 if (s.kind === "crawl") {
  const root = s.root ? shortUrl(s.root) : "a site";
  if (s.action === "cancel") return { title: `${you ? "You stopped" : "Stopped"} the crawl of ${root}`, meta: "" };
  const state = !job ? "" : job.state === "running" || job.state === "queued" || job.state === "cancelling" ? `${job.pagesUsed} of ${job.limits.maxPages} pages`
   : job.counts.saved === 0 ? "Nothing saved" : job.stopReason === "page-limit" ? `Stopped at its ${job.limits.maxPages}-page limit, ${plural(job.counts.saved, "page")} saved`
   : job.state === "cancelled" ? `Stopped, ${plural(job.counts.saved, "page")} saved` : job.state === "failed" ? "Failed" : `Finished with ${plural(job.counts.saved, "page")}`;
  return { title: `${s.action === "resume" ? (you ? "You resumed" : "Resumed") : you ? "You started" : "Started"} a crawl of ${root}`, meta: entry.status === "failure" ? plainError(entry.error ?? "The crawl did not start") : state };
 }
 const name = s.url ? shortUrl(s.url) : "a kept source";
 return { title: `Compared ${name} with its earlier version`, meta: entry.status === "failure" ? plainError(entry.error ?? "The comparison failed") : s.unchanged ? "No changes" : `+${s.added} −${s.removed} in ${plural(Math.max(1, s.sections.length), "section")}` };
}

interface Burst { actor: "agent" | "person"; from: number; to: number; entries: ActivityEntryView[] }
function bursts(entries: readonly ActivityEntryView[]): Burst[] {
 const out: Burst[] = [];
 for (const entry of entries) {
  const last = out.at(-1);
  if (last && last.actor === entry.actor && last.from - entry.finishedAt <= BURST_GAP) { last.entries.push(entry); last.from = entry.startedAt; }
  else out.push({ actor: entry.actor, from: entry.startedAt, to: entry.finishedAt, entries: [entry] });
 }
 return out;
}

export interface ActivityProps {
 scope: ThreadScope;
 onOpenSource(sourceId: string): void;
 onOpenCrawls(jobId?: string): void;
 onCompare(sourceId: string): void;
}

export function ActivityList(props: ActivityProps) {
 const { scope } = props;
 const [filter, setFilter] = useState<Filter>("all");
 const [limit, setLimit] = useState(40);
 const list = useQuery({ contract: rpcContract, method: "listActivity", input: { scope, limit } });
 const kept = useRef(list.data);
 if (list.data) kept.current = list.data;
 const data = list.data ?? kept.current;
 const jobs = useQuery({ contract: rpcContract, method: "listCrawlJobs", input: { scope, limit: 20 } });
 const jobById = useMemo(() => new Map((jobs.data?.jobs ?? []).map((job) => [job.id, job])), [jobs.data]);
 const entries = data?.entries ?? [];
 const counts = { all: entries.length, search: entries.filter((e) => category(e) === "search").length, pages: entries.filter((e) => category(e) === "pages").length, crawls: entries.filter((e) => category(e) === "crawls").length, problems: entries.filter(isProblem).length };
 const shown = entries.filter((e) => filter === "all" || (filter === "problems" ? isProblem(e) : category(e) === filter));
 if (list.error) return <ErrorLine error={list.error} />;
 if (!data) return <Loading label="Loading activity…" />;
 if (!data.enabled && entries.length === 0) return <p className="px-4 py-6 text-xs text-muted-foreground">The activity log is off in Forage settings, so searches and reads are not recorded. Sources and crawls still appear in their tabs.</p>;
 if (entries.length === 0) return <div className="px-4 py-8 text-center text-xs text-muted-foreground"><Glyph name="forage" className="mx-auto mb-2 size-6 opacity-60" /><p className="font-medium text-foreground">No activity yet</p><p className="mt-1">When the agent or you search or read a page in this thread, it shows up here. Clearing the log keeps the thread's sources and crawls.</p></div>;
 return <div>
  <div className="flex flex-wrap gap-1.5 px-3 pb-1 pt-2">
   {(["all", "search", "pages", "crawls", "problems"] as const).map((id) => <Chip key={id} pressed={filter === id} onClick={() => setFilter(id)} tone={id === "problems" && counts.problems ? "warn" : undefined}>
    {{ all: "All", search: "Searches", pages: "Pages", crawls: "Crawls", problems: "Problems" }[id]}{id !== "all" && <Count n={counts[id]} />}
   </Chip>)}
  </div>
  <div className="px-1.5 pb-4">
   {shown.length === 0 && <p className="px-3 py-4 text-xs text-muted-foreground">Nothing here for this filter.</p>}
   {bursts(shown).map((burst) => <section key={burst.entries.at(-1)!.id} aria-label={burst.actor === "person" ? "Your activity" : "The agent's activity"} className="mt-1.5">
    <h4 className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap px-2 pb-1 pt-2 text-[11px] text-muted-foreground">
     <Glyph name={burst.actor === "person" ? "user" : "bot"} /><span className="font-semibold text-foreground">{burst.actor === "person" ? "You" : "The agent"}</span>
     <span>{burst.from === burst.to || when(burst.from) === when(burst.to) ? when(burst.to) : `${when(burst.from)} – ${when(burst.to)}`}</span>
     <span className="truncate text-subtle-foreground">· {burst.actor === "person" ? "from Forage, with no model turns" : "while working in this thread"}</span>
    </h4>
    {burst.entries.map((entry) => <Entry key={entry.id} entry={entry} job={entry.summary.kind === "crawl" && entry.summary.jobId ? jobById.get(entry.summary.jobId) : undefined} {...props} />)}
   </section>)}
   {data.nextCursor && limit < 100 && <div className="px-2 pt-2"><Button variant="ghost" disabled={list.isFetching} onClick={() => setLimit(100)}>{list.isFetching ? "Loading…" : "Show older activity"}</Button></div>}
   {data.nextCursor && limit >= 100 && <p className="px-2 pt-2 text-[11px] text-muted-foreground">Showing the latest 100 entries. Older entries stay until they are 30 days old.</p>}
  </div>
 </div>;
}

function Entry({ entry, job, scope, onOpenSource, onOpenCrawls, onCompare }: ActivityProps & { entry: ActivityEntryView; job?: CrawlJobView }) {
 const [open, setOpen] = useState(false);
 const { title, meta } = describe(entry, job);
 const problem = isProblem(entry);
 const live = job && (job.state === "running" || job.state === "queued");
 return <div className={cx("rounded-lg", open && "my-0.5 bg-surface-recessed/60 ring-1 ring-border-seam")}>
  <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="grid w-full cursor-pointer grid-cols-[1.625rem_minmax(0,1fr)_auto_0.875rem] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-state-hover">
   <span className={cx("grid size-[26px] place-items-center rounded-md bg-surface-recessed", entry.status === "failure" ? "text-destructive-text" : TINT[entry.operation], entry.actor === "person" && "ring-1 ring-inset ring-current")}><Glyph name={entry.status === "failure" && entry.operation !== "search" ? "ban" : ICON[entry.operation]} className="size-[15px]" /></span>
   <span className="grid min-w-0">
    <span className="truncate text-[12.5px] font-medium text-foreground">{title}</span>
    {meta && <span className={cx("flex items-center gap-1 truncate text-[11.5px]", problem ? "text-warning-text" : "text-muted-foreground")}>{live && <Spinner className="size-3" />}{meta}</span>}
   </span>
   <span className="text-[11px] text-subtle-foreground">{when(entry.finishedAt)}</span>
   <Glyph name={open ? "chevron-down" : "chevron-right"} className="size-3 text-subtle-foreground" />
  </button>
  {!open && live && job && <div className="ml-10 mr-2 -mt-0.5 pb-1.5"><Bar value={job.pagesUsed} max={job.limits.maxPages} running /></div>}
  {open && <div className="grid gap-2 pb-2 pl-10 pr-2"><EntryBody entry={entry} job={job} scope={scope} onOpenSource={onOpenSource} onOpenCrawls={onOpenCrawls} onCompare={onCompare} /></div>}
 </div>;
}

function EntryBody({ entry, job, scope, onOpenSource, onOpenCrawls, onCompare }: ActivityProps & { entry: ActivityEntryView; job?: CrawlJobView }) {
 const s = entry.summary;
 if (entry.error && s.kind !== "search") return <p className="text-xs text-destructive-text">{plainError(entry.error)}</p>;
 if (s.kind === "search") return <>{s.queries.map((q, qi) => <div key={qi} className="overflow-hidden rounded-lg border border-border bg-card">
  <div className="flex items-baseline gap-2 border-b border-border px-2.5 py-1.5 text-xs">
   <span className="min-w-0 flex-1 truncate font-semibold">“{q.query}”</span><span className="whitespace-nowrap text-[11px] text-subtle-foreground">{[providerName(q.provider), plural(q.total, "result")].filter(Boolean).join(" · ")}</span>
  </div>
  {q.error && <p className="px-2.5 py-1.5 text-xs text-destructive-text">{plainError(q.error)}</p>}
  {q.results.map((r, i) => <ResultRow key={i} rank={i + 1} result={r} scope={scope} onOpenSource={onOpenSource} />)}
  {q.total > q.results.length && <p className="px-2.5 py-1.5 pl-8 text-[11px] text-subtle-foreground">{plural(q.total - q.results.length, "more result")} not kept in the log</p>}
 </div>)}{s.pages.length > 0 && <Pages pages={s.pages} onOpenSource={onOpenSource} />}</>;
 if (s.kind === "fetch" || s.kind === "save" || s.kind === "extract") return <>
  <Pages pages={s.pages} onOpenSource={onOpenSource} />
  {s.kind === "save" && <p className="text-[11px] text-muted-foreground">Forage read its own public copy of the page. The Browser's cookies and signed-in content were not used.</p>}
  {s.kind === "extract" && s.fields.length > 0 && <p className="text-[11px] text-muted-foreground">Fields: {s.fields.join(", ")}</p>}
 </>;
 if (s.kind === "map") return <div className="grid gap-1.5 text-xs">
  <p>Found {plural(s.total, "address", "addresses")}{Object.keys(s.methods).length > 0 && <>: {Object.entries(s.methods).map(([m, n]) => `${n} from ${{ sitemap: "the sitemap", "sitemap-index": "sitemap indexes", robots: "robots.txt", llms: "llms.txt", "html-link": "links on the page", provider: "the provider" }[m] ?? m}`).join(", ")}</>}.</p>
  {s.sample.length > 0 && <div className="flex flex-wrap gap-1">{s.sample.map((url) => <code key={url} className="rounded bg-surface-recessed px-1.5 py-px text-[11px]">{shortUrl(url)}</code>)}{s.total > s.sample.length && <span className="text-[11px] text-subtle-foreground">and {plural(s.total - s.sample.length, "more")}</span>}</div>}
 </div>;
 if (s.kind === "crawl") return <div className="grid gap-2 text-xs">
  {job && <div className="grid gap-1"><Bar value={job.pagesUsed} max={job.limits.maxPages} running={job.state === "running" || job.state === "queued"} /><span className="text-[11px] text-muted-foreground">{job.counts.saved} saved · {job.counts.failed} failed · {job.counts.queued} waiting</span></div>}
  {!job && <p className="text-muted-foreground">This crawl is no longer kept.</p>}
  <div className="flex flex-wrap gap-1.5"><Button icon="crawl" onClick={() => onOpenCrawls(s.jobId ?? undefined)}>Open in Crawls</Button></div>
 </div>;
 return <div className="grid gap-2 text-xs">
  <p>{s.unchanged ? "The page has not changed." : <><span className="text-diff-added">+{s.added}</span> <span className="text-diff-removed">−{s.removed}</span> lines{s.sections.length > 0 && <> in {s.sections.map((section, i) => <b key={i} className="font-semibold">{i ? ", " : ""}{section}</b>)}</>}.</>}{!s.persisted && " The new version was compared but not kept."}</p>
  {s.sourceId && <div><Button icon="diff" onClick={() => onCompare(s.sourceId!)}>Compare versions</Button></div>}
 </div>;
}

function Pages({ pages, onOpenSource }: { pages: ReadonlyArray<{ url: string; title: string; sourceId: string | null; chars: number; error?: string }>; onOpenSource(id: string): void }) {
 return <div className="overflow-hidden rounded-lg border border-border bg-card">{pages.map((page, i) => {
  const body = <><span className={cx("self-start pt-0.5", page.error ? "text-destructive-text" : "text-success")}><Glyph name={page.error ? "x-circle" : "check-circle"} /></span>
   <span className="grid min-w-0"><span className="truncate text-xs">{page.title || shortUrl(page.url)}</span><span className="truncate text-[11px] text-subtle-foreground">{shortUrl(page.url)}</span>{page.error && <span className="line-clamp-2 text-[11px] text-destructive-text">{plainError(page.error)}</span>}</span>
   <span className="self-start whitespace-nowrap pt-0.5 text-right text-[11px] text-muted-foreground">{!page.error && page.chars ? `${Math.max(1, Math.round(page.chars / 1000))}k characters` : ""}</span></>;
  const cls = "grid w-full grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-border px-2.5 py-1.5 text-left first:border-t-0";
  return page.sourceId ? <button key={i} type="button" onClick={() => onOpenSource(page.sourceId!)} className={cx(cls, "cursor-pointer hover:bg-state-hover")}>{body}</button> : <div key={i} className={cls}>{body}</div>;
 })}</div>;
}

function ResultRow({ rank, result, scope, onOpenSource }: { rank: number; result: { title: string; url: string; snippet?: string; sourceId: string | null }; scope: ThreadScope; onOpenSource(id: string): void }) {
 const run = useMutation({ contract: rpcContract, method: "run" });
 const [message, setMessage] = useState<string | null>(null);
 async function read() {
  try { const out = await run.mutate({ projectId: scope.projectId, threadId: scope.threadId, operation: "read", url: result.url, via: "tab" }); if (!out.ok) setMessage(out.message); }
  catch (error) { setMessage(error instanceof Error ? error.message : "The page could not be read."); }
 }
 return <div className="grid grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-border/60 px-2.5 py-1.5 first:border-t-0">
  <span className="text-right text-[11px] text-subtle-foreground">{rank}</span>
  <span className="grid min-w-0" title={result.snippet}>
   <a href={safeHref(result.url)} target="_blank" rel="noreferrer" className={cx("truncate text-xs hover:underline", result.sourceId && "font-medium")}>{result.title || shortUrl(result.url)}</a>
   <span className="truncate text-[11px] text-subtle-foreground">{message ?? shortUrl(result.url)}</span>
  </span>
  {result.sourceId
   ? <button type="button" onClick={() => onOpenSource(result.sourceId!)} className="cursor-pointer"><Tag tone="good"><Glyph name="check" className="size-3" />Read</Tag></button>
   : <Button className="h-6 px-2 text-[11px]" icon="fetch" disabled={run.isPending} onClick={() => { void read(); }} title="Read this page into the thread, with no model turn">{run.isPending ? "Reading…" : "Read now"}</Button>}
 </div>;
}

