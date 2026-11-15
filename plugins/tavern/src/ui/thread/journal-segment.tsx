import { useEffect, useRef, useState, type CSSProperties } from "react";
import { experimental_ThreadContextCardRow as CardRow, experimental_useAppPanel, experimental_useRpcMutation, experimental_useRpcQuery, experimental_useThreadContextKind, type ExperimentalThreadContextCardProps, type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { JournalEntry, JournalProgress } from "../../shared/schema";
import { Glyph, QueryState, SkBlock, SkGlyph, SkLine, Skeleton, StatusMark, readRemembered, skWidths, useSkeletonDelay, writeRemembered } from "../kit";
import { JOURNAL_TAB } from "./tabs";
import { useCardShown, useCardShownRef } from "./card-shown";
import "./journal-segment.css";

const isOpen = (e: JournalEntry) => e.status !== "done" && e.status !== "verified";

/** "Journal (checklist): 17 of 22 done, 1 blocked": the accessible name and tooltip at every width. */
export function journalSummaryLabel({ done, total, blocked }: JournalProgress) {
  return `Journal (checklist): ${done} of ${total} done${blocked > 0 ? `, ${blocked} blocked` : ""}`;
}

/** The current entry first, then the open entries in journal order (each top-level entry followed by its steps). */
export function nextEntries(entries: JournalEntry[], currentId: string | null, limit: number) {
  const byOrder = (a: JournalEntry, b: JournalEntry) => a.order - b.order;
  const ordered = entries.filter(e => e.parentId === null).sort(byOrder).flatMap(top => [top, ...entries.filter(e => e.parentId === top.id).sort(byOrder)]);
  const open = ordered.filter(isOpen);
  const current = open.find(e => e.id === currentId);
  const list = current ? [current, ...open.filter(e => e !== current)] : open;
  return { shown: list.slice(0, limit), more: Math.max(0, list.length - limit) };
}

function useDecor(threadId: string) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
}

/**
 * The journal shows in exactly one place: in the card's section while the pane really shows the card, above the composer otherwise.
 * bb reports "card" for wide panes even while the card is hidden, so the kind alone is not enough (card-shown.ts); an unknown card reads
 * as not shown, which keeps the segment rather than losing the journal.
 */
export function useJournalSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput) {
  const kind = experimental_useThreadContextKind();
  const cardShown = useCardShown(threadId);
  const decor = useDecor(threadId);
  const [seenWidth] = useState(() => segmentSeenWidth(threadId));
  // While the journal loads, the segment holds its place only where this device last saw it, so bb's row never gains a stranger.
  const has = decor.data ? decor.data.progress.total > 0 : decor.isLoading && seenWidth > 0;
  return has && !(kind === "card" && cardShown);
}

const segmentKey = (threadId: string) => `skel:thread:segment:${threadId}`;
/** The summary's width when this device last drew it on this thread, 0 when it did not: the skeleton takes it, so git's segment beside it stays put. */
function segmentSeenWidth(threadId: string) { const v = readRemembered<number>(segmentKey(threadId)); return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(400, Math.round(v))) : 0; }
function useRememberSegmentWidth(threadId: string, shown: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    const w = shown ? Math.round(ref.current?.getBoundingClientRect().width ?? 0) : 0;
    if (shown && w === 0) return; // not laid out (a hidden row): keep what was seen
    if (w !== last.current) { last.current = w; writeRemembered(segmentKey(threadId), w); }
  });
  return ref;
}

/** The summary while the journal loads: its mark, bar and count as shapes, at bb's segment height and the width it last had. */
export function SkJournalSegment({ width, shown }: { width: number; shown: boolean }) {
  return <Skeleton label="the journal" shown={shown} className="tavern jseg-sum jseg-skel">
    <span className="jseg-skel-in" style={{ "--jseg-w": `${width}px` } as CSSProperties}><SkGlyph size={14} /><SkBlock w={34} h={4} className="jseg-skbar" /><SkLine w="5ch" /></span>
  </Skeleton>;
}

/** The journal mark from icons/journal.svg, drawn inline so it renders wherever bb's icon registry has not loaded Tavern's set. */
function JournalMark({ size = 14 }: { size?: number }) {
  return <svg className="tavern-glyph jseg-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="square" strokeLinejoin="miter"><path d="M3.5 5.5 5.5 7.5 9 4M12.5 6h8M3.5 11.5 5.5 13.5 9 10M12.5 12h8M4 16h4v4H4ZM12.5 18h8" /></svg>;
}

function ProgressBar({ progress }: { progress: JournalProgress }) {
  const { done, total, blocked } = progress;
  if (total === 0) return null;
  return <span className="jseg-bar" aria-hidden="true"><i className="d" style={{ flexGrow: done }} /><i className="b" style={{ flexGrow: blocked }} /><i className="o" style={{ flexGrow: Math.max(0, total - done - blocked) }} /></span>;
}

export function JournalSegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const decor = useDecor(threadId);
  const progress = decor.data?.progress;
  const [seenWidth] = useState(() => segmentSeenWidth(threadId));
  const loading = !decor.data && decor.isLoading && seenWidth > 0;
  const shown = useSkeletonDelay(loading);
  const ref = useRememberSegmentWidth(threadId, !!progress && progress.total > 0);
  if (loading) return <SkJournalSegment width={seenWidth} shown={shown} />;
  if (!progress || progress.total === 0) return null;
  const label = journalSummaryLabel(progress);
  return (
    <button ref={ref} type="button" data-segment-summary className="tavern jseg-sum" aria-expanded={isExpanded} aria-label={label} title={`${label}. ${isExpanded ? "Hide" : "Show"} what is next`} onClick={onToggle}>
      <JournalMark />
      <ProgressBar progress={progress} />
      <span className="jseg-n num"><span className="jseg-long">{progress.done} of {progress.total}</span><span className="jseg-short">{progress.done}/{progress.total}</span></span>
      {progress.blocked > 0 && <span className="jseg-blk"><StatusMark status="blocked" size={12} /><span className="num">{progress.blocked}</span></span>}
      <Glyph name="chevron" size={11} className={`jseg-chev ${isExpanded ? "down" : ""}`} />
    </button>
  );
}

function useJournalActions(threadId: string) {
  const panel = experimental_useAppPanel();
  const edit = experimental_useRpcMutation({ contract: rpcContract, method: "journalEdit" });
  const [error, setError] = useState<unknown>(null);
  const openJournal = (focus?: string) => panel.openTab({ tab: JOURNAL_TAB, ...(focus ? { params: { focus } } : {}) });
  /** Linked work needs evidence and board mirrors move with their phase, so neither ticks from here: the journal opens on it instead. */
  const needsJournal = (e: JournalEntry) => !!e.boardQuestId || (e.link !== null && e.evidence.length === 0);
  const tick = (e: JournalEntry) => {
    if (needsJournal(e)) { openJournal(e.id); return; }
    setError(null);
    void edit.mutate({ threadId, edit: { op: "status", entryIds: [e.id], status: "done" } }).catch(setError);
  };
  const tickLabel = (e: JournalEntry) => e.boardQuestId ? `Open “${e.description}” in the journal: it follows its board quest’s phase` : needsJournal(e) ? `Mark “${e.description}” done: add evidence in the journal first` : `Mark “${e.description}” done`;
  return { openJournal, tick, tickLabel, pending: edit.isPending, error };
}

const DETAIL_LIMIT = 4;

export function JournalSegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  if (!isExpanded) return null;
  return <SegmentDetails threadId={threadId} />;
}

function SegmentDetails({ threadId }: { threadId: string }) {
  const journal = experimental_useRpcQuery({ contract: rpcContract, method: "journal", input: { threadId } });
  const { openJournal, tick, tickLabel, pending, error } = useJournalActions(threadId);
  const data = journal.data;
  const progress = useDecor(threadId).data?.progress;
  if (!data) return <div className="tavern jseg-det"><QueryState error={journal.error} loading={journal.isLoading} retry={() => void journal.refetch()} label="what is next in the journal" skeleton={<SkSegmentDetails progress={progress} />} /></div>;
  const { shown, more } = nextEntries(data.entries, data.progress.current?.id ?? null, DETAIL_LIMIT);
  const stepsOf = (id: string) => data.entries.filter(s => s.parentId === id);
  return (
    <div className="tavern jseg-det">
      {shown.length === 0 ? <p className="jseg-none m">All {data.progress.total} done.</p> : (
        <ul aria-label="Next in the journal">
          {shown.map(e => (
            <li key={e.id} className={`jseg-row s-${e.status} ${e.id === data.progress.current?.id ? "cur" : ""}`}>
              <button type="button" className="jseg-tick" disabled={pending} aria-label={tickLabel(e)} title={tickLabel(e)} onClick={() => tick(e)}><StatusMark status={e.status} size={14} /></button>
              <button type="button" className="jseg-open" title={e.description} aria-label={`Open “${e.description}” in the journal${e.status === "todo" ? "" : `, ${e.status}`}`} onClick={() => openJournal(e.id)}>
                <span className="id">{e.id}</span><span className="t" data-content>{e.description}</span>{e.status === "blocked" && <span className="flag">blocked</span>}{e.status === "rejected" && <span className="flag bad">rejected</span>}{(() => { const steps = stepsOf(e.id); return steps.length > 0 && <span className="cnt num" title={`${steps.filter(s => !isOpen(s)).length} of ${steps.length} steps done`}>{steps.filter(s => !isOpen(s)).length}/{steps.length}</span>; })()}
              </button>
            </li>
          ))}
        </ul>
      )}
      <QueryState error={error} />
      <div className="jseg-foot">
        {more > 0 ? <span className="m num">+{more} more open</span> : <span />}
        <button type="button" className="jseg-all" onClick={() => openJournal()}>Open the journal<Glyph name="chevron" size={11} /></button>
      </div>
    </div>
  );
}

/** The details while the journal loads: the summary already knows how many open entries there are, so the rows are exact. */
function SkSegmentDetails({ progress }: { progress: JournalProgress | undefined }) {
  const open = progress ? progress.total - progress.done : DETAIL_LIMIT;
  const rows = Math.min(DETAIL_LIMIT, open);
  return <>
    {rows === 0 ? <p className="jseg-none"><SkLine w="10ch" /></p> : <ul>{skWidths(rows).map((w, i) => <li key={i} className="jseg-row"><span className="jseg-tick"><SkGlyph size={14} /></span><span className="jseg-open"><span className="id"><SkLine w="2ch" /></span><span className="t"><SkLine w={w} /></span></span></li>)}</ul>}
    <div className="jseg-foot">{open > DETAIL_LIMIT ? <span><SkLine w="10ch" /></span> : <span />}<span className="jseg-all"><SkLine w="14ch" /></span></div>
  </>;
}

/** The thread context card's Journal section: the same glance as the segment, in bb's card rows. Its root tells the segment when the card is on screen. */
export function JournalCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const progress = useDecor(threadId).data?.progress;
  const ref = useCardShownRef(threadId);
  if (!progress || progress.total === 0) return null;
  return <div ref={ref} className="jseg-card"><CardSectionRows threadId={threadId} progress={progress} /></div>;
}

function CardSectionRows({ threadId, progress }: { threadId: string; progress: JournalProgress }) {
  const journal = experimental_useRpcQuery({ contract: rpcContract, method: "journal", input: { threadId } });
  const { openJournal, tick, tickLabel, pending } = useJournalActions(threadId);
  const { shown } = nextEntries(journal.data?.entries ?? [], progress.current?.id ?? null, 3);
  const label = journalSummaryLabel(progress);
  return <>
    <CardRow icon="tavern/journal" label={`${progress.done} of ${progress.total} done${progress.blocked ? ` · ${progress.blocked} blocked` : ""}`} title={`${label}. Open the journal`} trailing={<span className="tavern jseg-card-bar"><ProgressBar progress={progress} /></span>} onClick={() => openJournal()} />
    {shown.map(e => (
      <CardRow key={e.id} leading={<span className="tavern jseg-lead"><StatusMark status={e.status} size={14} /></span>} label={e.description} title={`Open “${e.description}” in the journal`} onClick={() => openJournal(e.id)}
        action={<button type="button" className="tavern jseg-tick" disabled={pending} aria-label={tickLabel(e)} title={tickLabel(e)} onClick={() => tick(e)}><Glyph name="check" size={13} /></button>} />
    ))}
  </>;
}
