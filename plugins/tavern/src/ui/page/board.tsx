import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef } from "react";
import { onTheRoad, CELLAR, ExpandsMark, Hearth, rememberCount, KeeperRow, OpensMark, QuestRow, QuietNotice, Vocabulary, clockTime, glowVars, hearthWords, keeperStartedLabel, keeperStatus, plural, useNow, useReturnCue, useToday } from "../kit";
import type { BoardQuestSummary, Room } from "../../shared/contract";
import type { Member } from "../../shared/schema";
import type { ArchiveApi } from "./archive";
import { CrestOf, StateMark, characterName, classLabel, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { isFinished, questMove, roomAway } from "./model";
import { usePanelState } from "./panel-state";
import { SKEL } from "./skeletons";
import { PartyPicture } from "./room";
import { settingsHref } from "./insights";

type K = Room["keepers"][number];
const names = (registry: Registry, keeper: Member) => ({ keeper: characterName(registry, keeper), member: (m: Member) => characterName(registry, m) });
/** A Keeper's quests still in the room: not in the cellar, and not just sent there (the receipt's Undo can bring them back). */
export const inRoom = (k: K, api: Pick<ArchiveApi, "hidden">) => k.boardQuests.filter((q) => !q.archivedAt && !api.hidden.has(q.id));
export const needsYou = (room: Room, k: K) => room.asks.some((a) => a.state === "open" && a.keeperThreadId === k.member.threadId);
const unseenDecided = (room: Room, k: K) => room.decidedForYou.filter((d) => d.keeperThreadId === k.member.threadId && !d.undone && d.seenAt == null).length;

/**
 * Who gets a notice and in what order: a Keeper with a quest in the room or an open ask. Yours first, then a failed member,
 * then work on the road, then only returned quests, archived threads last; the latest change breaks ties. The rest are rows.
 */
export function sortKeepers(room: Room, api: Pick<ArchiveApi, "hidden">) {
  const withWork = room.keepers.filter((k) => inRoom(k, api).length > 0 || needsYou(room, k));
  const rank = (k: K) => needsYou(room, k) ? 0 : inRoom(k, api).some((q) => !isFinished(q.phase) && q.members.some((m) => m.state === "failed")) ? 1 : k.archived ? 4 : inRoom(k, api).some((q) => !isFinished(q.phase)) ? 2 : 3;
  const latest = (k: K) => Math.max(0, ...inRoom(k, api).map((q) => q.updatedAt));
  const notices = [...withWork].sort((a, b) => rank(a) - rank(b) || latest(b) - latest(a));
  const idle = room.keepers.filter((k) => !withWork.includes(k));
  return { notices, idleLive: idle.filter((k) => !k.archived), idleArchived: idle.filter((k) => k.archived) };
}

/** The board's one glow: the notice that needs you, else the one with the most members at work. Never a quiet or archived Keeper. */
export function litKeeper(room: Room, notices: K[]) {
  const awake = notices.filter((k) => k.quietSince == null && !k.archived);
  const waiting = awake.find((k) => needsYou(room, k));
  if (waiting) return waiting.member.threadId;
  const working = (k: K) => k.boardQuests.flatMap((q) => isFinished(q.phase) ? [] : q.members).filter((m) => m.state === "working").length;
  const busiest = [...awake].sort((a, b) => working(b) - working(a))[0];
  return busiest && working(busiest) > 0 ? busiest.member.threadId : null;
}

const ACTIVE_CAP = 5;
const DONE_CAP = 2;
/** A Keeper's notice: its header is the Keeper (it opens the thread), and each quest's row opens that quest. */
export function KeeperNotice({ keeper, room, registry, api, lit, since }: { keeper: K; room: Room; registry: Registry; api: ArchiveApi; lit: boolean; since?: number }) {
  const navigate = useBbNavigate();
  const day = useToday();
  const rows = useRef<HTMLDivElement>(null);
  useReturnCue(rows, { also: ".rm-more" });
  const id = keeper.member.threadId;
  const name = characterName(registry, keeper.member);
  const title = keeper.threadTitle ?? null;
  const all = inRoom(keeper, api);
  const order = (q: BoardQuestSummary) => { const t = questMove(q, room.asks, names(registry, keeper.member), { now: day }).tone; return t === "you" ? 0 : t === "bad" ? 1 : 2; };
  const active = all.filter((q) => !isFinished(q.phase)).sort((a, b) => order(a) - order(b) || b.updatedAt - a.updatedAt);
  const done = all.filter((q) => isFinished(q.phase)).sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
  const [moreA, setMoreA] = usePanelState(`room.notice.${id}.active`, false);
  const [moreD, setMoreD] = usePanelState(`room.notice.${id}.done`, false);
  const party = [...new Map(active.flatMap((q) => q.members).map((m) => [m.threadId, m])).values()];
  const failed = party.filter((m) => m.state === "failed").length;
  const stale = party.filter((m) => m.strikes > 0).length;
  const health = failed ? `${failed} failed` : stale ? `${stale} quiet` : null;
  const cls = classLabel(registry, keeper.member.classId);
  const started = keeperStartedLabel(keeper, room.keepers, registry, day);
  const decided = unseenDecided(room, keeper);
  const steered = active.map((q) => q.plan?.fromSteer).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => b.at - a.at)[0];
  const versions = active.filter((q) => q.planVersion > 0).map((q) => `v${q.planVersion}`);
  const ledger = steered ? `steer ${clockTime(steered.at)}` : versions.length ? `quest map ${versions.slice(0, 3).join(", ")}` : null;
  const status = keeperStatus(keeper);
  const label = `Open ${name}'s thread${title ? `: ${title}` : ""}${started ? `, ${started}` : ""}`;
  const archive = (q: BoardQuestSummary) => void api.archive([q]);
  return <article className={`tv-notice rm-notice ${needsYou(room, keeper) ? "needs" : ""} ${lit ? "lit" : ""}`} aria-label={`${name}${title ? `, ${title}` : ""}, Keeper`} style={lit ? glowVars(`notice:${id}`) : undefined} data-part="KeeperNotice">
    <span className="tack" aria-hidden="true" />
    <header className="rm-nh">
      <button type="button" className="rm-nh-who act" onClick={() => navigate.toThread(id)} title={label} aria-label={label}>
        <CrestOf member={keeper.member} registry={registry} size={28} />
        <span className="rm-nh-t"><span className="rm-nh-l1"><b>{name}</b><span className="rm-nh-title" data-content>{title ?? cls?.label ?? "Keeper"}</span>{started && <span className="rm-nh-st">· {started}</span>}<OpensMark /></span>
          {health && <span className="rm-nh-l2"><b className="tv-health" data-stuck={failed > 0 || undefined}>{health}</b></span>}</span>
      </button>
      <span className="rm-nh-s"><StateMark tone={status.tone}>{status.label}</StateMark></span>
    </header>
    <QuietNotice threadId={id} since={keeper.quietSince} />
    {(keeper.freeHands ?? 0) > 0 && <p className="m small">{keeper.freeHands} free {keeper.freeHands === 1 ? "hand" : "hands"}</p>}
    {party.length > 0 && <PartyPicture ambientMotion={room.ambientMotion} repeatSeconds={room.repeatSeconds} members={party} registry={registry} quests={all} mini />}
    <div className="rm-qs" ref={rows}>
      {(moreA ? active : active.slice(0, ACTIVE_CAP)).map((q) => <QuestRow key={q.id} quest={q} room={room} registry={registry} keeper={keeper} arrival={{ since }} />)}
      {active.length > ACTIVE_CAP && <button type="button" className="tv-fold act rm-more" aria-expanded={moreA} onClick={() => setMoreA(!moreA)}><ExpandsMark open={moreA} /><span>{moreA ? "Show fewer" : `+${active.length - ACTIVE_CAP} more active ${active.length - ACTIVE_CAP === 1 ? "quest" : "quests"}`}</span></button>}
      {done.length > 0 && <div className="rm-done" role="group" aria-label={`${name}: returned and stopped`}>{(moreD ? done : done.slice(0, DONE_CAP)).map((q) => <QuestRow key={q.id} quest={q} room={room} registry={registry} keeper={keeper} onArchive={archive} pending={api.pending} arrival={{ since }} />)}</div>}
      {done.length > DONE_CAP && <button type="button" className="tv-fold act rm-more" aria-expanded={moreD} onClick={() => setMoreD(!moreD)}><ExpandsMark open={moreD} /><span>{moreD ? "Show fewer" : `+${done.length - DONE_CAP} returned`}</span></button>}
    </div>
    {(decided > 0 || ledger) && <footer className="tv-nf">{decided > 0 && <span className="tag tv-decided-tag" title="Reversible calls made for you, not yet seen"><PageGlyph name="seal" /><span>{decided} decided</span></span>}{ledger && <span className="tv-nf-t">{ledger}</span>}</footer>}
  </article>;
}

/**
 * Row-order masonry: each child spans as many 4 px rows as it is tall (plus the 18 px gap), so a short notice packs under a short one.
 * The board aligns its children to the start, so a child's height never depends on its span: the fit reads every height first, then
 * writes only the spans that changed. It runs only from the ResizeObserver callback, after the browser's own layout, so a room
 * render that changes no size forces no layout at all.
 */
export function fitMasonry(children: readonly HTMLElement[], heightOf: (el: HTMLElement) => number) {
  const spans = children.map((el) => `span ${Math.ceil((heightOf(el) + 18) / 4)}`);
  children.forEach((el, i) => { if (el.style.gridRowEnd !== spans[i]) el.style.gridRowEnd = spans[i]!; });
}
export function useMasonry<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  const observer = useRef<{ ro: ResizeObserver; watched: Set<Element> } | null>(null);
  // A render only tells the observer about children that came or went: no measuring here.
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    if (!observer.current) observer.current = { ro: new ResizeObserver(() => fitMasonry([...grid.children] as HTMLElement[], (el) => el.getBoundingClientRect().height)), watched: new Set() };
    const { ro, watched } = observer.current;
    const now = new Set(grid.children);
    for (const el of watched) if (!now.has(el)) { ro.unobserve(el); watched.delete(el); }
    for (const el of now) if (!watched.has(el)) { ro.observe(el); watched.add(el); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  // In the layout phase too, so a remount (React's strict check) drops the old observer before the effect above makes a new one.
  useLayoutEffect(() => () => { observer.current?.ro.disconnect(); observer.current = null; }, []);
  return ref;
}

/** The board's hearth. Its words read the clock while the tavern is closed ("closed until Sun 08:00"), so it keeps its own. */
function BoardHearth({ room, flareKey }: { room: Room; flareKey: string | undefined }) {
  const now = useNow();
  const pluginId = experimental_usePluginId();
  // Ambient motion follows the Motion settings; older servers retain Calm with the legacy flicker switch.
  return <Hearth words={hearthWords(room.keepers.map(keeperStatus), { away: roomAway(room), now, onRoad: onTheRoad(room) })} surface="page" flareKey={flareKey} replay={room.hearthFlicker !== false} ambientMotion={room.ambientMotion} repeatSeconds={room.repeatSeconds} settingsHref={settingsHref(pluginId)} />;
}

/**
 * The quest board: a notice per Keeper with work, one-line rows for idle Keepers, archived idle Keepers folded.
 * Heading line 1 is the title and the hearth, whose words carry the Keeper count; line 2 the actions. `since` is the room's last look, for the rows' "new" marks.
 */
export function Board({ room, registry, api, since }: { room: Room; registry: Registry; api: ArchiveApi; since?: number }) {
  const navigate = useBbNavigate();
  const { notices, idleLive, idleArchived } = sortKeepers(room, api);
  const [foldOpen, setFoldOpen] = usePanelState("room.board.idle", false);
  const returned = room.keepers.flatMap((k) => inRoom(k, api)).filter((q) => isFinished(q.phase));
  const lit = litKeeper(room, notices);
  // The hearth flares once when a quest comes back: its key is the newest returned quest.
  const newestReturned = returned.filter((q) => q.phase === "done").sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))[0]?.id;
  const grid = useMasonry<HTMLDivElement>([room, api.hidden, foldOpen]);
  useEffect(() => rememberCount(SKEL.notices, notices.length), [notices.length]);
  return <section className="tv-sec rm-board-sec" aria-labelledby="rm-board-h">
    <header className="tv-colh rm-boardhead"><h2 id="rm-board-h"><Vocabulary word="questBoard" /></h2>
      <span className="rm-hearth-slot" data-slot="hearth"><BoardHearth room={room} flareKey={newestReturned} /></span>
      <div className="rm-board-acts">
        <button type="button" className="btn ghost sm" onClick={() => navigate.toPluginPanel("tavern", { subPath: "map" })}><PageGlyph name="map" /><span>The map</span><OpensMark /></button>
        {returned.length > 1 && <button type="button" className="lnk-btn act" onClick={() => void api.archive(returned)} disabled={api.pending} title={`${CELLAR.sendAllReturned}: ${plural(returned.length, "quest")}, returned and stopped`}><PageGlyph name="archive" /><span>{CELLAR.sendAllReturned}</span></button>}
      </div>
    </header>
    <div className="tv-board rm-board lit" ref={grid} style={glowVars("board")}>
      {notices.map((k) => <KeeperNotice key={k.member.threadId} keeper={k} room={room} registry={registry} api={api} lit={k.member.threadId === lit} since={since} />)}
      {(idleLive.length > 0 || idleArchived.length > 0) && <div className="rm-idle" data-part="KeeperRow list">
        {idleLive.map((k) => <KeeperRow key={k.member.threadId} keeper={k} registry={registry} room={room} />)}
        {idleArchived.length > 0 && <>
          <button type="button" className="tv-fold act rm-idle-fold" aria-expanded={foldOpen} onClick={() => setFoldOpen(!foldOpen)}><ExpandsMark open={foldOpen} /><span>{plural(idleArchived.length, "Keeper")} without a quest · threads archived</span></button>
          {foldOpen && idleArchived.map((k) => <KeeperRow key={k.member.threadId} keeper={k} registry={registry} room={room} />)}
        </>}
      </div>}
      {!room.keepers.length && <p className="tv-empty" data-empty>No Keeper yet. Start a quest from the header to hire one.</p>}
    </div>
  </section>;
}
