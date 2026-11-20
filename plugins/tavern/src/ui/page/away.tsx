import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { rpcContract, type BoardQuestSummary, type Room } from "../../shared/contract";
import type { AwayControl } from "../../shared/away-rpc";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import type { AwayStopKind } from "../../shared/away";
import { AwayStopChoices, stopListWords, windowStopWords } from "./away-preferences";
import { useTavernSettings } from "./settings";
import type { Member } from "../../shared/schema";
import { OpensMark, Vocabulary, plural, readable, useNow } from "../kit";
import { AwayTime, ClosedWords, characterName, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { activeQuests, closedWords, roomAway, stoppingQuests, visibleMembers, workingQuests } from "./model";
import "./away.css";

/*
 * Closing time on the page, against Tim's contract (docs/closing-time.md): the sheet with its confirm in place, Return, and the
 * stops that haven't confirmed. Words never promise prevention for watched or unguarded work.
 */

export type EndChoice = "drafts-ready" | "pause" | "hold";
export const REOPEN_LINE = "Answering an ask or messaging any Tavern thread, a solo included, reopens the tavern.";
export const NOTHING_ENDED_LINE = "Nothing is ended; paused work waits for your return.";
export const NOTHING_RUNNING_LINE = "Nothing is running now. Closing changes only what starts while you're away: new work waits until you return.";
export const SOLOS_LINE = "Solo threads keep running. Where a solo is guarded, the stop list still applies; a watched solo isn't stopped, only watched.";
export const SIDE_QUESTS_LINE = "Side quests follow their quest: a paused or unselected quest pauses its side quests.";

/** A member still in play: what closing can pause or let keep drafting. */
const inPlay = (m: Pick<Member, "engagement" | "state">) => m.engagement === "active" && m.state !== "failed";
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export type ClosePlan = {
  /** `text` is the whole line; `detail` is the same without the quest's name, for a row that shows the name itself. */
  quests: { id: string; short: string; title: string; choice: EndChoice; text: string; detail: string }[];
  /** The whole-tavern watched line, only when the server gives no per-quest counts and some member is watched. */
  watchedTotal: string | null;
  /** Errands that belong to no quest: they always pause, with the server's watched count for them. Null when there are none. */
  unattached: string | null;
  /** A line whose count is 0 is left out of the confirm. `pausing` is null when the server counts side quests inside their quest's members and gives no split: the rule shows without a number. */
  sideQuests: { text: string; pausing: number | null; shown: boolean };
  solos: { text: string; running: number };
  /** Null when no ask is open. */
  asks: string | null;
  /** Quests still stopping: they take no choice, and Tavern keeps retrying their stops while closed. Null when none. */
  stopping: string | null;
  /** No live quest, errand, solo or ask: the confirm leads with NOTHING_RUNNING_LINE instead. */
  nothingRunning: boolean;
};

/** What closing would do, quest by quest, in the user's words, from the room and the server's away state. Every quest is listed with its choice. */
/**
 * What closing would do, quest by quest, in the user's words, from the room and the server's away state. Every quest is listed with its choice.
 * The server's eligibleByQuest and soloCount are the members and solos Close acts on, so they win over counting the room's member states,
 * which can't see a released, archived or deleted member. Without them (an older server) the page counts states, as before.
 */
export function closePlan(room: Room, control: Pick<AwayControl, "watchedCount" | "watchedByQuest" | "eligibleByQuest" | "soloCount"> | null | undefined, input: { choices: Record<string, EndChoice>; allowWatched: boolean; wakeRules: { blockers: boolean; productionAsksAfterTwoHours: boolean }; defaultEndState?: EndChoice; productionWakeHours?: number }): ClosePlan {
  const byQuest = control?.watchedByQuest;
  const eligible = control?.eligibleByQuest;
  const watchedIn = (questId: string | null) => (byQuest ? byQuest.find((w) => w.questId === questId)?.watchedCount ?? 0 : null);
  /** The server's count for one quest (null: errands that belong to no quest). A missing row is 0; `errands` is the side-quest subset when the server splits it. */
  const eligibleIn = (questId: string | null) => { const row = eligible?.find((r) => r.questId === questId) as (NonNullable<typeof eligible>[number] & { errands?: number }) | undefined; return { members: row?.members ?? 0, watched: row?.watchedCount ?? 0, errands: row?.errands ?? null }; };
  const split = !eligible || eligible.every((r) => typeof (r as { errands?: unknown }).errands === "number");
  const errands = room.keepers.flatMap((k) => k.errands).filter(inPlay);
  const quests = workingQuests(room).map((q) => {
    const choice = input.choices[q.id] ?? input.defaultEndState ?? "drafts-ready";
    const row = eligible ? eligibleIn(q.id) : null;
    const counts = row ? { members: row.members - (row.errands ?? 0), watched: row.watched } : { members: q.members.filter((m) => m.role === "member" && !m.errand && inPlay(m)).length, watched: watchedIn(q.id) ?? 0 };
    const detail = questLine(choice, counts, input.allowWatched);
    return { id: q.id, short: q.short || q.title, title: q.title, choice, detail, text: `${q.short || q.title}: ${detail}` };
  });
  const paused = new Set(quests.filter((q) => q.choice !== "drafts-ready").map((q) => q.id));
  const attached = errands.filter((m) => !!m.boardQuestId && paused.has(m.boardQuestId));
  const pausing = eligible ? (split ? [...paused].reduce((n, id) => n + (eligibleIn(id).errands ?? 0), 0) : null) : attached.length;
  const looseRow = eligible ? eligibleIn(null) : null;
  const looseCount = looseRow ? looseRow.members : errands.filter((m) => !m.boardQuestId).length;
  const looseWatched = looseRow ? looseRow.watched : watchedIn(null);
  const open = room.asks.filter((a) => a.state === "open").length;
  const solos = control?.soloCount ?? room.solos.filter(inPlay).length;
  const stopping = stoppingQuests(room).length;
  const wakes = [input.wakeRules.blockers ? "A blocker wakes you." : "Nothing wakes you for a blocker.", input.wakeRules.productionAsksAfterTwoHours ? `A production or cluster write ask wakes you after ${plural(input.productionWakeHours ?? DEFAULT_SETTINGS.away.productionWakeHours, "hour")}.` : ""].filter(Boolean).join(" ");
  return {
    quests,
    watchedTotal: byQuest || eligible || !control || !control.watchedCount ? null : `${plural(control.watchedCount, "watched member")} ${input.allowWatched ? s(control.watchedCount, "keeps drafting, watched", "keep drafting, watched") : s(control.watchedCount, "holds", "hold")} across all quests.`,
    unattached: looseCount ? `Errands that belong to no quest pause: ${looseCount}${looseWatched ? `, ${looseWatched} of them watched` : ""}.` : null,
    sideQuests: { text: SIDE_QUESTS_LINE, pausing, shown: pausing === null ? attached.length > 0 : pausing > 0 },
    solos: { text: SOLOS_LINE, running: solos },
    asks: open ? `${plural(open, "ask")} ${s(open, "waits", "wait")} for you. ${wakes}` : null,
    stopping: stopping ? `${plural(stopping, "quest")} ${s(stopping, "is", "are")} still stopping; Tavern keeps retrying while you’re away.` : null,
    nothingRunning: !quests.length && !looseCount && !attached.length && !solos && !open && !stopping,
  };
}

/** A quest's line without its name: what its choice does to the members Close acts on (`watched` is their watched subset). */
function questLine(choice: EndChoice, counts: { members: number; watched: number }, allowWatched: boolean): string {
  const n = counts.members, watched = counts.watched;
  if (choice !== "drafts-ready") {
    const lead = choice === "pause" ? "paused" : "left out, so it's held";
    return n ? `${lead}; ${plural(n, "member")} ${s(n, "stops its turn and waits", "stop their turn and wait")}.` : `${lead}; no member is on the road.`;
  }
  if (!n) return "No member is on the road; new work stays as private drafts.";
  const w = Math.min(watched, n);
  const guarded = n - w;
  const parts = [guarded ? `${plural(guarded, "member")} ${s(guarded, "keeps", "keep")} drafting where the guard holds` : null, w ? `${plural(w, "watched member")} ${allowWatched ? s(w, "keeps drafting, watched", "keep drafting, watched") : s(w, "holds", "hold")}` : null].filter(Boolean);
  return `${parts.join("; ")}.`;
}

/** Names for ids in server text (a stop's error), from every member the room knows, so no raw thread id reaches the page. */
export function roomNames(room: Room, registry: Registry) {
  const threadNames = new Map(visibleMembers(room).map((m) => [m.threadId, characterName(registry, m)] as const));
  const questNames = new Map(activeQuests(room).map((q) => [q.id, q.short || q.title] as const));
  return { threadNames, questNames };
}
/** Server text with every id named: the room's own thread ids first (whatever their form), then the shared namer for the rest. */
export function idFree(text: string, names: ReturnType<typeof roomNames>): string {
  let out = text;
  for (const [id, name] of [...names.threadNames].sort((a, b) => b[0].length - a[0].length)) out = out.split(id).join(name);
  return readable(out, names);
}
const nameOf = (room: Room, registry: Registry, threadId: string) => { const m = visibleMembers(room).find((x) => x.threadId === threadId); return m ? characterName(registry, m) : "A member"; };

/** The server's away state, read once a window exists (the room's windowId), or always for the sheet. */
/**
 * Whether the page needs the full Closing time state: while closed, or while a window still has unconfirmed stops or members
 * waiting for a fresh instruction (the room's followUp). An open room with an old window has nothing to show, so it reads nothing
 * on each room signal. An older server sends no followUp; then any recorded window counts, as before.
 */
export function awayNeeded(room: Room | undefined): boolean {
  const away = room ? roomAway(room) : null;
  if (!away) return false;
  return away.closed || (away.followUp ?? !!away.windowId);
}
export function useAwayControl(room: Room | undefined, always = false) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "away", input: {}, enabled: always || awayNeeded(room) });
}

/** Stops that haven't confirmed, and members waiting for a fresh instruction after Return: named, with what Tavern does next. */
export function AwayNotes({ room, registry, control, questId }: { room: Room; registry: Registry; control: AwayControl | undefined; questId?: string }) {
  if (!control) return null;
  const members = visibleMembers(room);
  const mine = (threadId: string) => !questId || members.find((m) => m.threadId === threadId)?.boardQuestId === questId;
  const names = roomNames(room, registry);
  const stops = control.pendingStops.filter((p) => mine(p.threadId));
  const resume = control.resumeRequired.filter((r) => !questId || r.questId === questId);
  if (!stops.length && !resume.length) return null;
  return <ul className="tv-awaynotes" aria-label="Closing time">
    {stops.map((p) => <li key={p.threadId} className="tv-awaynote warn" data-pending-stop data-stuck>
      <PageGlyph name="stale" size={13} />
      <span><b>{nameOf(room, registry, p.threadId)}</b>’s stop isn’t confirmed yet{p.error ? <>: <span data-content>{idFree(p.error, names)}</span></> : ""}. Tavern retries it.</span>
    </li>)}
    {resume.map((r) => <li key={r.threadId} className="tv-awaynote" data-resume>
      <PageGlyph name="note" size={13} />
      <span><b>{nameOf(room, registry, r.threadId)}</b> waits for a fresh instruction from {nameOf(room, registry, r.keeperThreadId)}.</span>
    </li>)}
  </ul>;
}

/** A quest page's Closing time notes: its members' unconfirmed stops and who waits for a fresh instruction. */
export function QuestAwayNotes({ room, registry, questId }: { room: Room; registry: Registry; questId: string }) {
  const control = useAwayControl(room);
  return <AwayNotes room={room} registry={registry} control={control.data} questId={questId} />;
}

/** The room's Closing time line under the status line: the stops that haven't confirmed, named, with an anchor the status line jumps to. */
export function RoomAwayNotes({ room, registry }: { room: Room; registry: Registry }) {
  const control = useAwayControl(room);
  const navigate = useBbNavigate();
  const pendingCellar = room.keepers.flatMap(keeper => keeper.boardQuests).filter(quest => quest.phase === "stopping" && quest.cellarOnStop);
  return <div id="tv-away-notes">
    <AwayNotes room={room} registry={registry} control={control.data} />
    {pendingCellar.length > 0 && <section className="tv-awaynotes" aria-labelledby="tv-cellar-pending-h">
      <h2 id="tv-cellar-pending-h">Stops not confirmed</h2>
      <ul>{pendingCellar.map(quest => <li key={quest.id} className="tv-awaynote warn" data-pending-stop data-stuck>
        <PageGlyph name="stale" size={13} />
        <span><b>{quest.title}</b>: Tavern retries before sending this quest to the cellar.</span>
        <button type="button" className="btn sm" aria-label={`Open stop retry for ${quest.title}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${quest.id}` })}>Open stop retry</button>
      </li>)}</ul>
    </section>}
  </div>;
}
/** How many stops haven't confirmed, for the status line; 0 when there is no window. */
export function usePendingStops(room: Room) { return useAwayControl(room).data?.pendingStops.length ?? 0; }

type ReturnResult = { code: "returned" | "unchanged" | "stale"; state: AwayControl };
/** What Return resumed and what still waits, in one receipt. It names only what the window had: drafts-ready quests, and the cleanup of any that returned while away. */
export function returnReceipt(result: ReturnResult, room: Room, registry: Registry): string {
  if (result.code === "unchanged") return "Already open.";
  if (result.code === "stale") return "Closing time changed elsewhere; this shows the current state.";
  const waiting = result.state.resumeRequired.map((r) => nameOf(room, registry, r.threadId));
  const kept = (result.state.window?.quests ?? []).filter((q) => q.endState === "drafts-ready").length;
  const parts = ["Back. Keepers pick up with a digest on their next tick."];
  if (kept) parts.push(`${kept === 1 ? "The drafts-ready quest carries" : "Drafts-ready quests carry"} on, and the member threads of any that returned while you were away are cleaned up now.`);
  if (waiting.length) parts.push(`${waiting.length === 1 ? waiting[0] : `${waiting.slice(0, -1).join(", ")} and ${waiting.at(-1)}`} ${s(waiting.length, "waits", "wait")} for a fresh instruction from ${s(waiting.length, "its", "their")} Keeper.`);
  return parts.join(" ");
}

/**
 * Return's action and what came of it. Whoever holds it must outlive the closed and open switch: the room reopens as soon as Return
 * lands, and a receipt kept inside a part drawn only while closed would vanish with it.
 */
export function useReturn(room: Room, registry: Registry) {
  const back = experimental_useRpcMutation({ contract: rpcContract, method: "awayReturn" });
  const [receipt, setReceipt] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const windowId = roomAway(room)?.windowId ?? null;
  const go = async () => {
    if (!windowId) return;
    setProblem(null);
    try { const out = await back.mutate({ windowId }); setReceipt(returnReceipt(out, room, registry)); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };
  return { go, pending: back.isPending, receipt, problem, windowId, closed: !!roomAway(room)?.closed };
}
export type ReturnAction = ReturnType<typeof useReturn>;

/**
 * Return: one real button (44 px on touch), its receipt with a link to the digest, and the problem with Retry if it fails. It draws
 * nothing while open with nothing to report, so a parent can keep it mounted across the switch; or the parent holds `action`.
 */
export function ReturnButton({ room, registry, className = "", action }: { room: Room; registry: Registry; className?: string; action?: ReturnAction }) {
  const navigate = useBbNavigate();
  const own = useReturn(room, registry);
  const { go, pending, receipt, problem, windowId, closed } = action ?? own;
  if (!closed && !receipt && !problem) return null;
  return <span className={`tv-return ${className}`}>
    {closed && !receipt && <button type="button" className="btn sm tv-return-b" onClick={() => void go()} disabled={pending || !windowId} title="Return: reopen the tavern now"><PageGlyph name="lantern" /><span>{pending ? "Returning…" : "Return"}</span></button>}
    {receipt && <span className="tv-receipt" role="status"><PageGlyph name="done" /><span>{receipt}</span><button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: "digest" })}><span>While closed</span><OpensMark /></button></span>}
    {problem && <span className="tv-problem" role="alert"><span>Couldn’t return: {problem}</span><button type="button" className="btn sm" onClick={() => void go()}>Retry</button></span>}
  </span>;
}

/** A datetime-local value for the next 08:00 at least an hour away. */
export function defaultBackAt(now = new Date(), hour = DEFAULT_SETTINGS.away.defaultBackAtHour) {
  const d = new Date(now); d.setHours(hour, 0, 0, 0);
  if (d.getTime() - now.getTime() < 60 * 60_000) d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const CHOICES: { id: EndChoice; label: string; hint: string }[] = [
  { id: "drafts-ready", label: "Drafts ready", hint: "private work goes on where the guard holds; it may wrap, and its threads stay until you are back" },
  { id: "pause", label: "Pause", hint: "member turns stop now and wait" },
  { id: "hold", label: "Hold", hint: "left out of the window, so its work waits" },
];

/** The Closing time sheet: the form, the confirm in place beside it, and the result. Closed already, it shows the window and Return. */
export function AwayForm({ room, registry }: { room: Room; registry: Registry }) {
  const id = useId();
  const control = useAwayControl(room, true);
  const close = experimental_useRpcMutation({ contract: rpcContract, method: "awayClose" });
  const live = workingQuests(room);
  const settings = useTavernSettings();
  const defaults = settings.data?.effective.away ?? DEFAULT_SETTINGS.away;
  const [openedAt] = useState(() => new Date());
  const [backAtInput, setBackAt] = useState<string | null>(null);
  const backAt = backAtInput ?? defaultBackAt(openedAt, defaults.defaultBackAtHour);
  const [note, setNote] = useState("");
  const [choices, setChoices] = useState<Record<string, EndChoice>>({});
  const [watchedChoice, setAllowWatched] = useState<boolean | null>(null);
  const allowWatched = watchedChoice ?? defaults.defaultAllowWatched;
  const [wakeChoice, setWake] = useState<Partial<{blockers: boolean; productionAsksAfterTwoHours: boolean}>>({});
  const wake = useMemo(() => ({ blockers: wakeChoice.blockers ?? defaults.defaultWakeBlockers, productionAsksAfterTwoHours: wakeChoice.productionAsksAfterTwoHours ?? defaults.defaultWakeProduction }), [wakeChoice, defaults]);
  const [selection, setSelection] = useState<AwayStopKind[] | null>(null);
  const stopList = selection ?? defaults.neverWhileClosed;
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "done" | "warn" | "bad"; text: ReactNode } | null>(null);
  const until = new Date(backAt).getTime();
  // The sheet may sit open past its Back at time with no input: the minute clock re-checks it.
  useNow();
  const badTime = !Number.isFinite(until) || until <= Date.now();
  const plan = useMemo(() => {
    const preview = control.data && !stopList.length ? {
      ...control.data, watchedCount: 0, watchedByQuest: [],
      eligibleByQuest: control.data.eligibleByQuest?.map(row => ({ ...row, watchedCount: 0 })),
    } : control.data;
    return closePlan(room, preview, { choices, allowWatched, wakeRules: wake, defaultEndState: defaults.defaultEndState, productionWakeHours: defaults.productionWakeHours });
  }, [room, control.data, choices, allowWatched, wake, defaults, stopList.length]);
  const away = roomAway(room);
  const ret = useReturn(room, registry);
  // Close's own receipt is for the moment before the room says closed; once it does, the closed view says so, and a receipt kept
  // past that would reappear, stale, when the form opens again after Return.
  useEffect(() => { if (away?.closed) { setOutcome(null); setSelection(null); } }, [away?.closed]);
  useEffect(() => setConfirming(false), [settings.data?.revision]);

  if (away?.closed) return <div className="tv-form" aria-labelledby={`${id}-h`}>
    <header className="tv-form-h"><PageGlyph name="lantern" size={18} /><h2 id={`${id}-h`}><Vocabulary word="closing" /></h2></header>
    <p><b><ClosedWords away={away} /></b>{control.data?.window?.note ? <> · <span data-content>“{control.data.window.note}”</span></> : null}</p>
    {control.data?.window && <p>{windowStopWords(control.data.window)}</p>}
    <AwayNotes room={room} registry={registry} control={control.data} />
    <p className="m small">{REOPEN_LINE}</p>
    <footer className="tv-formf"><ReturnButton room={room} registry={registry} action={ret} /></footer>
  </div>;

  const submit = async () => {
    const state = control.data;
    if (!state || !settings.data || settings.pending) return;
    setOutcome(null);
    const quests = live.flatMap((q) => { const c = choices[q.id] ?? defaults.defaultEndState; return c === "hold" ? [] : [{ questId: q.id, endState: c }]; });
    try {
      const out = await close.mutate({ revision: state.revision, settingsRevision: settings.data.revision, stopList, until, note: note.trim() || null, quests, allowWatched, wakeRules: wake });
      if (out.code === "stale") { setOutcome({ tone: "warn", text: "Closing time or its settings changed. Nothing has closed; check the lines again." }); void control.refetch(); void settings.refetch(); return; }
      const words = closedWords(out.state.status) ?? "Closed";
      if (out.code === "pending") setOutcome({ tone: "warn", text: <>{words}, but {plural(out.state.pendingStops.length, "stop")} {s(out.state.pendingStops.length, "isn’t", "aren’t")} confirmed yet. Tavern retries {s(out.state.pendingStops.length, "it", "them")}.<AwayNotes room={room} registry={registry} control={out.state} /></> });
      else setOutcome({ tone: "done", text: `${words}. Return from the status line or here.` });
      setConfirming(false);
    } catch (e) {
      setOutcome({ tone: "bad", text: `Couldn’t close: ${e instanceof Error ? e.message : String(e)}. Nothing has closed; your choices are kept.` });
    }
  };

  return <form className="tv-form tv-awayform" aria-labelledby={`${id}-h`} onSubmit={(e) => { e.preventDefault(); if (!badTime) setConfirming(true); }}>
    <header className="tv-form-h"><PageGlyph name="lantern" size={18} /><h2 id={`${id}-h`}><Vocabulary word="closing" /></h2></header>
    {(ret.receipt || ret.problem) && <div className="tv-formr"><ReturnButton room={room} registry={registry} action={ret} /></div>}
    <p className="m">Choose what keeps going and what waits for your return.</p>
    <fieldset className="tv-fields" disabled={close.isPending}><legend className="sr">When you are back</legend>
      <label className="tv-field" htmlFor={`${id}-back`}>Back at<input className="tv-inp" id={`${id}-back`} type="datetime-local" value={backAt} onChange={(e) => { setBackAt(e.target.value); setConfirming(false); }} aria-invalid={badTime || undefined} aria-describedby={badTime ? `${id}-backerr` : undefined} required /></label>
      <label className="tv-field wide" htmlFor={`${id}-note`}>Note to the Keepers <span className="m">{note.length} of 500</span><textarea className="tv-inp" id={`${id}-note`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </fieldset>
    {badTime && <p id={`${id}-backerr`} className="tv-problem" role="alert">Back at has to be later than now.</p>}
    {live.map((q) => <fieldset key={q.id} className="opts tv-grpbox" disabled={close.isPending}><legend title={q.title}>{q.short || q.title}</legend>
      {CHOICES.map((c) => <label className="opt" key={c.id}><input type="radio" name={`${id}-end-${q.id}`} checked={(choices[q.id] ?? defaults.defaultEndState) === c.id} onChange={() => setChoices((prev) => ({ ...prev, [q.id]: c.id }))} /><span className="ol"><b>{c.label}</b><span className="m"> · {c.hint}</span></span></label>)}
    </fieldset>)}
    {!live.length && <p className="tv-empty" data-empty>No live quests: nothing would keep going while you are away.</p>}
    <fieldset className="tv-grpbox" disabled={close.isPending}><legend>Watched members</legend>
      <label className="tv-chk"><input type="checkbox" checked={allowWatched} onChange={(e) => setAllowWatched(e.target.checked)} /><span>Let watched members keep drafting (watched, not prevented){control.data ? <span className="m"> · {plural(stopList.length ? control.data.watchedCount : 0, "watched member")} now</span> : null}</span></label>
    </fieldset>
    <fieldset className="tv-grpbox" disabled={close.isPending}><legend>Wake me for</legend>
      <label className="tv-chk"><input type="checkbox" checked={wake.blockers} onChange={(e) => setWake((w) => ({ ...w, blockers: e.target.checked }))} /><span>Blockers</span></label>
      <label className="tv-chk"><input type="checkbox" checked={wake.productionAsksAfterTwoHours} onChange={(e) => setWake((w) => ({ ...w, productionAsksAfterTwoHours: e.target.checked }))} /><span>Production or cluster write asks waiting {plural(defaults.productionWakeHours, "hour")}</span></label>
    </fieldset>
    {settings.data && <>
      <AwayStopChoices items={stopList} disabled={close.isPending} onChange={items => { setSelection(items); setConfirming(false); }} />
      <p className="m small">These choices apply only to this window. Change the default in Tavern Settings.</p>
    </>}
    {settings.error && <p className="tv-problem" role="alert">{settings.error.message}</p>}
    {control.error && !control.data && <p className="tv-problem" role="alert"><span>Couldn’t read Closing time: {control.error.message}</span><button type="button" className="btn sm" onClick={() => void control.refetch()}>Retry</button></p>}
    {!confirming && <footer className="tv-formf"><button type="submit" className="btn pri" disabled={badTime || !control.data || !settings.data || settings.pending || close.isPending}><span>Review before closing</span></button></footer>}
    {confirming && <section className="tv-confirm" aria-labelledby={`${id}-c`}>
      <h3 id={`${id}-c`}>Before you close, until {Number.isFinite(until) ? <AwayTime at={until} /> : "—"}</h3>
      {plan.quests.length > 0 && <ul className="tv-confirm-q" aria-label="Each quest">
        {plan.quests.map((q) => <li key={q.id} data-quest={q.id}><span className="tv-confirm-n"><b title={q.title} data-content>{q.short}</b><span className={`tag tv-confirm-c c-${q.choice}`}>{CHOICES.find((c) => c.id === q.choice)!.label}</span></span><span data-content>{q.detail}</span></li>)}
      </ul>}
      <ul className="tv-confirm-l" aria-label={plan.quests.length ? "Everything else" : "What closing does"}>
        {plan.nothingRunning && <li data-line="nothing-running"><span>{NOTHING_RUNNING_LINE}</span></li>}
        {plan.watchedTotal && <li data-line="watched-total"><span>{plan.watchedTotal}</span></li>}
        {plan.stopping && <li data-line="stopping"><span>{plan.stopping}</span></li>}
        {plan.sideQuests.shown && <li data-line="side-quests"><span>{plan.sideQuests.text}{plan.sideQuests.pausing !== null && <> <b className="num">{plan.sideQuests.pausing}</b> {s(plan.sideQuests.pausing, "side quest pausing", "side quests pausing")}.</>}</span></li>}
        {plan.unattached && <li data-line="unattached"><span>{plan.unattached}</span></li>}
        {plan.solos.running > 0 && <li data-line="solos"><span>{plan.solos.text} <b className="num">{plan.solos.running}</b> {s(plan.solos.running, "solo running", "solos running")}.</span></li>}
        {plan.asks && <li data-line="asks"><span>{plan.asks}</span></li>}
        <li data-line="stop-policy"><span>{stopListWords(stopList)}</span></li>
        <li data-line="reopen"><span>{REOPEN_LINE}</span></li>
        <li data-line="nothing-ended"><span>{NOTHING_ENDED_LINE}</span></li>
      </ul>
      <footer className="tv-formf"><button type="button" className="btn pri" onClick={() => void submit()} disabled={close.isPending || badTime}><span>{close.isPending ? "Closing…" : "Close the tavern"}</span></button><button type="button" className="btn sm" onClick={() => setConfirming(false)} disabled={close.isPending}><span>Back to the sheet</span></button></footer>
    </section>}
    {outcome && <div className={outcome.tone === "bad" ? "tv-problem" : outcome.tone === "warn" ? "tv-awayout warn" : "tv-receipt"} role={outcome.tone === "bad" ? "alert" : "status"}>{outcome.tone === "done" && <PageGlyph name="done" />}<span>{outcome.text}</span>{outcome.tone === "bad" && <button type="button" className="btn sm" onClick={() => void submit()}>Retry</button>}</div>}
  </form>;
}
