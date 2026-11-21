import { attentionView } from "../../shared/attention";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ExpandsMark, rememberCount, KeeperRow, OpensMark, QuestRow, QuietNotice, Vocabulary, clockTime, glowVars, keeperStartedLabel, keeperStatus, plural, useReturnCue, useToday } from "../kit";
import type { BoardQuestSummary, Room } from "../../shared/contract";
import type { Member } from "../../shared/schema";
import type { CellarStopReceipt } from "../../shared/stop-all";
import type { ArchiveApi } from "./archive";
import { CrestOf, Faces, StateMark, characterName, classLabel, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { boardQuestState, isFinished, questMove } from "./model";
import { usePanelState } from "./panel-state";
import { SKEL } from "./skeletons";
import { jumpTo } from "./rail";
import { CellarStopReceiptView, StopKeeperGone } from "./stop-all";
import { PlacementFacts } from "../kit/placement";
import { RefreshKeeper } from "../kit/succession";


type K = Room["keepers"][number];
const names = (registry: Registry, keeper: Member) => ({ keeper: characterName(registry, keeper), member: (m: Member) => characterName(registry, m) });
/** A Keeper's quests still in the room: not in the cellar, and not just sent there (the receipt's Undo can bring them back). */
export const inRoom = (k: K, api: Pick<ArchiveApi, "hidden">) => k.boardQuests.filter(q => boardQuestState(k, q) !== "off-board" && !api.hidden.has(q.id));
export const needsYou = (_room: Room, k: K) => attentionView(k.attention).needYou > 0;
const unseenDecided = (_room: Room, k: K) => attentionView(k.attention).decided ?? attentionView(k.attention).new;

export function sortKeepers(room: Room, api: Pick<ArchiveApi, "hidden">) {
  const open = (keeper: K) => inRoom(keeper, api).filter(quest => boardQuestState(keeper, quest) === "active");
  const active = room.keepers.filter(keeper => !keeper.archived && (open(keeper).length > 0 || needsYou(room, keeper)));
  const rank = (keeper: K) => needsYou(room, keeper) ? 0 : open(keeper).some(quest => quest.members.some(member => member.state === "failed")) ? 1 : 2;
  const latest = (keeper: K) => Math.max(0, ...open(keeper).map(quest => quest.updatedAt));
  return {
    notices: active.sort((a, b) => rank(a) - rank(b) || latest(b) - latest(a)),
    idle: room.keepers.filter(keeper => !active.includes(keeper) && inRoom(keeper, api).every(q => boardQuestState(keeper, q) === "finished")),
  };
}

/** The board's one glow: the notice that needs you, else the one with the most members at work. Never a quiet or archived Keeper. */
export function litKeeper(room: Room, notices: K[]) {
  const awake = notices.filter((k) => k.quietSince == null && !k.archived);
  const waiting = awake.find((k) => needsYou(room, k));
  if (waiting) return waiting.member.threadId;
  const working = (k: K) => k.boardQuests.flatMap(q => boardQuestState(k, q) === "active" ? q.members : []).filter((m) => m.state === "working").length;
  const busiest = [...awake].sort((a, b) => working(b) - working(a))[0];
  return busiest && working(busiest) > 0 ? busiest.member.threadId : null;
}

const ACTIVE_CAP = 5;
const PARTY_CAP = 4;

export function NoticeParty({ party, registry, id }: { party: Member[]; registry: Registry; id: string }) {
  const [all, setAll] = usePanelState(`room.notice.${id}.party`, false);
  const controlled = useId();
  return <div className="rm-party-strip" role="group" aria-label="Party">
    <div id={controlled}><Faces members={all ? party : party.slice(0, PARTY_CAP)} registry={registry} size={18} max={party.length} still /></div>
    {party.map(member => <PlacementFacts key={member.threadId} placement={member.placement} memberName={characterName(registry, member)} variant="compact" />)}
    {party.length > PARTY_CAP && <button type="button" className="tv-fold act" aria-controls={controlled} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer members" : `+${party.length - PARTY_CAP} more members`}</button>}
  </div>;
}
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
  const active = all.filter(q => boardQuestState(keeper, q) === "active").sort((a, b) => order(a) - order(b) || b.updatedAt - a.updatedAt);
  const [moreA, setMoreA] = usePanelState(`room.notice.${id}.active`, false);
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
    {!keeper.archived && <RefreshKeeper threadId={id} view={keeper.succession} />}
    {(keeper.freeHands ?? 0) > 0 && <p className="m small">{keeper.freeHands} free {keeper.freeHands === 1 ? "hand" : "hands"}</p>}
    {party.length > 0 && <NoticeParty party={party} registry={registry} id={id} />}
    <div className="rm-qs" ref={rows}>
      {(moreA ? active : active.slice(0, ACTIVE_CAP)).map((q) => <QuestRow key={q.id} quest={q} room={room} registry={registry} keeper={keeper} arrival={{ since }} />)}
      {active.length > ACTIVE_CAP && <button type="button" className="tv-fold act rm-more" aria-expanded={moreA} onClick={() => setMoreA(!moreA)}><ExpandsMark open={moreA} /><span>{moreA ? "Show fewer" : `+${active.length - ACTIVE_CAP} more active ${active.length - ACTIVE_CAP === 1 ? "quest" : "quests"}`}</span></button>}

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

export function RoomFold({ name, label, count, children }: { name: string; label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = usePanelState(`room.fold.${name}`, false);
  const id = useId();
  return <section data-board-fold={name} className="rm-room-fold">
    <h3><button type="button" className="tv-fold act" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><ExpandsMark open={open} />{label} <span className="tv-count">{count}</span></button></h3>
    <div id={id} hidden={!open}>{open && children}</div>
  </section>;
}

function FoldQuest({ keeper, quest, room, registry, api, finished = false, waiting = false }: { keeper: K; quest: BoardQuestSummary; room: Room; registry: Registry; api: ArchiveApi; finished?: boolean; waiting?: boolean }) {
  const navigate = useBbNavigate();
  const name = characterName(registry, keeper.member);
  return <div className="rm-fold-quest">
    <QuestRow quest={quest} room={room} registry={registry} keeper={keeper}
      onArchive={finished ? q => void api.archive([q]) : undefined} pending={api.pending} />
    <button type="button" className="act lnk-btn rm-fold-keeper" title={keeper.threadTitle ?? undefined} aria-label={`Open ${name}'s thread${keeper.threadTitle ? `: ${keeper.threadTitle}` : ""}`} onClick={() => navigate.toThread(keeper.member.threadId)}>
      <CrestOf member={keeper.member} registry={registry} size={16} />{name}<OpensMark />
    </button>
    {waiting && <p className="rm-pending-cellar m">Waiting for Tavern to confirm the stop. <button type="button" className="act lnk-btn" onClick={() => jumpTo("tv-away-notes")}>See stop status</button></p>}
  </div>;
}

export function Board({ room, registry, api, since }: { room: Room; registry: Registry; api: ArchiveApi; since?: number }) {
  const navigate = useBbNavigate();
  const { notices, idle } = sortKeepers(room, api);
  const [receipt, setReceipt] = useState<CellarStopReceipt | null>(null);
  const rows = room.keepers.flatMap(keeper => inRoom(keeper, api).map(quest => ({ keeper, quest })));
  const cellared = new Set(receipt?.entries.filter(entry => entry.state === "cellared").map(entry => entry.questId));
  const gone = rows.filter(({ keeper, quest }) => boardQuestState(keeper, quest) === "needs-keeper" && !cellared.has(quest.id));
  const returned = rows.filter(({ keeper, quest }) => boardQuestState(keeper, quest) === "finished")
    .sort((a, b) => (b.quest.endedAt ?? b.quest.updatedAt) - (a.quest.endedAt ?? a.quest.updatedAt));
  const stillStopping = new Set(receipt?.entries.filter(entry => entry.state === "stopping" && rows.some(({ quest }) => quest.id === entry.questId && !isFinished(quest.phase))).map(entry => entry.questId));
  const ready = gone.filter(({ quest }) => !quest.cellarOnStop && !stillStopping.has(quest.id));
  const lit = litKeeper(room, notices);
  const grid = useMasonry<HTMLDivElement>([room, api.hidden]);
  useEffect(() => rememberCount(SKEL.notices, notices.length), [notices.length]);
  return <section className="tv-sec rm-board-sec" aria-labelledby="rm-board-h">
    <header className="tv-colh rm-boardhead"><h2 id="rm-board-h"><Vocabulary word="questBoard" /></h2>
      <div className="rm-board-acts"><button type="button" className="btn ghost sm" onClick={() => navigate.toPluginPanel("tavern", { subPath: "map" })}><PageGlyph name="map" /><span>The map</span><OpensMark /></button></div>
    </header>
    {notices.length > 0 && <div className="tv-board rm-board lit" ref={grid} style={glowVars("board")}>
      {notices.map(keeper => <KeeperNotice key={keeper.member.threadId} keeper={keeper} room={room} registry={registry} api={api} lit={keeper.member.threadId === lit} since={since} />)}
    </div>}
    {receipt && <CellarStopReceiptView receipt={receipt} stillStopping={stillStopping} />}
    {gone.length > 0 && <RoomFold name="gone" label="Needs a Keeper" count={gone.length}>
      <p className="m small">These quests are off the active board because their Keeper’s thread is archived or deleted. Unarchive the Keeper’s thread to bring its quests back, or stop them here.</p>
      {gone.map(({ keeper, quest }) => <FoldQuest key={quest.id} {...{ keeper, quest, room, registry, api }} waiting={!!quest.cellarOnStop || stillStopping.has(quest.id)} />)}
      {ready.length > 0 && <StopKeeperGone ids={ready.map(({ quest }) => quest.id)} onReceipt={setReceipt} />}
    </RoomFold>}
    {returned.length > 0 && <RoomFold name="returned" label="Returned and stopped" count={returned.length}>
      {returned.map(({ keeper, quest }) => <FoldQuest key={quest.id} {...{ keeper, quest, room, registry, api }} finished />)}
      {returned.length > 1 && <button type="button" className="btn sm" onClick={() => void api.archive(returned.map(({ quest }) => quest))} disabled={api.pending}><PageGlyph name="archive" />Send all {returned.length} to the cellar</button>}
    </RoomFold>}
    {idle.length > 0 && <RoomFold name="idle" label="Keepers without a quest" count={idle.length}><div className="rm-idle">
      {idle.map(keeper => <div key={keeper.member.threadId}>
        <KeeperRow keeper={keeper} registry={registry} room={room} />
        {!keeper.archived && <RefreshKeeper threadId={keeper.member.threadId} view={keeper.succession} />}
      </div>)}
    </div></RoomFold>}
    {!room.keepers.length && <p className="tv-empty" data-empty>No Keeper yet. Start a quest from the header to hire one.</p>}
  </section>;
}
