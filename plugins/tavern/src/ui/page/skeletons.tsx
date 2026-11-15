import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { QueryState, SkAskRow, SkBlock, SkCard, SkChart, SkCreditCard, SkCrest, SkDecided, SkEventRow, SkField, SkFigureRow, SkLine, SkLines, SkMapNode, SkNotice, SkPhaseStrip, SkPill, SkQuestRow, SkReport, SkSegmented, readRemembered, useSkeletonCount, writeRemembered } from "../kit";
import { ReadState } from "./common";
import "./skeletons.css";

/*
 * The page's skeletons: each is drawn inside its surface's real containers and header classes, from the kit's parts, so the swap
 * to content moves nothing that was on screen. Lists draw the count this device last saw (keys under "skel:page:"), 2 when unknown.
 * Timing is the kit's alone: these only ever render inside QueryState's skeleton prop.
 */

export const SKEL = {
  asks: "skel:page:asks",
  decided: "skel:page:decided",
  notices: "skel:page:notices",
  events: "skel:page:events",
  reports: "skel:page:reports",
  mapRows: "skel:page:map",
  /** 1 when this device last saw the quest ended, so its record's shape draws before the room says so. */
  finished: (questId: string) => `skel:page:finished:${questId}`,
  /** How tall each top block of a surface stood, per width; see useRememberShape. */
  shape: (surface: string) => `skel:page:shape:${surface}`,
  /** The sidebar's space between its home link and "The tavern", in px: the quests and side quests. */
  sideNav: "skel:page:sidenav",
} as const;

/** The widths kept per surface, and how near a width must be to borrow its heights. */
const SHAPE_WIDTHS = 4, SHAPE_NEAR = 24;
type Shape = { w: number; h: Record<string, number> }[];
const GENERIC = new Set(["tv-card", "tavern", "lit", "act", "open", "narrow"]);
/** How deep the shape goes: the surface's blocks, their parts, and the parts' parts (a title, a phase strip, a figure row). */
const SHAPE_DEPTH = 3;
/**
 * The blocks of a surface, by path: each name is the element's classes without the generic ones, with #n for repeats, so the
 * skeleton's twin of a block, drawn in the same classes, finds its height.
 */
function blocks(root: Element, depth = SHAPE_DEPTH, path = ""): { el: HTMLElement; path: string; parent: string }[] {
  const seen = new Map<string, number>();
  return [...root.children].flatMap((child) => {
    const base = [...child.classList].filter((c) => !GENERIC.has(c) && !c.startsWith("sk")).join(".") || child.tagName.toLowerCase();
    const n = seen.get(base) ?? 0; seen.set(base, n + 1);
    const at = `${path}/${n ? `${base}#${n}` : base}`;
    const me = { el: child as HTMLElement, path: at, parent: path };
    return depth > 1 ? [me, ...blocks(child, depth - 1, at)] : [me];
  });
}

/**
 * While a surface is on screen, remembers how tall each of its top blocks stands at its width, so its skeleton next time holds
 * the same space and the swap moves nothing. The surface is the element matching `root` inside `body`, outside any skeleton.
 */
export function useRememberShape(body: RefObject<HTMLElement | null>, surface: string | null, root: string) {
  useEffect(() => {
    const box = body.current;
    if (!box || !surface || typeof ResizeObserver === "undefined") return;
    let el: Element | null = null, timer = 0;
    const save = () => {
      timer = 0;
      if (!el?.isConnected) return;
      const w = Math.round(el.getBoundingClientRect().width);
      if (!w) return;
      const h: Record<string, number> = {};
      for (const { el: block, path } of blocks(el)) h[path] = Math.round(block.getBoundingClientRect().height * 10) / 10;
      const kept = (readRemembered<Shape>(SKEL.shape(surface)) ?? []).filter((e) => Math.abs(e.w - w) > 2);
      writeRemembered(SKEL.shape(surface), [{ w, h }, ...kept].slice(0, SHAPE_WIDTHS));
    };
    const later = () => { if (!timer) timer = window.setTimeout(save, 400); };
    const sizes = new ResizeObserver(later);
    const find = () => {
      const found = [...box.querySelectorAll(root)].find((e) => !e.closest(".sk")) ?? null;
      if (found === el) return;
      if (el) sizes.unobserve(el);
      el = found;
      if (el) { sizes.observe(el); later(); }
    };
    const tree = new MutationObserver(find);
    tree.observe(box, { childList: true, subtree: true });
    find();
    return () => { tree.disconnect(); sizes.disconnect(); if (timer) { window.clearTimeout(timer); save(); } };
  }, [body, surface, root]);
}

/**
 * The skeleton's side: before it shows, gives each of its blocks the height its real twin last had at the nearest width. A block
 * marked data-sk-optional that the surface did not have then (a note for you, say) is left out.
 */
function useHeldShape(surface: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !surface) return;
    const w = el.getBoundingClientRect().width;
    const near = (readRemembered<Shape>(SKEL.shape(surface)) ?? []).filter((e) => Math.abs(e.w - w) <= SHAPE_NEAR).sort((a, b) => Math.abs(a.w - w) - Math.abs(b.w - w))[0];
    if (!near) return;
    for (const { el: block, path, parent } of blocks(el)) {
      const h = near.h[path];
      // align-content: start, so a held grid or wrapping row keeps its rows at their own height instead of stretching them.
      if (h !== undefined) Object.assign(block.style, { height: `${h}px`, boxSizing: "border-box", overflow: "hidden", alignContent: "start" });
      else if (block.dataset.skOptional !== undefined && (parent === "" || near.h[parent] !== undefined)) block.style.display = "none";
    }
  }, [surface]);
  return ref;
}

/** A surface still loading: today's error line with Retry if the read failed, else the kit's QueryState holding the skeleton. */
export function PageLoad({ error, retry, skeleton, label }: { error: { message: string } | null; retry(): unknown; skeleton: ReactNode; label: string }) {
  return error ? <ReadState error={error} retry={retry} /> : <QueryState error={null} loading skeleton={skeleton} label={label} />;
}

/** Body lines under a credit card's header, so a first visit's cards stand near the real ones at 1400 (records measured 204 and 240 px, the tale 204 px). */
const CREDIT_LINES = { record: 6, tale: 5 } as const;

const repeat = (n: number, draw: (i: number) => ReactNode) => Array.from({ length: n }, (_, i) => draw(i));

function SkStatusLine() {
  return <div className="tv-sline rm-sline sk-sline">
    <div className="rm-sl1"><div className="tv-hero"><b className="num"><SkLine w="1.4ch" /></b><span><SkLine w="7ch" /></span></div></div>
    <div className="tv-facts rm-sl2"><SkLine w="11ch" /><SkLine w="10ch" /><SkLine w="12ch" /></div>
  </div>;
}

/** The common room: the status line, the rail (asks, decided, What happened) and the board with its notices. */
export function RoomSkeleton() {
  const held = useHeldShape("room");
  const asks = useSkeletonCount(SKEL.asks, undefined, 0);
  const decided = useSkeletonCount(SKEL.decided);
  const notices = Math.max(1, useSkeletonCount(SKEL.notices));
  const events = useSkeletonCount(SKEL.events, undefined, 4);
  return <div ref={held} className="tv-room rm-a sk-room">
    <SkStatusLine />
    <div className="rm-a-grid">
      <aside className="rm-a-rail">
        <div className="rm-o1 rm-stackcol">
          {asks > 0 && <section className="tv-sec tv-queue"><header className="tv-colh"><h2><SkLine w="8ch" /></h2></header>{repeat(asks, (i) => <SkAskRow key={i} className="sk-askrow-page" />)}</section>}
          {decided > 0 && <SkDecided rows={decided} seenable />}
        </div>
        <div className="rm-o4"><section className="tv-sec"><header className="tv-colh"><h2><SkLine w="12ch" /></h2></header><SkSegmented count={4} />{repeat(events, (i) => <SkEventRow key={i} />)}</section></div>
      </aside>
      <div className="rm-a-main">
        <div className="rm-o2"><section className="tv-sec rm-board-sec">
          <header className="tv-colh rm-boardhead"><h2><SkLine w="17ch" /></h2><span className="rm-hearth-slot"><SkLine w="14ch" /></span></header>
          <div className="tv-board rm-board sk-board">{repeat(notices, (i) => <SkNotice key={i} rows={2} done={i === 0 ? 1 : 0} className="tv-notice rm-notice" />)}</div>
        </section></div>
      </div>
    </div>
  </div>;
}

/**
 * A quest's page before its detail arrives: the record's shape when the quest has ended, else the live page's. The room says which
 * once it has loaded; before that, what this device last saw of the quest.
 */
export function QuestSkeleton({ id, finished: known }: { id: string; finished?: boolean }) {
  const held = useHeldShape(`quest:${id}`);
  // With neither, the record: most quests opened from a link have ended.
  const remembered = useSkeletonCount(SKEL.finished(id), undefined, 1) > 0;
  const finished = known ?? remembered;
  if (finished) return <div ref={held} className="tv-quest tv-record sk-record">
    <header className="tv-card tv-rec-head"><div className="tv-gh-l"><h1 className="tv-qtitle"><SkLine w="70%" /><SkLine w="42%" /></h1><SkPhaseLabels /><div className="tv-facts"><SkLine w="14ch" /><SkLine w="9ch" /><SkLine w="10ch" /></div></div><div className="tv-gacts"><SkPill w="9ch" /></div></header>
    <section className="tv-card tv-rec-story"><header className="tv-colh"><h2><SkLine w="13ch" /></h2></header><div className="tv-rec-lines"><SkLines n={5} /></div><SkFigureRow count={3} /></section>
    <div className="tv-rec-two">{[0, 1].map((i) => <section key={i} className="tv-card tv-rec-sec"><header className="tv-colh"><h2><SkLine w="9ch" /></h2></header><SkLines n={3} /></section>)}</div>
    <section className="tv-card tv-rec-party"><header className="tv-colh"><h2><SkLine w="9ch" /></h2></header><div className="tv-credits-w"><ol className="tv-credits n-3">{[0, 1, 2].map((i) => <li key={i} className="sk-li"><SkCreditCard lines={CREDIT_LINES.record} /></li>)}</ol></div></section>
    <section className="tv-card tv-rec-fold tv-rec-map"><h2 className="tv-rec-fh"><span className="tv-rec-ft"><SkLine w="12ch" /></span></h2></section>
    <div className="tv-rec-folds">{repeat(7, (i) => <section key={i} className="tv-card tv-rec-fold"><h2 className="tv-rec-fh"><span className="tv-rec-ft"><SkLine w={i % 2 ? "14ch" : "10ch"} /></span></h2></section>)}</div>
  </div>;
  return <div ref={held} className="tv-quest sk-quest">
    <header className="tv-ghead"><div className="tv-gh-l"><h1 className="tv-qtitle"><SkLine w="70%" /><SkLine w="42%" /></h1><SkPhaseLabels /><div className="tv-facts"><SkLine w="16ch" /><SkLine w="10ch" /><SkLine w="9ch" /></div></div><div className="tv-gacts"><SkCrest size={28} /><SkPill w="12ch" /></div></header>
    <section className="tv-card tv-qmapcard"><header className="tv-colh"><h2><SkLine w="10ch" /></h2></header><div className="sk-mapcol">{repeat(3, (i) => <SkMapNode key={i} w={198} />)}</div></section>
    <div className="tv-ggrid">
      <div className="tv-col"><section className="tv-sec"><header className="tv-colh"><h2><SkLine w="12ch" /></h2></header>{repeat(3, (i) => <SkQuestRow key={i} />)}</section></div>
      <aside className="tv-col"><SkCard lines={3} /></aside>
    </div>
  </div>;
}

/** The phase strip with its five labels under it, as the page's PhaseStrip draws them. */
function SkPhaseLabels() {
  return <div className="tv-phase"><SkPhaseStrip className="lg" /><span className="tv-ph-labels">{repeat(5, (i) => <span key={i}><SkLine w="5ch" /></span>)}</span></div>;
}

/** The tale: its card with the title, the lead paragraph, the figures and the party's credit cards. */
export function TaleSkeleton({ id }: { id: string }) {
  return <div ref={useHeldShape(`tale:${id}`)} className="tv-tale-page sk-tale">
    <div className="tv-sline"><SkLine w="12ch" /></div>
    <section className="tv-tale tv-card">
      <header className="tv-tale-head"><div className="lbl"><SkLine w="16ch" /></div><h2 className="tv-tale-title"><SkLine w="60%" /></h2></header>
      <div className="tv-tale-lead"><SkLines n={3} /></div>
      <SkFigureRow count={3} />
      <div className="tv-tale-path"><SkBlock h={96} /></div>
      <div className="tv-leftfor nested" data-sk-optional><SkLines n={2} /></div>
      <div className="tv-credits-h"><h3><SkLine w="8ch" /></h3></div>
      <div className="tv-credits-w"><ol className="tv-credits n-3">{[0, 1, 2].map((i) => <li key={i} className="sk-li"><SkCreditCard lines={CREDIT_LINES.tale} /></li>)}</ol></div>
    </section>
  </div>;
}

/** The reports tab: who and which quest, then the reports this device last saw for a member. */
export function ReportsSkeleton() {
  const n = Math.max(1, useSkeletonCount(SKEL.reports, undefined, 1));
  return <div className="rv-reps">
    <header className="rv-reps-h"><SkCrest size={28} /><div className="rv-reps-who"><b><SkLine w="8ch" /></b><span className="m"><SkLine w="22ch" /></span></div></header>
    {repeat(n, (i) => <SkReport key={i} section />)}
  </div>;
}

/** A panel form (Closing time, a character's voice): its heading and fields. */
export function FormSkeleton({ fields = 3 }: { fields?: number }) {
  return <div className="tv-form sk-form">
    <header className="tv-form-h"><SkCrest size={18} /><h2><SkLine w="14ch" /></h2></header>
    <p className="m"><SkLine w="80%" /></p>
    <div className="sk-fields">{repeat(fields, (i) => <SkField key={i} />)}</div>
  </div>;
}

/** Insights below its heading: the headline tiles, the ideas, then a section with its chart. */
export function InsightsSkeleton() {
  return <div ref={useHeldShape("insights")} className="sk-insights">
    <div className="tkpis">{repeat(4, (i) => <div key={i} className="tkpi"><span className="tkpi-l"><SkLine w="10ch" /></span><b className="tkpi-v num"><SkLine w="5ch" /></b><span className="tkpi-s"><SkLine w="12ch" /></span></div>)}</div>
    <section className="tv-isec tv-ideas-sec"><header className="tv-isec-h"><h2><SkLine w="6ch" /></h2></header><div className="tv-ideas">{repeat(2, (i) => <SkCard key={i} lines={2} />)}</div></section>
    <section className="tv-card tv-isec"><header className="tv-isec-h"><h2><SkLine w="18ch" /></h2></header><p className="tv-isec-cap"><SkLine w="60%" /></p><SkChart bars={4} /></section>
  </div>;
}

/** The map: its status line, the picture's box at the map's floor height, and the list beside it with the rows last seen. */
export function MapSkeleton() {
  const rows = Math.max(2, useSkeletonCount(SKEL.mapRows, undefined, 4));
  return <div ref={useHeldShape("map")} className="tv-map sk-map">
    <div className="tv-sline"><div className="tv-hero"><b className="num"><SkLine w="1.4ch" /></b><span><SkLine w="22ch" /></span></div></div>
    <div className="tv-mapfilters" data-sk-optional><SkSegmented count={3} /></div>
    <div className="tv-mapgrid">
      <figure className="tv-card tv-mapcard sk-mapcard"><div className="sk-mapcols">{[0, 1, 2].map((c) => <div key={c} className="sk-mapcol">{repeat(c === 1 ? 3 : 2, (i) => <SkMapNode key={i} w={c === 1 ? 238 : 198} />)}</div>)}</div></figure>
      <section className="tv-card tv-maplist"><header className="tv-maplist-bar"><h2><SkLine w="16ch" /></h2></header><div className="sk-maprows">{repeat(rows, (i) => <div key={i} className="sk-maprow"><SkBlock w={13} h={13} /><SkCrest size={18} /><span className="sk-col"><SkLine w="70%" /><SkLine w="45%" /></span></div>)}</div></section>
    </div>
  </div>;
}

function SkPageLine({ facts = 3 }: { facts?: number }) {
  return <div className="tv-sline"><div className="tv-hero"><b className="num"><SkLine w="1.4ch" /></b><span><SkLine w="16ch" /></span></div><div className="tv-facts">{repeat(facts, (i) => <SkLine key={i} w={`${[11, 9, 14][i % 3]}ch`} />)}</div></div>;
}
function SkSheetHead({ crest }: { crest: number }) {
  return <header className="tv-sheet-head tv-card"><SkCrest size={crest} /><div className="tv-sh-t"><h1><SkLine w="12ch" /></h1><span className="tv-cc-r"><SkLine w="70%" /></span><div className="tv-facts"><SkLine w="10ch" /><SkLine w="12ch" /></div></div></header>;
}
const cards = (n: number, lines = 2) => repeat(n, (i) => <SkCard key={i} lines={lines} />);

/** The pages that wait on the registry or the room and have no skeleton of their own above: each in its page's own containers. */
export function RouteSkeleton({ kind, id }: { kind: "characters" | "classes" | "class" | "character" | "returned" | "archive" | "closing" | "digest"; id?: string }) {
  const surface = id ? `${kind}:${id}` : kind;
  const held = useHeldShape(surface);
  if (kind === "characters") return <div ref={held} className="tv-sheets"><SkPageLine /><SkSegmented count={4} /><div className="tv-chars">{cards(6)}</div></div>;
  if (kind === "classes") return <div ref={held} className="tv-classes"><SkPageLine /><div className="tv-card tv-ctable"><SkLines n={6} /></div></div>;
  if (kind === "class") return <div ref={held} className="tv-classd"><SkSheetHead crest={64} />{cards(2, 3)}</div>;
  if (kind === "character") return <div ref={held} className="tv-sheet"><SkSheetHead crest={80} />{cards(2, 3)}</div>;
  if (kind === "closing") return <div ref={held} className="tv-closing"><SkSheetHead crest={40} /><p className="tv-holdnote"><SkLine w="80%" /></p><div className="tv-tgrid">{repeat(3, (i) => <section key={i} className="tv-card tv-tsec"><header className="tv-colh"><h3><SkLine w="14ch" /></h3></header><SkLines n={3} /></section>)}</div></div>;
  if (kind === "digest") return <div ref={held} className="tv-digest"><SkPageLine facts={1} /><p className="tv-holdnote"><SkLine w="80%" /></p><div className="tv-digest-grid">{repeat(2, (i) => <section key={i} className="tv-card tv-tsec"><header className="tv-colh"><h3><SkLine w="14ch" /></h3></header>{repeat(3, (j) => <SkEventRow key={j} />)}</section>)}</div></div>;
  return <div ref={held} className="tv-returned"><SkPageLine facts={2} /><div className="tv-returned-bar"><SkSegmented count={2} /></div><div className="tv-card tv-rows tv-wrapped">{repeat(4, (i) => <SkQuestRow key={i} />)}</div></div>;
}

/** A read inside a fold or a row (the re-anchor text, older decisions): its lines, in the place the text will take. */
export function FoldLoad({ error, retry, label, lines = 3, children }: { error: { message: string } | null; retry(): unknown; label: string; lines?: number; children?: ReactNode }) {
  return error ? <ReadState error={error} retry={retry} /> : <QueryState error={null} loading skeleton={children ?? <SkLines n={lines} />} label={label} />;
}

/**
 * The sidebar's quests while the room loads, in the space they last took on this device, so "The tavern" and its links below stay
 * put. The sidebar measures that space itself (rememberSideNav).
 */
export function SideNavSkeleton() {
  const [gap] = useStateOnce(() => readRemembered<number>(SKEL.sideNav));
  const h = typeof gap === "number" && gap > 0 ? gap - 4 : 0;
  return <QueryState error={null} loading label="the quests" skeleton={<div className="sk-sidenav" style={h ? { height: h } : undefined}>
    <div className="tv-shead"><SkLine w="14ch" /></div>
    {repeat(h ? Math.max(1, Math.floor((h - 36) / 42)) : 3, (i) => <div key={i} className="tv-squest"><SkCrest size={18} /><span className="tv-squest-t"><SkLine w={`${[70, 55, 62][i % 3]}%`} /></span></div>)}
  </div>} />;
}
/**
 * Remembers the space between the sidebar's home link and "The tavern" when it can change, never on a plain re-render (a Keeper tick):
 * once when the data arrives, then when a block between them resizes (a quest arrives, the Returned fold opens, the width wraps a name)
 * or is added or removed. A resize is read in the observer's callback, after layout, so it forces no layout of its own.
 */
export function useRememberSideNav(nav: RefObject<HTMLElement | null>, ready: boolean) {
  useLayoutEffect(() => {
    const el = nav.current;
    if (!ready || !el) return;
    const last = { current: -1 };
    const measure = () => rememberSideNav(el, last);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(measure);
    const watch = () => { sizes.disconnect(); for (const child of el.children) { if (child.classList.contains("tv-shead-tavern")) break; sizes.observe(child); } };
    watch();
    // A removed block resizes nothing that is still watched, so a change in the blocks themselves is measured at the next frame.
    let frame = 0;
    const blocks = new MutationObserver(() => { watch(); if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); });
    blocks.observe(el, { childList: true });
    return () => { sizes.disconnect(); blocks.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [nav, ready]);
}
/** Remembers the space between the sidebar's home link and "The tavern", if it changed. */
export function rememberSideNav(nav: HTMLElement | null, last: { current: number }) {
  const first = nav?.querySelector(".tv-snav"), head = nav?.querySelector(".tv-shead-tavern");
  if (!first || !head) return;
  const gap = Math.round(head.getBoundingClientRect().top - first.getBoundingClientRect().bottom);
  if (gap !== last.current) { last.current = gap; writeRemembered(SKEL.sideNav, gap); }
}
function useStateOnce<T>(init: () => T) { const r = useRef<{ v: T } | null>(null); if (!r.current) r.current = { v: init() }; return [r.current.v] as const; }

/** The homepage's class cards, in their own grid. */
export function StartCardsSkeleton() {
  return <div className="tv-start-cards">{repeat(3, (i) => <SkCard key={i} lines={2} />)}</div>;
}
/** A settings section's rows (backups, where work runs) while its settings load. */
export function SettingsSkeleton({ rows = 2 }: { rows?: number }) {
  return <>{repeat(rows, (i) => <div key={i} className="tv-set-row"><div className="tv-set-l"><span className="tv-set-lbl"><SkLine w="8ch" /></span><p><SkLine w="60%" /></p></div><SkPill w="9ch" /></div>)}</>;
}
