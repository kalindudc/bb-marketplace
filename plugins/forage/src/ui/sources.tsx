import { useState } from "react";
import { experimental_usePluginId, experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery, experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { deleteScopeConfirmation, deleteSourceConfirmation } from "../contract.ts";
import { rpcContract } from "./contract.ts";
import type { SourceScope, SourceDetail, SnapshotMeta } from "../sources/model.ts";

export const buttonClass = "rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50";
const inputClass = "rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground";
function ErrorNotice({ error }: { error: { message: string } | null }) {
 return error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null;
}
function Pager({ hasPrevious, next, previous, forward }: { hasPrevious: boolean; next: string | null | undefined; previous(): void; forward(): void }) {
 return <div className="flex gap-2 py-2"><button className={buttonClass} disabled={!hasPrevious} onClick={previous}>Previous page</button><button className={buttonClass} disabled={!next} onClick={forward}>Next page</button></div>;
}
function usePages() {
 const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
 return { cursor: cursors.at(-1), hasPrevious: cursors.length > 1, previous: () => setCursors((v) => v.slice(0, -1)), forward: (next: string | null | undefined) => { if (next) setCursors((v) => [...v, next]); }, reset: () => setCursors([undefined]) };
}
function ConfirmDeletion({ token, pending, onConfirm, onCancel }: { token: string; pending: boolean; onConfirm(confirm: string): void; onCancel(): void }) {
 const [text, setText] = useState("");
 return <section aria-label="Confirm destructive action" className="space-y-2 rounded-md border border-destructive p-3">
  <p>This permanently deletes retained evidence in this selection. Cancel active jobs before deleting a single source. Clearing a scope also cancels its jobs. Type this exact token:</p>
  <code className="block break-all select-all">{token}</code>
  <label className="block">Deletion confirmation<input className={`${inputClass} block w-full`} value={text} onChange={(e) => setText(e.target.value)} /></label>
  <div className="flex gap-2"><button className={buttonClass} disabled={text !== token || pending} onClick={() => onConfirm(text)}>Confirm deletion</button><button className={buttonClass} disabled={pending} onClick={onCancel}>Keep evidence</button></div>
 </section>;
}
function ExportLink({ scope, sourceId }: { scope: SourceScope; sourceId?: string }) {
 const pluginId = experimental_usePluginId();
 const [restricted, setRestricted] = useState(false);
 const request = { scope, ...(sourceId ? { sourceIds: [sourceId] } : {}), includeRestricted: restricted };
 const href = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/sources-export?request=${encodeURIComponent(JSON.stringify(request))}`;
 return <div className="space-y-1">
  {sourceId && scope.kind === "thread" && <label className="block text-sm"><input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /> Include restricted content from this selected source</label>}
  {restricted && <p className="text-sm text-destructive">Restricted content leaves this thread in the download. Current capture policy must permit it.</p>}
  <a className="text-sm underline" href={href} download="forage-sources.ndjson">{sourceId ? "Export selected source" : "Export public sources"}</a>
  <p className="text-xs text-muted-foreground">Streamed NDJSON, at most 32 MiB or 1,000 snapshots per download. Check the final end record for completeness.</p>
 </div>;
}

export function SourcesBrowser({ scope }: { scope: SourceScope }) {
 const [query, setQuery] = useState("");
 const [filter, setFilter] = useState("");
 const [selected, setSelected] = useState<string | null>(null);
 const [deleting, setDeleting] = useState(false);
 const pages = usePages();
 const list = useQuery({ contract: rpcContract, method: "listSources", input: { scope, query: filter, ...(pages.cursor ? { cursor: pages.cursor } : {}), limit: 20 } });
 const clear = useMutation({ contract: rpcContract, method: "deleteScope" });
 async function deleteScope(confirm: string) {
  try { await clear.mutate({ scope, confirm }); setDeleting(false); setSelected(null); pages.reset(); } catch { /* The mutation owns the displayed error. */ }
 }
 return <main className="h-full overflow-auto bg-background p-4 text-foreground">
  <div className="mx-auto max-w-6xl space-y-4">
   <header className="space-y-2"><h2 className="text-lg font-semibold">{scope.kind === "thread" ? "Thread sources" : "Project sources (shared)"}</h2>
    <p className="text-sm text-muted-foreground">{scope.kind === "thread" ? "Evidence captured in this thread. Other threads cannot read it by ID. Copy public sources explicitly to share with the project." : "Public evidence explicitly copied into this project. Thread captures are not automatically shared."}</p>
    <p className="break-all text-xs text-muted-foreground">Project: {scope.projectId}{scope.kind === "thread" ? ` · Thread: ${scope.threadId}` : ""}</p>
   </header>
   <div className="flex flex-wrap gap-2">
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setFilter(query); pages.reset(); setSelected(null); }}><input aria-label="Search sources" className={inputClass} maxLength={500} placeholder="Filter sources" value={query} onChange={(e) => setQuery(e.target.value)} /><button className={buttonClass}>Search</button></form>
    <button className={buttonClass} onClick={() => { void list.refetch(); }}>Refresh sources</button>
    <button className={buttonClass} onClick={() => setDeleting(true)}>Delete all in scope</button>
   </div>
   <ExportLink scope={scope} />
   {deleting && <ConfirmDeletion token={deleteScopeConfirmation(scope)} pending={clear.isPending} onConfirm={(confirm) => { void deleteScope(confirm); }} onCancel={() => setDeleting(false)} />}
   <ErrorNotice error={clear.error} /><ErrorNotice error={list.error} />
   {list.isLoading && <p role="status">Loading sources…</p>}
   {!list.error && list.data && <div className="grid gap-4 lg:grid-cols-3">
    <section aria-label="Sources list" className="space-y-2">
     {list.data.sources.length === 0 && <p>No visible sources on this page.</p>}
     <ul className="space-y-2">{list.data.sources.map((source) => <li key={source.id} className="rounded-md border border-border p-3">
      <button className="text-left font-medium underline" aria-pressed={selected === source.id} onClick={() => setSelected(source.id)}>{source.title || source.url}</button>
      <p className="break-all text-xs text-muted-foreground">{source.url}</p><p className="text-xs">{source.access.network}{source.access.credentialed ? " · credentialed" : ""} · {source.latestSnapshot?.bytes ?? 0} bytes</p>
     </li>)}</ul>
     <Pager hasPrevious={pages.hasPrevious} next={list.data.nextCursor} previous={() => { pages.previous(); setSelected(null); }} forward={() => { pages.forward(list.data?.nextCursor); setSelected(null); }} />
    </section>
    <div className="min-w-0 lg:col-span-2">{selected ? <SourceInspector key={selected} scope={scope} sourceId={selected} onDeleted={() => { setSelected(null); pages.reset(); }} /> : <p className="text-muted-foreground">Select a source to inspect its snapshots and retrieval history.</p>}</div>
   </div>}
   <CrawlJobs scope={scope} />
  </div>
 </main>;
}

function SourceInspector({ scope, sourceId, onDeleted }: { scope: SourceScope; sourceId: string; onDeleted(): void }) {
 const snapshots = usePages(); const retrievals = usePages();
 const detail = useQuery({ contract: rpcContract, method: "getSource", input: { scope, sourceId, ...(snapshots.cursor ? { snapshotCursor: snapshots.cursor } : {}), ...(retrievals.cursor ? { retrievalCursor: retrievals.cursor } : {}), limit: 20 } });
 const remove = useMutation({ contract: rpcContract, method: "deleteSource" });
 const copy = useMutation({ contract: rpcContract, method: "copySourceToProject" });
 const [deleting, setDeleting] = useState(false);
 const [copied, setCopied] = useState(false);
 async function deleteSource(confirm: string) { try { await remove.mutate({ scope, sourceId, confirm }); onDeleted(); } catch { /* The mutation owns the displayed error. */ } }
 async function copySource() { if (scope.kind !== "thread") return; try { await copy.mutate({ projectId: scope.projectId, threadId: scope.threadId, sourceId }); setCopied(true); } catch { /* The mutation owns the displayed error. */ } }
 if (detail.error) return <ErrorNotice error={detail.error} />;
 if (detail.isLoading || detail.data === undefined) return <p role="status">Loading source…</p>;
 if (!detail.data) return <p role="status">This source is no longer visible. It may have been deleted or blocked by current policy.</p>;
 const data: SourceDetail = detail.data;
 const retrieval = data.retrievals.items[0];
 return <section aria-label="Source detail" className="space-y-3 rounded-md border border-border p-3">
  <h3 className="font-semibold">{data.title}</h3><p className="break-all text-sm">{data.url}</p>
  <dl className="grid grid-cols-2 gap-1 text-xs"><dt>Source ID</dt><dd className="break-all">{data.id}</dd><dt>Canonical URL</dt><dd className="break-all">{data.canonicalUrl ?? "Not supplied"}</dd><dt>Created</dt><dd>{new Date(data.createdAt).toISOString()}</dd><dt>Last retrieved</dt><dd>{data.lastRetrievedAt === null ? "Never" : new Date(data.lastRetrievedAt).toISOString()}</dd></dl>
  {retrieval?.completeness && <div className="text-sm"><p>Latest retrieval completeness: {retrieval.completeness.state}</p>{retrieval.completeness.parts.map((part, i) => <p key={i}>{part.name}: {part.state}, {part.fetched}{part.expected === undefined ? "" : ` of ${part.expected}`} {part.reason ?? ""}</p>)}</div>}
  <div className="flex flex-wrap gap-2">{scope.kind === "thread" && data.access.network === "public" && !data.access.credentialed && <button className={buttonClass} disabled={copy.isPending} onClick={() => { void copySource(); }}>Copy public source to project</button>}<button className={buttonClass} onClick={() => setDeleting(true)}>Delete source</button></div>
  {copied && <p role="status">Public source copied to project.</p>}<ErrorNotice error={copy.error} /><ErrorNotice error={remove.error} />
  {deleting && <ConfirmDeletion token={deleteSourceConfirmation(scope, sourceId)} pending={remove.isPending} onConfirm={(confirm) => { void deleteSource(confirm); }} onCancel={() => setDeleting(false)} />}
  <ExportLink scope={scope} sourceId={sourceId} />
  <SnapshotViewer key={`${snapshots.cursor ?? "first"}:${data.latestSnapshot?.id ?? "none"}`} scope={scope} snapshots={!snapshots.cursor && data.latestSnapshot ? [data.latestSnapshot, ...data.snapshots.items.filter((s) => s.id !== data.latestSnapshot!.id)] : data.snapshots.items} latestId={data.latestSnapshot?.id} />
  <div aria-label="Snapshot pages"><Pager hasPrevious={snapshots.hasPrevious} next={data.snapshots.nextCursor} previous={snapshots.previous} forward={() => snapshots.forward(data.snapshots.nextCursor)} /></div>
  <details><summary>Retrieval history</summary><ul className="space-y-2 text-xs">{data.retrievals.items.map((r) => <li className="border-b border-border py-2" key={r.id}>
   <p>{r.status} · {r.origin} · HTTP {r.httpStatus} · {r.transport ?? "no transport"} · {r.representation ?? "no representation"} · {r.cache}</p><p>Checked {new Date(r.finishedAt).toISOString()} · {r.transferredBytes} transferred bytes</p>
   {r.completeness && <p>Completeness: {r.completeness.state}</p>}{r.error && <p>{r.error}</p>}{r.warnings.map((w, i) => <p key={i}>{w.code}: {w.message}</p>)}
  </li>)}</ul><Pager hasPrevious={retrievals.hasPrevious} next={data.retrievals.nextCursor} previous={retrievals.previous} forward={() => retrievals.forward(data.retrievals.nextCursor)} /></details>
 </section>;
}

function SnapshotViewer({ scope, snapshots, latestId }: { scope: SourceScope; snapshots: SnapshotMeta[]; latestId?: string }) {
 const initialId = snapshots.find((s) => s.id === latestId)?.id ?? snapshots[0]?.id ?? "";
 const [selected, setSelected] = useState(initialId);
 const [before, setBefore] = useState(snapshots.find((s) => s.id !== initialId)?.id ?? initialId);
 const [after, setAfter] = useState(initialId);
 const [comparison, setComparison] = useState<{ before: string; after: string } | null>(null);
 const meta = snapshots.find((s) => s.id === selected);
 return <section className="space-y-2" aria-label="Snapshots">
  <label className="block text-sm">Snapshot<select className={`${inputClass} block w-full`} value={selected} onChange={(e) => setSelected(e.target.value)}>{snapshots.map((s) => <option key={s.id} value={s.id}>{new Date(s.fetchedAt).toISOString()} · {s.id}</option>)}</select></label>
  {meta && <><dl className="grid grid-cols-2 gap-1 text-xs"><dt>Format / size</dt><dd>{meta.kind} · {meta.bytes} bytes · {meta.truncated ? "Truncated" : "Not truncated"}</dd><dt>Extractor</dt><dd>{meta.extractorId} · {meta.extractorVersion}</dd><dt>Fetched</dt><dd>{new Date(meta.fetchedAt).toISOString()}</dd><dt>Checked</dt><dd>{new Date(meta.checkedAt).toISOString()}</dd><dt>Content hash</dt><dd className="break-all">{meta.contentHash}</dd><dt>Snapshot hash</dt><dd className="break-all">{meta.snapshotHash}</dd></dl><SnapshotPreview key={meta.id} scope={scope} meta={meta} /></>}
  {snapshots.length > 1 && <div className="space-y-2"><div className="flex flex-wrap gap-2"><SnapshotSelect label="Before snapshot" value={before} items={snapshots} onChange={setBefore} /><SnapshotSelect label="After snapshot" value={after} items={snapshots} onChange={setAfter} /></div><button className={buttonClass} onClick={() => setComparison({ before, after })}>Compare snapshots</button></div>}
  {comparison && <SnapshotDiffView scope={scope} before={comparison.before} after={comparison.after} />}
 </section>;
}
function SnapshotSelect({ label, value, items, onChange }: { label: string; value: string; items: SnapshotMeta[]; onChange(value: string): void }) {
 return <label className="text-sm">{label}<select className={`${inputClass} block max-w-full`} value={value} onChange={(e) => onChange(e.target.value)}>{items.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>;
}
function SnapshotPreview({ scope, meta }: { scope: SourceScope; meta: SnapshotMeta }) {
 const [offsets, setOffsets] = useState([0]);
 const preview = useQuery({ contract: rpcContract, method: "readSnapshot", input: { scope, snapshotId: meta.id, offset: offsets.at(-1)!, maxChars: 12_000, contentHash: meta.contentHash } });
 const [copied, setCopied] = useState(false);
 const metadata = useQuery({ contract: rpcContract, method: "snapshotMetadata", input: { scope, snapshotId: meta.id } });
 if (metadata.error) return <ErrorNotice error={metadata.error} />;
 if (metadata.data === null) return <p role="status">Snapshot metadata is no longer visible.</p>;
 if (preview.error) return <ErrorNotice error={preview.error} />;
 if (!preview.data) return <p role="status">Loading snapshot…</p>;
 if (preview.data.status !== "ok") return <p role="status">Snapshot unavailable: {preview.data.status}. Refresh the source to reload its immutable version.</p>;
 const slice = preview.data.slice;
 return <section className="space-y-2" aria-label="Content preview">
  {metadata.data && <div className="text-sm"><p>{metadata.data.completeness.state === "complete" ? "Complete" : metadata.data.completeness.state === "partial" ? "Partial" : "Completeness unknown"}</p><p className="text-xs">{metadata.data.contentType} · {metadata.data.language ?? "Language not supplied"}</p>{metadata.data.completeness.parts.map((part, i) => <p key={i}>{part.name}: {part.state} · {part.fetched}{part.expected === undefined ? "" : ` of ${part.expected}`} {part.reason ?? ""}</p>)}{metadata.data.warnings.map((w, i) => <p key={i}>{w.code}: {w.message}</p>)}</div>}
  <p className="text-xs">Characters {slice.offset}–{slice.end} of {slice.total}. Line range is in the citation.</p>
  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{slice.text}</pre>
  <label className="block text-xs">Citation<textarea className={`${inputClass} block w-full`} readOnly value={slice.citation} /></label>
  <button className={buttonClass} onClick={() => { void experimental_copyToClipboard({ text: slice.citation }).then(setCopied); }}>Copy citation</button>{copied && <span role="status">Citation copied.</span>}
  <div className="flex gap-2"><button className={buttonClass} disabled={offsets.length === 1} onClick={() => setOffsets((v) => v.slice(0, -1))}>Previous content</button><button className={buttonClass} disabled={slice.nextOffset === null} onClick={() => { if (slice.nextOffset !== null) setOffsets((v) => [...v, slice.nextOffset!]); }}>Next content</button></div>
 </section>;
}
function SnapshotDiffView({ scope, before, after }: { scope: SourceScope; before: string; after: string }) {
 const result = useQuery({ contract: rpcContract, method: "diffSnapshots", input: { scope, beforeSnapshotId: before, afterSnapshotId: after, maxHunks: 100, maxChars: 32_000 } });
 if (result.error) return <ErrorNotice error={result.error} />;
 if (!result.data) return <p role="status">Comparing snapshots…</p>;
 const diff = result.data;
 return <section aria-label="Snapshot comparison" className="space-y-2"><h4 className="font-medium">Snapshot comparison</h4><p className="text-xs break-all">Before: {before} · After: {after}</p><p>{diff.unchanged ? "No content changes." : `${diff.addedLines} lines added, ${diff.removedLines} removed.`}{diff.truncated ? " Diff truncated at its bounds." : ""}</p>{diff.extractorChanged && <p>Extractor changed between versions.</p>}{diff.warnings.map((w, i) => <p key={i}>{w}</p>)}
  {diff.hunks.map((h, i) => <article key={i} className="rounded-md border border-border p-2 text-xs"><p>{h.kind} · {h.headingPath.join(" / ")}</p>{h.before && <DiffPart label="Before" range={h.before} />}{h.after && <DiffPart label="After" range={h.after} />}</article>)}
 </section>;
}
function DiffPart({ label, range }: { label: string; range: { startLine: number; endLine: number; text: string } }) { return <><p>{label} lines {range.startLine}–{range.endLine}</p><pre className="overflow-auto whitespace-pre-wrap bg-muted p-2">{range.text}</pre></>; }

function CrawlJobs({ scope }: { scope: SourceScope }) {
 const pages = usePages();
 const jobs = useQuery({ contract: rpcContract, method: "listCrawlJobs", input: { scope, ...(pages.cursor ? { cursor: pages.cursor } : {}), limit: 20 } });
 const cancel = useMutation({ contract: rpcContract, method: "cancelCrawlJob" });
 const resume = useMutation({ contract: rpcContract, method: "resumeCrawlJob" });
 async function control(action: "cancel" | "resume", jobId: string) { try { await (action === "cancel" ? cancel : resume).mutate({ scope, jobId }); } catch { /* The mutation owns the displayed error. */ } }
 return <section aria-label="Crawl jobs" className="space-y-2 border-t border-border pt-4"><h3 className="font-semibold">Crawl jobs</h3><p className="text-xs text-muted-foreground">Status and controls for persisted jobs. Resume uses current provider policy and retained budgets.</p><button className={buttonClass} onClick={() => { void jobs.refetch(); }}>Refresh jobs</button><ErrorNotice error={jobs.error} /><ErrorNotice error={cancel.error} /><ErrorNotice error={resume.error} />
  {!jobs.error && jobs.data && <>{jobs.data.jobs.length === 0 && <p>No visible crawl jobs on this page.</p>}{jobs.data.jobs.map((job) => <section role="region" aria-label={`Crawl ${job.id}`} key={job.id} className="space-y-1 rounded-md border border-border p-3 text-sm">
   <p className="break-all">{job.rootUrl}</p><p>{job.state}</p><p>{job.backend} · {job.id}</p>{job.backend === "firecrawl" && <p className="text-xs text-muted-foreground">Remote Firecrawl job: vendor redirects cannot be DNS-pinned by Forage. Local robots enforcement is not claimed.</p>}<p>{job.counts.saved} saved · {job.counts.failed} failed · {job.counts.skipped} skipped · {job.counts.queued} queued · {job.counts.fetching} fetching</p>
   <progress className="w-full" aria-label="Pages used" value={job.pagesUsed} max={job.limits.maxPages} /><p>{job.pagesUsed} of {job.limits.maxPages} pages · {job.bytesUsed} of {job.limits.maxBytes} bytes · {job.activeDurationMs} of {job.limits.maxDurationMs} ms</p><p>Depth {job.limits.maxDepth} · Concurrency {job.limits.concurrency}{job.stopReason ? ` · Stop reason: ${job.stopReason}` : ""}</p>
   {job.error && <p className="text-destructive">{job.error}</p>}
   <div className="flex gap-2">{["queued", "running", "paused"].includes(job.state) && <button className={buttonClass} disabled={cancel.isPending || resume.isPending} onClick={() => { void control("cancel", job.id); }}>Cancel</button>}{["paused", "cancelled", "partial", "failed"].includes(job.state) && <button className={buttonClass} disabled={cancel.isPending || resume.isPending} onClick={() => { void control("resume", job.id); }}>Resume</button>}</div>
  </section>)}<Pager hasPrevious={pages.hasPrevious} next={jobs.data.nextCursor} previous={pages.previous} forward={() => pages.forward(jobs.data?.nextCursor)} /></>}
 </section>;
}
