import { useEffect, useState } from "react";
import {
 experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery, useBbNavigate, useSdk,
 type ExperimentalBadge, type ExperimentalPageTitle, type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract.ts";
import { Bar, Button, cx, ErrorLine, Glyph, hostOf, Loading, Notice, plural, shortUrl, size, Spinner, Tag, Tile, when } from "./kit.tsx";
import { POLICY_LABEL, ResearchView } from "./research.tsx";

function useThreadInfo(threadId: string): { value: { projectId: string; title: string; archived: boolean } | null; error: boolean } {
 const sdk = useSdk();
 const [state, setState] = useState<{ value: { projectId: string; title: string; archived: boolean } | null; error: boolean }>({ value: null, error: false });
 useEffect(() => {
  let active = true;
  const abort = new AbortController();
  void sdk.threads.get({ threadId, signal: abort.signal }).then((t) => { if (active) setState({ value: t.deletedAt === null ? { projectId: t.projectId, title: t.title ?? t.titleFallback ?? "Untitled thread", archived: t.archivedAt !== null } : null, error: t.deletedAt !== null }); }, () => { if (active) setState({ value: null, error: true }); });
  return () => { active = false; abort.abort(); };
 }, [sdk, threadId]);
 return state;
}
import { Reader } from "./reader.tsx";

export const PAGE_PATH = "sources";
type Route = { kind: "index" } | { kind: "thread"; threadId: string } | { kind: "health" } | { kind: "shared"; projectId?: string; sourceId?: string };
const decode = (value: string): string | null => { try { return decodeURIComponent(value); } catch { return null; } };
export function parseRoute(subPath: string): Route {
 const [head, rawA, rawB] = subPath.split("/").filter(Boolean);
 const a = rawA === undefined ? undefined : decode(rawA);
 const b = rawB === undefined ? undefined : decode(rawB);
 if (a === null || b === null) return { kind: "index" };
 if (head === "thread" && a) return { kind: "thread", threadId: a };
 if (head === "health") return { kind: "health" };
 if (head === "shared") return { kind: "shared", ...(a ? { projectId: a } : {}), ...(b ? { sourceId: b } : {}) };
 return { kind: "index" };
}

function useThreads() { return useQuery({ contract: rpcContract, method: "researchThreads", input: { limit: 60 } }); }
function useGo() {
 const navigate = useBbNavigate();
 return (subPath: string) => navigate.toPluginPanel(PAGE_PATH, { subPath });
}

export function useResearchBadge(): ExperimentalBadge | null {
 const threads = useThreads();
 const running = threads.data?.totals.running ?? 0;
 return running > 0 ? { count: running, label: `${plural(running, "crawl")} running` } : null;
}

export function usePageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
 const route = parseRoute(subPath);
 const threads = useThreads();
 const title = route.kind === "thread" ? threads.data?.threads.find((t) => t.threadId === route.threadId)?.title ?? "Thread research"
  : route.kind === "health" ? "Health and storage" : route.kind === "shared" ? "Shared with projects" : "All threads";
 return { title, windowTitle: `Research · ${title}` };
}

export function ResearchHeader({ subPath }: PluginNavPanelProps) {
 const route = parseRoute(subPath);
 const navigate = useBbNavigate();
 const threads = useThreads();
 const totals = threads.data?.totals;
 return <div className="flex items-center gap-2 text-xs text-muted-foreground">
  {totals && <span className="hidden items-center gap-1.5 sm:inline-flex"><Glyph name="database" />{size(totals.bytes)} kept</span>}
  {route.kind === "thread" && <Button icon="message" onClick={() => navigate.toThread(route.threadId)}>Open thread</Button>}
 </div>;
}

export function ResearchSidebar({ subPath }: PluginNavPanelProps) {
 const route = parseRoute(subPath);
 const threads = useThreads();
 const go = useGo();
 const [text, setText] = useState("");
 const all = threads.data?.threads ?? [];
 const q = text.trim().toLowerCase();
 const shown = all.filter((t) => !q || `${t.title} ${t.projectName}`.toLowerCase().includes(q));
 const running = shown.filter((t) => t.running);
 const week = Date.now() - 7 * 86_400_000;
 const recent = shown.filter((t) => !t.running && t.lastAt >= week);
 const older = shown.filter((t) => !t.running && t.lastAt < week);
 const row = (t: (typeof all)[number]) => <button key={t.threadId} type="button" onClick={() => go(`thread/${encodeURIComponent(t.threadId)}`)} aria-current={route.kind === "thread" && route.threadId === t.threadId ? "page" : undefined}
  className={cx("grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-px rounded-lg px-2 py-1.5 text-left hover:bg-state-hover", route.kind === "thread" && route.threadId === t.threadId && "bg-surface-selected")}>
  <span className={t.running ? "text-primary" : "text-subtle-foreground"}>{t.running ? <Spinner /> : <Glyph name="forage" />}</span>
  <span className="truncate text-[12.5px] font-medium text-foreground">{t.title}</span>
  <span className="text-[11px] text-subtle-foreground">{when(t.lastAt)}</span>
  <span className="col-start-2 col-end-4 truncate text-[11.5px] text-muted-foreground">{t.projectName} · {plural(t.sources, "source")}{t.cited ? ` · ${t.cited} cited` : ""}{t.archived ? " · archived" : ""}</span>
  {t.running && <span className="col-start-2 col-end-4 truncate text-[11.5px] text-primary">Crawl {t.running.pagesUsed} of {t.running.maxPages} pages</span>}
 </button>;
 const group = (label: string, items: typeof all) => items.length > 0 && <section aria-label={label}><h4 className="flex gap-1.5 px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">{label}<span className="font-medium">{items.length}</span></h4>{items.map(row)}</section>;
 const nav = (kind: "index" | "shared" | "health", icon: string, label: string, subPath2: string) => <button type="button" onClick={() => go(subPath2)} aria-current={route.kind === kind ? "page" : undefined}
  className={cx("flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-state-hover", route.kind === kind && "bg-surface-selected")}><span className="text-subtle-foreground"><Glyph name={icon} /></span>{label}</button>;
 return <div className="flex h-full min-h-0 flex-col text-foreground">
  <div className="grid shrink-0 gap-2 px-2.5 pb-2 pt-1">
   <label className="flex h-8 items-center gap-1.5 rounded-lg border border-border-seam bg-card px-2 text-muted-foreground">
    <Glyph name="magnifier" /><input aria-label="Filter threads" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter threads" className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground" />
   </label>
  </div>
  <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
   {nav("index", "list", "All threads", "")}
   {threads.error && <ErrorLine error={threads.error} />}
   {!threads.data && !threads.error && <Loading />}
   {group("Running", running)}{group("This week", recent)}{group("Earlier", older)}
   {threads.data && shown.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{q ? "No thread matches." : "No thread has research yet."}</p>}
   <h4 className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Library</h4>
   {nav("shared", "share", "Shared with projects", "shared")}
   {nav("health", "activity", "Health and storage", "health")}
  </div>
  {threads.data && <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground"><Glyph name="database" />{plural(threads.data.totals.sources, "source")} · {size(threads.data.totals.bytes)} of 128 MB</div>}
 </div>;
}

export function ResearchPage({ subPath }: PluginNavPanelProps) {
 const route = parseRoute(subPath);
 if (route.kind === "thread") return <ThreadPage threadId={route.threadId} />;
 if (route.kind === "health") return <Scroll><Health /></Scroll>;
 if (route.kind === "shared") return route.projectId && route.sourceId ? <SharedReader projectId={route.projectId} sourceId={route.sourceId} /> : <Scroll><Shared /></Scroll>;
 return <Scroll><Index /></Scroll>;
}

function Scroll({ children }: { children: React.ReactNode }) {
 return <div className="h-full overflow-y-auto bg-background text-foreground"><div className="mx-auto grid w-full max-w-4xl gap-6 p-4 md:p-6">{children}</div></div>;
}
function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
 return <section className="grid gap-2"><h3 className="flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-wider text-subtle-foreground">{title}<span className="flex-1" />{action}</h3>{children}</section>;
}
function Metric({ value, label, tone }: { value: React.ReactNode; label: React.ReactNode; tone?: "info" }) {
 return <div className="grid gap-0.5 rounded-xl border border-border bg-card px-3.5 py-3"><span className={cx("text-2xl font-semibold tracking-tight", tone === "info" && "text-primary")}>{value}</span><span className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}</span></div>;
}

function Index() {
 const threads = useThreads();
 const shared = useQuery({ contract: rpcContract, method: "sharedSources", input: { limit: 5 } });
 const go = useGo();
 if (threads.error) return <ErrorLine error={threads.error} />;
 if (!threads.data) return <Loading label="Loading research…" />;
 const t = threads.data;
 const week = t.threads.filter((x) => x.lastAt >= Date.now() - 7 * 86_400_000).length;
 const cited = t.threads.reduce((n, x) => n + x.cited, 0);
 return <>
  <div><h1 className="text-xl font-semibold tracking-tight">Research</h1><p className="mt-1 text-sm text-muted-foreground">What agents and you looked up, thread by thread.</p></div>
  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
   <Metric value={week} label={`${week === 1 ? "thread" : "threads"} with research this week`} />
   <Metric value={t.totals.sources.toLocaleString()} label={`sources kept · ${cited} cited`} />
   <Metric value={t.totals.running} label={<>{t.totals.running > 0 && <Spinner className="size-3" />}{t.totals.running === 1 ? "crawl running" : "crawls running"}</>} tone={t.totals.running ? "info" : undefined} />
   <Metric value={size(t.totals.bytes)} label="of 128 MB kept" />
  </div>
  <Section title="Recent">
   {t.threads.length === 0 ? <p className="text-sm text-muted-foreground">No thread has used web research yet. When an agent searches or reads a page, the thread shows up here.</p>
    : <div className="overflow-hidden rounded-xl border border-border bg-card">{t.threads.map((x) => <button key={x.threadId} type="button" onClick={() => go(`thread/${encodeURIComponent(x.threadId)}`)}
     className="grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1.6fr)_minmax(0,1.2fr)_5.5rem_6rem] items-center gap-3 border-t border-border px-3.5 py-2.5 text-left first:border-t-0 hover:bg-state-hover">
     <span className={x.running ? "text-primary" : "text-subtle-foreground"}>{x.running ? <Spinner /> : <Glyph name="forage" />}</span>
     <span className="grid min-w-0"><span className="truncate text-[13px] font-medium">{x.title}</span><span className="truncate text-xs text-muted-foreground">{x.projectName}</span></span>
     <span className="truncate text-xs">{x.running ? `Crawling · ${x.running.pagesUsed} of ${x.running.maxPages} pages` : x.policy !== "settings" ? `Web research: ${POLICY_LABEL[x.policy]}` : x.cited ? `${plural(x.cited, "source")} cited in replies` : `${plural(x.activity, "entry", "entries")} in the log`}</span>
     <span className="text-xs text-muted-foreground">{plural(x.sources, "source")}</span>
     <span className="text-right text-xs text-muted-foreground">{when(x.lastAt)}</span>
    </button>)}</div>}
  </Section>
  {shared.data && shared.data.sources.length > 0 && <Section title="Shared with projects" action={<Button variant="ghost" className="h-6" onClick={() => go("shared")}>Show all</Button>}>
   <SharedRows rows={shared.data.sources} />
  </Section>}
 </>;
}

function SharedRows({ rows }: { rows: ReadonlyArray<{ id: string; projectId: string; projectName: string; title: string; url: string; updatedAt: number }> }) {
 const go = useGo();
 return <div className="overflow-hidden rounded-xl border border-border bg-card">{rows.map((row) => <button key={row.id} type="button" onClick={() => go(`shared/${encodeURIComponent(row.projectId)}/${encodeURIComponent(row.id)}`)}
  className="grid w-full cursor-pointer grid-cols-[1.25rem_minmax(0,1.6fr)_minmax(0,1fr)_6rem] items-center gap-3 border-t border-border px-3.5 py-2.5 text-left first:border-t-0 hover:bg-state-hover">
  <Tile label={hostOf(row.url)} /><span className="grid min-w-0"><span className="truncate text-[13px] font-medium">{row.title || shortUrl(row.url)}</span><span className="truncate text-xs text-muted-foreground">{shortUrl(row.url)}</span></span>
  <span className="truncate text-xs text-muted-foreground">{row.projectName}</span><span className="text-right text-xs text-muted-foreground">{when(row.updatedAt)}</span>
 </button>)}</div>;
}

function Shared() {
 const shared = useQuery({ contract: rpcContract, method: "sharedSources", input: { limit: 100 } });
 return <>
  <div><h1 className="text-xl font-semibold tracking-tight">Shared with projects</h1><p className="mt-1 text-sm text-muted-foreground">Sources copied from a thread into its project, so every thread in the project can read them. Each thread's Sources tab lists these too.</p></div>
  <ErrorLine error={shared.error} />
  {!shared.data && !shared.error && <Loading />}
  {shared.data && (shared.data.sources.length ? <SharedRows rows={shared.data.sources} /> : <p className="text-sm text-muted-foreground">Nothing is shared yet. Share a source from its menu in a thread's Research tab.</p>)}
 </>;
}

function SharedReader({ projectId, sourceId }: { projectId: string; sourceId: string }) {
 const go = useGo();
 return <div className="flex h-full min-h-0 flex-col bg-background text-foreground"><div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
  <Reader scope={{ kind: "project", projectId }} sourceId={sourceId} backLabel="Shared with projects" onBack={() => go("shared")} canQuote={false} />
 </div></div>;
}

function ThreadPage({ threadId }: { threadId: string }) {
 const threads = useThreads();
 const info = useThreadInfo(threadId);
 const listed = threads.data?.threads.find((x) => x.threadId === threadId);
 // A thread outside the index's newest 60 still opens; its details come from bb.
 const t = listed ?? (info.value ? { ...info.value, threadId, projectName: "", lastAt: 0, archived: info.value.archived } : null);
 if (info.error && !listed) return <Scroll><p className="text-sm text-muted-foreground">This thread was deleted or is unavailable.</p></Scroll>;
 if (!t) return <Loading />;
 return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
  <div className="shrink-0 border-b border-border px-5 pb-3 pt-4">
   <h1 className="truncate text-[17px] font-semibold tracking-tight">{t.title}</h1>
   <p className="mt-0.5 text-xs text-muted-foreground">{[t.projectName, t.lastAt ? `last research ${when(t.lastAt)}` : "", t.archived ? "archived thread" : ""].filter(Boolean).join(" · ")}</p>
  </div>
  <ResearchView scope={{ kind: "thread", projectId: t.projectId, threadId }} variant="page" canQuote={false} />
 </div>;
}

const STATE_TAG = { ready: ["good", "Ready"], "needs-key": ["neutral", "Needs a key"], "not-configured": ["neutral", "Not set up"], blocked: ["warn", "Blocked by Private"], "not-allowed": ["neutral", "Turned off"] } as const;
const OP_LABEL: Record<string, string> = { search: "Search", fetch: "Read", map: "Map", extract: "Pull fields", crawl: "Crawl", diff: "Compare" };
function Health() {
 const health = useQuery({ contract: rpcContract, method: "health", input: {} });
 const prune = useMutation({ contract: rpcContract, method: "prune" });
 const [pruned, setPruned] = useState<string | null>(null);
 if (health.error) return <ErrorLine error={health.error} />;
 if (!health.data) return <Loading label="Checking Forage…" />;
 const h = health.data;
 const maxOp = Math.max(1, ...h.last24h.byOperation.map((o) => o.total));
 return <>
  <div><h1 className="text-xl font-semibold tracking-tight">Health and storage</h1><p className="mt-1 text-sm text-muted-foreground">How Forage searches and reads, and what it keeps. This view never shows queries, addresses or page text.</p></div>
  <Section title="Search and readers">
   <div className="overflow-hidden rounded-xl border border-border bg-card">{h.providers.map((p) => <div key={p.id} className="grid grid-cols-[1rem_8.5rem_7rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-3.5 py-2 text-[12.5px] first:border-t-0">
    <span className={p.state === "ready" ? "text-success" : "text-subtle-foreground"}><Glyph name={p.state === "ready" ? "check-circle" : "skip"} /></span>
    <span className="font-medium">{p.label}</span><span className="text-xs text-muted-foreground">{{ search: "Search", reader: "Reader", crawl: "Crawl" }[p.kind]}</span>
    <span className="truncate text-xs text-muted-foreground">{p.note}</span><Tag tone={STATE_TAG[p.state][0]}>{STATE_TAG[p.state][1]}</Tag>
   </div>)}</div>
  </Section>
  <Section title="Policy">
   <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
    {[
     ["Profile", h.policy.profile === "auto" ? "Auto" : h.policy.profile, "Each call picks providers within the ceiling"],
     ["Privacy ceiling", h.policy.privacy === "private" ? "Private" : "Standard", h.policy.privacy === "private" ? "Only SearXNG and this machine" : "Private would allow SearXNG and this machine only"],
     ["Paid fallback", h.policy.paidFallback ? "On" : "Off", h.policy.paidFallback ? "Paid providers can answer when free ones fail" : "A key alone never sends a billable request"],
     ["Private networks", h.policy.privateNetwork ? "Allowed" : "Blocked", h.policy.privateNetwork ? "Direct reads can reach internal addresses" : "Internal addresses are never read"],
     ["Signed-in pages", h.policy.restrictedCapture ? "Kept in their thread" : "Not kept", h.policy.restrictedCapture ? "Restricted capture is on" : "Restricted capture is off"],
     ["Activity log", h.policy.activityLog ? "On, 30 days" : "Off", h.policy.customThreads === 1 ? "1 thread has its own web research policy" : h.policy.customThreads ? `${h.policy.customThreads} threads have their own web research policy` : "Every thread uses these settings"],
    ].map(([k, v, d]) => <div key={k} className="grid gap-0.5 rounded-xl border border-border bg-card px-3.5 py-2.5"><span className="text-xs text-muted-foreground">{k}</span><b className="text-sm font-semibold">{v}</b><span className="text-[11.5px] text-subtle-foreground">{d}</span></div>)}
   </div>
   <p className="text-xs text-muted-foreground">Change these in Settings, under Plugins, Forage.</p>
  </Section>
  <Section title="Last 24 hours">
   {h.last24h.total === 0 ? <p className="text-sm text-muted-foreground">Forage has not run since it last started.</p> : <div className="grid gap-3 md:grid-cols-2">
    <div className="grid content-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3">
     <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">{[["bg-success", h.last24h.success], ["bg-warning", h.last24h.partial], ["bg-destructive", h.last24h.failure], ["bg-subtle-foreground", h.last24h.cancelled]].filter(([, n]) => Number(n) > 0).map(([c, n]) => <span key={String(c)} className={String(c)} style={{ flex: Number(n) }} />)}</div>
     <p className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{h.last24h.success} worked</span><span>{h.last24h.partial} partly worked</span><span>{h.last24h.failure} failed</span>{h.last24h.cancelled > 0 && <span>{h.last24h.cancelled} cancelled</span>}</p>
     <div className="grid gap-1">{h.last24h.byOperation.map((o) => <div key={o.operation} className="grid grid-cols-[5.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs"><span>{OP_LABEL[o.operation] ?? o.operation}</span><Bar value={o.total} max={maxOp} running /><span className="text-right text-muted-foreground">{o.total}</span></div>)}</div>
    </div>
    <div className="grid content-start gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
     <p className="text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Failures</p>
     {h.last24h.failures.length === 0 ? <p className="text-xs text-muted-foreground">None.</p> : h.last24h.failures.map((f, i) => <div key={i} className="grid grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-2 text-xs">
      <span className="mt-px text-destructive-text"><Glyph name="x-circle" /></span><span><b className="font-semibold">{OP_LABEL[f.operation] ?? f.operation}</b>{f.provider ? ` · ${f.provider}` : ""}<br /><span className="text-muted-foreground">{f.reason}</span></span><span className="text-subtle-foreground">{when(f.at)}</span>
     </div>)}
    </div>
   </div>}
  </Section>
  <Section title="Storage" action={<Button icon="trash" disabled={prune.isPending} onClick={() => { void prune.mutate({}).then((r) => setPruned(`Pruned ${plural(r.snapshots, "version")}, ${plural(r.sources, "source")} and ${plural(r.activity, "log entry", "log entries")}, freeing ${size(r.bytes)}.`), () => undefined); }}>{prune.isPending ? "Pruning…" : "Prune now"}</Button>}>
   <div className="grid gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[12.5px]"><span className="block h-2.5 overflow-hidden rounded-full bg-surface-recessed"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (h.storage.bytes / h.storage.maxBytes) * 100)}%` }} /></span><span><b className="font-semibold">{size(h.storage.bytes)}</b> of {size(h.storage.maxBytes)}</span></div>
    {h.storage.byThread.map((row, i) => <div key={i} className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)_4rem] items-center gap-3 text-xs"><span className="truncate">{row.title}</span><Bar value={row.bytes} max={h.storage.byThread[0]?.bytes ?? 1} /><span className="text-right text-muted-foreground">{size(row.bytes)}</span></div>)}
    <p className="text-xs text-muted-foreground">A thread's research is kept for 30 days after its last use, and sources shared with a project for 180 days. Pages a running crawl depends on are never pruned. Deleting a thread deletes its research.</p>
    {pruned && <Notice tone="good" icon="check-circle">{pruned}</Notice>}
    <ErrorLine error={prune.error} />
   </div>
  </Section>
 </>;
}
