import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { readRemembered, writeRemembered } from "./remember";
import "./skeleton.css";

/** How long a load may take before its skeleton shows. A faster load shows nothing; the space is held from the first frame either way. */
export const SKELETON_DELAY_MS = 150;
const MAX_ROWS = 8;

/** True once `loading` has lasted `delay`; false again as soon as it ends. The only skeleton timer in Tavern. */
export function useSkeletonDelay(loading: boolean, delay = SKELETON_DELAY_MS) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!loading) { setLate(false); return; }
    const timer = setTimeout(() => setLate(true), delay);
    return () => clearTimeout(timer);
  }, [loading, delay]);
  return loading && late;
}

/**
 * How many rows a list's skeleton draws: the count this device last saw there (0 to 8), else `fallback`. Pass `current` once the
 * data has arrived and it is remembered for next time.
 */
export function useSkeletonCount(key: string, current?: number, fallback = 2) {
  const [seen] = useState(() => { const v = readRemembered<number>(key); return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(MAX_ROWS, Math.round(v))) : fallback; });
  useEffect(() => { if (current !== undefined) rememberCount(key, current); }, [key, current]);
  return seen;
}
export function rememberCount(key: string, n: number) { writeRemembered(key, Math.max(0, Math.min(MAX_ROWS, Math.round(n)))); }

/**
 * Loading and failure for one fetch. An error shows the problem with Retry. While loading, `skeleton` holds its space at once and
 * shows at `SKELETON_DELAY_MS`, inside a busy region that names what is coming; a surface without a skeleton still says
 * "Loading Tavern…". After the data arrives the surface draws itself in the same place, so nothing on screen moves.
 */
export function QueryState({ error, loading, retry, skeleton, label }: { error: unknown; loading?: boolean; retry?: () => void; skeleton?: ReactNode; label?: string }) {
  const late = useSkeletonDelay(!!loading && !error && skeleton != null);
  if (error) return <div className="problem" role="alert"><span>{error instanceof Error ? error.message : String(error)}</span>{retry && <button type="button" className="btn sm" onClick={retry}>Retry</button>}</div>;
  if (!loading) return null;
  if (skeleton == null) return <p className="loading m" role="status">Loading Tavern…</p>;
  return <Skeleton label={label} shown={late}>{skeleton}</Skeleton>;
}

/** A skeleton region: busy for assistive technology, with one status line; the shapes themselves are hidden from it and hold no text. */
export function Skeleton({ label = "Tavern", shown = true, children, className = "" }: { label?: string; shown?: boolean; children: ReactNode; className?: string }) {
  return <div className={`sk-region ${className}`} aria-busy="true" data-skeleton={shown ? "shown" : "held"}>
    <span className="sk-sr" role="status">{shown ? `Loading ${label}` : ""}</span>
    <div className="sk" aria-hidden="true">{children}</div>
  </div>;
}

type Len = number | string;
const len = (v: Len) => typeof v === "number" ? `${v}px` : v;
const WIDTHS = ["92%", "84%", "64%", "88%", "72%", "58%"];
/** Line widths for `n` lines of running text: varied but fixed, so nothing changes between renders. */
export const skWidths = (n: number) => Array.from({ length: n }, (_, i) => i === n - 1 && n > 1 ? "46%" : WIDTHS[i % WIDTHS.length]!);

/** One line of text: as tall as a line of the text it stands in for (it takes the font and line height of where it sits). */
export function SkLine({ w = "100%", className = "" }: { w?: Len; className?: string }) {
  return <span className={`sk-l ${className}`} style={{ "--sk-w": len(w) } as CSSProperties} />;
}
export function SkLines({ n, className = "" }: { n: number; className?: string }) {
  return <>{skWidths(n).map((w, i) => <SkLine key={i} w={w} className={className} />)}</>;
}
export function SkBlock({ w = "100%", h, className = "" }: { w?: Len; h: Len; className?: string }) {
  return <span className={`sk-b ${className}`} style={{ "--sk-w": len(w), "--sk-h": len(h) } as CSSProperties} />;
}
/** Crests and glyphs are SVGs, as the real ones are, so every rule that keys on an icon (optical centring, sizes) treats both alike. */
export function SkCrest({ size = 20 }: { size?: number }) {
  return <svg className="sk-crest" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 2h18v11.5L12 22 3 13.5Z" /></svg>;
}
export function SkGlyph({ size = 13 }: { size?: number }) {
  return <svg className="sk-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" /></svg>;
}
export function SkPill({ w = "7ch" }: { w?: Len }) { return <SkBlock w={w} h="1.5em" className="sk-pill" />; }
/** A state mark (`StateMark`): a 13 px glyph and its word, in the mark's own inline-flex box. */
export function SkMark({ w = "8ch" }: { w?: Len }) { return <span className="tv-st"><SkGlyph size={13} /><SkLine w={w} /></span>; }

/** `QuestRow`, live (two lines) or returned (one line), in the row's own classes so it has the row's height at every width. */
export function SkQuestRow({ live = true }: { live?: boolean }) {
  if (!live) return <div className="tavern qrow qrow-done sk-row"><SkCrest size={12} /><span className="qrow-name"><SkLine w="22ch" /></span><span className="qrow-f"><SkLine w="10ch" /></span><span className="qrow-x sk-btn" /></div>;
  return <div className="tavern qrow qrow-live sk-row">
    <span className="qrow-name"><SkLine w="20ch" /></span>
    <time className="ago"><SkLine w="6ch" /></time>
    <span className="act-i" />
    <div className="qrow-l2"><span className="qrow-p"><SkBlock w={50} h={6} /><SkLine w="9ch" /></span><span className="qrow-m"><SkMark w="12ch" /></span></div>
  </div>;
}

/** `KeeperRow`, in its own classes, so the narrow form is two lines exactly as the real row is. */
export function SkKeeperRow() {
  return <div className="tavern krow sk-row">
    <span className="krow-who"><SkCrest size={20} /><b><SkLine w="5ch" /></b><span className="krow-l2"><span className="krow-t"><SkLine w="26ch" /></span></span></span>
    <span className="krow-s"><SkMark w="9ch" /></span>
    <span className="krow-go" />
  </div>;
}

/** A `.tcard` card: an optional header line, then `lines` of body text. `nested` draws it on the card-on-a-card level. */
export function SkCard({ lines = 3, head = true, nested = false, children }: { lines?: number; head?: boolean; nested?: boolean; children?: ReactNode }) {
  return <div className={`tavern tcard sk-card ${nested ? "sk-nested" : ""}`}>
    {head && <div className="tc-h"><SkCrest size={16} /><SkLine w="18ch" /><span className="sk-sp" /><SkLine w="6ch" /></div>}
    {lines > 0 && <div className="sk-body"><SkLines n={lines} /></div>}
    {children}
  </div>;
}

/** `FigureRow`: `count` figures, label above value, in the row's own classes. */
export function SkFigureRow({ count = 4, compact = false }: { count?: number; compact?: boolean }) {
  return <dl className={`tfig ${compact ? "compact" : ""}`}>{Array.from({ length: count }, (_, i) => <div key={i}><dt><SkLine w="8ch" /></dt><dd><SkLine w="4ch" /></dd></div>)}</dl>;
}

/** `ReportView`: headline, three lines of outcome and an evidence block. `section` adds `MemberReports`' status line above it. */
/** `confidence` draws ReportView's confidence line; pass whether the report last seen here had one. */
export function SkReport({ section = false, confidence = false }: { section?: boolean; confidence?: boolean }) {
  const body = <div className="rv">
    <p className="rv-lead"><SkLine w="72%" /></p>
    <p className="rv-p"><SkLines n={3} /></p>
    <div className="rv-sec"><span className="rv-h"><SkLine w="8ch" /></span><SkLine w="80%" /><SkLine w="66%" /></div>
    {confidence && <div className="conf"><span className="conf-l"><SkLine w="10ch" /></span><span className="conf-t"><SkLine w="34ch" /></span></div>}
  </div>;
  return section ? <section className="rv-rep"><header className="rv-rep-h"><SkPill w="6ch" /><SkLine w="14ch" /><SkLine w="5ch" className="sk-end" /></header>{body}</section> : body;
}

/** `PhaseMark`'s five segments, empty. Pass the page's class for its large strip. */
export function SkPhaseStrip({ className = "" }: { className?: string }) {
  return <span className={`tv-ph sk-ph ${className}`}>{[0, 1, 2, 3, 4].map(i => <i key={i} />)}</span>;
}

/** The segmented filter (`.segc`), `count` segments. */
export function SkSegmented({ count = 3 }: { count?: number }) {
  return <div className="segc sk-segc">{Array.from({ length: count }, (_, i) => <span key={i} className="seg"><SkLine w={i === 0 ? "5ch" : "7ch"} /></span>)}</div>;
}

/** `DecidedForYou`: its heading and `rows` decisions, each with Undo (and OK when `seenable`) at their real widths. */
export function SkDecided({ rows = 2, seenable = false }: { rows?: number; seenable?: boolean }) {
  return <section className={`decided sk-decided ${seenable ? "seenable" : ""}`}>
    <div className="dh"><h3 className="dh-t"><SkGlyph size={14} /><b><SkLine w="16ch" /></b></h3></div>
    <ul>{Array.from({ length: rows }, (_, i) => <li key={i} className="di"><span className="dt"><b><SkLine w={skWidths(rows)[i]} /></b></span><span className="di-acts"><span className="btn sm sk-btn" />{seenable && <span className="btn sm sk-btn" />}</span><span className="di-meta m"><SkLine w="6ch" /></span></li>)}</ul>
  </section>;
}

/** `Chart`'s bar form: a caption and `bars` labelled tracks. */
export function SkChart({ bars = 4 }: { bars?: number }) {
  return <figure className="tchart sk-chart"><figcaption><SkLine w="14ch" /></figcaption>
    <ul className="tchart-bars">{Array.from({ length: bars }, (_, i) => <li key={i}><span className="l"><SkLine w={`${10 - (i % 3) * 2}ch`} /></span><span className="t"><span className="b" style={{ width: ["78%", "54%", "36%", "62%"][i % 4] }} /></span><span><SkLine w="3ch" /></span></li>)}</ul>
  </figure>;
}

/** A form field: its label and a control at the real input height (44 px on touch). */
export function SkField() { return <div className="sk-field"><SkLine w="16ch" /><span className="sk-ctl" /></div>; }

/**
 * Shapes for page components, which the kit does not style. Each draws a sensible inner layout; pass the page's own container class
 * in `className` so it takes that container's size.
 */
export function SkNotice({ rows = 1, done = 0, className = "" }: { rows?: number; done?: number; className?: string }) {
  return <div className={`sk-notice ${className}`}>
    <div className="sk-nh"><SkCrest size={28} /><span className="sk-col"><SkLine w="10ch" /><SkLine w="24ch" /></span><SkPill w="8ch" /></div>
    <div className="sk-party">{[0, 1, 2].map(i => <span key={i} className="sk-zone"><SkLine w="6ch" /><SkCrest size={18} /></span>)}</div>
    <div className="sk-qrows">{Array.from({ length: rows }, (_, i) => <SkQuestRow key={`l${i}`} />)}{Array.from({ length: done }, (_, i) => <SkQuestRow key={`d${i}`} live={false} />)}</div>
  </div>;
}
export function SkAskRow({ className = "" }: { className?: string }) {
  return <div className={`sk-askrow ${className}`}><SkCrest size={16} /><span className="sk-col"><SkLine w="70%" /><SkLine w="44%" /></span><SkLine w="5ch" /></div>;
}
export function SkEventRow({ className = "" }: { className?: string }) {
  return <div className={`sk-event ${className}`}><SkCrest size={14} /><span className="sk-col"><SkLine w="12ch" /><SkLine w="80%" /></span><SkLine w="5ch" /></div>;
}
export function SkMapNode({ w, className = "" }: { w: Len; className?: string }) {
  return <div className={`sk-node ${className}`} style={{ "--sk-w": len(w) } as CSSProperties}><SkCrest size={18} /><span className="sk-col"><SkLine w="80%" /><SkLine w="50%" /></span></div>;
}
/** `lines`: the card's body lines below the header, so a surface whose cards carry more (the record's credits) can match its real height. */
export function SkCreditCard({ className = "", lines = 2 }: { className?: string; lines?: number }) {
  return <div className={`sk-credit ${className}`}>
    <div className="sk-nh"><SkCrest size={28} /><span className="sk-col"><SkLine w="8ch" /><SkLine w="16ch" /></span></div>
    <SkLines n={lines} />
    <SkLine w="12ch" />
  </div>;
}
