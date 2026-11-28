import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract, type BoardQuestSummary, type Room } from "../../shared/contract";
import { verifiedOf, verifiedWords, CELLAR, ExpandsMark, Glyph, OpensMark, SkQuestRow, TimeAgo, plural, vocab } from "../kit";
import { Faces, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { questsIn } from "./model";
import { usePanelState } from "./panel-state";
import { FoldLoad } from "./skeletons";
import { SideQuestParentLink } from "../kit/side-quest";

/** Returned and stopped quests still on the board, newest first. */
export const finishedQuests = (room: Room) => questsIn(room).filter((q) => (q.phase === "done" || q.phase === "stopped") && q.archivedAt == null && q.deletedAt == null).sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));

/** Archived count with the optimistic changes the room does not show yet; once the room refetches, the server's count already holds them. */
export function archiveTotal(room: Room, hidden: ReadonlySet<string>, shown: ReadonlySet<string>) {
  const inRoom = new Map(questsIn(room).map((q) => [q.id, q]));
  const archiving = [...hidden].filter((id) => { const q = inRoom.get(id); return !!q && !q.archivedAt; }).length;
  const restoring = [...shown].filter((id) => { const q = inRoom.get(id); return !q || !!q.archivedAt; }).length;
  return Math.max(0, room.archivedCount + archiving - restoring);
}

export type ArchiveReceipt = { ids: string[]; archived: boolean; label: string; notes: string[] };
/** What the user reads for the archive action on one quest; the code keeps "archive". */
export type CellarAction = typeof CELLAR.send | typeof CELLAR.restore;

/** Cellar moves share one receipt; a failed move puts its rows back. */
export function useArchive() {
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "archiveBoardQuests" });
  const [receipt, setReceipt] = useState<ArchiveReceipt | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Set<string>>(new Set());
  const run = async (ids: string[], archived: boolean, label: string) => {
    const flip = (set: Set<string>, on: boolean) => { const next = new Set(set); for (const id of ids) on ? next.add(id) : next.delete(id); return next; };
    setHidden((h) => flip(h, archived)); setShown((s) => flip(s, !archived));
    try { const out = await mutation.mutate({ ids, archived }); setReceipt({ ids, archived, label, notes: [...out.notes, ...(out.pendingArchives.length ? [`Archiving ${plural(out.pendingArchives.length, "thread")} remains pending. Tavern retries automatically.`] : [])] }); }
    catch { setHidden((h) => flip(h, !archived)); setShown((s) => flip(s, archived)); setReceipt(null); }
  };
  return {
    archive: (quests: BoardQuestSummary[]) => run(quests.map((q) => q.id), true, quests.length === 1 ? quests[0]!.short : plural(quests.length, "quest")),
    restore: (quests: BoardQuestSummary[]) => run(quests.map((q) => q.id), false, quests.length === 1 ? quests[0]!.short : plural(quests.length, "quest")),
    undo: () => { if (receipt) void run(receipt.ids, !receipt.archived, receipt.label); },
    clear: () => setReceipt(null),
    receipt, hidden, shown, pending: mutation.isPending, error: mutation.error,
  };
}
export type ArchiveApi = ReturnType<typeof useArchive>;

/** The inline receipt, in place of a toast: "2 sent to the cellar · Bring up". */
export function ArchiveReceiptLine({ api }: { api: ArchiveApi }) {
  if (!api.receipt && !api.error) return null;
  if (api.error && !api.receipt) return <p className="tv-problem" role="alert">Could not change the cellar: {api.error.message}</p>;
  const r = api.receipt!;
  return <p className="tv-receipt" role="status"><PageGlyph name={r.archived ? "archive" : "undo"} /><span>{r.archived ? r.ids.length === 1 ? <><b>{r.label}</b> sent to the cellar</> : <b>{CELLAR.sent(r.ids.length)}</b> : <><b>Brought up</b> {r.label} · back on the board</>}</span>{!r.archived && <span>Party threads stay archived; the Keeper can bring members back.</span>}{r.notes.map((note, i) => <span key={i}>{note}</span>)}<span className="tv-sp" /><button type="button" className="lnk-btn act" onClick={api.undo} disabled={api.pending}><span>{r.archived ? "Bring up" : "Undo"}</span></button><button type="button" className="tv-qbtn act" onClick={api.clear} aria-label="Dismiss" title="Dismiss"><Glyph name="close" size={12} /></button></p>;
}

/** One finished quest: the row opens its tale (or its quest page when stopped); a quiet action sends it to the cellar or brings it up. */
export function FinishedRow({ quest, registry, action }: { quest: BoardQuestSummary; registry: Registry; action?: { label: CellarAction; run: () => void; disabled?: boolean } }) {
  const navigate = useBbNavigate();
  const verified = verifiedOf(quest);
  const stopped = quest.phase === "stopped";
  const to = stopped ? `quest/${quest.id}` : `tale/${quest.id}`;
  return <div className={`tv-frow ${stopped ? "stopped" : ""}`}>
    <button type="button" className="tv-wrow act" onClick={() => navigate.toPluginPanel("tavern", { subPath: to })} title={stopped ? `Open the quest page: ${quest.title}` : `Open the tale: ${quest.title}`}>
      <Faces members={quest.members} registry={registry} size={16} max={5} still />
      <span className="tv-wrow-t" title={quest.title}><b>{quest.short}</b></span>
      <span className="tv-wrow-n num">{stopped ? "stopped" : verified ? verifiedWords(verified) : "no quest map"}</span>
      <TimeAgo at={quest.archivedAt ?? quest.endedAt ?? quest.updatedAt} />
      <span className="tv-wrow-a"><span>{stopped ? "The quest" : "The tale"}</span><OpensMark /></span>
    </button>
    {action && <button type="button" className="tv-qbtn act tv-frow-x" onClick={action.run} disabled={action.disabled} aria-label={`${action.label}: ${quest.short}`} title={`${action.label}: ${quest.short}`}><PageGlyph name={action.label === CELLAR.send ? "archive" : "undo"} size={13} /><span className="tv-qbtn-l">{action.label}</span></button>}
    {quest.leadChain?.seat && <SideQuestParentLink parent={quest.leadChain.seat} />}
  </div>;
}

function ArchivePage({ cursor, registry, api, onMore, last }: { cursor: string | null; registry: Registry; api: ArchiveApi; onMore: (next: string) => void; last: boolean }) {
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "archivedBoardQuests", input: { cursor, limit: 20 } });
  if (!page.data) return <FoldLoad error={page.error} retry={page.refetch} label="the cellar">{Array.from({ length: 3 }, (_, i) => <SkQuestRow key={i} />)}</FoldLoad>;
  const rows = page.data.boardQuests.filter((q) => !api.shown.has(q.id));
  return <>
    {rows.map((q) => <FinishedRow key={q.id} quest={q} registry={registry} action={{ label: CELLAR.restore, run: () => void api.restore([q]), disabled: api.pending }} />)}
    {last && page.data.nextCursor && <button type="button" className="tv-fold act" onClick={() => onMore(page.data!.nextCursor!)}><ExpandsMark open={false} /><span>Show older quests in the cellar</span></button>}
  </>;
}

function DeletedPage({ cursor, restored, onRestore, pending, onMore, last }: { cursor: string | null; restored: ReadonlySet<string>; onRestore: (q: BoardQuestSummary) => void; pending: boolean; onMore: (next: string) => void; last: boolean }) {
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "deletedBoardQuests", input: { cursor, limit: 20 } });
  if (!page.data) return <FoldLoad error={page.error} retry={page.refetch} label="deleted quests"><SkQuestRow /></FoldLoad>;
  return <>{page.data.boardQuests.filter(q => !restored.has(q.id)).map(q => <div key={q.id} className="tv-frow">
    <span className="tv-wrow"><span className="tv-wrow-t" title={q.title}><b>{q.short}</b></span><TimeAgo at={q.deletedAt!} /></span>
    <button type="button" className="tv-qbtn act" disabled={pending} aria-label={`Restore: ${q.short}`} title="Restore this quest to the cellar; its threads stay archived" onClick={() => onRestore(q)}>Restore</button>
  </div>)}{last && page.data.nextCursor && <button type="button" className="tv-fold act" onClick={() => onMore(page.data!.nextCursor!)}>Show older deleted quests</button>}</>;
}
function DeletedList() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [receipt, setReceipt] = useState<string | null>(null);
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "restoreDeletedQuest" });
  const restore = async (q: BoardQuestSummary) => {
    try { await mutation.mutate({ id: q.id }); setRestored(prev => new Set([...prev, q.id])); setReceipt(`Restored ${q.short} to the cellar. Its threads stay archived.`); }
    catch { /* The mutation refusal remains beside the row. */ }
  };
  return <><p className="m">Deleted quests stay here until you restore them. There is no expiry.</p>{receipt && <p className="tv-receipt" role="status">{receipt}</p>}{mutation.error && <p role="alert">Could not restore: {mutation.error.message}</p>}{cursors.map((cursor, i) => <DeletedPage key={cursor ?? "first"} cursor={cursor} restored={restored} onRestore={q => void restore(q)} pending={mutation.isPending} last={i === cursors.length - 1} onMore={next => setCursors(prev => [...prev, next])} />)}</>;
}

/** The cellar (archive), newest first, paged on demand. */
export function ArchivedList({ registry, api, total }: { registry: Registry; api: ArchiveApi; total: number }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [deleted, setDeleted] = useState(false);
  const count = experimental_useRpcQuery({ contract: rpcContract, method: "deletedQuestCount", input: {} });
  return <><div className="tv-filters" role="group" aria-label="Cellar views"><button type="button" className="act" aria-pressed={!deleted} onClick={() => setDeleted(false)}>In the cellar ({total})</button><button type="button" className="act" aria-pressed={deleted} onClick={() => setDeleted(true)}>Deleted{count.data && ` (${count.data.total})`}</button></div>{deleted ? <DeletedList /> : !total ? <p className="tv-empty" data-empty>The cellar is empty. Returned and stopped quests go down when you send them to the cellar.</p> : <div className="tv-wrapped">{cursors.map((c, i) => <ArchivePage key={c ?? "first"} cursor={c} registry={registry} api={api} last={i === cursors.length - 1} onMore={(next) => setCursors((prev) => [...prev, next])} />)}</div>}</>;
}

/** The collapsed cellar (archive) at the end of the common room. */
export function ArchiveFold({ room, registry, api }: { room: Room; registry: Registry; api: ArchiveApi }) {
  const [open, setOpen] = usePanelState("room.cellar", false);
  const total = archiveTotal(room, api.hidden, api.shown);
  const deleted = experimental_useRpcQuery({ contract: rpcContract, method: "deletedQuestCount", input: {} });
  if (!total && !deleted.data?.total) return deleted.error
    ? <p className="tv-problem" role="alert">Could not check for deleted quests. <button type="button" className="btn sm" onClick={() => void deleted.refetch()}>Retry</button></p>
    : null;
  return <section data-sec="cellar" className="tv-archive" aria-label={vocab("cellar")}>
    <button type="button" className="tv-fold act tv-archive-h" aria-expanded={open} onClick={() => setOpen(!open)}><PageGlyph name="archive" /><span>{total ? CELLAR.link(total) : "Cellar"}{deleted.data && deleted.data.total > 0 && ` · ${plural(deleted.data.total, "deleted quest")}`}</span><ExpandsMark open={open} /></button>
    {open && <div className="tv-card tv-archive-b"><ArchivedList registry={registry} api={api} total={total} /></div>}
  </section>;
}
