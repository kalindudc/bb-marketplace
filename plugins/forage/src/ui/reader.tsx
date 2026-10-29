import { useEffect, useMemo, useRef, useState } from "react";
import {
 experimental_copyToClipboard as copyToClipboard, experimental_usePluginId as usePluginId, experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery,
 useBbNavigate, useComposer,
} from "@get-bb/plugin-sdk/app";
import { deleteSourceConfirmation } from "../contract.ts";
import type { SourceScope } from "../web/contracts.ts";
import { rpcContract } from "./contract.ts";
import { Button, cx, day, ErrorLine, Glyph, hostOf, IconButton, Loading, Menu, MenuItem, Notice, plainError, plural, safeHref, shortUrl, size, Spinner, Tag, Tile, when } from "./kit.tsx";

// Bold, code and links inside one kept line, drawn without trusting any markup.
function Inline({ text }: { text: string }) {
 return <>{text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/gu).map((part, i) => {
  if (/^\*\*[^*]+\*\*$/u.test(part)) return <b key={i} className="font-semibold">{part.slice(2, -2)}</b>;
  if (/^`[^`]+`$/u.test(part)) return <code key={i} className="rounded bg-surface-recessed px-1 font-mono text-[11.5px]">{part.slice(1, -1)}</code>;
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(part);
  if (link) return <span key={i} className="underline decoration-border underline-offset-2" title={link[2]}>{link[1]}</span>;
  return part;
 })}</>;
}

export interface ReaderProps {
 scope: SourceScope;
 sourceId: string;
 snapshotId?: string;
 lines?: [number, number];
 backLabel: string;
 onBack(): void;
 onCheck?: (text: string) => void;
 canQuote: boolean;
 compare?: boolean;
 targetSeq?: number;
}
const CHUNK = 400;
const plainHeading = (line: string) => line.replace(/^#+\s/u, "").replace(/\*\*|`/gu, "");

export function quoteText(input: { title: string; url: string; snapshotId: string; startLine: number; endLine: number; lines: readonly string[] }): string {
 const range = input.startLine === input.endLine ? `line ${input.startLine}` : `lines ${input.startLine}–${input.endLine}`;
 return `${input.lines.map((line) => `> ${line}`).join("\n")}\n— ${input.title || shortUrl(input.url)}, ${input.url} (Forage snapshot ${input.snapshotId}, ${range})`;
}
export function citationText(input: { title: string; url: string; snapshotId: string; startLine: number; endLine: number; fetchedAt: number }): string {
 const range = input.startLine === input.endLine ? `line ${input.startLine}` : `lines ${input.startLine}–${input.endLine}`;
 return `${input.title || shortUrl(input.url)} — ${input.url} (${range}, read ${day(input.fetchedAt)}; Forage snapshot ${input.snapshotId})`;
}

function useComposerOrNull(enabled: boolean) {
 // useComposer is bound to the thread's composer only inside a thread's panels; elsewhere quoting is not offered.
 const composer = useComposer();
 return enabled ? composer : null;
}

export function Reader(props: ReaderProps) {
 const { scope, sourceId, onBack, backLabel, onCheck } = props;
 const detail = useQuery({ contract: rpcContract, method: "researchSource", input: { scope, sourceId } });
 const [version, setVersion] = useState<string | null>(props.snapshotId ?? null);
 const [compare, setCompare] = useState(Boolean(props.compare));
 const [target, setTarget] = useState<[number, number] | null>(props.lines ?? null);
 const [confirmDelete, setConfirmDelete] = useState(false);
 const [note, setNote] = useState<string | null>(null);
 const navigate = useBbNavigate();
 const pluginId = usePluginId();
 const copy = useMutation({ contract: rpcContract, method: "copySourceToProject" });
 const remove = useMutation({ contract: rpcContract, method: "deleteSource" });
 const run = useMutation({ contract: rpcContract, method: "run" });
 const [seq, setSeq] = useState(props.targetSeq ?? 0);
 useEffect(() => { setTarget(props.lines ?? null); setSeq((n) => n + 1); if (props.snapshotId) setVersion(props.snapshotId); }, [props.lines?.[0], props.lines?.[1], props.snapshotId, props.targetSeq]);
 const retarget = (t: [number, number] | null) => { setTarget(t); setSeq((n) => n + 1); };
 useEffect(() => { setCompare(Boolean(props.compare)); }, [props.compare]);
 if (detail.error) return <div><Back label={backLabel} onBack={onBack} /><ErrorLine error={detail.error} /></div>;
 if (detail.data === undefined) return <div><Back label={backLabel} onBack={onBack} /><Loading label="Loading source…" /></div>;
 if (detail.data === null) return <div><Back label={backLabel} onBack={onBack} /><p className="px-4 py-4 text-xs text-muted-foreground">This source is no longer kept, or current settings hide it.</p></div>;
 const d = detail.data;
 const s = d.source;
 const current = version ?? s.latestSnapshotId;
 // A crawl and a direct read keep separate snapshots of identical text; a person sees one version per distinct text.
 const versions = d.versions.filter((v, i, all) => all.findIndex((o) => o.contentHash === v.contentHash) === i);
 const hashOf = (id: string | null) => d.versions.find((v) => v.id === id)?.contentHash ?? null;
 const index = versions.findIndex((v) => v.contentHash === hashOf(current));
 const previous = index >= 0 ? versions[index + 1] : undefined;
 const citation = d.citations[0];
 const shareable = scope.kind === "thread" && s.network === "public" && !s.credentialed && s.status !== "failed";
 async function share() {
  if (scope.kind !== "thread") return;
  try { await copy.mutate({ projectId: scope.projectId, threadId: scope.threadId, sourceId }); setNote("Shared with the project. Other threads in it can now read this source."); } catch { /* The mutation shows its error. */ }
 }
 async function readAgain() {
  if (scope.kind !== "thread") return;
  const out = await run.mutate({ projectId: scope.projectId, threadId: scope.threadId, operation: "read", url: s.url, via: "tab" }).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Could not read the page." }));
  setNote(out.ok ? "Read again. A new version is kept if the page changed." : out.message); setVersion(null);
 }
 function exportSource() {
  const request = { scope, sourceIds: [sourceId], includeRestricted: false };
  const a = document.createElement("a");
  a.href = `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/sources-export?request=${encodeURIComponent(JSON.stringify(request))}`;
  a.download = "forage-source.ndjson"; a.click();
 }
 async function doDelete() {
  try { await remove.mutate({ scope, sourceId, confirm: deleteSourceConfirmation(scope, sourceId) }); onBack(); } catch { /* The mutation shows its error. */ }
 }
 function showInChat() {
  const element = citation && document.querySelector(`[data-forage-cite="${CSS.escape(`${citation.snapshotId}:${citation.startLine}-${citation.endLine}`)}"]`);
  if (element) { element.scrollIntoView({ behavior: "smooth", block: "center" }); (element as HTMLElement).focus({ preventScroll: true }); }
  else setNote("The reply that cites it is not on screen. Scroll the chat to it; bb only draws messages near the screen.");
 }
 return <div className="flex min-h-0 flex-1 flex-col">
  <Back label={backLabel} onBack={onBack} actions={<Menu trigger={({ toggle }) => <IconButton icon="more" label="More for this source" onClick={toggle} />} width="w-72">
   {(close) => <>
    {scope.kind === "thread" && s.status !== "failed" && <MenuItem icon="refresh" label="Read again now" detail="Keeps a new version if the page changed" onSelect={() => { close(); void readAgain(); }} />}
    {versions.length > 1 && <MenuItem icon="diff" label={compare ? "Show the text" : "Compare with the earlier version"} onSelect={() => { close(); setCompare(!compare); }} />}
    <MenuItem icon="window" label="Open in Browser" onSelect={() => { close(); if (safeHref(s.url) && !navigate.openUrl(s.url)) window.open(s.url, "_blank", "noopener"); }} />
    {shareable && <MenuItem icon="share" label="Share with the project" detail="Other threads in the project can then read it" onSelect={() => { close(); void share(); }} />}
    {s.status !== "failed" && <MenuItem icon="download" label="Export this source" detail="An NDJSON file with its kept text" onSelect={() => { close(); exportSource(); }} />}
    <div className="my-1 h-px bg-border" />
    <MenuItem icon="trash" danger label="Delete this source…" onSelect={() => { close(); setConfirmDelete(true); }} />
   </>}
  </Menu>} />
  <div className="grid gap-1 px-3.5 pb-2 pt-1">
   <div className="flex min-w-0 items-center gap-2"><Tile label={hostOf(s.url)} /><h3 className="truncate text-[15px] font-semibold tracking-tight">{s.title || shortUrl(s.url)}</h3></div>
   <a href={safeHref(s.url)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground hover:underline">{shortUrl(s.url)}<Glyph name="external" className="size-3" /></a>
   <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
    {s.status === "failed" ? <Tag tone="bad"><Glyph name="x-circle" className="size-3" />Not kept</Tag> : s.status === "partial" ? <Tag tone="warn"><Glyph name="warning" className="size-3" />Partial</Tag> : <Tag tone="good"><Glyph name="check-circle" className="size-3" />Complete</Tag>}
    <span>{{ agent: "Read by the agent", crawl: "From a crawl", person: s.via === "browser" ? "Saved by you from the Browser" : "Read by you", shared: "Shared with the project" }[s.arrival]} · {when(s.lastRetrievedAt ?? s.updatedAt)}{s.bytes ? ` · ${size(s.bytes)}` : ""}</span>
   </div>
   {s.truncated && <Notice tone="warn" icon="warning">Only part of this page was kept: it was longer than Forage's limit.</Notice>}
   {citation && <Notice tone="good" icon="quote" action={<Button className="h-6" onClick={showInChat}>Show in chat</Button>}>Quoted in a reply, <b className="font-semibold">{citation.startLine === citation.endLine ? `line ${citation.startLine}` : `lines ${citation.startLine}–${citation.endLine}`}</b>{d.citations.length > 1 && ` and ${plural(d.citations.length - 1, "other place")}`}</Notice>}
   {confirmDelete && <Notice tone="bad" icon="trash" action={<span className="flex gap-1"><Button variant="danger" className="h-6" disabled={remove.isPending} onClick={() => { void doDelete(); }}>Delete</Button><Button variant="ghost" className="h-6" onClick={() => setConfirmDelete(false)}>Keep</Button></span>}>Delete <b className="font-semibold">{s.title || shortUrl(s.url)}</b> and its {plural(Math.max(1, versions.length), "version")} from {scope.kind === "thread" ? "this thread" : "the project"}?</Notice>}
   {note && <Notice icon="info" action={<IconButton icon="x" label="Dismiss" onClick={() => setNote(null)} />}>{note}</Notice>}
   <ErrorLine error={copy.error ?? remove.error} />
  </div>
  {s.status === "failed" || !current ? <div className="grid justify-items-start gap-2.5 px-4 py-4 text-xs">
   <p><b className="font-semibold">Forage did not keep this page.</b> {plainError(s.error) || "The read failed."} The agent was told the read failed.</p>
   <div className="flex gap-1.5">{scope.kind === "thread" && <Button icon="refresh" disabled={run.isPending} onClick={() => { void readAgain(); }}>Try again</Button>}<Button variant="ghost" icon="window" onClick={() => { if (safeHref(s.url) && !navigate.openUrl(s.url)) window.open(s.url, "_blank", "noopener"); }}>Open in Browser</Button></div>
  </div> : <>
   {compare && previous ? <Compare scope={scope} before={previous} after={versions[index]!} onExit={() => setCompare(false)} />
    : <Lines key={current} scope={scope} snapshotId={current} title={s.title} url={s.url} target={target} targetSeq={seq} onTarget={retarget} {...(onCheck ? { onCheck } : {})} canQuote={props.canQuote}
     versions={versions.length > 1 ? <VersionPicker versions={versions} value={versions[index]?.id ?? current} latest={versions[0]?.id ?? s.latestSnapshotId} onChange={(id) => { setVersion(id); setCompare(false); }} onCompare={previous ? () => setCompare(true) : undefined} /> : <span className="text-[11px] text-subtle-foreground">1 version</span>}
     citations={d.citations.filter((c) => hashOf(c.snapshotId) === hashOf(current))} />}
   <div className="grid gap-2 px-3 pb-4">
    <details className="group rounded-lg border border-border text-xs">
     <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground"><Glyph name="chevron-right" className="size-3 group-open:rotate-90" />How Forage got this page</summary>
     {d.retrieval && <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 pb-2.5">
      <dt className="text-muted-foreground">Answer</dt><dd>HTTP {d.retrieval.httpStatus}{d.retrieval.redirects ? ` after ${plural(d.retrieval.redirects, "redirect")}` : ""}{d.retrieval.durationMs !== null ? `, in ${Math.round(d.retrieval.durationMs)} ms` : ""}{d.retrieval.cache === "hit" ? ", from cache" : ""}</dd>
      <dt className="text-muted-foreground">Reader</dt><dd>{d.retrieval.transport === "github-smart" ? "GitHub API" : d.retrieval.transport === "provider" ? "A remote reader" : "Read directly from this machine"}{d.retrieval.representation === "raw" ? ", exact text" : ", readable text"}</dd>
      <dt className="text-muted-foreground">Last checked</dt><dd>{when(d.retrieval.finishedAt)}</dd>
      {d.retrieval.error && <><dt className="text-muted-foreground">Problem</dt><dd className="text-destructive-text">{plainError(d.retrieval.error)}</dd></>}
     </dl>}
    </details>
    <details className="group rounded-lg border border-border text-xs">
     <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground"><Glyph name="chevron-right" className="size-3 group-open:rotate-90" />Technical details</summary>
     <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 pb-2.5 font-mono text-[11px]">
      {[["Source", s.id], ["Version", current], ["Content hash", d.contentHash], ["Extractor", d.extractor], ["Canonical", d.canonicalUrl]].filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents">
       <dt className="font-sans text-muted-foreground">{k}</dt><dd className="flex min-w-0 items-center gap-1"><span className="truncate">{v}</span><IconButton icon="copy" label={`Copy ${k}`} className="size-5" onClick={() => { void copyToClipboard({ text: v! }); }} /></dd>
      </div>)}
     </dl>
    </details>
   </div>
  </>}
 </div>;
}

export function Back({ label, onBack, actions }: { label: string; onBack(): void; actions?: React.ReactNode }) {
 return <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
  <button type="button" onClick={onBack} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"><Glyph name="chevron-left" className="size-3" />{label}</button>
  <span className="flex-1" />{actions}
 </div>;
}

function VersionPicker({ versions, value, latest, onChange, onCompare }: { versions: ReadonlyArray<{ id: string; fetchedAt: number }>; value: string; latest: string | null; onChange(id: string): void; onCompare?: () => void }) {
 return <span className="flex items-center gap-1">
  <select aria-label="Version" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 max-w-[11rem] rounded-md border border-border bg-card px-1.5 text-[11px]">
   {versions.map((v) => <option key={v.id} value={v.id}>{when(v.fetchedAt)}{v.id === latest ? " (latest)" : ""}</option>)}
  </select>
  {onCompare && <Button className="h-6 px-2 text-[11px]" icon="diff" onClick={onCompare}>Compare</Button>}
 </span>;
}

function Lines({ scope, snapshotId, title, url, target, targetSeq, onTarget, onCheck, canQuote, versions, citations }: {
 scope: SourceScope; snapshotId: string; title: string; url: string; target: [number, number] | null; targetSeq: number; onTarget(t: [number, number] | null): void;
 onCheck?: (text: string) => void; canQuote: boolean; versions: React.ReactNode; citations: ReadonlyArray<{ startLine: number; endLine: number }>;
}) {
 // The server returns at most CHUNK lines per read, so the reader shows one window and moves it.
 const [start, setStart] = useState(() => (target ? Math.max(1, target[0] - 40) : 1));
 const [sel, setSel] = useState<[number, number] | null>(null);
 const [find, setFind] = useState("");
 const [findReq, setFindReq] = useState<{ text: string; from: number; wrapped: boolean } | null>(null);
 const [findNote, setFindNote] = useState<string | null>(null);
 const [copied, setCopied] = useState(false);
 const composer = useComposerOrNull(canQuote);
 const box = useRef<HTMLDivElement>(null);
 const read = useQuery({ contract: rpcContract, method: "readLines", input: { scope, snapshotId, startLine: start, endLine: start + CHUNK - 1 } });
 const kept = useRef<{ startLine: number; endLine: number; totalLines: number; lines: string[]; fetchedAt: number } | null>(null);
 if (read.data?.status === "ok") kept.current = read.data;
 const data = read.data?.status === "ok" ? read.data : read.data === undefined ? kept.current : null;
 const lines = data?.lines ?? [];
 const first = data?.startLine ?? start;
 const found = useQuery({ contract: rpcContract, method: "readLines", input: { scope, snapshotId, startLine: findReq?.from ?? 1, find: findReq?.text ?? "x" }, enabled: Boolean(findReq) });
 useEffect(() => {
  if (!target) return;
  if (target[0] < first || target[0] > first + CHUNK - 1) setStart(Math.max(1, target[0] - 40));
 }, [targetSeq, target?.[0]]);
 useEffect(() => {
  if (!target || !data || target[0] < data.startLine || target[0] > data.endLine) return;
  box.current?.querySelector(`[data-line="${target[0]}"]`)?.scrollIntoView?.({ block: "center" });
 }, [targetSeq, target?.[0], data?.startLine]);
 useEffect(() => {
  if (!findReq || !found.data) return;
  if (found.data.status === "ok") { setFindReq(null); setFindNote(null); onTarget([found.data.startLine, found.data.startLine]); return; }
  if (found.data.status === "missing" && !findReq.wrapped && findReq.from > 1) { setFindReq({ ...findReq, from: 1, wrapped: true }); return; }
  setFindReq(null); setFindNote(`“${findReq.text}” is not in this page.`);
 }, [found.data, findReq]);
 const outline = useMemo(() => lines.map((line, i) => ({ line: first + i, text: line })).filter((l) => /^#{1,4}\s/u.test(l.text)).slice(0, 40), [lines, first]);
 const cited = (n: number) => citations.some((c) => n >= c.startLine && n <= c.endLine);
 const at = (n: number) => lines[n - first] ?? "";
 function pick(n: number, extend: boolean) {
  if (extend && sel) { setSel([Math.min(sel[0], n), Math.max(sel[1], n)]); return; }
  let a = n, b = n;
  if (at(n).trim() !== "") { while (a > first && at(a - 1).trim() !== "") a--; while (b < first + lines.length - 1 && at(b + 1).trim() !== "") b++; }
  setSel(sel && sel[0] === a && sel[1] === b ? null : [a, b]); setCopied(false);
 }
 function jumpToFind() {
  const text = find.trim();
  if (!text) return;
  setFindNote(null);
  setFindReq({ text: text.slice(0, 200), from: (target ? target[0] : sel ? sel[1] : first - 1) + 1, wrapped: false });
 }
 const selected = sel && data ? { title, url, snapshotId, startLine: sel[0], endLine: sel[1], lines: lines.slice(sel[0] - first, sel[1] - first + 1), fetchedAt: data.fetchedAt } : null;
 const selectedText = selected ? selected.lines.join(" ").trim() : "";
 if (read.error) return <ErrorLine error={read.error} />;
 if (!data && read.data === undefined) return <Loading label="Loading the kept text…" />;
 if (!data) return <p className="px-4 py-4 text-xs text-muted-foreground">This version is no longer kept, or current settings hide it.</p>;
 return <>
  <div className="flex shrink-0 items-center gap-1.5 border-y border-border px-2.5 py-1.5">
   {outline.length > 0 && <Menu align="start" width="w-64" trigger={({ toggle }) => <Button variant="ghost" className="h-6 px-1.5" icon="list" onClick={toggle}>Outline</Button>}>
    {(close) => <div className="max-h-72 overflow-y-auto">{outline.map((h) => <MenuItem key={h.line} label={plainHeading(h.text)} onSelect={() => { close(); onTarget([h.line, h.line]); }} />)}</div>}
   </Menu>}
   <label className="flex h-6 w-32 min-w-0 items-center gap-1 rounded-md border border-border bg-card px-1.5 text-muted-foreground">
    {found.isFetching && findReq ? <Spinner className="size-3" /> : <Glyph name="magnifier" className="size-3" />}<input aria-label="Find in page" value={find} onChange={(e) => { setFind(e.target.value); setFindNote(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); jumpToFind(); } }} placeholder="Find in page" className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none" />
   </label>
   <span className="flex-1" />{versions}
  </div>
  {findNote && <p role="status" className="shrink-0 px-3 py-1 text-[11px] text-muted-foreground">{findNote}</p>}
  <div ref={box} className="min-h-0 flex-1 overflow-y-auto pb-2" aria-label="Kept text">
   {data.startLine > 1 && <div className="px-3 py-1.5"><Button variant="ghost" onClick={() => setStart(Math.max(1, data.startLine - CHUNK))}>Show lines {Math.max(1, data.startLine - CHUNK)}–{data.startLine - 1}</Button></div>}
   <table className="w-full table-fixed border-collapse text-[12.5px] leading-5">
    <tbody>
     {lines.map((line, i) => {
      const n = first + i;
      const isSel = sel && n >= sel[0] && n <= sel[1];
      const isCited = cited(n);
      const isTarget = target && n >= target[0] && n <= target[1];
      const heading = /^#{1,6}\s/u.test(line);
      return [<tr key={n} data-line={n} onClick={(e) => pick(n, e.shiftKey)} className={cx("cursor-text", isSel ? "bg-surface-selected" : isCited ? "bg-success/15" : isTarget ? "bg-warning/10" : "hover:bg-state-hover")}>
       <td className={cx("w-10 select-none pr-2.5 text-right align-top font-mono text-[11px] text-subtle-foreground", isSel ? "shadow-[inset_3px_0_0_var(--ring)]" : isCited ? "shadow-[inset_3px_0_0_var(--success)]" : isTarget && "shadow-[inset_3px_0_0_var(--warning)]")}>{n}</td>
       <td className={cx("whitespace-pre-wrap break-words pr-3 align-top", heading && "pt-1 font-semibold", line.startsWith("|") && "font-mono text-[11.5px]")}>{heading ? plainHeading(line) : line ? <Inline text={line} /> : "\u00a0"}</td>
      </tr>, isSel && sel && n === sel[1] && selected ? <tr key={`${n}-tools`}><td /><td className="py-1">
       <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-md">
        {composer && <Button variant="primary" icon="quote" disabled={!selectedText} onClick={() => { composer.insert(quoteText(selected), { at: "end", block: true }); composer.focus(); setSel(null); }}>Quote in message</Button>}
        <Button icon="copy" disabled={!selectedText} onClick={() => { void copyToClipboard({ text: citationText(selected) }).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy citation"}</Button>
        {onCheck && <Button variant="ghost" icon="forage" disabled={!selectedText} onClick={() => onCheck(selectedText.slice(0, 2000))}>Check sources</Button>}
       </div>
      </td></tr> : null];
     })}
    </tbody>
   </table>
   {data.endLine < data.totalLines && <div className="px-3 pt-2"><Button variant="ghost" onClick={() => setStart(data.endLine + 1)}>Show lines {data.endLine + 1}–{Math.min(data.totalLines, data.endLine + CHUNK)} of {data.totalLines.toLocaleString()}</Button></div>}
  </div>
 </>;
}

function Compare({ scope, before, after, onExit }: { scope: SourceScope; before: { id: string; fetchedAt: number }; after: { id: string; fetchedAt: number }; onExit(): void }) {
 const diff = useQuery({ contract: rpcContract, method: "diffSnapshots", input: { scope, beforeSnapshotId: before.id, afterSnapshotId: after.id, maxHunks: 100, maxChars: 32_000 } });
 return <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-3 py-2">
  <div className="flex items-center gap-1.5 pb-2 text-xs"><Glyph name="diff" /><b className="font-semibold">{when(before.fetchedAt)}</b><Glyph name="arrow-right" className="size-3 text-subtle-foreground" /><b className="font-semibold">{when(after.fetchedAt)}</b><span className="flex-1" />
   {diff.data && !diff.data.unchanged && <span><span className="text-diff-added">+{diff.data.addedLines}</span> <span className="text-diff-removed">−{diff.data.removedLines}</span></span>}<Button variant="ghost" className="h-6" onClick={onExit}>Show the text</Button></div>
  <ErrorLine error={diff.error} />
  {!diff.data && !diff.error && <Loading label="Comparing versions…" />}
  {diff.data?.unchanged && <p className="text-xs text-muted-foreground">The two versions say the same thing.</p>}
  {diff.data?.hunks.map((h, i) => <div key={i} className="mb-2 overflow-hidden rounded-lg border border-border bg-card">
   <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs"><Tag tone={h.kind === "added" ? "good" : h.kind === "removed" ? "bad" : "warn"}>{{ added: "Added", removed: "Removed", changed: "Changed" }[h.kind]}</Tag><span className="truncate">{h.headingPath.join(" › ") || "Top of the page"}</span></div>
   {h.before && h.kind !== "added" && <pre className="whitespace-pre-wrap break-words bg-diff-removed/10 px-2.5 py-1 font-sans text-xs">{h.before.text}</pre>}
   {h.after && h.kind !== "removed" && <pre className="whitespace-pre-wrap break-words bg-diff-added/10 px-2.5 py-1 font-sans text-xs">{h.after.text}</pre>}
  </div>)}
  {diff.data?.truncated && <p className="text-[11px] text-muted-foreground">The comparison stopped at its size limit.</p>}
 </div>;
}
