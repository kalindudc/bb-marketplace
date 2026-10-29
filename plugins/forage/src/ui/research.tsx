import { useEffect, useRef, useState } from "react";
import {
 experimental_usePluginId as usePluginId, experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery, useSdk,
 type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { deleteScopeConfirmation } from "../contract.ts";
import type { ThreadScope } from "../research/activity.ts";
import type { ThreadPolicy } from "../research/policy.ts";
import type { SourceScope } from "../web/contracts.ts";
import { ActivityList } from "./activity.tsx";
import { CheckInSources } from "./check.tsx";
import { rpcContract } from "./contract.ts";
import { CrawlsView } from "./crawls.tsx";
import { Button, cx, day, ErrorLine, Glyph, IconButton, Loading, Menu, MenuItem, Notice, plural, size, Spinner } from "./kit.tsx";
import { takeResearchRequest, useOpenResearch, useResearchRequest, type ResearchRequest } from "./nav-store.ts";
import { Back, Reader } from "./reader.tsx";
import { SourcesList } from "./sources.tsx";

type View = "activity" | "sources" | "crawls";
type Drill = { kind: "reader"; scope: SourceScope; sourceId: string; snapshotId?: string; lines?: [number, number]; compare?: boolean; from: View | "check"; seq?: number } | { kind: "check"; text: string };
const PROFILES = [["auto", "Auto", "Your Forage settings decide"], ["docs", "Docs", "Prefer documentation sites"], ["fresh", "Fresh", "Prefer recent pages"], ["private", "Private", "SearXNG and this machine only"]] as const;
export const POLICY_LABEL: Record<ThreadPolicy, string> = { settings: "Use Forage settings", docs: "Docs first", fresh: "Fresh results", private: "Private", off: "Off" };
const looksLikeUrl = (text: string) => /^https?:\/\/\S+$/iu.test(text) || /^[\w-]+(\.[\w-]+)+\/\S*$/u.test(text);

// A thread never changes project, so remounting a tab does not need to ask again.
const projects = new Map<string, string>();
export function useThreadProject(threadId: string): { projectId: string | null; error: boolean } {
 const sdk = useSdk();
 const [state, setState] = useState<{ projectId: string | null; error: boolean }>(() => ({ projectId: projects.get(threadId) ?? null, error: false }));
 useEffect(() => {
  let active = true;
  const abort = new AbortController();
  const known = projects.get(threadId);
  if (known) { setState({ projectId: known, error: false }); return () => { active = false; }; }
  setState({ projectId: null, error: false });
  void sdk.threads.get({ threadId, signal: abort.signal }).then((t) => { projects.set(threadId, t.projectId); if (active) setState({ projectId: t.projectId, error: false }); }, () => { if (active) setState({ projectId: null, error: true }); });
  return () => { active = false; abort.abort(); };
 }, [sdk, threadId]);
 return state;
}

export function ResearchTab({ threadId }: { threadId: string }) {
 const { projectId, error } = useThreadProject(threadId);
 if (error) return <p role="alert" className="p-4 text-xs text-destructive-text">This thread's research is unavailable. Reopen the tab to try again.</p>;
 if (!projectId) return <Loading label="Loading research…" />;
 return <ResearchView scope={{ kind: "thread", projectId, threadId }} variant="panel" canQuote />;
}

export function CheckTab({ threadId, params }: ExperimentalThreadActionTabProps) {
 const { projectId, error } = useThreadProject(threadId);
 const initial = params && typeof params === "object" && !Array.isArray(params) && typeof (params as Record<string, unknown>).text === "string" ? String((params as Record<string, unknown>).text) : "";
 const [text, setText] = useState(initial);
 const [draft, setDraft] = useState("");
 useEffect(() => { setText(initial); }, [initial]);
 const [drill, setDrill] = useState<{ sourceId: string; snapshotId: string; lines: [number, number] } | null>(null);
 const openResearch = useOpenResearch();
 if (error) return <p role="alert" className="p-4 text-xs text-destructive-text">This thread's research is unavailable.</p>;
 if (!projectId) return <Loading />;
 const scope: ThreadScope = { kind: "thread", projectId, threadId };
 if (!text) return <div className="grid gap-2 p-3 text-xs">
  <p className="flex items-center gap-1.5 font-semibold"><Glyph name="forage" />Check in sources</p>
  <p className="text-muted-foreground">Paste a sentence to see where this thread's kept pages say it. You can also select text in a reply and choose Check in sources.</p>
  <textarea aria-label="Text to check" value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className="w-full resize-y rounded-lg border border-border bg-card p-2 text-[12.5px] text-foreground outline-none focus:border-ring" />
  <div><Button variant="primary" disabled={!draft.trim()} onClick={() => setText(draft.trim())}>Check</Button></div>
 </div>;
 return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
  {drill ? <Reader scope={scope} sourceId={drill.sourceId} snapshotId={drill.snapshotId} lines={drill.lines} backLabel="Check in sources" onBack={() => setDrill(null)} onCheck={(next) => { setText(next); setDrill(null); }} canQuote />
   : <div className="min-h-0 flex-1 overflow-y-auto pt-2"><CheckInSources scope={scope} text={text} canQuote onOpen={(sourceId, snapshotId, lines) => setDrill({ sourceId, snapshotId, lines })} onSearched={() => { openResearch(threadId, { view: "activity" }); }} /></div>}
 </div>;
}

function Header({ scope, variant }: { scope: ThreadScope; variant: "panel" | "page" }) {
 const summary = useQuery({ contract: rpcContract, method: "researchSummary", input: { projectId: scope.projectId, threadId: scope.threadId } });
 const clear = useMutation({ contract: rpcContract, method: "clearActivity" });
 const wipe = useMutation({ contract: rpcContract, method: "deleteScope" });
 const share = useMutation({ contract: rpcContract, method: "copySourceToProject" });
 const cited = useQuery({ contract: rpcContract, method: "listResearchSources", input: { scope, filter: "cited", limit: 200 } });
 const pluginId = usePluginId();
 const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);
 const [note, setNote] = useState<string | null>(null);
 const s = summary.data;
 function exportAll() {
  const a = document.createElement("a");
  a.href = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/sources-export?request=${encodeURIComponent(JSON.stringify({ scope, includeRestricted: false }))}`;
  a.download = "forage-sources.ndjson"; a.click();
 }
 const [sharing, setSharing] = useState(false);
 async function shareCited() {
  const candidates = (cited.data?.sources ?? []).filter((source) => source.network === "public" && !source.credentialed && source.status !== "failed");
  if (candidates.length === 0) { setNote("No cited public sources to share yet."); return; }
  setSharing(true); setNote(`Sharing ${plural(candidates.length, "cited source")}…`);
  let n = 0;
  for (const source of candidates) await share.mutate({ projectId: scope.projectId, threadId: scope.threadId, sourceId: source.id }).then(() => { n++; }, () => undefined);
  setSharing(false);
  setNote(n === candidates.length ? `Shared ${plural(n, "cited source")} with the project.` : `Shared ${n} of ${plural(candidates.length, "cited source")}; the rest could not be copied.`);
 }
 return <div className="grid shrink-0 gap-1.5 px-3 pb-1.5 pt-2.5">
  <div className="flex min-w-0 items-center gap-2">
   {variant === "panel" && <b className="text-sm font-semibold">Research</b>}
   <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
    {s ? <>{s.searches > 0 && <>{plural(s.searches, "search", "searches")} · </>}{plural(s.reads, "page")} read · {plural(s.sources, "source")}{s.running.length > 0 && <> · <span className="inline-flex items-center gap-1 text-primary"><Spinner className="size-3" />{plural(s.running.length, "crawl")} running</span></>}</> : summary.error ? "" : "Loading…"}
   </span>
   <span className="flex-1" />
   <Menu width="w-72" trigger={({ toggle }) => <IconButton icon="more" label="More for this thread's research" onClick={toggle} />}>
    {(close) => <>
     <MenuItem icon="download" label="Export this thread's sources" detail="One NDJSON file with the kept text of public sources" onSelect={() => { close(); exportAll(); }} />
     <MenuItem icon="share" label="Share cited sources with the project" detail="Copies public sources a reply cited, so other threads can read them" disabled={sharing} onSelect={() => { close(); void shareCited(); }} />
     <div className="my-1 h-px bg-border" />
     <MenuItem icon="activity" label="Clear the activity log" detail="Removes this thread's searches and reads from Activity; sources stay" onSelect={() => { close(); setConfirm("clear"); }} />
     <MenuItem icon="trash" danger label="Delete this thread's research…" detail="Sources, versions, crawls and the activity log" onSelect={() => { close(); setConfirm("delete"); }} />
    </>}
   </Menu>
  </div>
  <ErrorLine error={summary.error ?? clear.error ?? wipe.error} />
  {s && s.policy !== "settings" && <Notice tone={s.policy === "off" ? "warn" : "neutral"} icon={s.policy === "off" ? "ban" : "shield"}>
   {s.policy === "off" ? "Web research is off in this thread, for the agent and for searches here. Turn it on from the thread menu." : <>Web research in this thread: <b className="font-semibold">{POLICY_LABEL[s.policy]}</b>. Change it from the thread menu.</>}
  </Notice>}
  {confirm === "clear" && <Notice tone="warn" icon="activity" action={<span className="flex gap-1"><Button className="h-6" disabled={clear.isPending} onClick={() => { void clear.mutate({ scope }).then((r) => { setConfirm(null); setNote(`Cleared ${plural(r.removed, "entry", "entries")}.`); }, () => undefined); }}>Clear</Button><Button variant="ghost" className="h-6" onClick={() => setConfirm(null)}>Keep</Button></span>}>Clear this thread's activity log? Kept sources and crawls stay.</Notice>}
  {confirm === "delete" && <Notice tone="bad" icon="trash" action={<span className="flex gap-1"><Button variant="danger" className="h-6" disabled={wipe.isPending} onClick={() => { void wipe.mutate({ scope, confirm: deleteScopeConfirmation(scope) }).then(() => setConfirm(null), () => undefined); }}>Delete</Button><Button variant="ghost" className="h-6" onClick={() => setConfirm(null)}>Keep</Button></span>}>Delete {s ? plural(s.sources, "source") : "every source"}, their versions, crawls and the activity log from this thread? Running crawls stop.</Notice>}
  {note && <Notice icon="info" action={<IconButton icon="x" label="Dismiss" onClick={() => setNote(null)} />}>{note}</Notice>}
 </div>;
}

function AskBar({ scope, focusSeq, onDone }: { scope: ThreadScope; focusSeq: number; onDone(): void }) {
 const summary = useQuery({ contract: rpcContract, method: "researchSummary", input: { projectId: scope.projectId, threadId: scope.threadId } });
 const off = summary.data?.policy === "off";
 const [text, setText] = useState("");
 const [profile, setProfile] = useState<(typeof PROFILES)[number][0]>("auto");
 const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
 const run = useMutation({ contract: rpcContract, method: "run" });
 const input = useRef<HTMLInputElement>(null);
 useEffect(() => { if (focusSeq > 0) input.current?.focus(); }, [focusSeq]);
 useEffect(() => {
  if (!message?.ok) return;
  const t = setTimeout(() => setMessage(null), 4000);
  return () => clearTimeout(t);
 }, [message]);
 async function submit() {
  const value = text.trim();
  if (!value) return;
  const url = looksLikeUrl(value) ? (/^https?:\/\//iu.test(value) ? value : `https://${value}`) : null;
  try {
   const out = await run.mutate({ projectId: scope.projectId, threadId: scope.threadId, operation: url ? "read" : "search", ...(url ? { url } : { query: value.slice(0, 500) }), via: "tab", ...(profile !== "auto" ? { profile } : {}) });
   setMessage({ ok: out.ok, text: out.message });
   if (out.ok) { setText(""); onDone(); }
  } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : "That did not run." }); }
 }
 return <div className="grid shrink-0 gap-1 px-3 pb-2">
  <div className="flex gap-1.5">
   <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-muted-foreground focus-within:border-ring">
    {run.isPending ? <Spinner /> : <Glyph name="search" />}
    <input ref={input} aria-label="Search the web or paste a link" value={text} disabled={run.isPending || off} onChange={(e) => { setText(e.target.value); setMessage(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
     placeholder={off ? "Web research is off in this thread" : "Search the web or paste a link"} className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-subtle-foreground" />
   </label>
   <Menu width="w-60" trigger={({ toggle }) => <Button className="h-8" onClick={toggle} aria-label="Search profile">{PROFILES.find((p) => p[0] === profile)![1]}<Glyph name="chevron-down" className="size-3" /></Button>}>
    {(close) => <>
     <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Profile for this search</p>
     {PROFILES.map(([id, label, detail]) => <MenuItem key={id} checked={profile === id} label={label} detail={detail} onSelect={() => { setProfile(id); close(); }} />)}
     <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">A profile can narrow your settings, never widen them.</p>
    </>}
   </Menu>
  </div>
  {text && !message && <p className="flex items-start gap-1 text-[11px] text-muted-foreground"><Glyph name="info" className="mt-px size-3" />Press Enter. It runs in this thread with no model turn; the agent sees what you find when you quote it.</p>}
  {message && <p role={message.ok ? "status" : "alert"} className={cx("text-[11px]", message.ok ? "text-muted-foreground" : "text-destructive-text")}>{message.text}</p>}
 </div>;
}

function Footer({ scope }: { scope: ThreadScope }) {
 const summary = useQuery({ contract: rpcContract, method: "researchSummary", input: { projectId: scope.projectId, threadId: scope.threadId } });
 const s = summary.data;
 if (!s) return null;
 return <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
  <Glyph name="clock" className="size-3" />
  <span className="truncate">Kept for 30 days after each use{s.expiresAt ? ` · oldest expires ${day(s.expiresAt)}` : ""}{s.bytes ? ` · ${size(s.bytes)}` : ""}{!s.activityLog ? " · activity log off" : ""}</span>
 </div>;
}

// bb remounts a tab when the window crosses the compact breakpoint; keep each thread's place for the session.
const places = new Map<string, { view: View; side: "sources" | "crawls"; drill: Drill | null }>();
export const resetResearchPlaces = () => places.clear();
function usePlace<K extends "view" | "side" | "drill">(key: string, field: K, initial: (typeof places extends Map<string, infer P> ? P : never)[K]) {
 const [value, set] = useState(() => places.get(key)?.[field] ?? initial);
 const update = (next: typeof value) => {
  set(next);
  places.set(key, { view: "activity", side: "sources", drill: null, ...places.get(key), [field]: next });
 };
 return [value, update] as const;
}

export function ResearchView({ scope, variant, canQuote }: { scope: ThreadScope; variant: "panel" | "page"; canQuote: boolean }) {
 const placeKey = `${variant}:${scope.threadId}`;
 const [view, setView] = usePlace(placeKey, "view", "activity");
 const [side, setSide] = usePlace(placeKey, "side", "sources");
 const [drill, setDrill] = usePlace(placeKey, "drill", null);
 const [crawlFocus, setCrawlFocus] = useState<string | null>(null);
 const [openCrawl, setOpenCrawl] = useState<string | null>(null);
 const [focusSeq, setFocusSeq] = useState(0);
 const summary = useQuery({ contract: rpcContract, method: "researchSummary", input: { projectId: scope.projectId, threadId: scope.threadId } });
 const request = useResearchRequest(scope.threadId);
 const seen = useRef(0);
 useEffect(() => {
  const next = takeResearchRequest(scope.threadId, seen.current);
  if (!next) return;
  seen.current = next.seq;
  apply(next.request);
 }, [request?.seq, scope.threadId]);
 function apply(r: ResearchRequest) {
  if (r.view === "reader") { setDrill({ kind: "reader", scope: r.scope, sourceId: r.sourceId, ...(r.snapshotId ? { snapshotId: r.snapshotId } : {}), ...(r.lines ? { lines: r.lines } : {}), from: "sources", seq: Date.now() }); return; }
  if (r.view === "check") { setDrill({ kind: "check", text: r.text }); return; }
  setDrill(null);
  if (r.view === "search") { setView("activity"); setFocusSeq((n) => n + 1); return; }
  setView(r.view); if (r.view !== "activity") setSide(r.view);
 }
 const openSource = (sourceScope: SourceScope, sourceId: string, from: View | "check" = variant === "page" ? "sources" : view) => setDrill({ kind: "reader", scope: sourceScope, sourceId, from });
 const showCrawls = (jobId?: string) => { setDrill(null); setCrawlFocus(jobId ?? null); setView("crawls"); setSide("crawls"); };
 const showPages = (jobId: string) => { setDrill(null); setOpenCrawl(jobId); setView("sources"); setSide("sources"); };
 const s = summary.data;
 const activity = <ActivityList scope={scope} onOpenSource={(id) => openSource(scope, id, "activity")} onOpenCrawls={showCrawls} onCompare={(id) => setDrill({ kind: "reader", scope, sourceId: id, compare: true, from: "activity" })} />;
 const sources = <SourcesList scope={scope} selected={drill?.kind === "reader" ? drill.sourceId : null} onOpen={(sc, id) => openSource(sc, id, "sources")} initialCrawl={openCrawl} />;
 const crawls = <CrawlsView scope={scope} onShowPages={showPages} focus={crawlFocus} />;
 const drillView = drill?.kind === "reader"
  ? <Reader key={`${drill.sourceId}:${drill.snapshotId ?? ""}`} scope={drill.scope} sourceId={drill.sourceId} {...(drill.snapshotId ? { snapshotId: drill.snapshotId } : {})} {...(drill.lines ? { lines: drill.lines } : {})} compare={Boolean(drill.compare)} {...(drill.seq ? { targetSeq: drill.seq } : {})}
   backLabel={drill.from === "check" ? "Check in sources" : { activity: "Activity", sources: "Sources", crawls: "Crawls" }[drill.from]} onBack={() => setDrill(null)} onCheck={(text) => setDrill({ kind: "check", text })} canQuote={canQuote} />
  : drill?.kind === "check" ? <div className="flex min-h-0 flex-1 flex-col"><Back label={variant === "page" ? "Sources" : { activity: "Activity", sources: "Sources", crawls: "Crawls" }[view]} onBack={() => setDrill(null)} />
   <div className="min-h-0 flex-1 overflow-y-auto"><CheckInSources scope={scope} text={drill.text} canQuote={canQuote} onOpen={(sourceId, snapshotId, lines) => setDrill({ kind: "reader", scope, sourceId, snapshotId, lines, from: "check", seq: Date.now() })} onSearched={() => { setDrill(null); setView("activity"); }} /></div></div>
  : null;
 if (variant === "page") return <div className="grid min-h-0 flex-1 grid-cols-2">
  <section aria-label="Activity" className="flex min-h-0 flex-col border-r border-border">
   <Header scope={scope} variant="page" />
   <AskBar scope={scope} focusSeq={focusSeq} onDone={() => undefined} />
   <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">{activity}</div>
   <Footer scope={scope} />
  </section>
  <section aria-label="Sources" className="flex min-h-0 flex-col">
   {drillView ?? <>
    <div className="shrink-0 px-3 pb-2 pt-2.5"><TabSwitch value={side} counts={s} onChange={(v) => setSide(v as "sources" | "crawls")} options={["sources", "crawls"]} /></div>
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">{side === "sources" ? sources : crawls}</div>
   </>}
  </section>
 </div>;
 return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
  {drillView ?? <>
   <Header scope={scope} variant="panel" />
   <AskBar scope={scope} focusSeq={focusSeq} onDone={() => setView("activity")} />
   <div className="shrink-0 border-b border-border px-3 pb-2"><TabSwitch value={view} counts={s} onChange={(v) => setView(v)} options={["activity", "sources", "crawls"]} /></div>
   <div className="min-h-0 flex-1 overflow-y-auto">{view === "activity" ? activity : view === "sources" ? sources : crawls}</div>
   <Footer scope={scope} />
  </>}
 </div>;
}

function TabSwitch<T extends View>({ value, options, onChange, counts }: { value: T; options: readonly T[]; onChange(v: T): void; counts: { sources: number; shared: number; running: unknown[] } | undefined }) {
 return <div role="tablist" aria-label="Research views" className="flex gap-0.5 rounded-lg bg-surface-recessed p-0.5">
  {options.map((id) => <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
   className={cx("inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs", value === id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
   {{ activity: "Activity", sources: "Sources", crawls: "Crawls" }[id]}
   {id === "sources" && counts && <span className="text-[11px] text-subtle-foreground">{counts.sources + counts.shared}</span>}
   {id === "crawls" && counts && counts.running.length > 0 && <span className="size-1.5 rounded-full bg-primary" aria-label={`${plural(counts.running.length, "crawl")} running`} />}
  </button>)}
 </div>;
}
