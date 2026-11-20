import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { replyToHandBack } from "../thread/handback-reply";
import { useState } from "react";
import type { GateRecord, KeeperNote } from "../../shared/schema";
import { Glyph } from "./glyphs";
import { Clamp, StatusPill, TimeAgo, clockTime, localTime, plural, useNow } from "./primitives";

const SHOWN = 3;
type Short = (boardQuestId: string | null) => string | null;

const at = (ms: number, now: number) => localTime(ms, now);

/** Promises first by due time (overdue on top, conditions last), facts and hand-backs newest first. */
function sorted(notes: KeeperNote[]) {
  return [...notes].sort((a, b) => a.kind === "commitment" ? (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) : b.createdAt - a.createdAt);
}

function NoteRow({ note, short, now }: { note: KeeperNote; short?: Short; now: number }) {
  const q = short?.(note.boardQuestId) ?? null;
  const late = note.kind === "commitment" && note.dueAt !== null && note.dueAt < now;
  const text = note.kind === "waiting-on-user" ? note.action ?? note.text : note.kind === "fact" ? `“${note.text}”` : note.condition ? `${note.text} · when ${note.condition}` : note.text;
  const meta = note.kind === "commitment"
    ? late ? <span title={`Was due ${at(note.dueAt!, now)}`}><StatusPill status="blocked">overdue</StatusPill></span> : note.dueAt !== null ? <span className="m" title={`by ${at(note.dueAt, now)}`}>by {at(note.dueAt, now)}</span> : <span className="m" title={`on a condition: ${note.condition}`}>on a condition</span>
    : note.kind === "fact" && note.validUntil !== null ? <span className="m" title={`Kept until ${new Date(note.validUntil).toLocaleString()}`}>until {at(note.validUntil, now)}</span>
    : <TimeAgo at={note.createdAt} />;
  return <li className={`mem-row k-${note.kind} ${late ? "late" : ""}`}><Clamp lines={1} text={text} /><span className="mem-meta">{meta}</span>{q ? <span className="lg-q" title={q}>{q}</span> : <span />}{note.kind === "waiting-on-user" && <HandBackActions note={note} />}</li>;
}

export function useHandBackActions(note: Pick<KeeperNote, "id" | "keeperThreadId" | "text" | "action" | "why">) {
  const resolve = experimental_useRpcMutation({ contract: rpcContract, method: "resolveHandBack" });
  const navigate = useBbNavigate();
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  return {
    done, error, pending: resolve.isPending,
    markDone: () => void resolve.mutate({ noteId: note.id, how: "done" }).then(() => setDone(true)).catch(setError),
    reply: () => { replyToHandBack(note); navigate.toThread(note.keeperThreadId); },
  };
}

function HandBackActions({ note }: { note: KeeperNote }) {
  const actions = useHandBackActions(note);
  const navigate = useBbNavigate();
  return <div className="mem-handback">
    {note.validUntil != null && note.validUntil < Date.now() && <p>expired, Done to clear</p>}
    {note.why && <p>{note.why}</p>}
    {note.action && note.text !== note.action && <p className="m small">{note.text}</p>}
    {note.sourceMessageId && <button type="button" className="lnk-btn" onClick={() => navigate.toThread(note.keeperThreadId)} title={`Source receipt: ${note.sourceMessageId}`}>Keeper thread</button>}
    {actions.done ? <span role="status">Done. The Keeper has been told.</span> : <><button type="button" className="btn sm" disabled={actions.pending} onClick={actions.markDone}>Done</button><button type="button" className="btn sm" onClick={actions.reply}>Reply</button></>}
    {actions.error != null && <p role="alert">{actions.error instanceof Error ? actions.error.message : String(actions.error)}</p>}
  </div>;
}

/** One kind of Keeper note, the first three shown and the rest expanding in place. */
export function KeeperNoteRows({ notes, short, label, fold, newestFirst = false }: { notes: KeeperNote[]; short?: Short; label: string; fold?: [boolean, (next: boolean) => void]; newestFirst?: boolean }) {
  const now = useNow();
  const localFold = useState(false);
  const [all, setAll] = fold ?? localFold;
  if (notes.length === 0) return null;
  const list = newestFirst ? [...notes].sort((a, b) => b.createdAt - a.createdAt) : sorted(notes);
  const shown = all || list.every(note => note.kind === "waiting-on-user") ? list : list.slice(0, SHOWN);
  return <>
    <ul className="lg-rows mem-rows" aria-label={label}>{shown.map(n => <NoteRow key={n.id} note={n} short={short} now={now} />)}</ul>
    {list.length > SHOWN && <button type="button" className="lnk-btn mem-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${list.length}`}<Glyph name="chevron" size={11} className={`act-i ${all ? "up" : "down"}`} /></button>}
  </>;
}

/** What the Keeper promised and what it keeps word for word. `total` is the server's count when it returned fewer rows than it holds; `older` counts aged promises the server leaves out (over a day past due, or three days open with no due time), which only the Keeper can list. */
export function KeptInMind({ notes, total, older = 0, short, folds, newestFirst = false, headless = false }: { notes: KeeperNote[]; total?: number; older?: number; short?: Short; folds?: { promises: [boolean, (next: boolean) => void]; facts: [boolean, (next: boolean) => void] }; newestFirst?: boolean; headless?: boolean }) {
  const promises = notes.filter(n => n.kind === "commitment" && n.state === "open");
  const facts = notes.filter(n => n.kind === "fact" && n.state === "open");
  if (promises.length + facts.length + older === 0) return null;
  const hidden = (total ?? notes.length) - notes.length;
  return <section className="lg-sec mem" aria-label="Kept in mind">
    {!headless && <h3><Glyph name="pin" size={13} /><span>Kept in mind</span><span className="num">{plural(promises.length, "promise")} · {plural(facts.length, "fact")}</span></h3>}
    {promises.length > 0 && <><p className="lbl">Promises <span className="anc">the Keeper owes you</span></p><KeeperNoteRows notes={promises} short={short} fold={folds?.promises} newestFirst={newestFirst} label="Promises the Keeper made" /></>}
    {older > 0 && <p className="m small mem-older" title="Promises over a day past due, or open three days with no due time. The Keeper still holds them; ask it in the thread to list them.">Older promises: {older} <span className="anc">overdue by more than a day or open 3 days; ask the Keeper to list them</span></p>}
    {facts.length > 0 && <><p className="lbl">Facts <span className="anc">kept word for word</span></p><KeeperNoteRows notes={facts} short={short} fold={folds?.facts} newestFirst={newestFirst} label="Facts the Keeper keeps" /></>}
    {hidden > 0 && <p className="m small">{plural(hidden, "older note")} not shown here.</p>}
  </section>;
}

/** The outside gates on a plan: who was asked, how and when, and their answer once it came. */
export function GateRows({ waypoints }: { waypoints: { id: string; title: string; gate?: GateRecord | null }[] }) {
  const gated = waypoints.filter((w): w is typeof w & { gate: GateRecord } => !!w.gate);
  if (gated.length === 0) return null;
  return <ul className="lg-rows mem-rows mem-gates" aria-label="Outside gates">{gated.map(({ id, title, gate }) => {
    const asked = `Asked ${gate.askedWho} via ${gate.via} at ${new Date(gate.askedAt).toLocaleString()}`;
    return <li key={id} className={`mem-row k-gate ${gate.answer !== null ? "answered" : ""}`}>
      <span className="mem-gt" title={`${title} · ${asked}`}><Glyph name="gate" size={12} /><b>{gate.askedWho}</b><span className="m">{title}</span></span>
      <span className="mem-meta" title={asked}>{gate.answer !== null ? <StatusPill status="answered">answered</StatusPill> : <span className="m">asked <TimeAgo at={gate.askedAt} /></span>}</span>
      <span />
      {gate.answer !== null && <Clamp className="mem-ans" lines={1} text={`${gate.via}${gate.answeredAt !== null ? `, ${clockTime(gate.answeredAt)}` : ""}: “${gate.answer}”`} />}
    </li>;
  })}</ul>;
}
