import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { rpcContract, type BoardQuestDetail } from "../../shared/contract";
import { attentionNotes, attentionView } from "../../shared/attention";
import type { Ask, KeeperNote, SummaryEntry, SummaryView } from "../../shared/schema";
import { Glyph, plural, QueryState, TimeAgo } from "../kit";
import { SummaryCard } from "../kit/summary-card";
import { Section } from "./common";

function useSummaryVisit(questId: string, summaries: SummaryEntry[] | undefined) {
  const seen = experimental_useRpcMutation({ contract: rpcContract, method: "markSummariesSeen" });
  const send = useRef(seen.mutate);
  const latest = useRef<string[]>([]);
  const visit = useRef<{ ids: Set<string>; sent: Set<string> } | null>(null);
  useEffect(() => { send.current = seen.mutate; }, [seen.mutate]);
  useEffect(() => {
    const current = { ids: new Set<string>(), sent: new Set<string>() };
    visit.current = current;
    const flush = () => {
      const ids = [...current.ids].filter(id => !current.sent.has(id));
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        batch.forEach(id => current.sent.add(id));
        void send.current({ boardQuestId: questId, ids: batch }).catch(error => {
          batch.forEach(id => current.sent.delete(id));
          console.warn("Could not acknowledge Tavern summaries", error);
        });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else current.ids = new Set(latest.current);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      if (visit.current === current) visit.current = null;
      queueMicrotask(() => { if (visit.current === null) flush(); });
    };
  }, [questId]);
  useEffect(() => {
    latest.current = (summaries ?? []).filter(s => !s.seen && s.correctedBy === null && s.body !== undefined).map(s => s.id);
    if (visit.current && document.visibilityState !== "hidden") visit.current.ids = new Set(latest.current);
  }, [summaries, questId]);
}

type View = { detail: BoardQuestDetail; focusId?: string; tale?: boolean };
function ReadSummary({ summary, detail, focusId, tale, ask, handBack }: View & { summary: SummaryView; ask?: Ask | null; handBack?: KeeperNote | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusId !== summary.id) return;
    const card = ref.current?.querySelector("article");
    const frame = requestAnimationFrame(() => { card?.scrollIntoView?.({ block: "start" }); card?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [focusId, summary.id]);
  return <div ref={ref}><SummaryCard summary={summary} document={detail.summaryDocument} history={tale}
    ask={ask ?? detail.asks.find(ask => ask.id === summary.request?.id)} handBack={handBack ?? attentionNotes(attentionView(detail.attention)).find(note => note.id === summary.request?.id)}>
    {summary.supersedes && <SummaryFold detail={detail} id={summary.supersedes} title={summary.previousTitle ?? detail.summaries?.find(item => item.id === summary.supersedes)?.title ?? "Earlier summary"} corrected focusId={focusId} tale={tale} />}
  </SummaryCard></div>;
}

function DeferredSummary({ id, detail, focusId, tale }: View & { id: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "summary", input: { id, threadId: detail.quest.keeperThreadId } });
  const summary = query.data?.summary;
  if (summary?.boardQuestId === detail.quest.id) return <ReadSummary summary={summary} detail={detail} focusId={focusId} tale={tale} ask={query.data?.ask} handBack={query.data?.handBack} />;
  if (query.data) return <p className="m">This summary is no longer available on this quest.</p>;
  return <QueryState label="the Keeper’s summary" error={query.error} loading={query.isLoading} retry={() => void query.refetch()} />;
}

function SummaryFold({ id, title, detail, focusId, tale, corrected, at, revealId }: View & { id: string; title: string; corrected?: boolean; at?: number; revealId?: string }) {
  const reveal = focusId === id || focusId !== undefined && focusId === revealId;
  const [open, setOpen] = useState(reveal);
  useEffect(() => { if (reveal) setOpen(true); }, [reveal]);
  return <details className="tv-sum-fold" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Glyph name="chevron" size={12} /><span data-content>{title}</span>{corrected ? <span className="m">corrected</span> : at !== undefined && <TimeAgo at={at} />}</summary>
    {open && <DeferredSummary id={id} detail={detail} focusId={focusId} tale={tale} />}
  </details>;
}

function SummaryHistory({ detail, focusId, tale }: View) {
  const older = experimental_useRpcMutation({ contract: rpcContract, method: "olderSummaries" });
  const [pages, setPages] = useState<{ entries: SummaryEntry[]; nextCursor: string | null }>();
  const entries = new Map((pages?.entries ?? []).map(item => [item.id, item]));
  for (const item of detail.summaries ?? []) entries.set(item.id, item);
  const superseded = new Set([...entries.values()].flatMap(item => item.supersedes ? [item.supersedes] : []));
  const current = [...entries.values()].filter(item => item.correctedBy === null && !superseded.has(item.id));
  current.sort((a, b) => (b.order ?? b.createdAt) - (a.order ?? a.createdAt));
  if (tale) current.reverse();
  const totals = detail.summaryCounts ?? { current: current.length, corrected: entries.size - current.length };
  const cursor = pages ? pages.nextCursor : detail.summariesNextCursor;
  const left = Math.max(0, totals.current - current.length);
  const linkedOutsideList = focusId && !current.some(item => item.id === focusId || item.supersedes === focusId);
  if (!current.length && !linkedOutsideList) return null;
  const load = () => {
    if (!cursor) return;
    void older.mutate({ boardQuestId: detail.quest.id, beforeId: cursor }).then(page => setPages(previous => ({ entries: [...(previous?.entries ?? []), ...page.summaries], nextCursor: page.nextCursor }))).catch(() => { /* The mutation error is shown next to the control. */ });
  };
  return <Section title={tale ? "Along the way" : "Summaries"} count={`${plural(totals.current, "summary", "summaries")}${totals.corrected ? `, ${totals.corrected} corrected` : ""}`} className="tv-card tv-sum-sec">
    {linkedOutsideList && <DeferredSummary id={focusId} detail={detail} focusId={focusId} tale={tale} />}
    {tale && cursor && <button type="button" className="btn sm tv-sum-more" disabled={older.isPending} onClick={load}>Show {left} older</button>}
    <ol className="tv-sums">{current.map(summary => <li key={summary.id}>
      {summary.body !== undefined && summary.links !== undefined
        ? <ReadSummary summary={{ ...summary, body: summary.body, links: summary.links }} detail={detail} focusId={focusId} tale={tale} />
        : <SummaryFold detail={detail} id={summary.id} title={summary.title} at={summary.createdAt} focusId={focusId} revealId={summary.supersedes} tale={tale} />}
    </li>)}</ol>
    {!tale && cursor && <button type="button" className="btn sm tv-sum-more" disabled={older.isPending} onClick={load}>Show {left} older</button>}
    <QueryState error={older.error} />
  </Section>;
}

export function TaleSummaries({ detail }: { detail: BoardQuestDetail }) {
  return <SummaryHistory key={detail.quest.id} detail={detail} tale />;
}

export function QuestSummaries({ detail, focusId }: { detail: BoardQuestDetail; focusId?: string }) {
  useSummaryVisit(detail.quest.id, detail.summaries);
  const phaseSeen = experimental_useRpcMutation({ contract: rpcContract, method: "markVisitSeen" });
  const sentChange = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = detail.visitChangeId;
    if (!id || sentChange.current === id) return;
    sentChange.current = id;
    void phaseSeen.mutate({ summaryIds: [], changeIds: [id] }).catch(error => { sentChange.current = undefined; console.warn("Could not acknowledge Tavern quest change", error); });
  }, [detail.visitChangeId, phaseSeen.mutate]);
  return <SummaryHistory key={detail.quest.id} detail={detail} focusId={focusId} />;
}
