import { hasEndedEngagement } from "../../shared/member-engagement";
import { UrlLink, experimental_usePluginId, experimental_useRpcQuery, useBbNavigate, useComposer, type ExperimentalPageTitle, type PluginAppBuilder, type PluginHomepageSectionProps, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Room } from "../../shared/contract";
import { Hearth, hearthWords, keeperStatus, onTheRoad, OpensMark, QuestRow, questNeedYouCount, rememberCount, useRegistry, vocab } from "../kit";
import { ClosingTimeSheet, ClosedDigest } from "./closing";
import { ClassEditTab } from "./class-editor";
import { CLASS_EDIT_TAB, CLOSING_TAB, CharacterVoiceTab, ClosingTimeTab, REPORTS_TAB, VOICE_TAB, useOpenPanelTab } from "./panels";
import { ReportsTab } from "./reports";
import { isPresentationProblem } from "./authorship";
import { Ago, CrestOf, Empty, PageButton, PhaseMark, ReadState, type Registry, plural } from "./common";
import { TheMap } from "./connections";
import { MobileQuestOptions, QuestNav, mobileQuestPaths } from "./nav";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { boardQuestState, decodePageRoute, isFinished, needYouCount, questsIn, restoreVerdict, roomAway, type PageRoute } from "./model";
import { QuestAwayNotes } from "./away";
import { MapSkeleton, PageLoad, QuestSkeleton, RoomSkeleton, RouteSkeleton, SKEL, SideNavSkeleton, StartCardsSkeleton, TaleSkeleton, FoldLoad, useRememberSideNav, useRememberShape } from "./skeletons";
import { PanelStateProvider, panelStorageKey, readPanel, rememberPath, useRestoreScroll } from "./panel-state";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { InsightsPage, settingsHref } from "./insights";
import { SETTINGS_SECTIONS, settingsSection } from "./settings";
import { QuestPage, ReturnedList } from "./quest";
import { TalePage } from "./tale";
import { CommonRoom } from "./room";
import { ClassStartCards, withClassPill } from "./start";
import { armClassSettings } from "../kit/remember";
import { CharacterSheetEditor, CharacterSheets, ClassDetail, ClassesList } from "./sheets";
import { StopAllControls } from "./stop-all";
import { StartQuest } from "./start-quest";
import { MachinesPage } from "./machines";
import { PLACEMENT_RPC_LIVE } from "./machines-contract";
import { narrowTitle, useFoldedHeader, useNarrowTitle, usePageColumn } from "./page-title";
import "./page.css";

const destinations: [string, string, PageGlyphName][] = [["room", vocab("commonRoom"), "home"], ["map", vocab("connections"), "map"], ["archive", vocab("cellar"), "archive"], ["characters", "Character sheets (records)", "shield"], ["classes", "Classes (types)", "file"], ["digest", "While closed (digest)", "moon"], ["closing", vocab("closing"), "lantern"]];
/** The machine placement page joins the sidebar and the phone page picker once its server reads are live. */
const pages = (): [string, string, PageGlyphName][] => PLACEMENT_RPC_LIVE ? [...destinations, ["machines", "Where work runs (machines)", "machine"]] : destinations;
const isCurrent = (path: string, route: PageRoute) => path === route.kind || (path === "characters" && route.kind === "character") || (path === "classes" && route.kind === "class");

function SideLink({ path, label, glyph, count, route, room }: { path: string; label: string; glyph: PageGlyphName; count?: React.ReactNode; route: PageRoute; room?: Room }) {
  const navigate = useBbNavigate();
  const [word, anchor] = label.split(" (");
  const words = room ? hearthWords(room.keepers.map(keeperStatus), { away: roomAway(room), onRoad: onTheRoad(room) }) : null;
  const lit = words?.state === "working";
  return <button type="button" className="tv-snav act" aria-label={lit && room ? `${label}, lit: ${words.detail.split(" · ").join(", ")}, ${needYouCount(room)} need you` : undefined} aria-current={isCurrent(path, route) ? "page" : undefined} onClick={() => navigate.toPluginPanel("tavern", { subPath: path })}>
    {lit && room ? <Hearth words={words} surface="page" size={14} iconOnly replay={room.hearthFlicker !== false} ambientMotion={room.ambientMotion} repeatSeconds={room.repeatSeconds} /> : <PageGlyph name={glyph} />}<span className="tv-snav-l" title={label}><span className="tv-snav-w">{word}</span>{anchor && <span className="anc">{anchor.replace(/\)$/, "")}</span>}</span>{count}
  </button>;
}

export function TavernSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const registry = useRegistry();
  const route = decodePageRoute(subPath);
  const data = room.data;
  const asks = data ? needYouCount(data) : 0;
  const navRef = useRef<HTMLElement>(null);
  useRememberSideNav(navRef, !!data);
  const errands = data ? data.keepers.flatMap((k) => k.errands).filter((m) => !hasEndedEngagement(m)) : [];
  return <PanelStateProvider value={panelStorageKey(pluginId)}><nav ref={navRef} className="tavern tv-page tv-sidebar" aria-label="Tavern navigation">
    <SideLink path="room" label="Common room (home)" glyph="home" route={route} room={data} count={data ? <span className={`tv-snav-c ${asks ? "y" : ""}`}>{asks > 0 && <PageGlyph name="you" size={10} />}<span>{asks} need you</span></span> : undefined} />
    {data ? <QuestNav room={data} registry={registry.data} route={route} /> : !room.error && <SideNavSkeleton />}
    {errands.length > 0 && <><div className="tv-shead">Side quests <span className="anc">errands</span><span className="tv-snav-c">{errands.length} out</span></div>
      {errands.map((m) => <button type="button" key={m.threadId} className="tv-squest act" onClick={() => navigate.toThread(m.threadId)} title={`Open the side quest thread: ${m.title ?? ""}`}>{registry.data ? <CrestOf member={m} registry={registry.data} size={18} /> : <span />}<span className="tv-squest-t">{m.title ?? m.doing ?? "Side quest"}</span><Ago at={m.lastActiveAt ?? m.createdAt} /></button>)}</>}
    <div className="tv-shead tv-shead-tavern">The tavern</div>
    {pages().slice(1).map(([path, label, glyph]) => <SideLink key={path} path={path} label={label} glyph={glyph} route={route} count={data && path === "archive" ? <span className="tv-snav-c">{data.archivedCount}</span> : registry.data && path === "characters" ? <span className="tv-snav-c">{registry.data.characters.length}</span> : registry.data && path === "classes" ? <span className="tv-snav-c">{registry.data.classes.length}</span> : undefined} />)}
    {!data && room.error && <ReadState error={room.error} retry={room.refetch} />}
    <div className="tv-sfoot" role="group" aria-label="Observability">
      <div className="tv-shead">Observability</div>
      <SideLink path="insights" label="Insights (all data)" glyph="report" route={route} />
      <UrlLink href={settingsHref(pluginId)} className="tv-snav act" title="Tavern's settings: opens its page in bb's Settings"><PageGlyph name="rule" /><span className="tv-snav-l"><span className="tv-snav-w">Settings</span><span className="anc">tuning</span></span><OpensMark /></UrlLink>
    </div>
  </nav></PanelStateProvider>;
}

/** A quest's name for a breadcrumb: its short name, else its title cut to a short name's 40 characters. */
export function questShortName(quest: { short?: string | null; title: string }) {
  const short = quest.short?.trim();
  if (short) return short;
  return quest.title.length > 40 ? `${quest.title.slice(0, 39).trimEnd()}…` : quest.title;
}

/** Breadcrumbs after bb's "Tavern": the page's place, and the quest's short name on quest pages and tales. */
export function useTavernPageTitle({ subPath }: PluginNavPanelProps) {
  const route = decodePageRoute(subPath);
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const registry = useRegistry();
  const root = "/plugins/tavern/tavern";
  const id = route.kind === "quest" || route.kind === "tale" ? route.id : null;
  const inRoom = id && room.data ? questsIn(room.data).find((q) => q.id === id) : undefined;
  // A quest the room no longer lists (sent to the cellar) still has a name: its own detail, which the page fetches anyway.
  const detail = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: id ?? "" }, enabled: !!id && !!room.data && !inRoom });
  const quest = inRoom ?? detail.data?.quest;
  const narrow = useFoldedHeader();
  const full = ((): ExperimentalPageTitle | null => { switch (route.kind) {
    case "room": return { title: "Common room" };
    case "map": return { title: "The map" };
    case "returned": return { title: "Returned" };
    case "archive": return { title: "Cellar" };
    case "characters": return { title: "Character sheets" };
    case "classes": return { title: "Classes" };
    case "closing": return { title: "Closing time" };
    case "digest": return { title: "While closed" };
    case "insights": return { title: "Insights" };
    case "machines": return { title: "Where work runs" };
    case "quest": return { breadcrumbs: [{ label: "Quests", to: root }, { label: quest ? questShortName(quest) : "Quest" }] };
    // The returned list holds stopped quests too; the first step says how this one ended.
    case "tale": return { breadcrumbs: [{ label: quest?.phase === "stopped" ? "Stopped" : "Returned", to: `${root}/returned` }, { label: quest ? questShortName(quest) : "Quest", to: `${root}/quest/${encodeURIComponent(route.id)}` }, { label: "The tale" }] };
    case "character": return { breadcrumbs: [{ label: "Character sheets", to: `${root}/characters` }, { label: registry.data?.characters.find((c) => c.id === route.id)?.name ?? route.id }] };
    case "class": return { breadcrumbs: [{ label: "Classes", to: `${root}/classes` }, { label: registry.data?.classes.find((c) => c.id === route.id)?.label ?? route.id }] };
    default: return null;
  } })();
  return narrow ? narrowTitle(full) : full;
}

/**
 * Start a Keeper thread in bb's own composer: open it first, so the click always lands somewhere, then put the Keeper pill in
 * the draft. Nothing is sent. The page never sets pickers (bb rejects setSelection from a surface outside any composer, and
 * that rejection used to swallow the navigation); it arms the class, and the composer's class banner applies its settings.
 */
export function useStartKeeper(registry: Registry | undefined) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  return () => {
    const cls = registry?.classes.find((c) => c.id === "keeper");
    const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId ?? undefined : undefined;
    if (cls) armClassSettings(cls.id);
    navigate.toCompose({ projectId, focusPrompt: true });
    if (cls && composer.scope.kind === "new-thread") composer.replace((draft) => withClassPill(draft, cls, pluginId));
  };
}


export function TavernHeader({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const openTab = useOpenPanelTab();
  const registry = useRegistry();
  const start = useStartKeeper(registry.data);
  // On a phone the title needs the room; Closing time stays in the page picker as "Closing time (away)".
  const narrow = useNarrowTitle(), folded = useFoldedHeader();
  return <div className={`tavern tv-page tv-head${folded ? " fold" : ""}`}>
    {!narrow && <button type="button" className="btn ghost" onClick={() => { if (!openTab(CLOSING_TAB)) navigate.toPluginPanel("tavern", { subPath: "closing" }); }} title="Closing time (away): opens the sheet in the side panel, beside the page" aria-label="Closing time"><PageGlyph name="lantern" /><span>Closing time</span></button>}
    {decodePageRoute(subPath).kind === "room" && <StopAllControls />}
    <StartQuest registry={registry.data} startKeeper={start} onRoom={decodePageRoute(subPath).kind === "room"} />
  </div>;
}

function QuestRoute({ id, summaryId, tale, registry, room }: { id: string; summaryId?: string; tale: boolean; registry: Registry; room: Room | undefined }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id, ...(tale ? {} : { refreshPullRequests: true }) } });
  const ended = query.data ? isFinished(query.data.quest.phase) : undefined;
  useEffect(() => { if (ended !== undefined) rememberCount(SKEL.finished(id), ended ? 1 : 0); }, [id, ended]);
  return query.data ? <>{query.error && <div className="tv-problem" role="alert" data-stuck>Refresh failed: {query.error.message}. Showing the last loaded quest.<button type="button" className="btn sm" onClick={() => void query.refetch()}>Retry</button></div>}{!tale && room && <QuestAwayNotes room={room} registry={registry} questId={id} />}{tale ? <Surface.TalePage detail={query.data} registry={registry} room={room} /> : <Surface.QuestPage detail={query.data} registry={registry} room={room} summaryId={summaryId} />}</> : <PageLoad error={query.error} retry={query.refetch} skeleton={questSkeleton(id, tale, room)} label={tale ? "the tale" : "the quest"} />;
}
/** A quest route's skeleton: the tale's, or the record's when the room already says the quest has ended, else the live page's. */
function questSkeleton(id: string, tale: boolean, room: Room | undefined) {
  if (tale) return <TaleSkeleton id={id} />;
  const phase = room ? questsIn(room).find((q) => q.id === id)?.phase : undefined;
  return <QuestSkeleton id={id} finished={phase === undefined ? undefined : isFinished(phase)} />;
}
const ROUTE_LABEL: Partial<Record<PageRoute["kind"], string>> = { characters: "the character sheets", classes: "the classes", class: "the class", character: "the character sheet", returned: "the returned quests", archive: "the cellar", closing: "Closing time", digest: "the digest" };
/** The surface a route's shape is remembered under, and its root, for its skeleton next time (see useRememberShape). */
function shapeOf(route: PageRoute): [string | null, string] {
  if (route.kind === "quest") return [`quest:${route.id}`, ".tv-quest"];
  if (route.kind === "tale") return [`tale:${route.id}`, ".tv-tale-page"];
  const roots: Partial<Record<PageRoute["kind"], string>> = { room: ".tv-room", map: ".tv-map", insights: ".tv-insights", characters: ".tv-sheets", classes: ".tv-classes", class: ".tv-classd", character: ".tv-sheet", returned: ".tv-returned", archive: ".tv-returned", closing: ".tv-closing", digest: ".tv-digest" };
  const root = roots[route.kind];
  return root ? ["id" in route ? `${route.kind}:${route.id}` : route.kind, root] : [null, ""];
}
/** The skeleton for a route still waiting on the registry or the room; null keeps the plain line for pages without one. */
function routeSkeleton(route: PageRoute, room: Room | undefined): { skeleton: ReactNode; label: string } | null {
  if (route.kind === "room") return { skeleton: <RoomSkeleton />, label: "the common room" };
  if (route.kind === "map") return { skeleton: <MapSkeleton />, label: "the map" };
  if (route.kind === "quest" || route.kind === "tale") return { skeleton: questSkeleton(route.id, route.kind === "tale", room), label: route.kind === "tale" ? "the tale" : "the quest" };
  const label = ROUTE_LABEL[route.kind];
  if (!label) return null;
  return { skeleton: <RouteSkeleton kind={route.kind as Parameters<typeof RouteSkeleton>[0]["kind"]} id={"id" in route ? route.id : undefined} />, label };
}
/** The route to reopen when the panel opens at its bare root (bb's rail always does), or null to show the common room. */
function useRestoreRoute(key: string, subPath: string, room: { data?: Room; error: unknown }, registry: { data?: Registry; error: unknown }) {
  const navigate = useBbNavigate();
  const remembered = () => { const path = readPanel(key).path; return subPath === "" && path && path !== "room" ? path : null; };
  const [target, setTarget] = useState<string | null>(remembered);
  useEffect(() => { setTarget(remembered()); }, [key, subPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const verdict = target ? restoreVerdict(target, room.data, registry.data) : null;
  const unknowable = verdict === "wait" && ((!!room.error && !room.data) || (!!registry.error && !registry.data));
  const give = verdict === "stale" || unknowable;
  useEffect(() => {
    if (!target) return;
    if (verdict === "ok") navigate.toPluginPanel("tavern", { subPath: target.split("/").map(decodeURIComponent).join("/"), replace: true });
    else if (give) { rememberPath(key, "room"); setTarget(null); }
  }, [target, verdict, give]); // eslint-disable-line react-hooks/exhaustive-deps
  return target && !give ? target : null;
}

/**
 * The page's surfaces, memoized. bb's room query re-renders the page shell when a fetch starts and on every tick, and an unchanged
 * refetch hands back the same room and registry objects (structural sharing), so the surfaces skip both. Their props are only those
 * objects, ids and strings, never a fresh object or callback. Texts in them that read the clock keep their own minute clock.
 */
const Surface = {
  CommonRoom: memo(CommonRoom), TheMap: memo(TheMap), ReturnedList: memo(ReturnedList), CharacterSheets: memo(CharacterSheets),
  CharacterSheetEditor: memo(CharacterSheetEditor), ClassesList: memo(ClassesList), ClassDetail: memo(ClassDetail),
  ClosingTimeSheet: memo(ClosingTimeSheet), ClosedDigest: memo(ClosedDigest), QuestRoute: memo(QuestRoute),
  InsightsPage: memo(InsightsPage), MachinesPage: memo(MachinesPage),
  // Inside QuestRoute, whose own quest query re-renders it the same way.
  QuestPage: memo(QuestPage), TalePage: memo(TalePage),
};

export function TavernPage({ subPath }: PluginNavPanelProps) {
  const route = decodePageRoute(subPath);
  const navigate = useBbNavigate();
  const registry = useRegistry();
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const key = panelStorageKey(experimental_usePluginId());
  const restoring = useRestoreRoute(key, subPath, room, registry);
  const here = subPath || "room";
  useEffect(() => { if (!restoring && route.kind !== "missing") rememberPath(key, here); }, [key, here, restoring, route.kind]);
  const scroller = useRef<HTMLElement>(null);
  usePageColumn(scroller);
  const [surface, root] = shapeOf(route);
  useRememberShape(scroller, surface, root);
  useRestoreScroll(key, scroller, here, !restoring && !!registry.data && (!!room.data || route.kind === "insights"));
  let body;
  if (route.kind === "missing") body = <><h1>Page not found</h1><PageButton path="room">Back to the common room</PageButton></>;
  else if (route.kind === "insights") body = <Surface.InsightsPage />;
  else if (route.kind === "machines") body = <Surface.MachinesPage rule={route.rule} hire={route.hire} />;
  else if (!registry.data) { const sk = routeSkeleton(route, room.data); body = sk ? <PageLoad error={registry.error} retry={registry.refetch} {...sk} /> : <ReadState error={registry.error} retry={registry.refetch} />; }
  else if (route.kind === "quest" || route.kind === "tale") body = <Surface.QuestRoute key={route.id} id={route.id} summaryId={route.summaryId} tale={route.kind === "tale"} registry={registry.data} room={room.data} />;
  else if (route.kind === "classes") body = <Surface.ClassesList registry={registry.data} />;
  else if (route.kind === "class") body = <Surface.ClassDetail id={route.id} registry={registry.data} />;
  else if (!room.data) { const sk = routeSkeleton(route, undefined); body = sk ? <PageLoad error={room.error} retry={room.refetch} {...sk} /> : <ReadState error={room.error} retry={room.refetch} />; }
  else if (route.kind === "map") body = <Surface.TheMap room={room.data} registry={registry.data} />;
  else if (route.kind === "returned" || route.kind === "archive") body = <Surface.ReturnedList key={route.kind} room={room.data} registry={registry.data} initialView={route.kind === "archive" ? "archive" : "board"} />;
  else if (route.kind === "characters") body = <Surface.CharacterSheets room={room.data} registry={registry.data} />;
  else if (route.kind === "character") { const character = registry.data.characters.find((c) => c.id === route.id); body = character ? <Surface.CharacterSheetEditor key={character.id} character={character} room={room.data} registry={registry.data} /> : <Empty>Character not found: {route.id}</Empty>; }
  else if (route.kind === "closing") body = <Surface.ClosingTimeSheet room={room.data} registry={registry.data} />;
  else if (route.kind === "digest") body = <Surface.ClosedDigest room={room.data} registry={registry.data} />;
  else body = <Surface.CommonRoom room={room.data} registry={registry.data} />;
  if (restoring) body = <p className="tv-empty" role="status">Opening where you left off…</p>;
  return <PanelStateProvider value={key}><main ref={scroller} className="tavern tv-page tv-page-root"><div className="tv-pagebody">
    <nav className="tv-mobile-nav" aria-label="Tavern pages"><label>Page<select aria-label="Tavern page" value={subPath || "room"} onChange={(event) => navigate.toPluginPanel("tavern", { subPath: event.target.value })}><optgroup label="Pages">{pages().map(([path, label]) => <option value={path} key={path}>{label}</option>)}</optgroup><optgroup label="Observability"><option value="insights">Insights (all data)</option></optgroup>{room.data && <MobileQuestOptions room={room.data} />}{subPath !== "" && !destinations.some(([path]) => path === subPath) && subPath !== "insights" && !(room.data && mobileQuestPaths(room.data).includes(subPath)) && <option value={subPath}>{route.kind === "quest" ? "Quest (goal)" : route.kind === "tale" ? "The tale (credits)" : currentPageName(route, registry.data) ?? "This page"}</option>}</select></label></nav>
    {registry.error && registry.data && <div className="tv-problem" role="alert" data-stuck>Registry refresh failed: {registry.error.message}. Showing the last loaded definitions.</div>}
    {room.error && room.data && <div className="tv-problem" role="alert" data-stuck>Room refresh failed: {room.error.message}. Showing the last loaded board.<button type="button" className="btn sm" onClick={() => void room.refetch()}>Retry</button></div>}
    {registry.data?.problems.filter((p) => !isPresentationProblem(p)).map((p, i) => <p className="tv-problem" role="alert" key={`${p.path}:${i}`}>{p.path}: {p.message}</p>)}
    {body}
  </div></main></PanelStateProvider>;
}
/** The phone picker's name for a page outside its list: the class or character it shows, as the page heading names it. */
function currentPageName(route: { kind: string; id?: string }, registry: { classes: { id: string; label: string; plain: string }[]; characters: { id: string; name: string }[] } | undefined) {
  if (route.kind === "class") { const c = registry?.classes.find((x) => x.id === route.id); return c ? `${c.label} (${c.plain})` : null; }
  if (route.kind === "character") return registry?.characters.find((x) => x.id === route.id)?.name ?? null;
  return null;
}
export function useTavernBadge() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const count = query.data ? needYouCount(query.data) : 0;
  const label = query.data ? `${count} need you` : "";
  return count > 0 ? { count, tone: "critical" as const, label } : null;
}
export function TavernHomepage(_props: PluginHomepageSectionProps) {
  const registry = useRegistry();
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const data = room.data;
  const quests = data ? data.keepers.flatMap(keeper => keeper.boardQuests.filter(quest => boardQuestState(keeper, quest) === "active").map(quest => ({ quest, keeper }))).sort((a, b) => Number(questNeedYouCount(b.quest, data.asks) > 0) - Number(questNeedYouCount(a.quest, data.asks) > 0) || b.quest.updatedAt - a.quest.updatedAt) : [];
  return <section className="tavern tv-page tv-homepage" aria-label="Tavern">
    <header className="tv-colh"><h2>Start with a class <span className="anc">thread type</span></h2><span className="tv-colh-aside">your draft stays here until you send</span><span className="tv-sp" /><PageButton path="room" className="ghost sm" glyph="home">{room.data ? `${needYouCount(room.data)} need you` : "The common room"}</PageButton></header>
    {registry.data ? <ClassStartCards registry={registry.data} /> : <FoldLoad error={registry.error} retry={registry.refetch} label="the classes"><StartCardsSkeleton /></FoldLoad>}
    {room.data ? quests.length > 0 && <><header className="tv-colh" style={{ marginTop: 12 }}><h3>Quests on the board <span className="anc">goals</span></h3><span className="tv-count">{plural(quests.length, "quest")}</span></header><div className="tv-card tv-homequests">{registry.data ? quests.map(({ quest, keeper }) => <QuestRow key={quest.id} quest={quest} room={room.data!} registry={registry.data!} keeper={keeper} showKeeper />) : <ReadState error={registry.error} retry={registry.refetch} />}</div></> : <ReadState error={room.error} retry={room.refetch} />}
  </section>;
}
export function registerPageSurfaces(app: PluginAppBuilder) {
  app.slots.navPanel({ id: "tavern", title: "Tavern", path: "tavern", icon: "tavern", component: TavernPage, experimental_sidebar: TavernSidebar, experimental_useBadge: useTavernBadge, experimental_usePageTitle: useTavernPageTitle, headerContent: TavernHeader });
  app.slots.experimental_tab({ ...CLOSING_TAB, title: "Closing time", icon: "Moon", layout: "flush", component: ClosingTimeTab });
  app.slots.experimental_tab({ ...VOICE_TAB, title: "Character voice", icon: "Feather", layout: "flush", component: CharacterVoiceTab });
  app.slots.experimental_tab({ ...CLASS_EDIT_TAB, title: "Edit class", icon: "FilePen", layout: "flush", component: ClassEditTab });
  app.slots.experimental_tab({ ...REPORTS_TAB, title: "Reports", icon: "FileText", layout: "flush", component: ReportsTab });
  app.slots.homepageSection({ id: "tavern", title: "Tavern", component: TavernHomepage });
  for (const section of SETTINGS_SECTIONS) app.slots.settingsSection(settingsSection(section));
}
