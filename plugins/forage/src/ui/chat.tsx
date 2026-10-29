import { useEffect, useState } from "react";
import {
 experimental_InfoList as InfoList, experimental_InfoListRow as InfoListRow, experimental_InfoSection as InfoSection, experimental_useRpcKeyedQuery as useKeyedQuery, experimental_useRpcMutation as useMutation,
 experimental_useRpcQuery as useQuery, useComposer,
 type ExperimentalPluginBrowserToolbarActionProps, type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps, type ExperimentalThreadInfoProps,
 type PluginCommandRegistration, type PluginMessageActionRegistration, type PluginMessageDirectiveProps, type PluginThreadActionRegistration, type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { THREAD_POLICIES, type ThreadPolicy } from "../research/policy.ts";
import type { ThreadScope } from "../research/activity.ts";
import { describe } from "./activity.tsx";
import { rpcContract } from "./contract.ts";
import { Bar, Button, cx, day, Glyph, hostOf, Menu, plainText, plural, shortUrl, Spinner, Tile, when } from "./kit.tsx";
import { CHECK_TAB_ID, canOpenFromCommand, openFromCommand, registerOpener, useOpenResearch } from "./nav-store.ts";
import { POLICY_LABEL, useThreadProject } from "./research.tsx";

const SNAPSHOT_ID = /^[\w.-]{1,200}$/u;
// bb draws a message again whenever it scrolls back into view; record each citation once per app session.
const noted = new Set<string>();
function parseLines(value: string | undefined): [number, number] | null {
 const match = /^\s*(\d{1,7})\s*(?:[-–]\s*(\d{1,7}))?\s*$/u.exec(value ?? "");
 if (!match) return null;
 const a = Number(match[1]); const b = Number(match[2] ?? match[1]);
 if (a < 1 || b < 1) return null;
 return [Math.min(a, b), Math.min(Math.max(a, b), Math.min(a, b) + 40)];
}

function useSummary(projectId: string | null, threadId: string) {
 return useQuery({ contract: rpcContract, method: "researchSummary", input: { projectId: projectId ?? "pending", threadId }, enabled: Boolean(projectId) });
}

// ::forage-cite{snapshot="…" lines="15-19"}, or find="a short phrase" instead of lines.
export function CiteDirective({ attributes, message }: PluginMessageDirectiveProps) {
 const snapshotId = attributes.snapshot ?? "";
 const lines = parseLines(attributes.lines);
 const find = (attributes.find ?? "").trim().slice(0, 200);
 const known = useThreadProject(message.threadId);
 const projectId = message.projectId ?? known.projectId;
 const valid = SNAPSHOT_ID.test(snapshotId) && Boolean(lines || find);
 const scope: ThreadScope | null = projectId ? { kind: "thread", projectId, threadId: message.threadId } : null;
 const read = useQuery({ contract: rpcContract, method: "readLines", input: { scope: scope ?? { kind: "thread", projectId: "pending", threadId: message.threadId }, snapshotId: valid ? snapshotId : "invalid", startLine: lines?.[0] ?? 1, ...(lines ? { endLine: lines[1] } : {}), ...(find && !lines ? { find } : {}) }, enabled: Boolean(scope && valid) });
 const note = useMutation({ contract: rpcContract, method: "noteCitation" });
 const open = useOpenResearch();
 const data = read.data?.status === "ok" ? read.data : null;
 useEffect(() => {
  if (!data || !scope) return;
  const key = `${message.id}:${data.snapshotId}:${data.startLine}-${data.endLine}`;
  if (noted.has(key)) return;
  noted.add(key);
  void note.mutate({ projectId: scope.projectId, threadId: scope.threadId, messageId: message.id, snapshotId: data.snapshotId, startLine: data.startLine, endLine: Math.max(data.startLine, data.endLine) }).catch(() => { noted.delete(key); });
 }, [data?.snapshotId, data?.startLine, data?.endLine]);
 if (!valid) return <code className="text-xs text-muted-foreground">{`::forage-cite{${Object.entries(attributes).map(([k, v]) => `${k}="${v}"`).join(" ")}}`}</code>;
 if (read.data?.status === "not-visible" || read.error) return <div className="my-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Glyph name="quote" />A cited source that this thread no longer keeps.</div>;
 if (read.data?.status === "missing") return <div className="my-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Glyph name="warning" />{find && !lines ? `The cited phrase “${find}” is not in the kept page.` : `The cited lines are not in the kept page, which has ${plural(read.data.totalLines, "line")}.`}</div>;
 if (!data) return <div className="my-2 h-[74px] animate-pulse rounded-lg border border-border bg-surface-recessed/50" aria-label="Loading the cited source" />;
 const range = data.startLine === data.endLine ? `line ${data.startLine}` : `lines ${data.startLine}–${data.endLine}`;
 const quote = plainText(data.lines.join("\n"));
 return <button type="button" tabIndex={0} data-forage-cite={`${data.snapshotId}:${data.startLine}-${Math.max(data.startLine, data.endLine)}`}
  onClick={() => { if (scope) open(scope.threadId, { view: "reader", scope, sourceId: data.sourceId, snapshotId: data.snapshotId, lines: [data.startLine, Math.max(data.startLine, data.endLine)] }); }}
  className={cx("my-2 grid w-full cursor-pointer gap-1 rounded-lg border border-l-[3px] border-border bg-card py-2 pl-3 pr-2.5 text-left text-[12.5px] hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", data.latest ? "border-l-success" : "border-l-warning")}>
  <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"><Tile label={hostOf(data.url)} className="size-[18px]" /><b className="truncate font-semibold">{data.title || shortUrl(data.url)}</b><span className="truncate text-xs text-muted-foreground">{hostOf(data.url)}</span><span className="flex-1" /><span className="text-[11px] text-subtle-foreground">{range}</span></span>
  <span className="line-clamp-2 leading-snug text-foreground">“{quote.length > 320 ? `${quote.slice(0, 319)}…` : quote}”</span>
  <span className="flex items-center gap-1 text-[11px] text-subtle-foreground">{data.latest ? `Read ${when(data.fetchedAt)} · kept in this thread` : <><Glyph name="diff" className="size-3" />From the version read {day(data.fetchedAt)}; the page has changed since</>}</span>
 </button>;
}

export function SourcesDirective({ message }: PluginMessageDirectiveProps) {
 const known = useThreadProject(message.threadId);
 const projectId = message.projectId ?? known.projectId;
 const summary = useSummary(projectId, message.threadId);
 const open = useOpenResearch();
 const s = summary.data;
 if (!s) return null;
 return <div className="my-2 flex items-center gap-2 rounded-lg bg-surface-recessed px-2.5 py-1.5 text-xs text-muted-foreground">
  <Glyph name="forage" /><b className="font-semibold text-foreground">Sources</b>
  <span className="truncate">{s.cited.toLocaleString()} cited · {s.sources.toLocaleString()} kept{s.running.length ? ` · ${plural(s.running.length, "crawl")} running` : ""}</span>
  <span className="flex-1" /><Button variant="ghost" className="h-6" onClick={() => open(message.threadId, { view: "sources" })}>Open Research<Glyph name="arrow-right" className="size-3" /></Button>
 </div>;
}

const hasResearch = (s: { sources: number; searches: number; running: unknown[]; policy: ThreadPolicy } | undefined) => Boolean(s && (s.sources > 0 || s.searches > 0 || s.running.length > 0 || s.policy !== "settings"));

export function HeaderChip({ threadId, projectId, isCompactViewport }: PluginThreadHeaderActionProps) {
 const summary = useSummary(projectId, threadId);
 const open = useOpenResearch();
 useEffect(() => registerOpener(threadId, (request) => open(threadId, request)), [threadId, open]);
 const s = summary.data;
 if (isCompactViewport || !s || !hasResearch(s)) return null;
 const running = s.running[0];
 return <Menu width="w-80" trigger={({ toggle, open: isOpen }) => <button type="button" onClick={toggle} aria-expanded={isOpen} aria-label={`Research in this thread: ${plural(s.sources, "source")}${running ? ", a crawl is running" : ""}`} title="Research in this thread"
  className={cx("inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs", isOpen ? "border-ring text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
  <Glyph name="forage" /><span>{s.sources.toLocaleString()}</span>{running && <span className="size-1.5 rounded-full bg-primary" />}{s.policy === "off" && <Glyph name="ban" className="size-3" />}
 </button>}>
  {(close) => <div className="grid gap-1.5 p-1.5 text-xs">
   <p className="flex items-center gap-1.5 font-semibold"><Glyph name="forage" />Research in this thread</p>
   <p className="text-muted-foreground">{plural(s.sources, "source")} · {s.cited.toLocaleString()} cited · {s.running.length ? `${plural(s.running.length, "crawl")} running` : "no crawls running"}{s.policy !== "settings" ? ` · ${POLICY_LABEL[s.policy]}` : ""}</p>
   {running && <div className="grid gap-1 rounded-lg bg-surface-recessed px-2.5 py-2"><span className="flex items-center gap-1.5"><Spinner className="size-3" /><span className="truncate">Crawling {shortUrl(running.rootUrl)}</span></span><Bar value={running.pagesUsed} max={running.maxPages} running /><span className="text-[11px] text-muted-foreground">{running.pagesUsed} of {running.maxPages} pages</span></div>}
   {s.latest.length > 0 && <><p className="pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Latest</p>
    {s.latest.map((entry) => <div key={entry.id} className="flex min-w-0 items-center gap-2"><span className="truncate">{describe(entry).title}</span><span className="flex-1" /><span className="text-[11px] text-subtle-foreground">{when(entry.finishedAt)}</span></div>)}</>}
   <div className="pt-1"><Button onClick={() => { close(); open(threadId, { view: "activity" }); }}>Open Research</Button></div>
  </div>}
 </Menu>;
}

export function useSegmentVisible({ threadId, projectId }: ExperimentalThreadContextSegmentInput): boolean {
 const summary = useSummary(projectId, threadId);
 return Boolean(summary.data && (summary.data.sources > 0 || summary.data.running.length > 0));
}

export function SegmentSummary({ threadId, projectId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
 const s = useSummary(projectId, threadId).data;
 if (!s) return null;
 const running = s.running[0];
 return <button type="button" aria-expanded={isExpanded} onClick={onToggle} title={isExpanded ? "Hide research" : "Show this thread's research"}
  className="inline-flex h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
  <Glyph name="forage" /><span className="truncate">Research <span className="font-medium text-foreground">{s.sources.toLocaleString()}</span>{running && <> · <span className="inline-flex items-center gap-1"><Spinner className="size-3" />crawl {running.pagesUsed}/{running.maxPages}</span></>}</span>
  <Glyph name={isExpanded ? "chevron-down" : "chevron-right"} className="size-3" />
 </button>;
}

export function SegmentDetails({ threadId, projectId, isExpanded }: ExperimentalThreadContextSegmentProps) {
 const s = useSummary(projectId, threadId).data;
 const open = useOpenResearch();
 const composer = useComposer();
 if (!isExpanded || !s) return null;
 return <div className="grid max-h-64 gap-0.5 overflow-y-auto py-1 text-xs">
  {s.running.map((job) => <button key={job.jobId} type="button" onClick={() => open(threadId, { view: "crawls" })} className="grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_7rem_auto] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover">
   <Glyph name="crawl" /><span className="truncate">Crawling {shortUrl(job.rootUrl)}</span><Bar value={job.pagesUsed} max={job.maxPages} running /><span className="text-[11px] text-muted-foreground">{job.pagesUsed} of {job.maxPages}</span>
  </button>)}
  {s.recentSources.length > 0 && <p className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Quote a recent source in your message</p>}
  {s.recentSources.slice(0, 4).map((source) => <div key={source.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-2 py-1 hover:bg-state-hover">
   <Tile label={hostOf(source.url)} className="size-4 text-[9px]" />
   <button type="button" className="min-w-0 cursor-pointer truncate text-left" onClick={() => open(threadId, { view: "reader", scope: { kind: "thread", projectId, threadId }, sourceId: source.id })}>{source.title || shortUrl(source.url)} <span className="text-subtle-foreground">{hostOf(source.url)}</span></button>
   <span className="text-[11px] text-subtle-foreground">{when(source.lastRetrievedAt ?? source.updatedAt)}</span>
   <Button className="h-6 px-2 text-[11px]" icon="quote" disabled={source.status === "failed"} onClick={() => { composer.insert(`— ${source.title || shortUrl(source.url)}, ${source.url} (Forage source ${source.id})`, { at: "end", block: true }); composer.focus(); }}>Quote</Button>
  </div>)}
  <button type="button" onClick={() => open(threadId, { view: "activity" })} className="mt-0.5 flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground">
   <Glyph name="forage" /><span className="min-w-0 flex-1 truncate">{s.searches > 0 && <>{plural(s.searches, "search", "searches")} · </>}{plural(s.reads, "page")} read</span><span className="shrink-0 text-foreground">Open Research</span><Glyph name="chevron-right" className="size-3" />
  </button>
 </div>;
}

export function InfoResearch({ threadId, projectId }: ExperimentalThreadInfoProps) {
 const s = useSummary(projectId, threadId).data;
 const cited = useQuery({ contract: rpcContract, method: "listResearchSources", input: { scope: { kind: "thread", projectId, threadId }, filter: "cited", limit: 5 } });
 const open = useOpenResearch();
 if (!s || !hasResearch(s)) return null;
 const running = s.running[0];
 const facts = [
  { key: "policy", icon: "shield", name: "Web research", value: POLICY_LABEL[s.policy] },
  { key: "cited", icon: "quote", name: "Cited in replies", value: s.cited.toLocaleString() },
  { key: "crawl", icon: "crawl", name: running ? `Crawling ${hostOf(running.rootUrl)}` : "Crawls running", value: running ? `${running.pagesUsed} of ${running.maxPages}` : "None" },
  { key: "kept", icon: "clock", name: "Oldest expires", value: s.expiresAt ? day(s.expiresAt) : "—" },
 ];
 return <InfoSection label="Research" count={s.sources}>
  <InfoList items={facts} getKey={(item) => item.key} limit={4}
   renderItem={(item) => <InfoListRow leading={<Glyph name={item.icon} />} name={item.name} trailing={<span className="whitespace-nowrap text-xs text-foreground">{item.value}</span>} onSelect={() => open(threadId, { view: item.key === "crawl" ? "crawls" : "activity" })} />} />
  {(cited.data?.sources.length ?? 0) > 0 && <InfoList items={cited.data!.sources} getKey={(item) => item.id} limit={3}
   renderItem={(item) => <InfoListRow leading={<Tile label={hostOf(item.url)} className="size-4 text-[9px]" />} name={item.title || shortUrl(item.url)} context={hostOf(item.url)} onSelect={() => open(threadId, { view: "reader", scope: { kind: "thread", projectId, threadId }, sourceId: item.id })} />} />}
 </InfoSection>;
}

export const policyAction: PluginThreadActionRegistration<{ policies: Record<string, ThreadPolicy>; searxng: boolean; set(threadId: string, policy: ThreadPolicy): Promise<unknown> }> = {
 id: "web-research",
 title: "Web research",
 icon: "forage/forage",
 group: "3_settings",
 order: 60,
 useData: ({ threadIds }) => {
  // Keyed by thread, so scrolling the sidebar fetches only threads not loaded yet.
  const policies = useKeyedQuery({ contract: rpcContract, method: "policies", keys: threadIds, enabled: threadIds.length > 0 });
  const config = useQuery({ contract: rpcContract, method: "researchConfig", input: {} });
  const mutation = useMutation({ contract: rpcContract, method: "setThreadPolicy" });
  return { policies: policies.data ?? {}, searxng: config.data?.searxng ?? false, set: (threadId, policy) => mutation.mutate({ threadId, policy }) };
 },
 item: ({ thread, data }) => {
  const current = data.policies[thread.id] ?? "settings";
  return {
   label: "Web research",
   detail: POLICY_LABEL[current],
   icon: "forage/forage",
   choices: {
    hint: "Applies from the agent's next turn. A thread can narrow Forage settings, never widen them.",
    items: THREAD_POLICIES.map((id) => ({ id, label: POLICY_LABEL[id], selected: id === current, ...(id === "private" && !data.searxng ? { disabled: true } : {}) })),
   },
   run: async ({ value }) => {
    if (value && (THREAD_POLICIES as readonly string[]).includes(value)) await data.set(thread.id, value as ThreadPolicy);
   },
  };
 },
};

export function BrowserSave({ threadId, url, isCompactViewport }: ExperimentalPluginBrowserToolbarActionProps) {
 const { projectId } = useThreadProject(threadId);
 const run = useMutation({ contract: rpcContract, method: "run" });
 const [state, setState] = useState<{ url: string; ok: boolean; message: string } | null>(null);
 const [show, setShow] = useState(false);
 useEffect(() => { setState(null); setShow(false); }, [url]);
 if (!/^https?:\/\//iu.test(url) || !projectId) return null;
 const saved = state?.url === url && state.ok;
 async function save() {
  try {
   const out = await run.mutate({ projectId: projectId!, threadId, operation: "read", url, via: "browser" });
   setState({ url, ok: out.ok, message: out.ok ? "Saved to this thread's research. Forage read its own public copy; the Browser's cookies and signed-in content were not used." : out.message });
  } catch (error) { setState({ url, ok: false, message: error instanceof Error ? error.message : "The page was not saved." }); }
  setShow(true);
 }
 return <div className="relative inline-flex">
  <button type="button" disabled={run.isPending} onClick={() => { if (saved) setShow(!show); else void save(); }} title={saved ? "Saved to this thread's research" : "Save this page to the thread's research"} aria-label={saved ? "Saved to research" : "Save to research"}
   className={cx("inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs", saved ? "border-transparent bg-success/15 text-success" : "border-border text-muted-foreground hover:text-foreground")}>
   {run.isPending ? <Spinner /> : <Glyph name={saved ? "check" : "forage"} />}{!isCompactViewport && (saved ? "Saved" : "Save to research")}
  </button>
  {show && state && <div role="status" className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-card p-2.5 text-xs shadow-lg">
   <p className={state.ok ? "text-foreground" : "text-destructive-text"}>{state.message}</p>
   <div className="mt-2 flex justify-end"><Button variant="ghost" className="h-6" onClick={() => setShow(false)}>Close</Button></div>
  </div>}
 </div>;
}

export const checkAction: PluginMessageActionRegistration = {
 id: "check-in-sources",
 title: "Check in sources",
 icon: "forage/forage",
 run: ({ selectedText, message, openPanel }) => {
  const text = (selectedText ?? message.text).trim().slice(0, 2000);
  if (text) openPanel({ actionId: CHECK_TAB_ID, title: "Check in sources", params: { text } });
 },
};

export function createCommands(): PluginCommandRegistration[] {
 return [
  { id: "open-research", title: "Forage: open this thread's research", isAvailable: ({ threadId }) => threadId !== null && canOpenFromCommand(threadId), run: ({ threadId }) => { if (threadId) openFromCommand(threadId, { view: "activity" }); } },
  { id: "search-web", title: "Forage: search the web in this thread", isAvailable: ({ threadId }) => threadId !== null && canOpenFromCommand(threadId), run: ({ threadId }) => { if (threadId) openFromCommand(threadId, { view: "search" }); } },
 ];
}
