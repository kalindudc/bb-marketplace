// The dependency maps: a phase's tickets laid out by dagre, or a ticket and its hops in fixed columns. Nodes are HTML
// buttons over one SVG of edges, both inside one camera transform, so a join can never drift from its port. One node
// per ticket, whatever kinds join it; each kind has its own port and stroke. The map is one tab stop: arrows move along
// the edges and columns, Enter or Space opens the ticket, and focus stays on the node chosen.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { BoardCard } from "../contract";
import { listText } from "./common";
import { edgesAmong, isOpen, type DepIndex, type Kind } from "./deps";
import { STATE_WORDS } from "./groups";
import { PAD, bundleEdges, bundleHeight, layoutBands, layoutColumns, layoutPhase, type MapBand, type MapEdgeIn, type MapLayout, type MapNodeIn, type NodeKind } from "./map-layout";
import { StateMark } from "./marks";
import { useCoarsePointer, useNarrowPage } from "./narrow";

const NODE_H = 28;
const SMALL_H = 24;
const KEY_CHAR = 7.3; // 12px monospace
const SMALL_CHAR = 6.7; // 11px monospace
const WORD_CHAR = 6.6; // 11px sans, a generous average
const ICON = 14;

/**
 * How much larger the map's text renders than the widths above assume: 1 as drawn by default, more with text enlarged
 * (200%) or spaced out (WCAG 1.4.12's letter and word spacing). Never under 1, so a default map keeps its size. `line`
 * is the height of a key's line, which sets how tall a node must be to hold it.
 */
export interface TextMetrics {
  key: number;
  smallKey: number;
  word: number;
  line: number;
  /** The state mark's width in px: it is sized in rem, so it grows with enlarged text while the padding does not. */
  icon?: number;
  smallIcon?: number;
}
export const UNSCALED: TextMetrics = { key: 1, smallKey: 1, word: 1, line: 0 };
const nodeHeight = (small: boolean, m: TextMetrics) => Math.max(small ? SMALL_H : NODE_H, Math.ceil(m.line + (small ? 10 : 14)));

/**
 * A node's width from its parts: padding, the mark, the key and, on a wide node, the state word. A node too narrow for
 * its state word drops the word rather than cut it; the word stays in its name and tip.
 */
export function nodeWidth(key: string, word: string | null, small = false, m: TextMetrics = UNSCALED): number {
  if (small) return Math.ceil(6 + Math.max(11, m.smallIcon ?? 0) + 4 + key.length * SMALL_CHAR * m.smallKey + 6);
  return Math.ceil(9 + Math.max(ICON, m.icon ?? 0) + 5 + key.length * KEY_CHAR * m.key + (word === null ? 0 : 6 + word.length * WORD_CHAR * m.word) + 9);
}

const RULER_KEY = "LANE-12345";
const RULER_WORD = "in progress";

/**
 * The map's text as the page renders it, from a hidden ruler in the nodes' own fonts, measured again whenever the ruler
 * changes size, so a map laid out at one text size is laid out again at another rather than spill its labels.
 */
function useTextMetrics(): { metrics: TextMetrics; ruler: ReactNode } {
  const ref = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState<TextMetrics>(UNSCALED);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const measure = () => {
      const [key, small, word, icon, smallIcon] = [...node.children].map((child) => child.getBoundingClientRect());
      const ratio = (width: number, chars: number, per: number) => Math.max(1, Math.ceil((width / (chars * per)) * 100) / 100);
      const next = { key: ratio(key!.width, RULER_KEY.length, KEY_CHAR), smallKey: ratio(small!.width, RULER_KEY.length, SMALL_CHAR), word: ratio(word!.width, RULER_WORD.length, WORD_CHAR), line: Math.ceil(key!.height), icon: Math.ceil(icon?.width ?? 0), smallIcon: Math.ceil(smallIcon?.width ?? 0) };
      setMetrics((before) => (before.key === next.key && before.smallKey === next.smallKey && before.word === next.word && before.line === next.line && before.icon === next.icon && before.smallIcon === next.smallIcon ? before : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  const ruler = (
    <span ref={ref} aria-hidden data-map-ruler className="pointer-events-none invisible absolute top-0 left-0 flex whitespace-nowrap">
      <span className="font-mono text-xs leading-none font-semibold">{RULER_KEY}</span>
      <span className="font-mono text-[11px] leading-none font-semibold">{RULER_KEY}</span>
      <span className="font-sans text-[11px] leading-none">{RULER_WORD}</span>
      <span className="inline-block size-3.5 shrink-0" />
      <span className="inline-block size-[11px] shrink-0" />
    </span>
  );
  return { metrics, ruler };
}

export interface MapNode extends MapNodeIn {
  label: string;
  card?: BoardCard;
  /** On a stub: what it stands for, in words. */
  note?: string;
}

const KIND_DASH: Record<Kind, string | undefined> = { work: undefined, merge: "6 3", live: "1.5 3" };

// Edge and bundle-bar strokes, as colours rather than opacity so each measures what it draws. On Loom's cards the base
// tone is 5.3:1 (gruve light) and 5.6:1 (gruvbox dark); the tone off the focused path is 3.6:1 and 4.2:1, so a dimmed
// second hop stays a readable relation (3:1 for graphics) while the lit path, in the primary colour and thicker, leads.
const EDGE = "text-[color-mix(in_oklab,var(--foreground)_72%,transparent)]";
const EDGE_DIM = "text-[color-mix(in_oklab,var(--foreground)_58%,transparent)]";
const BAR = "bg-[color-mix(in_oklab,var(--foreground)_72%,transparent)]";
const BAR_DIM = "bg-[color-mix(in_oklab,var(--foreground)_58%,transparent)]";

/** Each bundle in words: "each of CSV-9, CSV-10 and CSV-11 needs all of CSV-6, CSV-7 and CSV-8". */
export const bundleText = (bundle: { kind: Kind; sources: string[]; targets: string[] }, labelOf: (id: string) => string) => {
  const sources = listText(bundle.sources.map(labelOf));
  const needs = bundle.kind === "work" ? `needs all of ${sources}` : bundle.kind === "merge" ? `merges after all of ${sources}` : `needs all of ${sources} live`;
  return `each of ${listText(bundle.targets.map(labelOf))} ${needs}`;
};

/** The keys a focus lights: itself, what it waits on and what waits on it. */
export function litOf(index: DepIndex, focus: string | null): ReadonlySet<string> {
  if (focus === null) return new Set();
  return new Set([focus, ...index.prereqs(focus).map((prereq) => prereq.key), ...index.dependents(focus).map((dep) => dep.key)]);
}

/** A phase's picture: its tickets, one stub per earlier phase (or outside ticket) they need, and bundles. */
export function phasePicture(index: DepIndex, scope: readonly BoardCard[], phases: ReadonlyArray<{ ref: string; title: string }> | null, small = false, current: string | null = null, stubsFor: string | null = null, m: TextMetrics = UNSCALED): { nodes: MapNode[]; edges: MapEdgeIn[] } {
  const inScope = new Set(scope.map((card) => card.key));
  const height = nodeHeight(small, m);
  const nodes: MapNode[] = scope.map((card) => ({ id: card.key, kind: "ticket" as const, width: nodeWidth(card.key, null, small, m), height, label: card.key, card }));
  const stubs = new Map<string, MapNode>();
  const edges: MapEdgeIn[] = edgesAmong(index, inScope);
  const seen = new Set(edges.map((edge) => `${edge.from}>${edge.to}>${edge.kind}`));
  for (const card of scope)
    for (const prereq of index.prereqs(card.key)) {
      if (inScope.has(prereq.key) || (stubsFor !== null && card.key !== stubsFor)) continue;
      const outside = index.by.get(prereq.key)!;
      // An earlier phase is one stub; a ticket of this phase that the map leaves out is a stub of its own.
      const phase = outside.phase === null || outside.phase === current ? -1 : (phases?.findIndex((one) => one.ref === outside.phase) ?? -1);
      const id = phase >= 0 ? `phase:${outside.phase}` : `stub:${prereq.key}`;
      const label = phase >= 0 ? `Phase ${phase + 1}` : prereq.key;
      if (!stubs.has(id)) stubs.set(id, { id, kind: "stub", width: Math.ceil(12 + label.length * (small ? SMALL_CHAR * m.smallKey : KEY_CHAR * m.key) + 4), height, label, note: phase >= 0 ? phases![phase]!.title : STATE_WORDS[outside.state] });
      const edge = `${id}>${card.key}>${prereq.kind}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      edges.push({ from: id, to: card.key, kind: prereq.kind });
    }
  return { nodes: [...stubs.values(), ...nodes], edges };
}

/**
 * A ticket and its neighbours in columns: prerequisites left, dependents right, `hops` deep, at most `cap` per column
 * with the rest as one "more" node. Done prerequisites fold to one stub with their count; cancelled ones are named apart.
 */
export function hopPicture(index: DepIndex, focus: string, hops: 1 | 2, cap = 7, expanded: ReadonlySet<string> = new Set(), wide = true, m: TextMetrics = UNSCALED): { columns: MapNode[][]; edges: MapEdgeIn[] } {
  const height = nodeHeight(false, m);
  const node = (key: string): MapNode => {
    const card = index.by.get(key)!;
    const word = wide ? STATE_WORDS[card.state] : null;
    return { id: key, kind: "ticket", width: nodeWidth(key, word, false, m), height, label: key, card };
  };
  const placed = new Set([focus]);
  const columns: MapNode[][] = [[node(focus)]];
  const edges: MapEdgeIn[] = [];
  const side = (from: readonly string[], dir: -1 | 1, depth: number) => {
    const keys: Array<{ key: string; kind: Kind; via: string }> = [];
    for (const at of from) {
      const next = dir === -1 ? index.prereqs(at).map((prereq) => ({ key: prereq.key, kind: prereq.kind })) : index.dependents(at).map((dep) => ({ key: dep.key, kind: dep.kind }));
      for (const one of next) if (!placed.has(one.key) || keys.some((other) => other.key === one.key)) keys.push({ ...one, via: at });
    }
    const unique = [...new Set(keys.map((one) => one.key))].filter((key) => !placed.has(key));
    const done = dir === -1 ? unique.filter((key) => index.by.get(key)!.state === "done") : [];
    const rest = unique.filter((key) => !done.includes(key));
    const column: MapNode[] = [];
    const id = `${dir === -1 ? "pre" : "dep"}${depth}`;
    const open = expanded.has(id);
    const shown = open ? rest : rest.slice(0, cap);
    for (const key of shown) {
      placed.add(key);
      column.push(node(key));
    }
    // A folded node keeps the kinds of the edges it stands for, one edge per kind and neighbour.
    const join = (members: readonly string[], node: (key: string) => string) => {
      for (const one of keys) if (members.includes(one.key)) edges.push(dir === -1 ? { from: node(one.key), to: one.via, kind: one.kind } : { from: one.via, to: node(one.key), kind: one.kind });
    };
    join(shown, (key) => key);
    if (rest.length > shown.length) {
      const label = `and ${rest.length - shown.length} more`;
      // Sized from its label at the key's width per character: themes that set the sans font to a monospace one drew it wider than 92 px.
      const more = { id: `more:${id}`, kind: "more" as const, width: Math.max(92, Math.ceil(20 + label.length * KEY_CHAR * Math.max(m.key, m.word))), height, label };
      column.push(more);
      join(rest.slice(shown.length), () => more.id);
    }
    if (done.length > 0) {
      const label = `${done.length} done`;
      const stub = { id: `done:${id}`, kind: "stub" as const, width: Math.max(72, Math.ceil(20 + label.length * KEY_CHAR * m.key)), height, label, note: listText(done) };
      column.push(stub);
      join(done, () => stub.id);
    }
    // Order the column by where its neighbours sit, so edges into one column do not cross.
    const prior = dir === -1 ? columns[0]! : columns.at(-1)!;
    const rank = (one: MapNode) => {
      const at = edges.filter((edge) => (dir === -1 ? edge.from : edge.to) === one.id).map((edge) => prior.findIndex((other) => other.id === (dir === -1 ? edge.to : edge.from)));
      return at.length === 0 ? 99 : at.reduce((sum, n) => sum + n, 0) / at.length;
    };
    column.sort((a, b) => (a.kind === "ticket" ? 0 : 1) - (b.kind === "ticket" ? 0 : 1) || rank(a) - rank(b));
    return column;
  };
  let left = [focus];
  let right = [focus];
  for (let depth = 1; depth <= hops; depth++) {
    const pre = side(left, -1, depth);
    if (pre.length > 0) columns.unshift(pre);
    left = pre.filter((one) => one.kind === "ticket").map((one) => one.id);
    const dep = side(right, 1, depth);
    if (dep.length > 0) columns.push(dep);
    right = dep.filter((one) => one.kind === "ticket").map((one) => one.id);
  }
  // Two kinds between the same pair stay two edges on their own ports; the same kind twice is one.
  const unique = [...new Map(edges.map((edge) => [`${edge.from}>${edge.to}>${edge.kind}`, edge])).values()];
  return { columns, edges: unique };
}

const NODE = "absolute flex items-center gap-[5px] whitespace-nowrap rounded-[5px] border bg-[var(--loom-card)] px-[9px] text-left font-mono text-xs leading-none transition-[opacity,box-shadow] duration-150 ease-[var(--loom-ease)]";

/** The SVG and the nodes, at the camera's scale; the frame is sized to what it shows, so nothing is cut. */
/** A phase's band on the whole project's map: its column range, and its label in words. */
export interface BandView extends MapBand {
  number: number | null;
  title: string;
  counts: string;
  state: "active" | "done" | "planned";
}

/**
 * Everything a map draws, as its layout placed it: what the Map view's export turns into a picture. `closed` draws done
 * and cancelled tickets as finished and cut cloth, as Show done does.
 */
export interface MapPicture {
  layout: MapLayout;
  nodes: ReadonlyMap<string, MapNode>;
  bands: readonly BandView[];
  kinds: ReadonlySet<Kind>;
  closed: boolean;
  small: boolean;
  metrics: TextMetrics;
}

/** Where a map leaves the picture it drew, for its owner to export; null while it draws none. */
export type PictureRef = { current: MapPicture | null };

function usePicture(ref: PictureRef | undefined, picture: MapPicture | null) {
  useLayoutEffect(() => {
    if (ref === undefined) return;
    ref.current = picture;
    return () => {
      if (ref.current === picture) ref.current = null;
    };
  }, [ref, picture]);
}

function MapCanvas({ layout, nodes, index, focus, center = focus, lit, active, onActive, onPick, label, caption, maxScale = 1, onMore, small = false, still = false, metrics = UNSCALED, bands = [], finished = false }: { bands?: readonly BandView[]; finished?: boolean; metrics?: TextMetrics; layout: MapLayout; nodes: ReadonlyMap<string, MapNode>; index: DepIndex; focus: string | null; center?: string | null; lit: ReadonlySet<string>; active: string | null; onActive(key: string): void; onPick(key: string): void; label: string; caption: ReactNode; maxScale?: number; onMore?(id: string): void; small?: boolean; still?: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const width = useWidth(frame);
  // On a phone, a Loom page under 36rem or a touch screen, the map is a picture of plain marks: its nodes cannot be 44 px
  // targets, and the list, the exact list and a ticket's Waits on and Unblocks rows open the same tickets at full size.
  const narrow = useNarrowPage(frame);
  const coarse = useCoarsePointer();
  const picture = narrow || coarse;
  // The camera never shrinks the map: its smallest text is 11 px (keys on the small map, state words and stubs), and a
  // scaled one drew 8 px keys. A map wider than its frame is folded by its owner (the side map shows its focus and
  // neighbours), or scrolls sideways with its focus, or `center`, kept in view.
  const fit = width === null ? 1 : width / layout.width;
  const scale = Math.min(maxScale, Math.max(1, fit));
  const marksOnly = picture || still;
  const scrolls = width !== null && layout.width * scale > width + 0.5;
  useLayoutEffect(() => {
    const node = frame.current;
    const at = layout.nodes.find((one) => one.id === center);
    if (node === null || !scrolls || at === undefined) return;
    node.scrollLeft = Math.max(0, (at.x + at.width / 2) * scale - node.clientWidth / 2);
  }, [center, layout, scale, scrolls]);
  const tickets = layout.nodes.filter((node) => node.kind === "ticket");
  // The keyboard walks every control the map draws: its tickets and, where a column is capped, its "and N more".
  const stops = layout.nodes.filter((node) => node.kind === "ticket" || (node.kind === "more" && !marksOnly && onMore !== undefined));
  const tabKey = active !== null && stops.some((node) => node.id === active) ? active : (focus ?? tickets[0]?.id ?? null);
  // After "and N more" opens, focus goes to the first ticket it revealed, in the same column.
  const revealing = useRef<{ rank: number; before: ReadonlySet<string> } | null>(null);
  useLayoutEffect(() => {
    const pending = revealing.current;
    if (pending === null) return;
    revealing.current = null;
    const shown = tickets.filter((node) => node.rank === pending.rank && !pending.before.has(node.id)).sort((a, b) => a.y - b.y)[0];
    if (shown === undefined) return;
    onActive(shown.id);
    frame.current?.querySelector<HTMLElement>(`[data-map-stop="${shown.id}"]`)?.focus();
  }, [layout]);
  const expand = (placed: (typeof layout.nodes)[number]) => {
    revealing.current = { rank: placed.rank, before: new Set(tickets.map((node) => node.id)) };
    onMore?.(placed.id.slice(5));
  };
  const dim = focus !== null;
  const litEdge = (from: string, to: string) => focus !== null && (from === focus || to === focus || (from.startsWith("bundle:") && lit.has(to) && (to === focus || index.prereqs(to).some((prereq) => prereq.key === focus))) || (to.startsWith("bundle:") && from === focus));
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-map-stop]")?.dataset.mapStop;
    if (current === undefined) return;
    const at = layout.nodes.find((node) => node.id === current)!;
    const column = (rank: number) => stops.filter((node) => node.rank === rank).sort((a, b) => a.y - b.y);
    const through = (id: string, dir: "in" | "out"): string[] => {
      const ends = layout.edges.filter((edge) => (dir === "out" ? edge.from : edge.to) === id).map((edge) => (dir === "out" ? edge.to : edge.from));
      return ends.flatMap((end) => (end.startsWith("bundle:") ? through(end, dir) : [end]));
    };
    const nearest = (ids: string[]) => stops.filter((node) => ids.includes(node.id)).sort((a, b) => Math.abs(a.y - at.y) - Math.abs(b.y - at.y))[0]?.id;
    let next: string | undefined;
    if (event.key === "ArrowRight") next = nearest(through(current, "out")) ?? column(at.rank + 1)[0]?.id;
    else if (event.key === "ArrowLeft") next = nearest(through(current, "in")) ?? column(at.rank - 1)[0]?.id;
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const list = column(at.rank);
      next = list[list.findIndex((node) => node.id === current) + (event.key === "ArrowDown" ? 1 : -1)]?.id;
    } else if (event.key === "Home") next = [...stops].sort((a, b) => a.rank - b.rank || a.y - b.y)[0]?.id;
    else if (event.key === "End") next = [...stops].sort((a, b) => b.rank - a.rank || b.y - a.y)[0]?.id;
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (next === undefined) return;
    onActive(next);
    frame.current?.querySelector<HTMLElement>(`[data-map-stop="${next}"]`)?.focus();
  };
  return (
    <figure className="m-0 grid gap-1.5">
      <div ref={frame} role="group" aria-label={label} data-dep-map data-map-picture={picture ? "" : undefined} onKeyDown={move} className={`relative w-full ${scrolls ? "overflow-x-auto overflow-y-hidden" : "overflow-hidden"}`} style={{ height: Math.ceil(layout.height * scale) + (scrolls ? 12 : 0) }}>
        <div data-map-camera className="absolute left-0 top-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${scale.toFixed(4)})` }}>
          {/* A phase's band: the rail's card for it, its tickets' columns under its label, its edge woven as the rail's is. */}
          {bands.map((band) => (
            <div key={band.id} data-map-band={band.id} data-on={band.state === "active" ? "true" : undefined} className="loom-selvedge absolute top-0 overflow-hidden rounded-md border border-[var(--loom-line)] bg-[color-mix(in_oklab,var(--foreground)_3%,transparent)] pt-1.5 pr-2 pl-3" style={{ left: band.x, width: band.width, height: layout.height - PAD / 2 }}>
              <p className="m-0 flex min-w-0 items-baseline gap-1.5 text-xs leading-snug">
                {band.number !== null && <span className="loom-num shrink-0 font-extrabold">{band.number}</span>}
                <span className="min-w-0 truncate font-semibold" title={band.title}>
                  {band.title}
                </span>
              </p>
              <p className="loom-num m-0 truncate text-xs leading-snug text-[var(--loom-muted)]">{band.counts}</p>
            </div>
          ))}
          <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden className="absolute left-0 top-0 overflow-visible">
            {layout.edges.map((edge) => (
              <path key={edge.id} data-edge={edge.id} d={edge.d} fill="none" stroke="currentColor" strokeWidth={1.4} strokeDasharray={KIND_DASH[edge.kind]} strokeLinecap="butt" className={`transition-colors duration-150 ${dim && !litEdge(edge.from, edge.to) ? EDGE_DIM : EDGE}`} />
            ))}
            {/* The light runs over the base edge on the same path, so the join holds while it fades in or out. */}
            {layout.edges.map((edge) => (
              <path key={`lit-${edge.id}`} data-edge-lit={edge.id} d={edge.d} fill="none" stroke="var(--primary)" strokeWidth={2.2} strokeDasharray={KIND_DASH[edge.kind]} strokeLinecap="butt" className={`transition-opacity duration-150 ${litEdge(edge.from, edge.to) ? "opacity-100" : "opacity-0"}`} />
            ))}
          </svg>
          {layout.nodes.map((placed) => {
            const node = nodes.get(placed.id)!;
            const style = { left: placed.x, top: placed.y, width: placed.width, height: placed.height };
            const off = dim && !lit.has(placed.id) && !(placed.kind === "bundle" && layout.edges.some((edge) => (edge.from === placed.id || edge.to === placed.id) && litEdge(edge.from, edge.to)));
            if (placed.kind === "bundle") return <span key={placed.id} data-map-bundle={placed.id} aria-hidden className={`absolute rounded-[1px] transition-colors duration-150 ${off ? BAR_DIM : BAR}`} style={style} />;
            if (placed.kind === "stub")
              return (
                <span key={placed.id} data-map-stub={placed.id} title={node.note} className={`${NODE} ${small ? "px-1.5 text-[11px]" : ""} border-dashed text-[var(--loom-muted)] ${off ? "border-[var(--loom-line)]" : "border-[var(--loom-muted)]"}`} style={style}>
                  {node.label}
                </span>
              );
            if (placed.kind === "more" && marksOnly)
              return (
                <span key={placed.id} data-map-more={placed.id} className={`${NODE} border-dashed border-[var(--loom-muted)] font-sans text-[var(--loom-muted)]`} style={style}>
                  {node.label}
                </span>
              );
            if (placed.kind === "more")
              return (
                <button key={placed.id} type="button" data-map-more={placed.id} data-map-stop={placed.id} tabIndex={placed.id === tabKey ? 0 : -1} aria-label={node.label.replace(/^and (\d+) more$/, "Show $1 more tickets in this column")} onFocus={() => onActive(placed.id)} onClick={() => expand(placed)} className={`${NODE} cursor-pointer border-dashed border-[var(--loom-muted)] font-sans text-[var(--loom-muted)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`} style={style}>
                  {node.label}
                </button>
              );
            const card = node.card!;
            const word = STATE_WORDS[card.state];
            const isFocus = placed.id === focus;
            // With done shown, a done ticket is finished cloth (a woven edge in the done ink) and a cancelled one is cut
            // (hatched, its key faded), as the rail and the ticket bar draw them.
            const closed = finished && (card.state === "done" || card.state === "cancelled") ? card.state : null;
            const look = `${NODE} ${small ? "gap-1 px-1.5" : ""} ${closed === null ? "" : closed === "done" ? "loom-node-done" : "loom-node-cut text-[var(--loom-muted)]"} ${card.state === "blocked" ? "border-[var(--attention)]" : "border-[var(--loom-node)]"} ${isFocus ? "z-10 bg-[var(--loom-sel)] shadow-[0_0_0_2px_var(--primary)]" : ""} ${off ? "!border-[var(--loom-line)] text-[var(--loom-muted)]" : ""}`;
            const marks = (
              <>
                <StateMark state={card.state} draft={card.draft === "held"} className={small ? "size-[11px]" : "size-3.5"} />
                <span className={`font-semibold ${small ? "text-[11px]" : ""}`}>{card.key}</span>
                {!small && placed.width >= nodeWidth(card.key, word, false, metrics) && <span className="font-sans text-[11px] text-[var(--loom-muted)]">{word}</span>}
              </>
            );
            if (marksOnly)
              return (
                <span key={placed.id} data-map-node={placed.id} data-state={card.state} data-closed={closed ?? undefined} title={`${card.key} · ${word} · ${card.title}`} className={look} style={style}>
                  {marks}
                </span>
              );
            return (
              <button
                key={placed.id}
                type="button"
                data-map-node={placed.id}
                data-map-stop={placed.id}
                data-state={card.state}
                data-closed={closed ?? undefined}
                tabIndex={placed.id === tabKey ? 0 : -1}
                aria-label={`${card.key}, ${word}: ${card.title}`}
                aria-current={isFocus ? "true" : undefined}
                title={`${card.key} · ${word} · ${card.title}`}
                onFocus={() => onActive(placed.id)}
                onClick={() => onPick(placed.id)}
                className={`${look} cursor-pointer ${isFocus ? "" : "hover:bg-state-hover"} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]`}
                style={style}
              >
                {marks}
              </button>
            );
          })}
        </div>
      </div>
      <figcaption className="text-xs text-[var(--loom-muted)]">
        {caption}
        {picture && <span data-map-picture-note>{caption === null ? "" : " · "}At this width the map is a picture: open tickets from the list.</span>}
      </figcaption>
    </figure>
  );
}

export function MapLegend({ kinds, stubs, bundles, closed = false }: { kinds: ReadonlySet<Kind>; stubs: boolean; bundles: boolean; closed?: boolean }) {
  const line = (kind: Kind) => (
    <span key={kind} className="inline-flex items-center gap-1.5">
      <svg width={22} height={6} aria-hidden>
        <path d="M0 3H22" stroke="currentColor" strokeWidth={1.4} strokeDasharray={KIND_DASH[kind]} className={EDGE} />
      </svg>
      {kind === "work" ? "work" : kind === "merge" ? "merges after" : "needs live"}
    </span>
  );
  return (
    <p data-map-legend className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--loom-muted)]">
      {(["work", "merge", "live"] as const).filter((kind) => kinds.has(kind)).map(line)}
      {bundles && (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-3 w-1 rounded-[1px] ${BAR}`} />
          needs all of
        </span>
      )}
      {stubs && (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-5 rounded-[3px] border border-dashed border-[var(--loom-muted)]" />
          outside this map
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <StateMark state="queued" className="size-3" />
        queued
      </span>
      {closed && (
        <>
          <span data-legend="done" className="inline-flex items-center gap-1.5">
            <span aria-hidden className="loom-node-done relative inline-block h-3 w-5 rounded-[3px] border border-[var(--loom-node)]" />
            done
          </span>
          <span data-legend="cancelled" className="inline-flex items-center gap-1.5">
            <span aria-hidden className="loom-node-cut relative inline-block h-3 w-5 rounded-[3px] border border-[var(--loom-node)]" />
            cancelled
          </span>
        </>
      )}
    </p>
  );
}

/** How wide an element is, again whenever it resizes; null until measured (and in tests, which have no layout). */
function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const measure = () => setWidth(node.clientWidth || null);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [ref]);
  return width;
}

type Fold = "phase" | "unblocks" | "direct";

/** A phase's tickets laid out as its map draws them: the picture, its bundles placed as bars, and the dagre layout. */
export function phaseLayout(index: DepIndex, keys: readonly BoardCard[], phases: ReadonlyArray<{ ref: string; title: string }> | null, small: boolean, current: string | null, stubsFor: string | null, metrics: TextMetrics = UNSCALED) {
  const picture = phasePicture(index, keys, phases, small, current, stubsFor, metrics);
  const bundled = bundleEdges(picture.edges);
  const height = nodeHeight(small, metrics);
  const nodesep = small ? 10 : 12;
  const all: MapNode[] = [...picture.nodes, ...bundled.bundles.map((bundle) => ({ id: bundle.id, kind: "bundle" as NodeKind, width: 4, height: bundleHeight(bundle, height, nodesep), label: "" }))];
  return { layout: layoutPhase(all, bundled.edges, bundled.bundles, { nodesep, ranksep: small ? 26 : 44 }), nodes: new Map(all.map((node) => [node.id, node])), kinds: new Set(picture.edges.map((edge) => edge.kind)), bundles: bundled.bundles };
}

/**
 * A phase's map, or with `focus` the map that ticket's pane shows: it, what it waits on and everything it unblocks. With
 * `fold`, a picture wider than its frame folds rather than shrinks: to the focus (or `center` when nothing is open), what
 * it waits on and what it unblocks, then to its direct neighbours only, and the caption counts what it left out.
 */
export function PhaseMap({ index, scope, phases, focus, center = null, fold = false, onPick, label, maxScale, compact = false, small = false, still = false, pictureRef }: { index: DepIndex; scope: readonly BoardCard[]; phases: ReadonlyArray<{ ref: string; title: string }> | null; focus: string | null; center?: string | null; fold?: boolean; onPick(key: string): void; label: string; maxScale?: number; compact?: boolean; small?: boolean; still?: boolean; pictureRef?: PictureRef }) {
  const [active, setActive] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const { metrics, ruler } = useTextMetrics();
  const around = focus ?? center;
  const pictures = useMemo(() => {
    const near = (key: string, depth: "unblocks" | "direct") => {
      const wanted = new Set([key, ...index.prereqs(key).map((prereq) => prereq.key), ...index.dependents(key).map((dep) => dep.key), ...(depth === "unblocks" ? index.inAll(key) : [])]);
      return scope.filter((card) => wanted.has(card.key)).concat([...wanted].filter((one) => !scope.some((card) => card.key === one)).map((one) => index.by.get(one)!).filter((card) => card !== undefined));
    };
    const sets: Array<{ keys: readonly BoardCard[]; fold: Fold; bare?: boolean }> = [compact && focus !== null ? { keys: near(focus, "unblocks"), fold: "unblocks" } : { keys: scope, fold: "phase" }];
    if (fold && around !== null && index.by.has(around)) for (const depth of ["unblocks", "direct"] as const) sets.push({ keys: near(around, depth), fold: depth });
    const distinct = sets.filter((set, at) => at === 0 || set.keys.length < sets[at - 1]!.keys.length);
    // Last, the direct neighbours without the stubs for what they need from outside: those cost a column.
    if (fold && around !== null && index.by.has(around)) distinct.push({ keys: near(around, "direct"), fold: "direct", bare: true });
    return distinct.map(({ keys, fold: kind, bare = false }) => ({ keys, fold: kind, ...phaseLayout(index, keys, phases, small, scope[0]?.phase ?? null, bare ? around : null, metrics) }));
  }, [index, scope, phases, small, compact, focus, fold, around, metrics]);
  const chosen = width === null ? pictures[0]! : (pictures.find((one) => one.layout.width <= width) ?? pictures.at(-1)!);
  const { keys, layout, nodes, kinds, bundles } = chosen;
  const drawn = useMemo<MapPicture | null>(() => (keys.length === 0 ? null : { layout, nodes, bands: [], kinds, closed: false, small, metrics }), [keys, layout, nodes, kinds, small, metrics]);
  usePicture(pictureRef, drawn);
  if (keys.length === 0) return null;
  const labelOf = (id: string) => nodes.get(id)?.label ?? id;
  const lit = litOf(index, focus);
  const what = chosen.fold === "direct" ? "what waits on it directly" : "what it unblocks";
  const caption = [
    ...bundles.map((bundle) => bundleText(bundle, labelOf)),
    ...(chosen.fold !== "phase" && keys.length < scope.length ? [`${keys.length} of the phase's ${scope.length} tickets: ${around}, what it waits on and ${what}; Map shows them all`] : []),
    layout.crossings > 0 ? `${layout.crossings} crossing${layout.crossings === 1 ? "" : "s"} remain` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div ref={box} data-phase-map data-map-fold={chosen.fold} className="relative grid gap-2">
      {ruler}
      <MapCanvas metrics={metrics} small={small} still={still} layout={layout} nodes={nodes} index={index} focus={focus} center={around} lit={lit} active={active} onActive={setActive} onPick={onPick} label={label} maxScale={maxScale} caption={caption.length === 0 ? null : caption.join(" · ")} />
      <MapLegend kinds={kinds} stubs={layout.nodes.some((node) => node.kind === "stub")} bundles={bundles.length > 0} />
    </div>
  );
}

/** A ticket and its hops laid out in columns, as `HopMap` draws them, with the bundles it keeps as bars. */
export function hopLayout(index: DepIndex, focus: string, hops: 1 | 2, expanded: ReadonlySet<string> = new Set(), wide = true, metrics: TextMetrics = UNSCALED) {
  const picture = hopPicture(index, focus, hops, 7, expanded, wide, metrics);
  const bundled = bundleEdges(picture.edges);
  const layout = layoutColumns(picture.columns, bundled.edges, bundled.bundles);
  const all: MapNode[] = [...picture.columns.flat(), ...layout.bundles.map((bundle) => ({ id: bundle.id, kind: "bundle" as NodeKind, width: 4, height: 0, label: "" }))];
  return { layout, nodes: new Map(all.map((node) => [node.id, node])), kinds: new Set(picture.edges.map((edge) => edge.kind)) };
}

/** A ticket and its hops: for unphased projects, and for a phase's ticket in the Map view's pane. */
export function HopMap({ index, focus, hops, onPick, label, wide = true, maxScale, still = false, pictureRef }: { index: DepIndex; focus: string; hops: 1 | 2; onPick(key: string): void; label: string; wide?: boolean; maxScale?: number; still?: boolean; pictureRef?: PictureRef }) {
  const [active, setActive] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { metrics, ruler } = useTextMetrics();
  const { layout, nodes, kinds } = useMemo(() => hopLayout(index, focus, hops, expanded, wide, metrics), [index, focus, hops, expanded, wide, metrics]);
  usePicture(pictureRef, useMemo(() => ({ layout, nodes, bands: [], kinds, closed: false, small: false, metrics }), [layout, nodes, kinds, metrics]));
  // In words, a stub of done tickets is the tickets it folds.
  const labelOf = (id: string) => {
    const node = nodes.get(id);
    return id.startsWith("done:") && node?.note !== undefined ? `${node.note} (done)` : (node?.label ?? id);
  };
  const lit = litOf(index, focus);
  const waits = index.prereqs(focus).filter((prereq) => isOpen(index.by.get(prereq.key)!)).length;
  return (
    <div data-hop-map className="relative grid gap-2">
      {ruler}
      <MapCanvas
        metrics={metrics}
        layout={layout}
        nodes={nodes}
        index={index}
        focus={focus}
        lit={lit}
        active={active}
        onActive={setActive}
        onPick={onPick}
        label={label}
        maxScale={maxScale}
        still={still}
        onMore={(id) => setExpanded((before) => new Set([...before, id]))}
        caption={[`${focus} waits on ${waits} open · unblocks ${index.direct(focus).length} directly, ${index.inAll(focus).length} in all`, ...layout.bundles.map((bundle) => bundleText(bundle, labelOf)), ...(layout.crossings > 0 ? [`${layout.crossings} crossing${layout.crossings === 1 ? "" : "s"} remain`] : [])].join(" · ")}
      />
      <MapLegend kinds={kinds} stubs={layout.nodes.some((node) => node.kind === "stub")} bundles={layout.bundles.length > 0} />
    </div>
  );
}

// The whole project runs long: columns sit closer than a phase's, and the router widens a gap its edges need.
const RANKSEP = 32;

/** "7 of 8 done · 1 cancelled": a set of tickets' counts, as a band and the Map's header say them. */
export function doneText(cards: readonly BoardCard[]): string {
  const done = cards.filter((card) => card.state === "done").length;
  const cancelled = cards.filter((card) => card.state === "cancelled").length;
  return `${done} of ${cards.length} done${cancelled > 0 ? ` · ${cancelled} cancelled` : ""}`;
}

/** The whole project's picture as `ProjectMap` lays it out: every ticket and edge, and a band per phase. */
export function projectPicture(index: DepIndex, board: readonly BoardCard[], phases: ReadonlyArray<{ ref: string; title: string; state: "planned" | "active" | "done" }> | null, metrics: TextMetrics = UNSCALED) {
  const height = nodeHeight(false, metrics);
  const nodesep = 12;
  const tickets: MapNode[] = board.map((card) => ({ id: card.key, kind: "ticket", width: nodeWidth(card.key, null, false, metrics), height, label: card.key, card }));
  const bundled = bundleEdges(edgesAmong(index, new Set(board.map((card) => card.key))));
  const all: MapNode[] = [...tickets, ...bundled.bundles.map((bundle) => ({ id: bundle.id, kind: "bundle" as NodeKind, width: 4, height: bundleHeight(bundle, height, nodesep), label: "" }))];
  const known = new Set((phases ?? []).map((phase) => phase.ref));
  const groups = phases === null ? [] : [...phases.map((phase) => ({ id: phase.ref, members: board.filter((card) => card.phase === phase.ref).map((card) => card.key) })), { id: "outside", members: board.filter((card) => card.phase === null || !known.has(card.phase)).map((card) => card.key) }];
  // A band's label is two lines of 12 px text; it grows with enlarged text, as the nodes do.
  const scale = Math.max(1, metrics.word, metrics.line / 12);
  const { layout, bands } = layoutBands(all, bundled.edges, bundled.bundles, groups, { nodesep, ranksep: RANKSEP, minWidth: Math.ceil(196 * scale), top: Math.ceil(14 + 36 * scale) });
  const views: BandView[] = bands.map((band) => {
    const at = phases?.findIndex((phase) => phase.ref === band.id) ?? -1;
    const phase = at >= 0 ? phases![at]! : null;
    return { ...band, number: phase === null ? null : at + 1, title: phase?.title ?? "Outside the phases", counts: doneText(board.filter((card) => groups.find((group) => group.id === band.id)!.members.includes(card.key))), state: phase?.state ?? "planned" };
  });
  return { layout, bands: views, nodes: new Map(all.map((node) => [node.id, node])), kinds: new Set(bundled.edges.map((edge) => edge.kind)), bundles: bundled.bundles };
}

/**
 * The whole project, done tickets included, with every edge: each phase in columns of its own as a band, in the
 * phases' order, titled and counted as the rail counts it; an unphased project as one graph. Laid out at the text's
 * size and never shrunk, so a project wider than its frame scrolls sideways with its focus in view.
 */
export function ProjectMap({ index, board, phases, focus, onPick, label, still = false, pictureRef }: { index: DepIndex; board: readonly BoardCard[]; phases: ReadonlyArray<{ ref: string; title: string; state: "planned" | "active" | "done" }> | null; focus: string | null; onPick(key: string): void; label: string; still?: boolean; pictureRef?: PictureRef }) {
  const [active, setActive] = useState<string | null>(null);
  const { metrics, ruler } = useTextMetrics();
  const picture = useMemo(() => projectPicture(index, board, phases, metrics), [index, board, phases, metrics]);
  usePicture(pictureRef, useMemo(() => (board.length === 0 ? null : { layout: picture.layout, nodes: picture.nodes, bands: picture.bands, kinds: picture.kinds, closed: true, small: false, metrics }), [picture, board.length, metrics]));
  if (board.length === 0) return null;
  const { layout, bands, nodes, kinds, bundles } = picture;
  const labelOf = (id: string) => nodes.get(id)?.label ?? id;
  const caption = [
    phases === null ? `${board.length} tickets` : `${board.length} tickets in ${bands.filter((band) => band.number !== null).length} phases`,
    doneText(board),
    ...bundles.map((bundle) => bundleText(bundle, labelOf)),
    layout.crossings > 0 ? `${layout.crossings} crossing${layout.crossings === 1 ? "" : "s"} remain` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div data-project-map className="relative grid gap-2">
      {ruler}
      <MapCanvas finished bands={bands} metrics={metrics} still={still} layout={layout} nodes={nodes} index={index} focus={focus} center={focus} lit={litOf(index, focus)} active={active} onActive={setActive} onPick={onPick} label={label} caption={caption.join(" · ")} />
      <MapLegend closed kinds={kinds} stubs={false} bundles={bundles.length > 0} />
    </div>
  );
}

/** Every open ticket in scope with what it waits on, by kind, and what it unblocks: the maps as a table. */
export function ExactList({ index, scope, scopeLabel, focus, onPick, still = false, closed = false, phaseOf }: { index: DepIndex; scope: readonly BoardCard[]; scopeLabel: string; focus: string | null; onPick(key: string): void; still?: boolean; closed?: boolean; phaseOf?: (key: string) => string | undefined }) {
  const byKey = (a: BoardCard, b: BoardCard) => a.key.localeCompare(b.key, undefined, { numeric: true });
  const rows = [
    ...scope
      .filter(isOpen)
      .map((card) => ({ card, all: index.inAll(card.key).length, direct: index.direct(card.key).length }))
      .sort((a, b) => b.all - a.all || b.direct - a.direct || byKey(a.card, b.card)),
    // With done shown, the closed tickets follow, done before cancelled, each in key order.
    ...(closed ? scope.filter((card) => !isOpen(card)).sort((a, b) => Number(a.state === "cancelled") - Number(b.state === "cancelled") || byKey(a, b)).map((card) => ({ card, all: index.inAll(card.key).length, direct: index.direct(card.key).length })) : []),
  ];
  const open = scope.filter(isOpen).length;
  return (
    <div data-exact-list className="grid gap-2 overflow-x-auto">
      <p className="m-0 text-xs text-[var(--loom-muted)]">
        {closed ? `${scopeLabel}: ${rows.length} tickets, ${open} open; open ones first, most unblocked first, then done and cancelled. Unblocks counts open tickets, directly and in all.` : `${scopeLabel}: ${rows.length} open, most unblocked first. Unblocks counts open tickets, directly and in all.`}
      </p>
      <table className="w-full border-collapse text-left text-xs">
        <thead className="text-[11px] uppercase tracking-wider text-[var(--loom-muted)]">
          <tr className="border-b border-[var(--loom-line)]">
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              Ticket
            </th>
            {phaseOf !== undefined && (
              <th scope="col" className="py-1.5 pr-2 font-semibold">
                Phase
              </th>
            )}
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              State
            </th>
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              Waits on
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right font-semibold">
              Unblocks directly
            </th>
            <th scope="col" className="py-1.5 text-right font-semibold">
              In all
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ card, all, direct }) => (
            <tr key={card.key} data-exact-row={card.key} className={`border-b border-[var(--loom-line)] ${card.key === focus ? "bg-[var(--loom-sel)]" : ""}`}>
              <td className="py-1 pr-2">
                {still ? (
                  <span className="inline-flex items-center gap-1.5 font-mono font-semibold">
                    <StateMark state={card.state} className="size-3" />
                    {card.key}
                  </span>
                ) : (
                  <button type="button" onClick={() => onPick(card.key)} aria-current={card.key === focus ? "true" : undefined} className="inline-flex min-h-7 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11 cursor-pointer items-center gap-1.5 rounded font-mono font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <StateMark state={card.state} className="size-3" />
                    {card.key}
                  </button>
                )}
              </td>
              {phaseOf !== undefined && <td className="py-1 pr-2 whitespace-nowrap">{phaseOf(card.key) ?? "none"}</td>}
              <td className="py-1 pr-2">{STATE_WORDS[card.state]}</td>
              <td className="py-1 pr-2 font-mono">{index.prereqs(card.key).map((prereq) => (prereq.kind === "work" ? prereq.key : `${prereq.key} (${prereq.kind === "merge" ? "merge" : "live"})`)).join(", ") || "nothing"}</td>
              <td className="loom-num py-1 pr-2 text-right">{direct}</td>
              <td className="loom-num py-1 text-right">{all}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
