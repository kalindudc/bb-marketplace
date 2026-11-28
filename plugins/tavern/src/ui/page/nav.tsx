import { UrlLink, experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { fromStoppedKeeper } from "../../shared/attention";
import type { Room } from "../../shared/contract";
import { hasEndedEngagement } from "../../shared/member-engagement";
import { Hearth, OpensMark, TimeAgo, hearthWords, keeperStatus, onTheRoad, plural, questNeedYouCount } from "../kit";
import { finishedQuests } from "./archive";
import { CrestOf, PhaseMark, characterName, type Registry } from "./common";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { settingsHref } from "./insights";
import { PLACEMENT_RPC_LIVE } from "./machines-contract";
import { activeQuests, decodePageRoute, endedCounts, needYouCount, phaseWord, questsIn, roomAway, type PageRoute } from "./model";
import { usePanelState } from "./panel-state";

const RETURNED_CAP = 5;
const places = [["closing", "Closing time", "lantern"], ["map", "The map", "map"], ["memory", "Memory", "ledger"], ["answers", "Search answers", "question"], ["archive", "Cellar", "archive"], ["characters", "Character sheets", "shield"]] as const;
const MORE_PLACES = [["classes", "Classes", "file"], ["digest", "While closed", "moon"], ["machines", "Where work runs", "machine"]] as const;
const morePlaces = () => PLACEMENT_RPC_LIVE ? MORE_PLACES : MORE_PLACES.slice(0, -1);
const isCurrent = (path: string, route: PageRoute) => path === route.kind || (path === "characters" && route.kind === "character") || (path === "classes" && (route.kind === "class" || route.kind === "overrides"));
const needWords = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;
const needKinds = ["plan", "review", "ask", "hold", "hand-back", "rule", "from stopped Keepers"] as const;

function attentionKinds(room: Room) {
  const attention = room.attention;
  if (!attention?.needYou) return null;
  const asks = new Map(room.asks.filter(ask => ask.state === "open").map(ask => [ask.id, ask]));
  const counts = new Map<typeof needKinds[number], number>();
  let known = 0;
  for (const item of attention.items) {
    if (item.kind !== "ask" && item.kind !== "hold" && item.kind !== "hand-back" && item.kind !== "rule") continue;
    const ask = item.kind === "ask" ? asks.get(item.id) : undefined;
    const stopped = fromStoppedKeeper(item);
    if (!stopped && item.kind === "ask" && !ask) return null;
    const kind = stopped ? "from stopped Keepers" : ask?.kind === "greenlight" ? "plan" : item.kind === "hold" && item.action === "Review" ? "review" : item.kind;
    known++;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // The room can carry fewer item details than its aggregate count.
  if (known !== attention.needYou) return null;
  return needKinds.flatMap(kind => {
    const count = counts.get(kind);
    return count ? [kind === "from stopped Keepers" ? `${count} ${kind}` : plural(count, kind)] : [];
  }).join(" · ");
}

function CommonRoomLink({ room, current, go }: { room?: Room; current: boolean; go(): void }) {
  const words = room ? hearthWords(room.keepers.map(keeperStatus), { away: roomAway(room), onRoad: onTheRoad(room) }) : null;
  const lit = words?.state === "working";
  const count = room ? needYouCount(room) : null;
  const kinds = room && attentionKinds(room);
  const label = ["Common room", lit && `lit: ${words.detail}`, count !== null && needWords(count), kinds].filter(Boolean).join(", ").replaceAll(" · ", ", ");
  return <div className="tv-shome">
    <button type="button" className="tv-home-link" aria-current={current ? "page" : undefined} aria-label={label} onClick={go}>
      <span className="tv-home-icon">{lit && room ? <Hearth words={words} surface="page" size={22} iconOnly replay={room.hearthFlicker !== false} ambientMotion={room.ambientMotion} repeatSeconds={room.repeatSeconds} /> : <PageGlyph name="road-hearth" size={22} />}</span>
      <strong>Common room</strong>{!current && <PageGlyph name="right" className="tv-home-next" />}
      {count !== null && <span className="tv-home-facts">
        <span className="tv-home-count" data-attention={count > 0 || undefined}>{count > 0 && <PageGlyph name="you" size={13} />}<b>{count}</b> <span>{count === 1 ? "needs you" : "need you"}</span></span>
        {kinds && <span className="tv-snav-c">{kinds}</span>}
      </span>}
    </button>
  </div>;
}

function QuestNav({ room, registry, route, go, openThread }: { room: Room; registry?: Registry; route: PageRoute; go(path: string): void; openThread(id: string): void }) {
  const active = activeQuests(room);
  const done = finishedQuests(room);
  const agePrefix = useId();
  const currentId = route.kind === "quest" || route.kind === "tale" ? route.id : null;
  const [kept, setOpen] = usePanelState<boolean | null>("nav.returned", null, (v) => typeof v === "boolean");
  const open = kept ?? (route.kind === "returned" || done.some(q => q.id === currentId));
  const ended = endedCounts(done);
  const keepers = new Map(room.keepers.map(k => [k.member.threadId, k.member]));
  return <>
    <h2 className="tv-shead tv-shead-q"><span>Quests on the board</span><span className="tv-snav-c">{active.length} active</span></h2>
    {active.map(q => {
      const conversationId = q.leadChain?.seat?.parentKeeperThreadId ?? q.keeperThreadId;
      const keeper = keepers.get(conversationId);
      const name = keeper && registry ? characterName(registry, keeper) : keeper?.displayName ?? "Keeper";
      const n = questNeedYouCount(q);
      return <div key={q.id} className="tv-sentry" data-attention={n > 0 || undefined}>
        <button type="button" className="tv-squest tv-sactive act" aria-current={currentId === q.id ? "page" : undefined} onClick={() => go(`quest/${q.id}`)}
          aria-label={`${q.title} · ${phaseWord(q.phase)}${n ? ` · ${needWords(n)}` : ""}`} aria-describedby={`${agePrefix}-${q.id}`}>
          <span className="tv-squest-t">{q.short || q.title}</span><PhaseMark phase={q.phase} />
          {n > 0 && <span className="tv-squest-n"><PageGlyph name="you" size={12} />{n}</span>}
          <span className="tv-sage" id={`${agePrefix}-${q.id}`}><TimeAgo at={q.updatedAt} showTitle={false} /></span>
        </button>
        <button type="button" className="tv-skeeper act" onClick={() => openThread(conversationId)} aria-label={`${name}, ${q.leadChain?.seat ? "lead Keeper" : "Keeper"}: open thread`}>
          <span aria-hidden="true">{keeper && registry ? <CrestOf member={keeper} registry={registry} size={16} /> : <PageGlyph name="shield" size={16} />}<OpensMark /></span><span className="tv-skeeper-name" title={name}>{name}</span>
        </button>
      </div>;
    })}
    {!active.length && <p className="tv-empty tv-snone" data-empty>{room.keepers.some(k => k.boardQuests.length > 0) ? "No active quests right now" : "No quests yet"}</p>}
    {done.length > 0 && <div className="tv-shistory">
      <FoldButton open={open} toggle={() => setOpen(!open)} count={done.length} label={`${ended.heading}: ${ended.words}`}>{ended.heading}</FoldButton>
      {open && <div className="tv-sbranch">
        <p className="tv-split tv-snav-c">{ended.words}</p>
        {done.slice(0, RETURNED_CAP).map(q => {
          const keeper = keepers.get(q.keeperThreadId);
          const returned = q.phase === "done";
          return <button type="button" key={q.id} className="tv-squest act tv-sdone" aria-current={currentId === q.id ? "page" : undefined} onClick={() => go(returned ? `tale/${q.id}` : `quest/${q.id}`)}
            aria-label={`${q.title} · ${returned ? "returned" : "stopped"} · open ${returned ? "the tale" : "the quest page"}`} aria-describedby={`${agePrefix}-${q.id}`}>
            <span aria-hidden="true">{keeper && registry && <CrestOf member={keeper} registry={registry} size={18} />}</span>
            <span className="tv-squest-t">{q.short || q.title}</span>
            <span className="tv-sdone-s"><PageGlyph name={returned ? "done" : "rejected"} size={11} />{returned ? "Returned" : "Stopped"}</span>
            <span className="tv-sage" id={`${agePrefix}-${q.id}`}><TimeAgo at={q.endedAt ?? q.updatedAt} showTitle={false} /></span>
          </button>;
        })}
        {done.length > RETURNED_CAP && <button type="button" className="tv-slink act" aria-current={route.kind === "returned" ? "page" : undefined} onClick={() => go("returned")}><span>Show all {done.length}</span><OpensMark /></button>}
      </div>}
    </div>}
  </>;
}

function FoldButton({ open, toggle, count, label, children }: { open: boolean; toggle(): void; count: number; label?: string; children: ReactNode }) {
  return <button type="button" className="tv-sfold act" aria-expanded={open} aria-label={label} onClick={toggle}>
    <PageGlyph name={open ? "down" : "right"} /><span>{children}</span><span className="tv-snav-c">{count}</span>
  </button>;
}

function SideLink({ path, label, glyph, count, away, route, go }: { path: string; label: string; glyph: PageGlyphName; count?: number; away?: boolean; route: PageRoute; go(path: string): void }) {
  return <button type="button" className="tv-snav act" aria-current={isCurrent(path, route) ? "page" : undefined} aria-label={away ? `${label}, Away` : count !== undefined ? `${label}, ${count}` : undefined} data-away={away || undefined} onClick={() => go(path)}>
    <PageGlyph name={glyph} size={16} /><span className="tv-snav-l">{label}</span>
    {away && <AwayMark />}{count !== undefined && <span className="tv-snav-c">{count}</span>}
  </button>;
}

function AwayMark() { return <span className="tv-saway">Away</span>; }

function MorePlaces({ subPath, route, registry, go }: { subPath: string; route: PageRoute; registry?: Registry; go(path: string): void }) {
  const items = morePlaces();
  const containsCurrent = items.some(([path]) => isCurrent(path, route));
  const [open, setOpen] = useState(containsCurrent);
  useEffect(() => { if (containsCurrent) setOpen(true); }, [containsCurrent, subPath]);
  return <div className="tv-smore">
    <FoldButton open={open} toggle={() => setOpen(!open)} count={items.length}>More places</FoldButton>
    {open && <div className="tv-sbranch">{items.map(([path, label, glyph]) => <SideLink key={path} path={path} label={label} glyph={glyph} route={route} go={go} count={path === "classes" ? registry?.classes.length : undefined} />)}</div>}
  </div>;
}

type NavProps = { subPath: string; room?: Room; registry?: Registry };

export function TavernNavItems({ subPath, room, registry, loading, error, onPage, onLeave }: NavProps & { loading?: ReactNode; error?: ReactNode; onPage?(): void; onLeave?(): void }) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const route = decodePageRoute(subPath);
  const away = room && roomAway(room)?.closed;
  const go = (path: string) => { onPage?.(); navigate.toPluginPanel("tavern", { subPath: path }); };
  const openThread = (id: string) => { onLeave?.(); navigate.toThread(id); };
  const errands = room ? room.keepers.flatMap(k => k.errands).filter(m => !hasEndedEngagement(m)) : [];
  return <>
    <CommonRoomLink room={room} current={route.kind === "room"} go={() => go("room")} />
    <div className="tv-sbody">
      <div className="tv-sboard">
        {room ? <QuestNav room={room} registry={registry} route={route} go={go} openThread={openThread} /> : loading}
        {errands.length > 0 && <div className="tv-serrands"><h2 className="tv-shead"><span>Errands</span><span className="tv-snav-c">{errands.length} out</span></h2>
          {errands.map(m => <button type="button" key={m.threadId} className="tv-squest tv-serrand act" onClick={() => openThread(m.threadId)}>
            <span aria-hidden="true">{registry && <CrestOf member={m} registry={registry} size={18} />}</span><span className="tv-squest-t">{m.title ?? m.doing ?? "Errand"}</span><TimeAgo at={m.lastActiveAt ?? m.createdAt} showTitle={false} />
          </button>)}
        </div>}
      </div>
      <div className="tv-splaces" role="group" aria-label="The tavern">
        <h2 className="tv-shead">The tavern</h2>
        {places.map(([path, label, glyph]) => <SideLink key={path} path={path} label={label} glyph={glyph} route={route} go={go} away={path === "closing" && away} count={path === "archive" ? room?.archivedCount : path === "characters" ? registry?.characters.length : undefined} />)}
        <MorePlaces subPath={subPath} route={route} registry={registry} go={go} />
      </div>
      {error}
      <div className="tv-sfoot" role="group" aria-label="Observability">
        <h2 className="tv-shead">Observability</h2>
        <SideLink path="insights" label="Insights" glyph="report" route={route} go={go} />
        <UrlLink href={settingsHref(pluginId)} className="tv-snav act" onClick={event => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onLeave?.();
        }}><PageGlyph name="rule" size={16} /><span className="tv-snav-l">Settings</span><OpensMark /></UrlLink>
      </div>
    </div>
  </>;
}

function currentPageName(route: PageRoute, room?: Room, registry?: Registry): string {
  if (route.kind === "quest" || route.kind === "tale") {
    const quest = room && questsIn(room).find(q => q.id === route.id);
    return quest?.title ?? (route.kind === "quest" ? "Quest" : "The tale");
  }
  if (route.kind === "class") return registry?.classes.find(c => c.id === route.id)?.label ?? "Classes";
  if (route.kind === "character") return registry?.characters.find(c => c.id === route.id)?.name ?? "Character sheets";
  return places.find(([path]) => path === route.kind)?.[1] ?? morePlaces().find(([path]) => path === route.kind)?.[1]
    ?? ({ room: "Common room", insights: "Insights", returned: "Returned and stopped", overrides: "Overrides" } as Record<string, string>)[route.kind] ?? "Tavern pages";
}

export function MobileNav({ subPath, room, registry, onPage }: NavProps & { onPage(): void }) {
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === subPath;
  const picker = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = open ? "Tavern pages" : currentPageName(decodePageRoute(subPath), room, registry);
  const count = room ? needYouCount(room) : null;
  const away = room && roomAway(room)?.closed;
  const label = open ? undefined : [`Tavern pages: ${current}`, count !== null && needWords(count), away && "Away"].filter(Boolean).join(", ");
  const close = () => { setOpenedAt(null); picker.current?.focus(); };
  return <nav className="tv-mobile-nav" aria-label="Tavern pages" onKeyDown={event => { if (open && event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <button type="button" ref={picker} className="tv-spicker act" aria-expanded={open} aria-controls={menuId} aria-label={label} onClick={() => setOpenedAt(open ? null : subPath)}>
      <PageGlyph name={open ? "down" : "right"} /><strong>{current}</strong>
      {!open && count !== null && <><span className="tv-snav-c" data-attention={count > 0 || undefined}>{needWords(count)}</span>{away && <AwayMark />}</>}
    </button>
    <div id={menuId} className="tv-smenu" hidden={!open}>
      {open && <TavernNavItems subPath={subPath} room={room} registry={registry} onPage={() => { setOpenedAt(null); onPage(); }} onLeave={close} />}
    </div>
  </nav>;
}
