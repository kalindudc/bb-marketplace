import { useState } from "react";
import { experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import type { CrawlJobView } from "../jobs/model.ts";
import type { ThreadScope } from "../research/activity.ts";
import { rpcContract } from "./contract.ts";
import { Bar, Button, cx, duration, ErrorLine, Glyph, IconButton, Loading, Notice, plural, shortUrl, size, Spinner, Tag, when } from "./kit.tsx";

const LIVE = new Set(["queued", "running", "cancelling"]);
export function crawlError(error: string | null): string | null {
 if (!error) return null;
 if (error.startsWith("FETCH_FAILED")) return "A page could not be read. Open its pages to see why.";
 if (/^Omitted \d+ frontier/u.test(error)) return "Some addresses were left out by its limits or path filter.";
 if (error.startsWith("Capture refused")) return "Forage would not keep a page: a privacy or storage setting refused it.";
 if (error.startsWith("REMOTE_START_UNKNOWN")) return "Firecrawl may have started this crawl but never confirmed it, so it cannot be resumed safely.";
 return error.replace(/^[A-Z][A-Z_]+: /u, "");
}
// The crawler matches path prefixes; a typed glob such as /docs/** means the prefix /docs.
export const pathPrefix = (value: string) => value.trim().replace(/\/?\*+$/u, "").replace(/(.)\/$/u, "$1") || "/";
const STOP_TEXT: Record<string, string> = {
 "page-limit": "Stopped at its page limit", "byte-limit": "Stopped at its data limit", "time-limit": "Stopped at its time limit",
 "frontier-empty": "Finished: no more links to follow", "storage-limit": "Stopped: Forage storage is full", cancelled: "Stopped", error: "Stopped after an error",
};

export function CrawlsView({ scope, onShowPages, focus }: { scope: ThreadScope; onShowPages(jobId: string): void; focus?: string | null }) {
 const jobs = useQuery({ contract: rpcContract, method: "listCrawlJobs", input: { scope, limit: 20 } });
 const [creating, setCreating] = useState(false);
 if (jobs.error) return <ErrorLine error={jobs.error} />;
 if (!jobs.data) return <Loading label="Loading crawls…" />;
 const live = jobs.data.jobs.filter((j) => LIVE.has(j.state));
 const done = jobs.data.jobs.filter((j) => !LIVE.has(j.state));
 return <div className="pb-4">
  <div className="flex items-center gap-2.5 px-3 pb-1 pt-2.5">
   {!creating && <Button icon="plus" onClick={() => setCreating(true)}>New crawl</Button>}
   <span className="text-[11.5px] text-muted-foreground">Crawls read a site in the background, within the limits shown.</span>
  </div>
  {creating && <NewCrawl scope={scope} onClose={() => setCreating(false)} />}
  {jobs.data.jobs.length === 0 && !creating && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No crawls in this thread. The agent starts one when it needs many pages of a site, or you can start one here.</p>}
  {live.length > 0 && <h4 className="px-3.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Running <span className="font-medium">{live.length}</span></h4>}
  <div className="grid gap-2 px-2.5">{live.map((job) => <CrawlCard key={job.id} scope={scope} job={job} onShowPages={onShowPages} focused={focus === job.id} />)}</div>
  {done.length > 0 && <h4 className="px-3.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Finished <span className="font-medium">{done.length}</span></h4>}
  <div className="grid gap-2 px-2.5">{done.map((job) => <CrawlCard key={job.id} scope={scope} job={job} onShowPages={onShowPages} focused={focus === job.id} />)}</div>
 </div>;
}

function Meter({ label, value, max, text, running }: { label: string; value: number; max: number; text: string; running: boolean }) {
 return <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_6.5rem] items-center gap-2 text-[11.5px]"><span className="text-muted-foreground">{label}</span><Bar value={value} max={max} running={running} /><span className="text-right">{text}</span></div>;
}

export function CrawlCard({ scope, job, onShowPages, focused }: { scope: ThreadScope; job: CrawlJobView; onShowPages(jobId: string): void; focused?: boolean }) {
 const cancel = useMutation({ contract: rpcContract, method: "cancelCrawlJob" });
 const resume = useMutation({ contract: rpcContract, method: "resumeCrawlJob" });
 const live = LIVE.has(job.state);
 const pages = useQuery({ contract: rpcContract, method: "listCrawlPages", input: { scope, jobId: job.id, limit: 8 }, enabled: live });
 const c = job.counts;
 const atLimit = job.stopReason === "page-limit";
 const nothing = !live && c.saved === 0;
 const state = live ? <Tag tone="info"><Spinner className="size-3" />{job.state === "cancelling" ? "Stopping" : job.state === "queued" ? "Waiting to start" : "Running"}</Tag>
  : job.state === "completed" ? <Tag tone="good">Finished</Tag> : job.state === "failed" ? <Tag tone="bad">Failed</Tag>
  : nothing ? <Tag tone="warn">Nothing saved</Tag>
  : <Tag tone={atLimit ? "warn" : "neutral"}>{job.state === "cancelled" ? "Stopped" : STOP_TEXT[job.stopReason ?? ""] ?? "Stopped"}</Tag>;
 const scopeLabel = job.includePaths.length ? `only paths starting with ${job.includePaths.join(", ")}` : job.includeSubdomains ? "including subdomains" : "the same site";
 return <article aria-label={`Crawl of ${shortUrl(job.rootUrl)}`} className={cx("grid gap-2 rounded-xl border bg-card px-3 py-2.5", live ? "border-primary/40" : "border-border", focused && "ring-2 ring-primary/40")}>
  <div className="flex min-w-0 items-center gap-2"><Glyph name="crawl" /><span className="truncate text-[13px] font-semibold">{shortUrl(job.rootUrl)}</span><span className="flex-1" />{state}</div>
  <p className="text-[11.5px] text-muted-foreground">Started {when(job.createdAt)} · {job.backend === "local" ? "on this machine" : "on Firecrawl"} · up to {plural(job.limits.maxDepth, "link")} deep · {plural(job.limits.concurrency, "page")} at a time · {scopeLabel}</p>
  {job.backend === "firecrawl" && <p className="text-[11px] text-muted-foreground">Firecrawl follows redirects on its own servers, so Forage cannot check each address it visits.</p>}
  <div className="grid gap-1">
   <Meter label="Pages" value={job.pagesUsed} max={job.limits.maxPages} text={`${job.pagesUsed} of ${job.limits.maxPages}`} running={live} />
   <Meter label="Data" value={job.bytesUsed} max={job.limits.maxBytes} text={`${size(job.bytesUsed)} of ${size(job.limits.maxBytes)}`} running={live} />
   <Meter label="Time" value={job.activeDurationMs} max={job.limits.maxDurationMs} text={`${duration(job.activeDurationMs)} of ${duration(job.limits.maxDurationMs)}`} running={live} />
  </div>
  <p className="text-xs text-muted-foreground"><b className="font-semibold text-foreground">{c.saved}</b> saved{live && <> · <b className="font-semibold text-foreground">{c.fetching}</b> reading</>} · <b className="font-semibold text-foreground">{c.queued}</b> {live ? "waiting" : "not reached"}{c.failed > 0 && <> · <span className="text-destructive-text"><b className="font-semibold">{c.failed}</b> failed</span></>}{c.skipped > 0 && <> · <b className="font-semibold text-foreground">{c.skipped}</b> skipped</>}</p>
  {job.error && !live && <p className="text-xs text-destructive-text">{crawlError(job.error)}</p>}
  {nothing && !job.error && <p className="text-xs text-muted-foreground">No page matched. Check the start address and the paths it may follow.</p>}
  {live && pages.data && pages.data.pages.length > 0 && <div className="border-t border-border pt-1.5">
   <p className="pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Latest pages</p>
   {pages.data.pages.map((page) => <div key={page.id} className="grid grid-cols-[0.875rem_auto_minmax(0,1fr)] items-center gap-2 py-px text-[11.5px]">
    {page.state === "fetching" ? <Spinner /> : page.state === "saved" ? <span className="text-success"><Glyph name="check-circle" /></span> : page.state === "failed" ? <span className="text-destructive-text"><Glyph name="x-circle" /></span> : <span className="text-subtle-foreground"><Glyph name={page.state === "queued" ? "clock" : "skip"} /></span>}
    <code className="truncate font-mono text-[11.5px]">{shortUrl(page.url)}</code>
    <span className="truncate text-right text-subtle-foreground">{page.state === "fetching" ? "Reading…" : page.state === "failed" ? page.error ?? "Failed" : page.state === "skipped" ? (page.error === "ROBOTS_DENIED" ? "robots.txt asks crawlers to skip it" : "Skipped") : page.state === "queued" ? "Waiting" : ""}</span>
   </div>)}
  </div>}
  <ErrorLine error={cancel.error ?? resume.error} />
  <div className="flex flex-wrap gap-1.5">
   {live && <Button icon="stop" disabled={cancel.isPending || job.state === "cancelling"} onClick={() => { void cancel.mutate({ scope, jobId: job.id }).catch(() => undefined); }}>Stop crawl</Button>}
   {!live && job.state !== "completed" && atLimit && job.limits.maxPages >= 200 && <span className="text-[11px] text-muted-foreground">It used the 200-page maximum; start a narrower crawl for more.</span>}
   {!live && job.state !== "completed" && !(atLimit && job.limits.maxPages >= 200) && <Button icon="play" disabled={resume.isPending} onClick={() => { void resume.mutate({ scope, jobId: job.id, ...(atLimit ? { limits: { maxPages: Math.min(200, job.limits.maxPages + 20) } } : {}) }).catch(() => undefined); }}>{atLimit && job.limits.maxPages < 200 ? "Resume with 20 more pages" : "Resume"}</Button>}
   {job.pagesUsed > 0 && <Button variant="ghost" onClick={() => onShowPages(job.id)}>{c.saved > 0 ? `Show ${plural(c.saved, "page")} in Sources` : "Show its pages"}</Button>}
  </div>
 </article>;
}

function NewCrawl({ scope, onClose }: { scope: ThreadScope; onClose(): void }) {
 const [url, setUrl] = useState("");
 const [paths, setPaths] = useState("");
 const [maxPages, setMaxPages] = useState(25);
 const [maxDepth, setMaxDepth] = useState(2);
 const [minutes, setMinutes] = useState(5);
 const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
 const run = useMutation({ contract: rpcContract, method: "run" });
 const includePaths = paths.split(/[\s,]+/u).map((p) => p.trim()).filter(Boolean).map(pathPrefix).slice(0, 10);
 async function go(operation: "map" | "crawl") {
  if (!url.trim()) { setMessage({ ok: false, text: "Enter the address to start from." }); return; }
  try {
   const out = await run.mutate({ projectId: scope.projectId, threadId: scope.threadId, operation, url: url.trim(), via: "tab", ...(operation === "crawl" ? { crawl: { maxPages, maxDepth, maxDurationMs: minutes * 60_000, ...(includePaths.length ? { includePaths } : {}) } } : {}) });
   setMessage({ ok: out.ok, text: out.message });
   if (out.ok && operation === "crawl") onClose();
  } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : "Could not start." }); }
 }
 const field = "h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground";
 return <div className="mx-2.5 my-2 grid gap-2 rounded-xl border border-ring bg-card px-3 py-2.5" aria-label="New crawl">
  <div className="flex items-center gap-1.5 text-xs"><Glyph name="crawl" /><b className="font-semibold">New crawl in this thread</b><span className="flex-1" /><IconButton icon="x" label="Close" onClick={onClose} /></div>
  <label className="grid gap-1 text-[11.5px] text-muted-foreground">Start at<input className={field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.example.com/guide" /></label>
  <label className="grid gap-1 text-[11.5px] text-muted-foreground">Only paths starting with (optional)<input className={field} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="/guide" /></label>
  <div className="grid grid-cols-3 gap-1.5">
   <label className="grid gap-1 text-[11.5px] text-muted-foreground">Pages<select className={field} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))}>{[10, 25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
   <label className="grid gap-1 text-[11.5px] text-muted-foreground">Links deep<select className={field} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
   <label className="grid gap-1 text-[11.5px] text-muted-foreground">Time<select className={field} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[2, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select></label>
  </div>
  {message && <Notice tone={message.ok ? "good" : "bad"} icon={message.ok ? "check-circle" : "warning"}>{message.text}</Notice>}
  <div className="flex flex-wrap items-center gap-1.5">
   <Button variant="primary" disabled={run.isPending} onClick={() => { void go("crawl"); }}>{run.isPending ? "Starting…" : "Start crawl"}</Button>
   <Button icon="map" disabled={run.isPending} onClick={() => { void go("map"); }}>Map first</Button>
   <span className="text-[11px] text-muted-foreground">Runs with no model turns.</span>
  </div>
 </div>;
}
