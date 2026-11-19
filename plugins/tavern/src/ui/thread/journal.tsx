import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_useAppPanel, type ExperimentalThreadTabProps, type JsonValue } from "@get-bb/plugin-sdk/app";
import { rpcContract, type JournalEdit } from "../../shared/contract";
import type { Evidence, JournalEntry, Journal } from "../../shared/schema";
import { EvidenceList, ExpandsMark, Glyph, readableEvidence, IconButton, OverflowMenu, QueryState, Ribbon, SkGlyph, SkLine, SkSegmented, StatusMark, Tally, TimeAgo, timeAgo, useNow, Vocabulary, rememberCount, skWidths, useActorNames, useJournalCues, useRegistry, useSkeletonCount, useSkeletonDelay, useRemembered, useRememberedView, type MenuItem } from "../kit";
import "./journal-notebook.css";
import { memberName } from "../../shared/member-name";
import { currency, delegated, TRACKER_GROUPS, trackerGroups } from "../../shared/journal-tracker";

type Change = (edit: JournalEdit) => Promise<boolean>;
type Names = ReturnType<typeof useActorNames>;
/**
 * Which thread ids the journal names, and the journal's own name. The tab works them out but never subscribes to names itself:
 * bb's query hook re-renders its subscriber on every refetch, even with equal data, and other threads' work refetches names
 * often. So only the parts that show a name (useJournalNames) re-render then, never the tab, the tally or the list.
 */
const NameInput = createContext<{ ids: string[]; self: { threadId: string; name: string | null } }>({ ids: [], self: { threadId: "", name: null } });
const useJournalNames = () => { const { ids, self } = useContext(NameInput); return useActorNames(ids, self); };
const FILTERS = { done: "Done", verified: "Verified", rejected: "Rejected", added: "Added by you" } as const;
type Filter = "all" | "open" | "stuck" | "delegated" | keyof typeof FILTERS;
const isFilter = (v: unknown): v is Filter => v === "all" || v === "open" || v === "stuck" || v === "delegated" || (typeof v === "string" && v in FILTERS);
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === "string");
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const STATUS_WORD: Record<JournalEntry["status"], string> = { todo: "to do", doing: "doing", blocked: "blocked", done: "done, not yet verified", verified: "verified", rejected: "rejected" };
const isDone = (e: JournalEntry) => e.status === "done" || e.status === "verified";
const isStuck = (e: JournalEntry) => e.status === "blocked" || e.status === "rejected";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const rowId = (threadId: string, id: string) => `journal-r-${threadId}-${id}`;
const LONG_FOLD = 20;
const ShowAll = ({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) => <button type="button" className="lnk-btn act journal-more" aria-expanded={open} onClick={onToggle}><ExpandsMark open={open} />{open ? "Show fewer" : `Show all ${count}`}</button>;
/** Focus an element once React has drawn it (the row after an edit, the field after a menu choice). */
/**
 * Keeps whatever takes focus in the list clear of the sticky header (WCAG 2.4.11). The browser scrolls a focused field only into
 * the scroller's box, which the header covers, so after its scroll this moves the field, or its whole form with Save and Cancel
 * when that fits, just below the header's real bottom edge (or up from the bottom).
 */
function keepClearOfHeader(target: HTMLElement) {
  const root = target.closest<HTMLElement>(".tavern.journal");
  const head = root?.querySelector<HTMLElement>(".journal-head");
  if (!root || !head || head.contains(target)) return;
  // Not laid out (an element about to be replaced, or display: none): it has no place to keep clear, and its zero box reads as y 0.
  const own = target.getBoundingClientRect();
  if (own.width === 0 && own.height === 0) return;
  let scroller: HTMLElement | null = root;
  while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
  scroller ??= document.scrollingElement as HTMLElement | null;
  if (!scroller) return;
  const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
  const top = Math.max(head.getBoundingClientRect().bottom, box.top) + 8;
  const bottom = Math.min(box.bottom, window.innerHeight) - 8;
  const form = target.closest<HTMLElement>(".journal-edit, .journal-ask, .journal-confirm, .journal-note-edit, .journal-stepadd, .journal-parent");
  const r = (form && form.getBoundingClientRect().height <= bottom - top ? form : target).getBoundingClientRect();
  if (r.top < top) scroller.scrollTop -= top - r.top;
  else if (r.bottom > bottom) scroller.scrollTop += Math.min(r.bottom - bottom, r.top - top);
}
const onListFocus = (e: { target: EventTarget }) => { const el = e.target as HTMLElement; requestAnimationFrame(() => { if (el.isConnected) keepClearOfHeader(el); }); };

const focusLater = (id: string, select?: "end") => requestAnimationFrame(() => { const el = document.getElementById(id) as HTMLInputElement | null; el?.focus(); if (select && el?.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); });

/** The block reason the server appends to the change text: ` Reason: "…".` */
function blockReason(entry: JournalEntry, changes: Journal["changes"]): string | null {
  if (entry.status !== "blocked") return null;
  const c = [...changes].reverse().find(x => x.entryIds.includes(entry.id) && / Reason: ".*"\.$/s.test(x.text));
  const m = c?.text.match(/ Reason: (".*")\.$/s);
  if (!m) return null;
  try { return JSON.parse(m[1]!) as string; } catch { return null; }
}
const reasonOf = (entry: JournalEntry, changes: Journal["changes"]) => entry.status === "rejected" ? entry.review?.reason ?? null : blockReason(entry, changes);
/** When the journal last moved. It owns the minute clock, so a tick re-renders this line alone, not the tally or the list. */
function JournalCurrency({ entries, graceMinutes }: { entries: JournalEntry[]; graceMinutes?: number }) {
  const now = useNow();
  const cur = currency(entries, now, graceMinutes === undefined ? undefined : graceMinutes * 60_000);
  if (cur.lastDoneAt === null) return null;
  return (
    <p className={`journal-cur num${cur.stale ? " stale" : ""}`} title={cur.oldestOpenAt !== null ? `Oldest open entry: ${timeAgo(cur.oldestOpenAt, now).replace(/ ago$/, "")}` : undefined}>
      Last done <TimeAgo at={cur.lastDoneAt} />{cur.stale && ` · ${plural(cur.reported, "report")} waiting`}
    </p>
  );
}
/** What a delegate last did, in one line: "Went idle 12m ago: SOURCE SETTLED for…". */
function reportLine(entry: JournalEntry, now = Date.now()): string | null {
  const r = isDone(entry) ? null : entry.report;
  if (!r) return null;
  const when = timeAgo(r.at, now);
  const head = r.kind === "idle" ? `Went idle ${when}` : r.kind === "settled" ? `Reported settled ${when}` : `Its thread was ${r.kind} ${when}`;
  return r.summary ? `${head}: ${r.summary}` : head;
}
/** An owner as a person reads it: a character's name, or an untyped thread's title up to its " · ", cut at a word, never mid-word. */
function ownerName(names: Names, owner: string): string {
  const full = names(owner).split(" · ")[0]!.trim();
  return full.length <= 24 ? full : `${full.slice(0, 24).replace(/\s+\S*$/, "") || full.slice(0, 24)}…`;
}

export function JournalTab({ threadId, params }: ExperimentalThreadTabProps & { params: JsonValue | null }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "journal", input: { threadId } });
  const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
  const registry = useRegistry();
  const edit = experimental_useRpcMutation({ contract: rpcContract, method: "journalEdit" });
  const panel = experimental_useAppPanel();
  // Filter, open entries, the folds and scroll come back when the panel reopens on this thread (per device).
  const [filter, setFilter] = useRemembered<Filter>(`journal:${threadId}:filter`, "all", isFilter);
  const [openIds, setOpenIds] = useRemembered<string[]>(`journal:${threadId}:open`, [], isIds);
  const [stepIds, setStepIds] = useRemembered<string[]>(`journal:${threadId}:steps`, [], isIds);
  const open = useMemo<ReadonlySet<string>>(() => new Set(openIds), [openIds]);
  const doneStepsShown = useMemo<ReadonlySet<string>>(() => new Set(stepIds), [stepIds]);
  const [showDone, setShowDone] = useRemembered(`journal:${threadId}:done`, false, isBool);
  const root = useRef<HTMLDivElement>(null);
  // Below 400 px the filter row holds three segments and More: of Delegated and Stuck, the one not in use folds into More.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? 1000) < 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!query.data]);
  const history = useRef<HTMLDetailsElement>(null);
  useRememberedView(root, `journal:${threadId}:view`, !!query.data);
  // The four cues (plan idea 2): fed the whole journal result, never a filtered list. The kit records the first result and cues nothing.
  // Everything up to the end of the mount's first fetch is the baseline: a cached result and the refetch after it never cue.
  useJournalCues(threadId, query.data, root, { fetching: query.isFetching });
  const skeletonRows = useSkeletonCount(journalSkeletonKey(threadId), undefined, 3);
  // The skeleton draws as many rows as the list showed here last time, counted from what was drawn (filters and folds included).
  const remembered = useRef(skeletonRows);
  useEffect(() => {
    if (!query.data) return;
    const rows = Math.min(8, root.current?.querySelector('ul.journal-list[aria-label="Journal entries"]')?.querySelectorAll(".journal-row").length ?? 0);
    if (rows !== remembered.current) { remembered.current = rows; rememberCount(journalSkeletonKey(threadId), rows); }
  });
  const [text, setText] = useState(params && typeof params === "object" && "text" in params && typeof params.text === "string" ? params.text.slice(0, 500) : "");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [jump, setJump] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const data = query.data;
  // The context row's segment opens the tab on one entry: show it, expanded, wherever the filter was.
  const focus = params && typeof params === "object" && "focus" in params && typeof params.focus === "string" ? params.focus : null;
  const focusFound = !!focus && !!data?.entries.some(e => e.id === focus);
  useEffect(() => {
    if (!focus || !focusFound) return;
    reveal(focus);
    expand(focus);
    const frame = requestAnimationFrame(() => document.getElementById(`journal-d-${threadId}-${focus}`)?.closest(".journal-entry")?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [focus, focusFound, threadId]);
  // The now line's jump: once the entry is drawn, centre its row and move focus to it.
  useEffect(() => {
    if (!jump) return;
    const frame = requestAnimationFrame(() => { const el = document.getElementById(rowId(threadId, jump)); el?.scrollIntoView?.({ block: "center" }); el?.focus({ preventScroll: true }); setJump(null); });
    return () => cancelAnimationFrame(frame);
  }, [jump, threadId, filter, showDone]);
  const member = decor.data?.member ?? null;
  const selfName = member && registry.data ? memberName(member, registry.data) : null;
  const nameIds = data ? [...data.entries.flatMap(e => [e.updatedBy, e.createdBy, e.doneBy, e.review?.actor ?? null].flatMap(a => a && a.kind === "agent" ? [a.threadId] : [])), ...data.entries.flatMap(e => e.owner ? [e.owner] : []), ...data.changes.flatMap(c => c.actor.kind === "agent" ? [c.actor.threadId] : [])] : [];
  const idKey = [...new Set(nameIds)].sort().join(",");
  const nameInput = useMemo(() => ({ ids: idKey ? idKey.split(",") : [], self: { threadId, name: selfName } }), [idKey, threadId, selfName]);

  const change: Change = async value => {
    setError(null);
    try { const result = await edit.mutate({ threadId, edit: value }); setMessage(result.message); if (value.op !== "clear") setReceipt(null); return true; }
    catch (e) { setError(e); return false; }
  };
  const toggle = (id: string) => setOpenIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id].slice(-200));
  const expand = (id: string) => setOpenIds(prev => prev.includes(id) ? prev : [...prev, id].slice(-200));
  const toggleSteps = (id: string) => setStepIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id].slice(-200));
  /** Make an entry visible in the list: All, and the Done fold open if its top-level entry is done. */
  function reveal(id: string) {
    const entry = data?.entries.find(e => e.id === id);
    if (!entry) return;
    setFilter("all");
    const top = data!.entries.find(e => e.id === entry.parentId) ?? entry;
    if (isDone(top)) setShowDone(true);
    if (entry.parentId && isDone(entry)) setStepIds(prev => prev.includes(entry.parentId!) ? prev : [...prev, entry.parentId!]);
  }

  if (!data) return <div className="tavern journal notebook" ref={root}>
    <SkJournalHead rows={skeletonRows} loading={query.isLoading && !query.error} />
    <QueryState error={query.error} loading={query.isLoading} retry={() => void query.refetch()} label="the journal" skeleton={<SkJournal rows={skeletonRows} />} />
  </div>;
  const tops = data.entries.filter(e => e.parentId === null).sort((a, b) => a.order - b.order);
  const stepsOf = (id: string) => data.entries.filter(e => e.parentId === id).sort((a, b) => a.order - b.order);
  const matches = (e: JournalEntry) => filter === "all" || (filter === "open" ? !isDone(e) : filter === "stuck" ? isStuck(e) : filter === "delegated" ? !isDone(e) && delegated(e) : filter === "added" ? e.createdBy.kind === "user" : e.status === filter);
  const visible = (e: JournalEntry) => matches(e) || stepsOf(e.id).some(matches);
  const ordered = tops.flatMap(t => [t, ...stepsOf(t.id)]);
  const groups = trackerGroups(data.entries);
  const delegatedCount = groups.reduce((n, g) => n + g.entries.length, 0);
  const shown = filter === "all" ? tops.filter(e => !isDone(e)) : filter === "stuck" ? ordered.filter(isStuck) : filter === "delegated" ? groups.flatMap(g => g.entries) : tops.filter(visible);
  const doneTops = filter === "all" ? tops.filter(isDone) : [];
  const { done, total, blocked } = data.progress;
  const rejected = data.entries.filter(e => e.status === "rejected").length;
  const stuck = blocked + rejected;
  // Proven work: only a Warden's verdict counts, never the agent's own tick (most journals have none).
  const verified = data.entries.filter(e => e.status === "verified").length;
  const crowded = narrow && delegatedCount > 0 && stuck > 0;
  const foldStuck = crowded && filter !== "stuck";
  const foldDelegated = crowded && filter === "stuck";
  const openCount = data.entries.filter(e => !isDone(e)).length;
  // The current entry is the server's choice (progress.current), never worked out again here.
  const current = data.progress.current ? data.entries.find(e => e.id === data.progress.current!.id) ?? null : null;
  const rowProps = { entries: data.entries, stepsOf, change, pending: edit.isPending, open, toggle, expand, changes: data.changes, threadId, currentId: current?.id ?? null, doneStepsShown, toggleSteps, filter };
  const add = (event: FormEvent) => { event.preventDefault(); const value = text.trim(); if (value) void change({ op: "add", descriptions: [value], parentId: null }).then(ok => { if (ok) setText(""); }); };
  const clearable = tops.filter(isDone).length;
  const clear = () => void change({ op: "clear", all: false }).then(ok => { if (ok) setReceipt(`Cleared ${clearable} done`); });
  const headMenu: MenuItem[] = [
    { id: "clear", label: `Clear done · ${clearable}`, glyph: "sweep", disabled: edit.isPending || clearable === 0, run: clear },
    { id: "history", label: `History · ${data.changes.length}`, glyph: "list", run: () => { if (history.current) { history.current.open = true; history.current.scrollIntoView?.({ block: "nearest" }); history.current.querySelector("summary")?.focus(); } } },
  ];

  return (
    <NameInput.Provider value={nameInput}>
    <div className="tavern journal notebook" data-part="JournalTab" ref={root} onFocus={onListFocus}>
      <header className="journal-head">
        <div className="journal-title">
          <h2><Vocabulary word="journal" /></h2>
          <span className="journal-tools" role="group" aria-label="Journal history">
            <IconButton glyph="undo" label="Undo the last change" disabled={!data.canUndo || edit.isPending} onClick={() => void change({ op: "undo" })} />
            <IconButton glyph="redo" label="Redo" disabled={!data.canRedo || edit.isPending} onClick={() => void change({ op: "redo" })} />
            <OverflowMenu label="Journal menu" items={headMenu} />
            <IconButton glyph="close" label="Back to chat" className="narrow-only" onClick={() => panel.close()} />
          </span>
        </div>
        {total > 0 && (
          <div className="journal-slate">
            <Tally done={done} total={total} blocked={blocked} rejected={rejected} verified={verified} reserve={stuck ? 200 : 90} />
            <span className="journal-count num" aria-hidden="true"><b>{done}</b> of {total}</span>
            {blocked > 0 && <span className="journal-k blk num" aria-hidden="true">{blocked} blocked</span>}
            {rejected > 0 && <span className="journal-k bad num" aria-hidden="true">{rejected} rejected</span>}
          </div>
        )}
        {total > 0 && <JournalCurrency entries={data.entries} graceMinutes={data.reportGraceMinutes} />}
        {current && (
          <button type="button" className="journal-now" aria-label={`${current.status === "doing" ? "Doing" : "Next"}: ${current.description}. Show it in the list`} title={current.description}
            onClick={() => { reveal(current.id); setJump(current.id); }}>
            <Ribbon variant="mark" />
            <span className="lbl">{current.status === "doing" ? "Doing" : "Next"}</span>
            <span className="id">{current.id}</span>
            <span className="t" data-content>{current.description}</span>
          </button>
        )}
        <div className="journal-filters">
          <div className="segc" role="group" aria-label="Show">
            <button type="button" className="seg" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span className="num">{data.entries.length}</span></button>
            <button type="button" className="seg" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>Open <span className="num">{openCount}</span></button>
            {delegatedCount > 0 && !foldDelegated && <button type="button" className="seg" aria-pressed={filter === "delegated"} onClick={() => setFilter("delegated")} title="Open work handed to other threads">Delegated <span className="num">{delegatedCount}</span></button>}
            {stuck > 0 && !foldStuck && <button type="button" className="seg" aria-pressed={filter === "stuck"} onClick={() => setFilter("stuck")}>Stuck <span className="num">{stuck}</span></button>}
            {filter in FILTERS && <button type="button" className="seg" aria-pressed="true" onClick={() => setFilter("all")} title="Back to all">{FILTERS[filter as keyof typeof FILTERS]} <Glyph name="close" size={11} /></button>}
          </div>
          <OverflowMenu label="More filters" align="end" trigger={<span className="seg-more">More <Glyph name="chevron" size={11} className="down" /></span>} items={[
            ...(foldDelegated ? [{ id: "delegated", label: `Delegated · ${delegatedCount}`, run: () => setFilter("delegated") }] : []),
            ...(foldStuck ? [{ id: "stuck", label: `Stuck · ${stuck}`, run: () => setFilter("stuck") }] : []),
            ...(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map(f => ({ id: f, label: FILTERS[f], run: () => setFilter(f) })),
          ]} />
        </div>
        {data.toolOwnedElsewhere && <p className="problem">pi-quests is still enabled. Disable it to let Tavern update this journal and its shared progress; imported logs are kept.</p>}
      </header>
      <QueryState error={error} />
      {message && <p className="sr" role="status">{message}</p>}
      {receipt && <p className="journal-receipt" role="status">{receipt} <button type="button" className="lnk" disabled={!data.canUndo || edit.isPending} onClick={() => void change({ op: "undo" })}>Undo</button></p>}
      {tops.length === 0 ? (
        <p className="journal-empty m">No journal entries yet. Add one below, or ask the agent to track its work in the journal.</p>
      ) : shown.length === 0 && filter === "all" ? (
        <p className="journal-alldone" role="status"><Tally done={done} total={done} verified={verified} variant="mini" maxWidth={200} /><span>{verified > 0 ? <><b>All {total} done</b> · {verified} verified by a Warden</> : <b>All {total} done.</b>}</span></p>
      ) : shown.length === 0 ? (
        <p className="journal-empty m">{filter === "stuck" ? "Nothing is stuck." : filter === "delegated" ? "Nothing is handed to another thread." : "Nothing matches this filter."}</p>
      ) : filter === "delegated" ? (
        groups.map(g => (
          <section key={g.id} className="journal-group" aria-label={TRACKER_GROUPS[g.id].label}>
            <h3 title={TRACKER_GROUPS[g.id].hint}>{TRACKER_GROUPS[g.id].label} <span className="num">{g.entries.length}</span></h3>
            <ul className="journal-list">{g.entries.map((e, i) => <EntryItem key={e.id} entry={e} siblings={g.entries} index={i} flat {...rowProps} />)}</ul>
          </section>
        ))
      ) : (
        <ul className="journal-list" aria-label="Journal entries">{shown.map((e, i) => <EntryItem key={e.id} entry={e} siblings={shown} index={i} flat={filter === "stuck"} {...rowProps} />)}</ul>
      )}
      <form className="journal-add" onSubmit={add}>
        <label className="sr" htmlFor={`journal-add-${threadId}`}>New journal entry</label>
        <input id={`journal-add-${threadId}`} value={text} maxLength={500} placeholder="Add a journal entry" onChange={e => setText(e.target.value)} />
        <button className="btn sm" type="submit" disabled={!text.trim() || edit.isPending}>Add</button>
      </form>
      {doneTops.length > 0 && (
        <div className="journal-done">
          <button type="button" className="fold" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}><Glyph name="chevron" size={12} className={showDone ? "down" : ""} /><span>Done · {doneTops.length}</span><Tally done={doneTops.length} total={doneTops.length} verified={doneTops.filter(e => e.status === "verified").length} variant="mini" maxWidth={90} /></button>
          {showDone && <ul className="journal-list" aria-label="Done entries">{(allDone ? doneTops : doneTops.slice(0, LONG_FOLD)).map((e, i) => <EntryItem key={e.id} entry={e} siblings={doneTops} index={i} {...rowProps} />)}</ul>}
          {showDone && doneTops.length > LONG_FOLD && <ShowAll open={allDone} count={doneTops.length} onToggle={() => setAllDone(!allDone)} />}
        </div>
      )}
      <details className="journal-history" data-fold="history" ref={history}>
        <summary><Glyph name="chevron" size={12} /><span>History · {data.changes.length}</span></summary>
        <JournalHistoryList changes={data.changes} all={allHistory} />
        {data.changes.length > LONG_FOLD && <ShowAll open={allHistory} count={data.changes.length} onToggle={() => setAllHistory(!allHistory)} />}
      </details>
    </div>
    </NameInput.Provider>
  );
}

/** The History fold's list: it shows who made each change, so it subscribes to names, and the tab doesn't. */
function JournalHistoryList({ changes, all }: { changes: Journal["changes"]; all: boolean }) {
  const names = useJournalNames();
  return <ol>{[...changes].reverse().slice(0, all ? undefined : LONG_FOLD).map(c => <li key={c.id}><span className="who-n">{names(c.actor)}</span><span className="tx" title={c.text} data-content>{c.text}</span><TimeAgo at={c.at} /></li>)}</ol>;
}
/** A delegated row's owner, by name; left out when the description already starts with it. */
function OwnerTag({ entry }: { entry: JournalEntry }) {
  const names = useJournalNames();
  const short = ownerName(names, entry.owner!);
  if (entry.description.startsWith(short)) return null;
  return <span className="own" title={`Owner: ${names(entry.owner)}`}>{short}</span>;
}

const journalSkeletonKey = (threadId: string) => `skel:thread:journal:${threadId}`;
/**
 * The journal's header while it loads. The title is real and stays outside the busy region, so a screen reader keeps the heading; the
 * tally, now line and filter are shapes shown at the kit's delay, in the header's own classes so its height is the loaded header's.
 */
function SkJournalHead({ rows, loading }: { rows: number; loading: boolean }) {
  const late = useSkeletonDelay(loading);
  const shape = { "aria-hidden": true, style: late ? undefined : { visibility: "hidden" as const } };
  return <header className="journal-head">
    <div className="journal-title"><h2><Vocabulary word="journal" /></h2><span className="journal-tools" aria-hidden="true"><span className="ibtn" /><span className="ibtn" /><span className="ibtn" /></span></div>
    {loading && rows > 0 && <div className="journal-slate" {...shape}><SkLine w="96px" /><span className="journal-count"><SkLine w="6ch" /></span></div>}
    {loading && rows > 0 && <div className="journal-now sk-now" {...shape}><span className="lbl"><SkLine w="4ch" /></span><span className="t"><SkLine w="62%" /></span></div>}
    {loading && <div className="journal-filters" {...shape}><SkSegmented count={2} /></div>}
  </header>;
}
/** The journal's list while it loads: the rows this device last saw, in `.journal-row`, so 44 px phone rows come from the real rule. */
export function SkJournal({ rows }: { rows: number }) {
  return rows > 0 ? <ul className="journal-list">{skWidths(rows).map((w, i) => <li key={i} className="journal-item"><div className="journal-entry"><div className="journal-row"><span className="tick"><SkGlyph size={16} /></span><span className="desc"><span className="id"><SkLine w="2ch" /></span><span className="t"><SkLine w={w} /></span></span></div></div></li>)}</ul>
    : <p className="journal-empty m"><SkLine w="70%" /></p>;
}

type RowProps = {
  entry: JournalEntry; siblings: JournalEntry[]; index: number; entries: JournalEntry[]; stepsOf: (id: string) => JournalEntry[]; filter: Filter; flat?: boolean;
  change: Change; pending: boolean; open: ReadonlySet<string>; toggle: (id: string) => void; expand: (id: string) => void; changes: Journal["changes"]; threadId: string;
  currentId: string | null; doneStepsShown: ReadonlySet<string>; toggleSteps: (id: string) => void;
};

function EntryItem(props: RowProps) {
  const { entry, stepsOf, filter, flat, doneStepsShown, toggleSteps } = props;
  const steps = stepsOf(entry.id);
  const matchesFilter = (e: JournalEntry) => filter === "all" || (filter === "open" ? !isDone(e) : filter === "added" ? e.createdBy.kind === "user" : filter === "stuck" ? isStuck(e) : filter === "delegated" ? !isDone(e) && delegated(e) : e.status === filter);
  const inFilter = steps.filter(s => matchesFilter(s) || matchesFilter(entry));
  // Done steps fold into one row under their parent, so unfinished work stays in view; the fold opens in place.
  const folding = filter === "all" && !isDone(entry);
  const doneSteps = folding ? inFilter.filter(isDone) : [];
  const unfolded = folding && doneStepsShown.has(entry.id);
  const shownSteps = folding && !unfolded ? inFilter.filter(s => !isDone(s)) : inFilter;
  return (
    <li className="journal-item">
      <EntryRow {...props} steps={steps} reasons={!!flat} />
      {!flat && (shownSteps.length > 0 || doneSteps.length > 0) && (
        <ul className="journal-steps" aria-label={`Steps of ${entry.description}`}>
          {doneSteps.length > 0 && <li className="journal-item"><button type="button" className="journal-row journal-stepfold" aria-expanded={unfolded} onClick={() => toggleSteps(entry.id)}><span className="tal" aria-hidden="true"><Glyph name="check" size={12} /></span><span>{plural(doneSteps.length, "done step")}</span><Glyph name="chevron" size={11} className={unfolded ? "down" : ""} /></button></li>}
          {shownSteps.map((s, i) => <li key={s.id} className="journal-item"><EntryRow {...props} entry={s} siblings={shownSteps} index={i} steps={[]} reasons={false} /></li>)}
        </ul>
      )}
    </li>
  );
}

type Pending = null | "done" | "blocked" | "note";
function EntryRow({ entry, siblings, index, entries, steps, change, pending, open, toggle, expand, changes, threadId, currentId, reasons }: RowProps & { steps: JournalEntry[]; reasons: boolean }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState<Pending>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const expanded = open.has(entry.id);
  const detailId = `journal-d-${threadId}-${entry.id}`;
  const descId = rowId(threadId, entry.id);
  const linked = entry.link !== null;
  const mirror = entry.boardQuestId !== null;
  const done = isDone(entry);
  const isNow = currentId === entry.id;
  const name = `“${entry.description}”`;
  const stepsDone = steps.filter(isDone).length;
  const reason = reasons ? reportLine(entry) ?? reasonOf(entry, changes) : null;
  const reported = !done && !!entry.report;
  // The counts marked .wide hide on phones; the tooltip keeps them.
  const rowTitle = [entry.description, mirror ? "follows its board quest" : null, linked ? `linked to waypoint ${entry.link!.waypointId}` : null, entry.evidence.length ? `${entry.evidence.length} evidence` : null].filter(Boolean).join(" · ");
  useEffect(() => { if (deleting) cancelRef.current?.focus(); }, [deleting]);

  function tick() {
    if (entry.status === "verified" || mirror) return;
    if (done) { void change({ op: "status", entryIds: [entry.id], status: "todo" }); return; }
    if (linked && entry.evidence.length === 0) { setAsking("done"); expand(entry.id); return; }
    void change({ op: "status", entryIds: [entry.id], status: "done" });
  }
  function block() { if (entry.status === "blocked") { void change({ op: "status", entryIds: [entry.id], status: "todo" }); return; } setAsking("blocked"); expand(entry.id); }
  const start = () => void change({ op: "status", entryIds: [entry.id], status: "doing" });
  const backToRow = () => focusLater(descId);
  const prev = siblings[index - 1];
  const after = siblings[index + 2];
  const menu: MenuItem[] = mirror ? [] : [
    ...(!done ? [{ id: "done", label: "Mark done", glyph: "check" as const, run: tick }] : []),
    { id: "edit", label: "Edit description", glyph: "edit" as const, run: () => setEditing(true) },
    ...(entry.parentId === null ? [{ id: "step", label: "Add a step", glyph: "plus" as const, run: () => { expand(entry.id); focusLater(`${detailId}-step`); } }] : [{ id: "top", label: "Move to top level", glyph: "up" as const, run: () => void change({ op: "reparent", entryId: entry.id, parentId: null }) }]),
    { id: "up", label: "Move up", glyph: "up" as const, disabled: !prev, run: () => { if (prev) void change({ op: "reorder", entryId: entry.id, beforeId: prev.id }); } },
    { id: "down", label: "Move down", glyph: "down" as const, disabled: index >= siblings.length - 1, run: () => void change({ op: "reorder", entryId: entry.id, beforeId: after?.id ?? null }) },
    ...(steps.length === 0 ? [{ id: "stepof", label: "Step of…", glyph: "link" as const, run: () => { expand(entry.id); focusLater(`${detailId}-parent`); } }] : []),
    { id: "delete", label: steps.length ? `Delete with ${plural(steps.length, "step")}` : "Delete", glyph: "trash" as const, danger: true, run: () => setDeleting(true) },
  ];

  if (editing) return <EditRow entry={entry} pending={pending} onCancel={() => { setEditing(false); backToRow(); }} onSave={async d => { const ok = await change({ op: "update", entryId: entry.id, description: d }); if (ok) { setEditing(false); backToRow(); } return ok; }} />;

  return (
    <div className={`journal-entry s-${entry.status} ${expanded ? "open" : ""} ${isNow ? "now" : ""}`} data-entry={entry.id} data-entry-state={entry.status}>
      <div className="journal-row">
        {isNow && <Ribbon />}
        <button type="button" className="tick" disabled={pending || entry.status === "verified" || mirror} onClick={tick}
          aria-label={entry.status === "verified" ? `${name} is verified by the Warden` : mirror ? `${name} follows its board quest’s phase` : done ? `Mark ${name} not done` : linked && entry.evidence.length === 0 ? `Mark ${name} done: add evidence first` : `Mark ${name} done`}
          title={STATUS_WORD[entry.status]}>
          <StatusMark status={entry.status} />
        </button>
        <button type="button" id={descId} className="desc" aria-expanded={expanded} aria-controls={detailId} onClick={() => toggle(entry.id)} title={rowTitle}>
          <span className="id">{entry.id}</span>
          <span className="t" data-content>{entry.description}</span>
          {isNow && <span className="sr">, {entry.status === "doing" ? "doing now" : "next"}</span>}
        </button>
        <span className="meta">
          {reasons && delegated(entry) && <OwnerTag entry={entry} />}
          {entry.createdBy.kind === "user" && <span className="pen wide" title="Added by you"><Glyph name="edit" size={11} /><span className="sr">Added by you</span></span>}
          {reported && <span className="flag rep">report in</span>}
          {entry.status === "rejected" && <span className="flag bad">rejected</span>}
          {entry.status === "blocked" && <span className="flag">blocked</span>}
          {entry.status === "done" && linked && <span className="flag">unverified</span>}
          {mirror && <span className="cnt wide" title="Follows its board quest’s phase"><Glyph name="board-quest" size={12} /><span>board</span></span>}
          {linked && <span className="chip-link wide" title={`Linked to board quest ${entry.link!.boardQuestId}, waypoint ${entry.link!.waypointId}`}><Glyph name="link" size={11} /><span>{entry.link!.waypointId}</span></span>}
          {steps.length > 0 && <span className="cnt" title={`${stepsDone} of ${steps.length} steps done`}>{stepsDone}/{steps.length}</span>}
          {entry.evidence.length > 0 && <span className="cnt wide" title={`${entry.evidence.length} evidence`}>{entry.evidence.length} ev</span>}
        </span>
        {!mirror && (
          <span className="journal-ctl">
            {entry.status !== "doing" && !done && <IconButton glyph="play" label={`Start ${name}`} disabled={pending} onClick={start} />}
            {!done && <IconButton glyph="block" label={entry.status === "blocked" ? `Unblock ${name}` : `Block ${name}…`} pressed={entry.status === "blocked"} disabled={pending} onClick={block} />}
            <OverflowMenu label={`More for ${name}`} items={menu} />
          </span>
        )}
      </div>
      {deleting && (
        <div className="journal-confirm" role="group" aria-label={`Delete ${name}?`} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); setDeleting(false); backToRow(); } }}>
          <span>{steps.length ? `Delete with ${plural(steps.length, "step")}?` : "Delete?"}</span>
          <button type="button" className="btn sm danger" disabled={pending} onClick={() => void change({ op: "delete", entryIds: [entry.id] })}>Delete</button>
          <button type="button" className="btn sm" ref={cancelRef} onClick={() => { setDeleting(false); backToRow(); }}>Cancel</button>
        </div>
      )}
      {reason && !expanded && <p className="journal-reason" title={reason} data-content>{reason}</p>}
      {expanded && <EntryDetail id={detailId} descId={descId} entry={entry} entries={entries} pending={pending} change={change} changes={changes} asking={asking} setAsking={setAsking} menu={menu} tick={tick} start={start} block={block} />}
    </div>
  );
}

function EditRow({ entry, pending, onCancel, onSave }: { entry: JournalEntry; pending: boolean; onCancel: () => void; onSave: (d: string) => Promise<boolean> }) {
  const [value, setValue] = useState(entry.description);
  return (
    <form className="journal-edit" onSubmit={e => { e.preventDefault(); if (value.trim()) void onSave(value.trim()); }}>
      <label className="sr" htmlFor={`journal-e-${entry.id}`}>Edit {entry.description}</label>
      <input id={`journal-e-${entry.id}`} autoFocus value={value} maxLength={500} onFocus={e => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }} />
      <button type="submit" className="btn sm pri" disabled={pending || !value.trim()}>Save</button>
      <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function LinkLine({ link }: { link: NonNullable<JournalEntry["link"]> }) {
  const quest = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: link.boardQuestId } });
  const q = quest.data?.quest;
  const n = q ? q.waypoints.findIndex(w => w.id === link.waypointId) : -1;
  const w = n >= 0 ? q!.waypoints[n] : null;
  return <p className="journal-linkline"><Glyph name="link" size={12} /><span><b data-content>{q?.title ?? link.boardQuestId}</b> · waypoint {n >= 0 ? n + 1 : link.waypointId}{w ? ` ${w.title}` : ""}</span><span className="m">Done needs evidence; the Warden verifies or rejects.</span></p>;
}

type DetailProps = { id: string; descId: string; entry: JournalEntry; entries: JournalEntry[]; pending: boolean; change: Change; changes: Journal["changes"]; asking: Pending; setAsking: (p: Pending) => void; menu: MenuItem[]; tick: () => void; start: () => void; block: () => void };
function EntryDetail({ id, descId, entry, entries, pending, change, changes, asking, setAsking, menu, tick, start, block }: DetailProps) {
  const names = useJournalNames();
  const [note, setNote] = useState(entry.note ?? "");
  const [step, setStep] = useState("");
  const [reason, setReason] = useState("");
  const [ev, setEv] = useState<Evidence>({ kind: "url", ref: "", detail: "", exitCode: null });
  const recent = changes.filter(c => c.entryIds.includes(entry.id)).slice(-4).reverse();
  const hasSteps = entries.some(e => e.parentId === entry.id);
  const mirror = entry.boardQuestId !== null;
  const parents = hasSteps || mirror ? [] : entries.filter(e => e.parentId === null && e.id !== entry.id && !isDone(e) && e.boardQuestId === null);
  const why = reasonOf(entry, changes);
  const cancel = () => { setAsking(null); focusLater(descId); };
  const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } };
  // One bordered action, chosen by state; Block…, Reopen and Add a note stay quiet links.
  const main = mirror || entry.status === "verified" ? null
    : entry.status === "todo" || entry.status === "rejected" ? <button type="button" className="btn sm" disabled={pending} onClick={start}><Glyph name="play" size={12} /><span>Start</span></button>
    : entry.status === "doing" ? <button type="button" className="btn sm" disabled={pending} onClick={tick}><Glyph name="check" size={12} /><span>Done</span></button>
    : entry.status === "blocked" ? <button type="button" className="btn sm" disabled={pending} onClick={block}><span>Unblock</span></button> : null;
  return (
    <div className="journal-detail" id={id} role="region" aria-label={`Details of ${entry.description}`}>
      {entry.description.length > 44 && <p className="full" data-content>{entry.description}</p>}
      {entry.status === "verified" && entry.review && (
        <div className="journal-verdict ok"><Glyph name="verified" size={14} /><div><p><b>Verified</b> by {names(entry.review.actor, { mid: true })} · <TimeAgo at={entry.review.at} /></p>{entry.review.evidence.length > 0 && <EvidenceList evidence={readableEvidence(entry.review.evidence, { threadNames: names.threadNames })} />}</div></div>
      )}
      {entry.status === "rejected" && (
        <div className="journal-verdict bad"><Glyph name="rejected" size={14} /><div><p><b>Rejected</b>{entry.review ? <> by {names(entry.review.actor, { mid: true })} · <TimeAgo at={entry.review.at} /></> : null}</p>{why && <p className="why" data-content>{why}</p>}</div></div>
      )}
      {entry.status === "blocked" && (
        <div className="journal-verdict blk"><Glyph name="block" size={14} /><div><p><b>Blocked</b></p>{why && <p className="why" data-content>{why}</p>}</div></div>
      )}
      {!isDone(entry) && entry.report && (
        <div className="journal-verdict rep"><Glyph name="report" size={14} /><div>
          <p>{entry.owner ? ownerName(names, entry.owner) : "The owner"} {entry.report.kind === "idle" ? "went idle" : entry.report.kind === "settled" ? "reported settled" : `’s thread was ${entry.report.kind}`} <TimeAgo at={entry.report.at} /></p>
          {entry.report.summary && <p className="why" data-content>{entry.report.summary}</p>}
          <button type="button" className="btn sm" disabled={pending} onClick={() => void change({ op: "wait", entryIds: [entry.id] })}>Still waiting</button>
        </div></div>
      )}
      {entry.link && <LinkLine link={entry.link} />}
      {asking === "done" && (
        <form className="journal-ask" onKeyDown={onEscape} onSubmit={e => { e.preventDefault(); if (ev.ref.trim()) void change({ op: "status", entryIds: [entry.id], status: "done", evidence: [{ ...ev, ref: ev.ref.trim(), detail: ev.detail.trim() }] }).then(ok => { if (ok) setAsking(null); }); }}>
          <b>Evidence for done</b>
          <div className="ev-row">
            <label>Kind<select value={ev.kind} onChange={e => setEv({ ...ev, kind: e.target.value as Evidence["kind"] })}>{(["url", "pr", "command", "file", "query", "note"] as const).map(k => <option key={k}>{k}</option>)}</select></label>
            <label className="grow">Reference<input autoFocus value={ev.ref} required maxLength={2000} placeholder="PR link, command, path:line…" onChange={e => setEv({ ...ev, ref: e.target.value })} /></label>
          </div>
          <label>What it showed<input value={ev.detail} maxLength={2000} placeholder="e.g. CI green, 14 checks" onChange={e => setEv({ ...ev, detail: e.target.value })} /></label>
          <span className="acts"><button type="submit" className="btn sm pri" disabled={pending || !ev.ref.trim()}>Mark done</button><button type="button" className="btn sm" onClick={cancel}>Cancel</button></span>
        </form>
      )}
      {asking === "blocked" && (
        <form className="journal-ask" onKeyDown={onEscape} onSubmit={e => { e.preventDefault(); void change({ op: "status", entryIds: [entry.id], status: "blocked", ...(reason.trim() ? { reason: reason.trim() } : {}) }).then(ok => { if (ok) { setAsking(null); focusLater(descId); } }); }}>
          <label><span><b>What blocks it?</b> <span className="m">optional, the agent sees it</span></span><input autoFocus value={reason} maxLength={2000} placeholder="e.g. waiting for #ci-help" onChange={e => setReason(e.target.value)} /></label>
          <span className="acts"><button type="submit" className="btn sm pri" disabled={pending}>Mark blocked</button><button type="button" className="btn sm" onClick={cancel}>Cancel</button></span>
        </form>
      )}
      {asking === "note" ? (
        <div className="journal-note-edit" onKeyDown={onEscape}>
          <label>Note<textarea autoFocus maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
          <span className="acts"><button type="button" className="btn sm pri" disabled={pending} onClick={() => void change({ op: "note", entryId: entry.id, note: note.trim() || null }).then(ok => { if (ok) setAsking(null); })}>Save note</button><button type="button" className="btn sm" onClick={() => { setNote(entry.note ?? ""); cancel(); }}>Cancel</button></span>
        </div>
      ) : entry.note ? <p className="journal-note"><span data-content>{entry.note}</span> <button type="button" className="lnk" aria-label="Edit the note" onClick={() => setAsking("note")}>Edit</button></p> : null}
      {entry.evidence.length > 0 && <EvidenceList evidence={readableEvidence(entry.evidence, { threadNames: names.threadNames })} />}
      <p className="journal-facts">
        <span>{entry.owner ? `Owner: ${names(entry.owner)}` : "No owner"}</span>
        <span>{names(entry.updatedBy)} · <TimeAgo at={entry.updatedAt} /></span>
        {entry.doneBy && isDone(entry) && <span>done by {names(entry.doneBy, { mid: true })}</span>}
        {entry.after.length > 0 && <span>after {entry.after.join(", ")}</span>}
      </p>
      {parents.length > 0 && (
        <label className="journal-parent">Step of<select id={`${id}-parent`} value={entry.parentId ?? ""} disabled={pending} onChange={e => void change({ op: "reparent", entryId: entry.id, parentId: e.target.value || null })}><option value="">Top level</option>{parents.map(p => <option value={p.id} key={p.id}>{p.id} · {p.description.slice(0, 50)}</option>)}</select></label>
      )}
      {recent.length > 0 && <ol className="journal-ehist" aria-label="Recent changes">{recent.map(c => <li key={c.id}><span className="who-n">{names(c.actor)}</span> <span className="tx" data-content>{c.text}</span> <TimeAgo at={c.at} /></li>)}</ol>}
      <div className="journal-dacts">
        {main}
        {!isDone(entry) && entry.status !== "blocked" && !mirror && <button type="button" className="lnk" disabled={pending} onClick={block}>Block…</button>}
        {entry.status === "done" && !mirror && <button type="button" className="lnk" disabled={pending} onClick={tick}>Reopen</button>}
        {!entry.note && asking !== "note" && !mirror && <button type="button" className="lnk" onClick={() => setAsking("note")}>Add a note</button>}
        <span className="sp" />
        {menu.length > 0 && <OverflowMenu label={`More for “${entry.description}”`} items={menu} />}
      </div>
      {entry.parentId === null && !mirror && (
        <form className="journal-stepadd" onSubmit={e => { e.preventDefault(); if (step.trim()) void change({ op: "add", descriptions: [step.trim()], parentId: entry.id }).then(ok => { if (ok) setStep(""); }); }}>
          <label className="sr" htmlFor={`${id}-step`}>New step for {entry.description}</label>
          <input id={`${id}-step`} value={step} maxLength={500} placeholder="Add a step" onChange={e => setStep(e.target.value)} />
          <button type="submit" className="btn sm" disabled={pending || !step.trim()}>Add step</button>
        </form>
      )}
    </div>
  );
}
