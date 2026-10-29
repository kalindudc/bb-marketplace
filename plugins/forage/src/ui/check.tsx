import { useState, type ReactNode } from "react";
import { experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery, useComposer } from "@get-bb/plugin-sdk/app";
import type { ThreadScope } from "../research/activity.ts";
import { rpcContract } from "./contract.ts";
import { Button, ErrorLine, Glyph, hostOf, Loading, Notice, plainText, plural, Tag, Tile, when } from "./kit.tsx";
import { quoteText } from "./reader.tsx";

function highlight(text: string, terms: readonly string[]): ReactNode[] {
 if (terms.length === 0) return [text];
 const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
 // Terms match at the start of a word, the same way Forage found them.
 return text.split(new RegExp(`(?<![\\p{L}\\p{N}])((?:${escaped})[\\p{L}\\p{N}]*)`, "giu")).map((part, i) => (i % 2 === 1 ? <mark key={i} className="rounded-sm bg-warning/30 px-px text-foreground">{part}</mark> : part));
}

export function CheckInSources({ scope, text, canQuote, onOpen, onSearched }: { scope: ThreadScope; text: string; canQuote: boolean; onOpen(sourceId: string, snapshotId: string, lines: [number, number]): void; onSearched(): void }) {
 const result = useQuery({ contract: rpcContract, method: "findInSources", input: { scope, text: text.slice(0, 2000) } });
 const run = useMutation({ contract: rpcContract, method: "run" });
 const composer = useComposer();
 const [message, setMessage] = useState<string | null>(null);
 async function searchWeb() {
  try {
   const out = await run.mutate({ projectId: scope.projectId, threadId: scope.threadId, operation: "search", query: text.replace(/\s+/gu, " ").slice(0, 200), via: "tab" });
   if (out.ok) onSearched(); else setMessage(out.message);
  } catch (error) { setMessage(error instanceof Error ? error.message : "The search did not run."); }
 }
 const matches = result.data?.matches ?? [];
 const latest = matches.filter((m) => m.latest);
 const older = matches.filter((m) => !m.latest);
 return <div className="grid gap-2 px-3 pb-4 pt-1">
  <div className="grid gap-1.5 rounded-xl border border-border bg-surface-recessed/60 px-3 py-2.5">
   <p className="flex items-center gap-1.5 text-xs font-semibold"><Glyph name="forage" />Check in sources</p>
   <blockquote className="border-l-[3px] border-primary pl-2.5 text-[12.5px]">{text.length > 600 ? `${text.slice(0, 600)}…` : text}</blockquote>
   <p className="text-[11.5px] text-muted-foreground">{result.data ? `Forage looked for these words in ${plural(result.data.scanned, "kept page")}.` : "Forage looks for these words in the pages this thread kept."} It shows where they appear; it does not judge whether the sentence is true.</p>
  </div>
  <ErrorLine error={result.error} />
  {!result.data && !result.error && <Loading label="Looking through kept pages…" />}
  {result.data && result.data.terms.length === 0 && <p className="text-xs text-muted-foreground">There are no words here to look for. Select a longer passage.</p>}
  {latest.length > 0 && <h4 className="px-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Found in {plural(latest.length, "source")}</h4>}
  {latest.map((m) => <Match key={m.sourceId} m={m} terms={result.data!.terms} canQuote={canQuote} composer={composer} onOpen={onOpen} />)}
  {older.length > 0 && <h4 className="px-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Only in an earlier version</h4>}
  {older.map((m) => <Match key={m.sourceId} m={m} terms={result.data!.terms} canQuote={canQuote} composer={composer} onOpen={onOpen} />)}
  {result.data && result.data.terms.length > 0 && matches.length === 0 && <p className="text-xs text-muted-foreground">No kept page in this thread uses enough of these words.</p>}
  {message && <Notice tone="bad" icon="warning">{message}</Notice>}
  {result.data && <div><Button icon="search" disabled={run.isPending} onClick={() => { void searchWeb(); }}>{run.isPending ? "Searching…" : "Search the web for this"}</Button></div>}
 </div>;
}

function Match({ m, terms, canQuote, composer, onOpen }: { m: { sourceId: string; snapshotId: string; title: string; url: string; startLine: number; endLine: number; lines: string[]; matched: string[]; latest: boolean; fetchedAt: number }; terms: readonly string[]; canQuote: boolean; composer: ReturnType<typeof useComposer>; onOpen(sourceId: string, snapshotId: string, lines: [number, number]): void }) {
 const strong = m.matched.length >= Math.max(2, Math.ceil(terms.length * 0.7));
 return <div className="grid gap-1.5 rounded-xl border border-border bg-card px-3 py-2.5 text-[12.5px]">
  <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
   <Tile label={hostOf(m.url)} className="size-4 text-[9px]" /><b className="truncate font-semibold">{m.title || hostOf(m.url)}</b>
   <span className="truncate text-[11.5px] text-subtle-foreground">{hostOf(m.url)} · {m.startLine === m.endLine ? `line ${m.startLine}` : `lines ${m.startLine}–${m.endLine}`}</span>
   <span className="flex-1" /><Tag tone={strong ? "good" : "neutral"}>{strong ? "Close match" : `${m.matched.length} of ${terms.length} words`}</Tag>
  </div>
  <p className="leading-relaxed">{highlight(plainText(m.lines.join("\n")), m.matched)}</p>
  {!m.latest && <Notice tone="warn" icon="diff">This is from the version read {when(m.fetchedAt)}. The latest version no longer says it.</Notice>}
  <div className="flex flex-wrap gap-1.5">
   <Button onClick={() => onOpen(m.sourceId, m.snapshotId, [m.startLine, m.endLine])}>Open at these lines</Button>
   {canQuote && <Button variant="ghost" icon="quote" onClick={() => { composer.insert(quoteText({ title: m.title, url: m.url, snapshotId: m.snapshotId, startLine: m.startLine, endLine: m.endLine, lines: m.lines }), { at: "end", block: true }); composer.focus(); }}>Quote in message</Button>}
  </div>
 </div>;
}
