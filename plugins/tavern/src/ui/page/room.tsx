import { hasEndedEngagement, memberActivityWord } from "../../shared/member-engagement";
import { attentionView } from "../../shared/attention";
import { StopAllNotice } from "./stop-all";
import { TellKeepers } from "./tell-keepers";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { PlacementFacts } from "../kit/placement";
import { voiceShown, Clamp, Crest, ExpandsMark, Hearth, OpensMark, rememberCount, Vocabulary, glowVars, hearthWords } from "../kit";
import type { BoardQuestSummary, Room } from "../../shared/contract";
import { DecidedForYou, NeedsYouQueue } from "./asks";
import { ArchiveFold, ArchiveReceiptLine, useArchive } from "./archive";
import { Ago, CrestOf, InlineLink, PageButton, Section, SegFilter, StateMark, characterName, classLabel, type Registry, plural } from "./common";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { eventContext, eventLines, needYouCount, questsIn, recordedAskAnchor, type EventLine } from "./model";
import { ClassStartCards } from "./start";
import { usePanelState } from "./panel-state";
import { Rail } from "./rail";
import { RoomAwayNotes } from "./away";
import { SKEL } from "./skeletons";
import { Board, RoomFold } from "./board";
import { SinceVisit } from "./since-visit";
import { reportsTitle, useOpenReports } from "./reports";
import { HearthBand } from "./hearth-band";
export { HearthBand as StatusLine } from "./hearth-band";

const reviewFolds = new Map<string, boolean>();
type ReviewItem = Room["review"]["items"][number];
const reviewKey = (item: ReviewItem) => item.reportId ?? `${item.boardQuestId ?? ""}:${item.waypoint?.id ?? item.title}:${item.member?.threadId ?? ""}`;

function ReviewRow({ item, single }: { item: ReviewItem; single: boolean }) {
  const key = reviewKey(item);
  const [open, setOpen] = useState(() => reviewFolds.get(key) ?? single);
  const bodyId = useId();
  const openReports = useOpenReports();
  const navigate = useBbNavigate();
  const title = item.waypoint?.title ?? item.title;
  const member = item.member;
  const who = item.waitingFor;
  const waiting = who?.who === "you" ? "you" : who?.who === "checker" ? `${who.name ?? "Checker"}${who.working === false ? " (assigned, not working)" : " checking"}` : who?.who === "keeper" ? "No checker working" : null;
  const toggle = () => {
    reviewFolds.delete(key);
    reviewFolds.set(key, !open);
    if (reviewFolds.size > 200) reviewFolds.delete(reviewFolds.keys().next().value!);
    setOpen(!open);
  };
  return <li className="tv-rv">
    <button type="button" className="tv-rv-head act" aria-label={`Review ${title}`} aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      <PageGlyph name="pr" /><span className="tv-rv-copy"><span className="tv-rv-t" title={title}>{title}{member && <> · {member.displayName} <span className="m">({member.classId})</span></>}</span><span className="tv-rv-meta m">{item.questTitle && <span data-content>{item.questTitle}</span>}{item.reportedAt != null && <span>reported <Ago at={item.reportedAt} /></span>}</span></span>
      <span className="tv-rv-tail">{waiting && <StateMark tone={who?.who === "you" ? "you" : who?.who === "checker" ? "work" : "keeper"}>{who?.who === "keeper" ? waiting : <>Waiting for {waiting}</>}</StateMark>}<ExpandsMark open={open} /></span>
    </button>
    {open && <div className="tv-rv-detail" id={bodyId}>
      {item.headline && <p data-content>{item.headline}{item.headlineTruncated && "…"}</p>}
      {item.headlineTruncated && <p className="m small">Read the rest in Open report.</p>}
      {item.waypoint?.doneWhen && <p><b>Done when:</b> <span data-content>{item.waypoint.doneWhen}</span></p>}
      {item.evidenceCount !== undefined && <p className="m">{item.evidenceCount} {item.evidenceCount === 1 ? "piece" : "pieces"} of evidence</p>}
      <div className="tv-rv-actions">
        {item.reportId && item.boardQuestId && member && <button type="button" className="btn sm" onClick={() => { if (!openReports({ questId: item.boardQuestId!, memberThreadId: member.threadId, reportId: item.reportId! }, reportsTitle(member.displayName, item.questTitle ?? title))) navigate.toPluginPanel("tavern", { subPath: `quest/${item.boardQuestId}` }); }}>Open report<OpensMark /></button>}
        {item.boardQuestId && <PageButton path={`quest/${item.boardQuestId}`} className="sm">Open quest</PageButton>}
        {item.url && <SafeLink href={item.url}>Open review</SafeLink>}
        {!item.boardQuestId && !item.url && <span className="m small">No link recorded</span>}
      </div>
    </div>}
  </li>;
}
export function ReviewQueue({ review }: { review: Room["review"] }) {
  if (!review.items.length) return null;
  return <Section title="Review queue" count={`${review.waiting} of ${review.budget} waiting for you`} aside={<ReviewMeter review={review} />}>
    <ul className="tv-card tv-rows">{review.items.map(item => <ReviewRow key={reviewKey(item)} item={item} single={review.items.length === 1} />)}</ul>
    {review.waiting >= review.budget && <p className="tv-holdnote" role="status"><PageGlyph name="report" /><span>At the review budget: clear one before more review-bound work starts.</span></p>}
  </Section>;
}
function ReviewMeter({ review }: { review: Room["review"] }) {
  return <span className={`tv-meter ${review.waiting >= review.budget ? "cap" : ""}`} role="img" aria-label={`Review budget: ${review.waiting} of ${review.budget} in use`}><i style={{ width: `${Math.min(100, (review.waiting / Math.max(review.budget, 1)) * 100)}%` }} /></span>;
}
export function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  return /^https?:\/\//i.test(href) ? <a className="btn sm" href={href} target="_blank" rel="noreferrer">{children}<OpensMark /></a> : <span>{children}: unsupported link</span>;
}

const EVENT_GLYPH: Record<EventLine["icon"], PageGlyphName> = { steer: "steer", question: "question", aside: "aside", quest: "quest", plan: "plan", ask: "you", answer: "done", decided: "seal", undo: "undo", rule: "rule", report: "report", hire: "hire", told: "told", stale: "stale", failed: "fail", anchor: "anchor", stop: "stop", skip: "skip", wrap: "wrap", phase: "phase", tick: "tick", note: "note" };
export function EventRow({ line, registry, compact = false, linkAsks = false }: { line: EventLine; registry: Registry; compact?: boolean; linkAsks?: boolean }) {
  const who = line.actor.kind === "you" ? "You" : line.actor.kind === "tavern" ? "Tavern" : line.actor.kind === "unknown" ? "" : line.actorLabel ?? characterName(registry, line.actor.member);
  const repeats = (line.repeats ?? 1) > 1 ? <span className="num" aria-label={`${line.repeats} occurrences`}>×{line.repeats}</span> : null;
  return <li className={`tv-ev t-${line.tone}${compact ? " tv-ev-compact" : ""}`}>
    <PageGlyph name={EVENT_GLYPH[line.icon] ?? "note"} size={13} className="tv-ev-g" />
    {compact ? <span className="tv-ev-brief"><Clamp text={[who, line.head].filter(Boolean).join(" ")} more={line.detail ?? undefined} lines={1} className="tv-ev-preview" />{repeats}</span> : <span className="tv-ev-b">
      <span className="tv-ev-h">{line.actor.kind === "member" || line.actor.kind === "keeper" ? <span className="tv-ev-who"><CrestOf member={line.actor.member} registry={registry} size={14} /><b>{who}</b></span> : line.actor.kind === "you" ? <b className="tv-ev-you">You</b> : line.actor.kind === "tavern" ? <b className="m">Tavern</b> : null} <span title={line.note}>{line.head}</span>{repeats}</span>
      {line.detail && <span className="tv-ev-d" data-content title={line.detail}>{line.detail}</span>}
      {line.replacement && <span className="tv-ev-d" data-content>{linkAsks
        ? <a href={`#${recordedAskAnchor(line.replacement.id)}`}>Replaced by {line.replacement.question}</a>
        : `Replaced by ${line.replacement.question}`}</span>}
    </span>}
    <Ago at={line.at} />
  </li>;
}

/** A plain list of events, newest first. */
export function EventList({ lines, registry, compact, linkAsks }: { lines: EventLine[]; registry: Registry; compact?: boolean; linkAsks?: boolean }) {
  return <ol className="tv-evs">{lines.map((line) => <EventRow key={line.id} line={line} registry={registry} compact={compact} linkAsks={linkAsks} />)}</ol>;
}

/** Events grouped by quest: each quest is named once, as a quiet link, with its latest events under it. */
function GroupedEvents({ lines, registry, questShort }: { lines: EventLine[]; registry: Registry; questShort: (id: string) => string | null }) {
  const navigate = useBbNavigate();
  const groups = new Map<string, EventLine[]>();
  for (const line of lines) { const key = line.questId ?? ""; groups.set(key, [...(groups.get(key) ?? []), line]); }
  return <div className="tv-evgroups">{[...groups.entries()].map(([q, items]) => {
    const short = q ? questShort(q) : null;
    return <section key={q || "none"} className="tv-evgroup" aria-label={short ?? "Not tied to a board quest"}>
      <header className="tv-evq">{short ? <InlineLink onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q}` })} title={`Open the quest page: ${short}`}>{short}<OpensMark /></InlineLink> : <span>Keepers and solos</span>}<span className="m">{plural(items.reduce((sum, item) => sum + (item.repeats ?? 1), 0), "event")}</span></header>
      <EventList lines={items} registry={registry} compact />
    </section>;
  })}</div>;
}

const FILTERS = [["all", "All"], ["asks", "Asks"], ["steers", "Steers"], ["reports", "Reports"], ["decided", "Decided"]] as const;
export type Filter = (typeof FILTERS)[number][0];
export function EventFeed({ lines, qualified, registry, questShort, title = "What happened", filter, setFilter, showQuest = true, limit = 8, foldKey = null }: { lines: EventLine[]; qualified?: ReadonlyMap<number, EventLine>; registry: Registry; questShort: (id: string) => string | null; title?: ReactNode; filter: Filter; setFilter: (f: Filter) => void; showQuest?: boolean; limit?: number; foldKey?: string | null }) {
  const [more, setMore] = usePanelState(foldKey && `${foldKey}.more`, false);
  if (!lines.length) return null;
  const shown = lines.filter((l) => filter === "all" || l.filter === filter);
  const count = (list: EventLine[]) => list.reduce((sum, item) => sum + (item.repeats ?? 1), 0);
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, f === "all" ? count(lines) : count(lines.filter((l) => l.filter === f))]));
  const preview = more ? shown : shown.slice(0, limit);
  const crossParty = qualified && new Set(preview.flatMap(l => l.memberKeeperIds ?? [])).size > 1;
  const namedPreview = crossParty ? preview.map(l => qualified.get(l.id) ?? l) : preview;
  return <Section title={title} count={plural(count(lines), "event")} className="tv-events-sec" action={<SegFilter label="Filter events" value={filter} onChange={setFilter} options={FILTERS.filter(([f]) => f === "all" || counts[f]).map(([f, label]) => ({ id: f, label, count: counts[f] }))} />}>
    {showQuest ? <GroupedEvents lines={namedPreview} registry={registry} questShort={questShort} /> : <EventList lines={namedPreview} registry={registry} />}
    {shown.length > limit && <button type="button" className="tv-fold act" aria-expanded={more} onClick={() => setMore(!more)}><ExpandsMark open={more} />{more ? "Show fewer" : "Show every event"}</button>}
    {!shown.length && <p className="tv-empty" data-empty>Nothing of this kind yet.</p>}
  </Section>;
}

const SEEN_KEY = "tavern.commonRoom.lastSeen";
function useSinceLastVisit() {
  const [since] = useState<number | null>(() => { try { const v = window.localStorage.getItem(SEEN_KEY); return v ? Number(v) : null; } catch { return null; } });
  useEffect(() => { try { window.localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* Arrival cues are optional without local storage. */ } }, []);
  return since;
}
export function Errands({ room, registry }: { room: Room; registry: Registry }) {
  const navigate = useBbNavigate();
  const errands = room.keepers.flatMap((k) => k.errands.map((m) => ({ m, keeper: k.member })));
  const live = errands.filter(({ m }) => !hasEndedEngagement(m));
  const done = errands.filter(({ m }) => hasEndedEngagement(m));
  const [doneOpen, setDoneOpen] = usePanelState("room.errands.done", false);
  if (!errands.length) return null;
  return <Section title={<Vocabulary word="errand" plural />} count={`${live.length} out`} aside="kept apart from quests" level={3}>
    <div className="tv-errands">{live.map(({ m, keeper }) => <Fragment key={m.threadId}><button type="button" className="tv-erow act" onClick={() => navigate.toThread(m.threadId)} title={`Open ${characterName(registry, m)}'s thread`}>
      <CrestOf member={m} registry={registry} size={16} /><span className="tv-erow-t"><b>{m.title ?? m.doing ?? "Errand"}</b> <span className="m">· {characterName(registry, m)} for {characterName(registry, keeper)}</span></span><StateMark tone={m.state === "failed" ? "bad" : m.state === "working" ? "work" : "wait"}>{memberActivityWord(m)}</StateMark><OpensMark />
    </button><PlacementFacts placement={m.placement} memberName={characterName(registry, m)} /></Fragment>)}
      {done.length > 0 && <details className="tv-fold-d" open={doneOpen} onToggle={(event) => { const now = (event.currentTarget as HTMLDetailsElement).open; if (now !== doneOpen) setDoneOpen(now); }}><summary className="tv-fold act"><ExpandsMark open={doneOpen} />{done.length} done · {done.map(({ m }) => m.title ?? characterName(registry, m)).join(", ")}</summary>{done.map(({ m }) => <Fragment key={m.threadId}><button type="button" className="tv-erow done act" onClick={() => navigate.toThread(m.threadId)}><CrestOf member={m} registry={registry} size={16} /><span className="tv-erow-t"><b>{m.title ?? "Errand"}</b> <span className="m" data-content>· {m.doing}</span></span><StateMark tone="done">done</StateMark><OpensMark /></button><PlacementFacts placement={m.placement} memberName={characterName(registry, m)} /></Fragment>)}</details>}
    </div>
  </Section>;
}

export function Solos({ room, registry }: { room: Room; registry: Registry }) {
  const navigate = useBbNavigate();
  if (!room.solos.length) return null;
  return <Section title={<>Solos <span className="anc">your own typed threads</span></>} count={`${plural(room.solos.length, "thread")}`} level={3}>
    <div className="tv-errands">{room.solos.map((m) => { const cls = classLabel(registry, m.classId); return <Fragment key={m.threadId}><button type="button" className="tv-erow solo act" onClick={() => navigate.toThread(m.threadId)} title={`Open ${characterName(registry, m)}'s thread`}>
      <CrestOf member={m} registry={registry} size={16} /><span className="tv-erow-t"><b>{characterName(registry, m)}</b> <span className="m">· {cls ? cls.label : m.classId}{m.title ? ` · ${m.title}` : ""}</span></span><StateMark tone={m.state === "working" ? "work" : m.state === "failed" ? "bad" : m.engagement === "resting" ? "done" : "wait"}>{memberActivityWord(m)}</StateMark><OpensMark />
    </button><PlacementFacts placement={m.placement} memberName={characterName(registry, m)} /></Fragment>; })}</div>
  </Section>;
}


const EMPTY_SECTIONS = [
  ["Needs you", "Asks waiting on you, oldest first, answered in place."],
  ["Decided for you", "Reversible calls a Keeper made alone, each with Undo."],
  ["Errands", "Quick jobs a Keeper sends out, kept apart from quests."],
  ["Solos", "Your own typed threads that belong to no Keeper."],
  ["Returned", "Finished quests, each with its tale and verified loot."],
  ["What happened", "Steers, reports, answers and decisions, in plain words."],
] as const;

export function CommonRoom({ room, registry }: { room: Room; registry: Registry }) {
  return <><StopAllNotice /><RoomContents room={room} registry={registry} /></>;
}

function RoomContents({ room, registry }: { room: Room; registry: Registry }) {
  const empty = !room.keepers.length && !room.asks.length && !room.solos.length && !room.decidedForYou.length && !room.recent.length && !room.review.waiting && !room.review.items.length && !room.archivedCount;
  if (!empty) return <RoomActivity room={room} registry={registry} />;
  const keeper = registry.classes.find((cls) => cls.id === "keeper");
  const host = registry.characters.find((character) => keeper?.characters.includes(character.id));
  return <div className="tv-room"><section className="tv-first-night" aria-labelledby="tv-first-night-title" data-empty>
    <div className="tv-hearth lit" style={glowVars("hearth")}>{registry.characters.flatMap((character, i) => {
      const cls = registry.classes.find((item) => character.classes.includes(item.id));
      const crest = cls ? [<span key={character.id} aria-hidden="true" style={{ ["--i" as string]: i }}><Crest cls={cls} character={character} size={36} /></span>] : [];
      // The kit hearth sits at the ring's centre, out until the first Keeper arrives; the cast around it waits to be hired.
      return i === Math.floor(registry.characters.length / 2) ? [<span key="hearth" className="tv-hearth-c"><Hearth words={hearthWords([])} surface="page" size={40} /></span>, ...crest] : crest;
    })}</div>
    <h1 id="tv-first-night-title">The common room is quiet</h1>
    {host && voiceShown(registry) && <p className="tv-voice tv-first-voice" data-content>{host.lines.empty}</p>}
    <p className="tv-first-invitation">Start a quest: give a Keeper <span className="anc">lead</span> a thin goal in bb's new-thread composer. Rangers <span className="anc">scouts</span> explore, you approve one quest map, then the party <span className="anc">team</span> forms.</p>
    <ClassStartCards registry={registry} openComposer />
    <div className="tv-first-links"><PageButton path="classes" className="ghost">Meet the classes <span className="anc">types</span></PageButton><PageButton path="closing" className="ghost">Closing time <span className="anc">away</span></PageButton></div>
  </section>
  <details className="tv-empty-fold">
    <summary className="tv-fold act"><ExpandsMark open={false} />What the common room shows once a quest starts · 6 sections</summary>
    <div className="tv-empty-grid">{EMPTY_SECTIONS.map(([title, line]) => <section key={title} className="tv-empty-sec" aria-label={title}><h3>{title}</h3><p className="m">{line}</p></section>)}</div>
  </details></div>;
}

const errandsOf = (room: Room) => room.keepers.flatMap((keeper) => keeper.errands.map((m) => ({ m, keeper: keeper.member })));

function RoomActivity({ room, registry }: { room: Room; registry: Registry }) {
  const api = useArchive();
  const ctx = useMemo(() => eventContext(room, registry, false), [room, registry]);
  const allLines = useMemo(() => eventLines(room.recent, ctx, { collapseRepeats: true, trackParties: true }), [room.recent, ctx]);
  const qualified = useMemo(() => new Set(allLines.flatMap(l => l.memberKeeperIds ?? [])).size > 1
    ? new Map(eventLines(room.recent, eventContext(room, registry, true), { collapseRepeats: true }).map(l => [l.id, l]))
    : undefined, [allLines, room, registry]);
  const onBoard = useMemo(() => new Set(questsIn(room).filter((q) => !q.archivedAt).map((q) => q.id)), [room]);
  const inCellar = (l: Pick<EventLine, "questId">) => l.questId !== null && (!onBoard.has(l.questId) || api.hidden.has(l.questId));
  const [showCellar, setShowCellar] = usePanelState("room.events.cellar", false);
  const folded = allLines.filter(inCellar).reduce((count, line) => count + (line.repeats ?? 1), 0);
  const lines = showCellar ? allLines : allLines.filter((l) => !inCellar(l));
  const [filter, setFilter] = usePanelState<Filter>("room.events.filter", "all", (v) => FILTERS.some(([f]) => f === v));
  const since = useSinceLastVisit();
  const navigate = useBbNavigate();
  const asks = needYouCount(room);
  const calls = attentionView(room.attention).decided ?? attentionView(room.attention).new;
  const decided = Math.min(3, calls);
  const errands = errandsOf(room).length;
  useEffect(() => { rememberCount(SKEL.asks, asks); rememberCount(SKEL.decided, decided); rememberCount(SKEL.events, Math.min(8, lines.length)); }, [asks, decided, lines.length]);
  return <div className="tv-room rm-a" data-room>
    <h1 className="sr">The common room (home)</h1>
    <HearthBand room={room} registry={registry} />
    <SinceVisit visit={room.sinceVisit} foldOnNarrow={asks > 0} />
    <RoomAwayNotes room={room} registry={registry} />
    <TellKeepers keepers={room.keepers.filter(k => !k.member.leadLinkId)} registry={registry} />
    <ArchiveReceiptLine api={api} />
    {(asks > 0 || attentionView(room.attention).heldByYou > 0) && <div data-sec="needs"><NeedsYouQueue room={room} registry={registry} /></div>}
    <Rail calm={!asks && !attentionView(room.attention).new}
      attention={<>
        <div id="rm-decided" data-sec="decided"><DecidedForYou decisions={room.decidedForYou} total={calls} seen={{ throughId: room.decidedThroughId }} headingId="room-decided" limit={3} compact /></div>
        {!!room.review.items.length && <div id="rm-review" data-sec="review"><ReviewQueue review={room.review} /></div>}
        {!asks && !attentionView(room.attention).new && <p className="tv-empty rm-calm" data-empty>Nothing needs you.</p>}
      </>}
      board={<div data-sec="board"><Board room={room} registry={registry} api={api} since={since ?? undefined} /></div>}
      lists={null}
      events={<div className="rm-stackcol">
        <div id="rm-events" data-sec="events"><EventFeed lines={lines} qualified={qualified} registry={registry} questShort={(id) => ctx.questShort(id) ?? (inCellar({ questId: id }) ? "A quest in the cellar" : null)} filter={filter} setFilter={setFilter} foldKey="room.events" />
          {folded > 0 && <button type="button" className="tv-fold act" aria-expanded={showCellar} onClick={() => setShowCellar(!showCellar)}><ExpandsMark open={showCellar} /><span>{showCellar ? "Fold the cellar's events" : `${plural(folded, "event")} from quests in the cellar folded out`}</span></button>}
        </div>
        {(errands > 0 || room.solos.length > 0) && <div id="rm-lists" className="rm-stackcol">
          {errands > 0 && <RoomFold name="errands" label="Errands" count={errands}><div data-sec="errands"><Errands room={room} registry={registry} /></div></RoomFold>}
          {room.solos.length > 0 && <RoomFold name="solos" label="Solos" count={room.solos.length}><div data-sec="solos"><Solos room={room} registry={registry} /></div></RoomFold>}
        </div>}
      </div>}
      cellar={<ArchiveFold room={room} registry={registry} api={api} />}
    />
  </div>;
}
