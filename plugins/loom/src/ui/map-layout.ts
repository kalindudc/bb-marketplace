// The dependency map's geometry: one node per ticket, layered left to right (dagre for a phase, fixed columns for a ticket
// and its hops), complete bipartite sets drawn through one bundle bar, and every edge routed orthogonally between ports
// Loom defines. A port is a fixed point on a node's left or right border, one per kind of edge, so an edge always leaves
// and enters perpendicular and two kinds between the same tickets run apart. Pure: no DOM, so tests can read it.
import dagre from "@dagrejs/dagre";
import { KINDS, type Kind } from "./deps";

export type NodeKind = "ticket" | "stub" | "more" | "bundle";

export interface MapNodeIn {
  id: string;
  kind: NodeKind;
  width: number;
  height: number;
}

export interface MapEdgeIn {
  from: string;
  to: string;
  kind: Kind;
}

export interface PlacedNode extends MapNodeIn {
  /** Top-left corner. */
  x: number;
  y: number;
  /** The column it sits in, left to right. */
  rank: number;
}

export interface RoutedEdge extends MapEdgeIn {
  id: string;
  /** The orthogonal route, port to port; every turn is a right angle. */
  points: Array<[number, number]>;
  /** The route as an SVG path, its corners rounded. */
  d: string;
}

export interface Bundle {
  id: string;
  /** The kind every edge through it has: each target needs all of the sources this way. */
  kind: Kind;
  sources: string[];
  targets: string[];
}

export interface MapLayout {
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  width: number;
  height: number;
  /** Where two edges cross after routing; 0 is the aim, and the caption counts what remains. */
  crossings: number;
  bundles: Bundle[];
}

export const PAD = 12;
const DIVIDER = "divider:";
const RANKERS = ["network-simplex", "tight-tree", "longest-path"] as const;
const PORT_GAP = 7;
/** How far a port on a bundle bar keeps from its ends, so no edge meets the bar at a corner. */
const BAR_INSET = 9;
const CHANNEL_GAP = 8;

const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Replaces complete bipartite sets of edges of one kind (two or more tickets that each need the same two or more
 * tickets) with bundles: the sources run into one bar, and the bar runs out to each target. A K3,3 becomes six edges,
 * none crossing. The set that covers the most edges goes first; its edges leave the pool and the search repeats, so a
 * ticket that needs more than the shared set keeps its other edges.
 */
export function bundleEdges(edges: readonly MapEdgeIn[]): { edges: MapEdgeIn[]; bundles: Bundle[] } {
  let rest = [...edges];
  const bundles: Bundle[] = [];
  for (const kind of KINDS)
    for (;;) {
      const sourcesOf = new Map<string, Set<string>>();
      for (const edge of rest) if (edge.kind === kind) sourcesOf.set(edge.to, (sourcesOf.get(edge.to) ?? new Set()).add(edge.from));
      const targets = [...sourcesOf.keys()].sort(byKey);
      let best: { sources: string[]; targets: string[]; size: number; id: string } | null = null;
      const tried = new Set<string>();
      for (let i = 0; i < targets.length; i++)
        for (let j = i + 1; j < targets.length; j++) {
          const other = sourcesOf.get(targets[j]!)!;
          const shared = [...sourcesOf.get(targets[i]!)!].filter((source) => other.has(source)).sort(byKey);
          const id = shared.join(",");
          if (shared.length < 2 || tried.has(id)) continue;
          tried.add(id);
          const all = targets.filter((target) => shared.every((source) => sourcesOf.get(target)!.has(source)));
          const size = shared.length * all.length;
          if (best === null || size > best.size || (size === best.size && id < best.id)) best = { sources: shared, targets: all, size, id };
        }
      if (best === null) break;
      const { sources, targets: into } = best;
      bundles.push({ id: kind === "work" ? `bundle:${best.id}` : `bundle:${kind}:${best.id}`, kind, sources, targets: into });
      rest = rest.filter((edge) => !(edge.kind === kind && sources.includes(edge.from) && into.includes(edge.to)));
    }
  for (const bundle of bundles) rest.push(...barEdges(bundle));
  return { edges: rest, bundles };
}

const barEdges = (bundle: Bundle): MapEdgeIn[] => [...bundle.sources.map((source) => ({ from: source, to: bundle.id, kind: bundle.kind })), ...bundle.targets.map((target) => ({ from: bundle.id, to: target, kind: bundle.kind }))];

/** Puts a bundle's edges back as they were, one per source and target. */
function unbundle(edges: readonly MapEdgeIn[], bundle: Bundle): MapEdgeIn[] {
  return [...edges.filter((edge) => edge.from !== bundle.id && edge.to !== bundle.id), ...bundle.targets.flatMap((target) => bundle.sources.map((source) => ({ from: source, to: target, kind: bundle.kind })))];
}

export const bundleHeight = (bundle: Bundle, nodeHeight: number, nodesep: number) => Math.max(nodeHeight, Math.max(bundle.sources.length, bundle.targets.length) * (nodeHeight + nodesep) - nodesep);

/**
 * A phase's map: dagre ranks and orders the nodes; the router draws the edges. With `groups`, each group's nodes take
 * columns of their own, left to right in the order given: an unseen node between each group and the next comes after
 * every node of the first and before every node of the second, so no column mixes two phases.
 */
export function layoutPhase(nodes: readonly MapNodeIn[], edges: readonly MapEdgeIn[], bundles: readonly Bundle[] = [], options: { nodesep?: number; ranksep?: number; groups?: ReadonlyArray<readonly string[]>; ranker?: "network-simplex" | "tight-tree" | "longest-path" } = {}): MapLayout {
  const nodesep = options.nodesep ?? 12;
  let ranksep = options.ranksep ?? 48;
  // Two passes at most: a gap that needs more channels than fit gets a wider rank separation.
  for (let pass = 0; pass < 2; pass++) {
    const graph = new dagre.graphlib.Graph({ multigraph: true });
    graph.setGraph({ rankdir: "LR", nodesep, ranksep, edgesep: 8, marginx: 0, marginy: 0, ...(options.ranker === undefined ? {} : { ranker: options.ranker }) });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of nodes) graph.setNode(node.id, { width: node.width, height: node.height });
    // One dagre edge per pair: kinds between the same tickets share a path through the ranks and part at the ports.
    const pairs = new Map<string, MapEdgeIn>();
    for (const edge of edges) if (!pairs.has(`${edge.from}>${edge.to}`)) pairs.set(`${edge.from}>${edge.to}`, edge);
    for (const [name, edge] of pairs) graph.setEdge(edge.from, edge.to, { weight: edge.kind === "work" ? 2 : 1, minlen: 1 }, name);
    // Only a group's last nodes run to the divider and only the next group's first nodes leave it: edges inside a group
    // order the rest, and fewer long edges leave dagre fewer dummy nodes to make room for.
    const groups = (options.groups ?? []).filter((group) => group.length > 0);
    for (let at = 0; at + 1 < groups.length; at++) {
      const divider = `${DIVIDER}${at}`;
      graph.setNode(divider, { width: 0, height: 0 });
      const here = new Set(groups[at]);
      const next = new Set(groups[at + 1]);
      for (const id of here) if (![...pairs.values()].some((edge) => edge.from === id && here.has(edge.to))) graph.setEdge(id, divider, { weight: 1, minlen: 1 }, `${id}>${divider}`);
      for (const id of next) if (![...pairs.values()].some((edge) => edge.to === id && next.has(edge.from))) graph.setEdge(divider, id, { weight: 1, minlen: 1 }, `${divider}>${id}`);
    }
    dagre.layout(graph);
    const placed = nodes.map((node): PlacedNode => {
      const at = graph.node(node.id) as { x: number; y: number; rank?: number };
      return { ...node, x: at.x - node.width / 2, y: at.y - node.height / 2, rank: 0 };
    });
    const dummies = new Map<string, Array<{ x: number; y: number }>>();
    for (const [name, edge] of pairs) {
      const points = ((graph.edge(edge.from, edge.to, name) as { points?: Array<{ x: number; y: number }> }).points ?? []).slice(1, -1);
      dummies.set(name, points);
    }
    // Columns from x: dagre gives every node of a rank the same centre in a left-to-right layout. Its ranks between the
    // columns hold only the midpoints it keeps for edge labels, which the router does not need.
    const centres = [...new Set(placed.map((node) => Math.round(node.x + node.width / 2)))].sort((a, b) => a - b);
    for (const node of placed) node.rank = nearest(centres, node.x + node.width / 2);
    keepBundlesTogether(placed, bundles);
    const layout = route(placed, edges, bundles, (edge) => dummies.get(`${edge.from}>${edge.to}`) ?? [], centres);
    if (layout.tightest >= CHANNEL_GAP || pass === 1) return layout.layout;
    ranksep = Math.ceil(ranksep * (CHANNEL_GAP / Math.max(1, layout.tightest))) + 4;
  }
  throw new Error("unreachable");
}

export interface MapBand {
  id: string;
  /** The band's left edge and width, around its nodes with room to spare, and never narrower than its label needs. */
  x: number;
  width: number;
}

/**
 * Moves everything right of `cut` by `by`. Every route stays orthogonal: a vertical run lies wholly on one side of the
 * cut, and a horizontal run that crosses it only grows.
 */
function stretch(layout: MapLayout, cut: number, by: number): MapLayout {
  if (by <= 0) return layout;
  const shift = (x: number) => (x > cut ? x + by : x);
  return {
    ...layout,
    width: layout.width + by,
    nodes: layout.nodes.map((node) => (node.x > cut ? { ...node, x: node.x + by } : node)),
    edges: layout.edges.map((edge) => {
      const points = edge.points.map(([x, y]): [number, number] => [shift(x), y]);
      return { ...edge, points, d: pathOf(points) };
    }),
  };
}

/**
 * The whole project's map: each group (a phase) in columns of its own, left to right, as a band at least `minWidth`
 * wide, and everything `top` lower so each band's label has a row above its tickets. A narrow band widens about its
 * middle, so its tickets stay centred under the label. With no groups it is one graph and no bands. A whole project's
 * graph is dense, so each of dagre's rankers is tried and the one with the fewest crossings kept: on LANE's 42 tickets
 * that is 105 crossings instead of 143, every edge still drawn.
 */
export function layoutBands(nodes: readonly MapNodeIn[], edges: readonly MapEdgeIn[], bundles: readonly Bundle[], groups: ReadonlyArray<{ id: string; members: readonly string[] }>, options: { nodesep?: number; ranksep?: number; minWidth: number; top: number; pad?: number }): { layout: MapLayout; bands: MapBand[] } {
  const pad = options.pad ?? 10;
  const used = groups.filter((group) => group.members.length > 0);
  let layout = RANKERS.map((ranker) => layoutPhase(nodes, edges, bundles, { nodesep: options.nodesep, ranksep: options.ranksep, groups: used.map((group) => group.members), ranker })).reduce((best, one) => (one.crossings < best.crossings ? one : best));
  const extent = (members: ReadonlySet<string>) => {
    const own = layout.nodes.filter((node) => members.has(node.id));
    return [Math.min(...own.map((node) => node.x)) - pad, Math.max(...own.map((node) => node.x + node.width)) + pad] as const;
  };
  // Each band's edges, moved with everything right of each stretch.
  const spans = used.map((group) => [...extent(new Set(group.members))] as [number, number]);
  for (const [at, band] of spans.entries()) {
    const [left, right] = band;
    const extra = options.minWidth - (right - left);
    if (extra <= 0) continue;
    const half = Math.ceil(extra / 2);
    layout = stretch(stretch(layout, right - 0.5, extra - half), left - 0.5, half);
    band[1] = right + extra;
    for (const later of spans.slice(at + 1)) {
      later[0] += extra;
      later[1] += extra;
    }
  }
  const bands = used.map((group, at) => ({ id: group.id, x: spans[at]![0], width: spans[at]![1] - spans[at]![0] }));
  // The first band's left edge starts the picture, inside the frame's padding.
  const dx = Math.max(0, PAD - Math.min(PAD, ...bands.map((band) => band.x)));
  const dy = bands.length > 0 ? options.top : 0;
  return {
    layout: {
      ...layout,
      width: Math.max(layout.width, ...bands.map((band) => band.x + band.width + PAD)) + dx,
      height: layout.height + dy,
      nodes: layout.nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
      edges: layout.edges.map((edge) => {
        const points = edge.points.map(([x, y]): [number, number] => [x + dx, y + dy]);
        return { ...edge, points, d: pathOf(points) };
      }),
    },
    bands: bands.map((band) => ({ ...band, x: band.x + dx })),
  };
}

/**
 * dagre orders a column by where each node's neighbours sit, so a ticket that needs one of a bundle's sources and
 * something far below can land between the bundle's targets, and its edge then crosses the bar's fan. Each bundle's
 * targets, and its sources, are made contiguous in their column, at the place of their middle one; the column's other
 * nodes keep their order around them. Only nodes of one height trade places, so the gaps dagre left for edges that run
 * through the column stay clear.
 */
function keepBundlesTogether(nodes: PlacedNode[], bundles: readonly Bundle[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const bundle of bundles)
    for (const members of [bundle.targets, bundle.sources]) {
      const group = members.map((id) => byId.get(id)).filter((node): node is PlacedNode => node !== undefined);
      if (group.length < 2 || new Set(group.map((node) => node.rank)).size !== 1) continue;
      const height = group[0]!.height;
      const column = nodes.filter((node) => node.rank === group[0]!.rank && node.kind !== "bundle" && node.height === height).sort((a, b) => a.y - b.y);
      const inGroup = (node: PlacedNode) => members.includes(node.id);
      const first = column.findIndex(inGroup);
      const middle = column.filter(inGroup)[Math.floor(group.length / 2)]!;
      const at = column.indexOf(middle);
      const before = column.filter((node, index) => !inGroup(node) && index < at);
      const after = column.filter((node, index) => !inGroup(node) && index > at);
      if (first < 0) continue;
      const order = [...before, ...column.filter(inGroup), ...after];
      const slots = column.map((node) => node.y);
      order.forEach((node, index) => {
        node.y = slots[index]!;
      });
    }
}

/**
 * A ticket and its hops: fixed columns, the focus in the middle, each column ordered to keep edges from crossing. A
 * bundle's bar stands just right of its sources, which are made contiguous, and spans only them, so edges from the
 * column's other tickets pass above or below it; from the bar its edges fan out to the targets. A bundle is drawn only
 * when its sources share one column and lead nowhere else, and two bars in one gap never share a source; otherwise
 * its edges are drawn one by one.
 */
export function layoutColumns(columns: ReadonlyArray<readonly MapNodeIn[]>, edges: readonly MapEdgeIn[], bundles: readonly Bundle[] = [], options: { nodesep?: number; colsep?: number } = {}): MapLayout {
  const nodesep = options.nodesep ?? 10;
  const colsep = options.colsep ?? 48;
  const columnOf = new Map(columns.flatMap((column, at) => column.map((node) => [node.id, at] as const)));
  let drawn = [...edges];
  const kept: Bundle[] = [];
  for (const bundle of [...bundles].sort((a, b) => b.sources.length * b.targets.length - a.sources.length * a.targets.length)) {
    const at = new Set(bundle.sources.map((source) => columnOf.get(source)));
    const alone = bundle.sources.every((source) => drawn.every((edge) => edge.from !== source || edge.to === bundle.id));
    const shares = kept.some((other) => other.sources.some((source) => bundle.sources.includes(source)));
    if (at.size === 1 && alone && !shares) kept.push(bundle);
    else drawn = unbundle(drawn, bundle);
  }
  const height = (column: readonly MapNodeIn[]) => column.reduce((sum, node) => sum + node.height, 0) + Math.max(0, column.length - 1) * nodesep;
  const tallest = Math.max(0, ...columns.map(height));
  const placed: PlacedNode[] = [];
  columns.forEach((column, rank) => {
    let y = (tallest - height(column)) / 2;
    for (const node of column) {
      placed.push({ ...node, x: 0, y, rank });
      y += node.height + nodesep;
    }
  });
  keepBundlesTogether(placed, kept);
  // Ranks left to right: each column, then a column of bars when its gap has any.
  const bars = new Map<number, Bundle[]>();
  for (const bundle of kept) bars.set(columnOf.get(bundle.sources[0]!)!, [...(bars.get(columnOf.get(bundle.sources[0]!)!) ?? []), bundle]);
  const byId = new Map(placed.map((node) => [node.id, node]));
  const centres: number[] = [];
  let x = 0;
  let rank = 0;
  columns.forEach((column, at) => {
    const width = Math.max(0, ...column.map((node) => node.width));
    for (const node of placed.filter((one) => columnOf.get(one.id) === at)) {
      node.x = x + (width - node.width) / 2;
      node.rank = rank;
    }
    centres.push(x + width / 2);
    x += width;
    rank++;
    const here = bars.get(at);
    if (here === undefined) {
      x += colsep;
      return;
    }
    x += BAR_GAP;
    for (const bundle of here) {
      const ys = bundle.sources.map((source) => byId.get(source)!).map((node) => node.y + node.height / 2);
      const top = Math.min(...ys) - BAR_INSET - PORT_GAP;
      placed.push({ id: bundle.id, kind: "bundle", width: BAR_W, height: Math.max(...ys) + BAR_INSET + PORT_GAP - top, x, y: top, rank });
    }
    centres.push(x + BAR_W / 2);
    x += BAR_W + colsep;
    rank++;
  });
  return route(placed, drawn, kept, () => [], centres).layout;
}

const BAR_W = 4;
/** Between a column and the bars right of it: room for the short runs from each source into its bar. */
const BAR_GAP = 14;

interface Segment {
  edge: number;
  gap: number;
  /** The y it comes in at, from the left, and leaves at, to the right. */
  ya: number;
  yb: number;
  y1: number;
  y2: number;
  /** The port its horizontal comes from when it is the edge's first turn, which edges from the same port may share. */
  from: string | null;
  /** The port its horizontal goes to when it is the edge's last turn. */
  to: string | null;
}

function route(nodes: PlacedNode[], edges: readonly MapEdgeIn[], bundles: readonly Bundle[], dummiesOf: (edge: MapEdgeIn) => Array<{ x: number; y: number }>, centres: readonly number[]): { layout: MapLayout; tightest: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rankLeft = centres.map((centre, rank) => Math.min(centre, ...nodes.filter((node) => node.rank === rank).map((node) => node.x)));
  const rankRight = centres.map((centre, rank) => Math.max(centre, ...nodes.filter((node) => node.rank === rank).map((node) => node.x + node.width)));
  const cy = (node: PlacedNode) => node.y + node.height / 2;
  const isBar = (node: PlacedNode) => node.kind === "bundle";

  // Ports on ticket nodes: one per kind on each side, centred. A side's kinds go in the order of where their other ends
  // sit, so two kinds between the same tickets run beside each other instead of crossing: the ports a node's edges
  // enter by follow their sources, and the ports they leave by follow the ports they enter.
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const portOrder = new Map<string, Kind[]>();
  const kindsOn = (id: string, side: "out" | "in", at: (edge: MapEdgeIn) => number) => {
    const kinds = KINDS.filter((kind) => edges.some((edge) => (side === "out" ? edge.from : edge.to) === id && edge.kind === kind));
    const where = new Map(kinds.map((kind) => [kind, mean(edges.filter((edge) => (side === "out" ? edge.from : edge.to) === id && edge.kind === kind).map(at))]));
    return [...kinds].sort((a, b) => where.get(a)! - where.get(b)! || KINDS.indexOf(a) - KINDS.indexOf(b));
  };
  const portY = (node: PlacedNode, side: "out" | "in", kind: Kind) => {
    const kinds = portOrder.get(`${node.id}:${side}`) ?? [kind];
    const index = Math.max(0, kinds.indexOf(kind));
    return cy(node) + (index - (kinds.length - 1) / 2) * PORT_GAP;
  };
  for (const node of nodes) if (!isBar(node)) portOrder.set(`${node.id}:in`, kindsOn(node.id, "in", (edge) => cy(byId.get(edge.from)!)));
  for (const node of nodes) if (!isBar(node)) portOrder.set(`${node.id}:out`, kindsOn(node.id, "out", (edge) => (isBar(byId.get(edge.to)!) ? cy(byId.get(edge.to)!) : portY(byId.get(edge.to)!, "in", edge.kind))));
  // On a bar, each edge gets its own port, level with the ticket at its other end when the bar reaches it.
  const barY = (bar: PlacedNode, other: number) => Math.min(bar.y + bar.height - BAR_INSET, Math.max(bar.y + BAR_INSET, other));
  const start = (edge: MapEdgeIn): [number, number] => {
    const node = byId.get(edge.from)!;
    if (!isBar(node)) return [node.x + node.width, portY(node, "out", edge.kind)];
    const target = byId.get(edge.to)!;
    return [node.x + node.width, barY(node, isBar(target) ? cy(target) : portY(target, "in", edge.kind))];
  };
  const end = (edge: MapEdgeIn): [number, number] => {
    const node = byId.get(edge.to)!;
    if (!isBar(node)) return [node.x, portY(node, "in", edge.kind)];
    const source = byId.get(edge.from)!;
    return [node.x, barY(node, isBar(source) ? cy(source) : portY(source, "out", edge.kind))];
  };
  const portId = (id: string, side: "out" | "in", kind: Kind, y: number) => (isBar(byId.get(id)!) ? `${id}:${side}:${y.toFixed(1)}` : `${id}:${side}:${kind}`);

  // Each edge as levels: the y it runs at in each gap it crosses, from its start port, through dagre's points in the
  // columns between, to its end port.
  const routes = edges.map((edge) => {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const s = start(edge);
    const t = end(edge);
    const gaps = Array.from({ length: Math.max(1, to.rank - from.rank) }, (_, index) => from.rank + index);
    // The y it crosses each column between at: dagre's bend point in that column, which it kept clear of the nodes there.
    const bends = dummiesOf(edge);
    const through: number[] = [];
    for (const gap of gaps.slice(1)) through.push(bends.find((point) => Math.abs(point.x - centres[gap]!) < 3)?.y ?? through.at(-1) ?? s[1]);
    return { edge, s, t, levels: [s[1], ...through, t[1]], gaps };
  });

  // Vertical runs, one per gap an edge turns in; runs that may share a channel are those of one edge, or of edges leaving
  // or entering the same port, which then read as one line splitting or joining.
  const segments: Segment[] = [];
  routes.forEach((one, index) => {
    one.gaps.forEach((gap, step) => {
      const y1 = one.levels[step]!;
      const y2 = one.levels[step + 1] ?? one.levels.at(-1)!;
      if (Math.abs(y1 - y2) < 0.5) return;
      const first = step === 0;
      const last = step === one.gaps.length - 1;
      segments.push({ edge: index, gap, ya: y1, yb: y2, y1: Math.min(y1, y2), y2: Math.max(y1, y2), from: first ? portId(one.edge.from, "out", one.edge.kind, one.s[1]) : null, to: last ? portId(one.edge.to, "in", one.edge.kind, one.t[1]) : null });
    });
  });
  const compatible = (a: Segment, b: Segment) => a.edge === b.edge || (a.from !== null && a.from === b.from) || (a.to !== null && a.to === b.to);
  // Lanes left to right in an order that keeps overlapping runs from crossing: a run going up turns before one that
  // starts below it, and a run going down before one that starts above it. A later run takes a lane right of every
  // earlier one it overlaps and cannot share with.
  const overlaps = (a: Segment, b: Segment) => !(a.y2 + 3 < b.y1 || b.y2 + 3 < a.y1);
  const order = (a: Segment) => (a.yb < a.ya ? [0, a.ya] : [1, -a.ya]);
  const channelOf = new Map<Segment, number>();
  const channels = new Map<number, Segment[][]>();
  const sorted = [...segments].sort((a, b) => a.gap - b.gap || order(a)[0]! - order(b)[0]! || order(a)[1]! - order(b)[1]!);
  for (const segment of sorted) {
    const lanes = channels.get(segment.gap) ?? [];
    const floor = Math.max(-1, ...sorted.filter((other) => other.gap === segment.gap && channelOf.has(other) && overlaps(segment, other) && !compatible(segment, other)).map((other) => channelOf.get(other)!)) + 1;
    let lane = floor;
    while (lane < lanes.length && !lanes[lane]!.every((other) => compatible(segment, other) || !overlaps(segment, other))) lane++;
    while (lanes.length <= lane) lanes.push([]);
    lanes[lane]!.push(segment);
    channels.set(segment.gap, lanes);
    channelOf.set(segment, lane);
  }
  let tightest = Number.POSITIVE_INFINITY;
  const channelX = (gap: number, lane: number) => {
    const count = channels.get(gap)?.length ?? 1;
    const left = rankRight[gap]!;
    const right = rankLeft[gap + 1] ?? left + 48;
    const spacing = (right - left) / (count + 1);
    tightest = Math.min(tightest, spacing);
    return left + spacing * (lane + 1);
  };

  const routed: RoutedEdge[] = routes.map((one, index) => {
    const points: Array<[number, number]> = [one.s];
    one.gaps.forEach((gap, step) => {
      const y1 = one.levels[step]!;
      const y2 = one.levels[step + 1] ?? one.levels.at(-1)!;
      if (Math.abs(y1 - y2) < 0.5) return;
      const segment = segments.find((candidate) => candidate.edge === index && candidate.gap === gap)!;
      const x = channelX(gap, channelOf.get(segment)!);
      points.push([x, y1], [x, y2]);
    });
    points.push(one.t);
    return { ...one.edge, id: `${one.edge.from}>${one.edge.to}>${one.edge.kind}`, points: simplify(points), d: pathOf(simplify(points)) };
  });

  // Shift everything by the padding, so strokes, glows and focus rings stay inside the frame.
  for (const node of nodes) {
    node.x += PAD;
    node.y += PAD;
  }
  for (const edge of routed) {
    edge.points = edge.points.map(([x, y]) => [x + PAD, y + PAD]);
    edge.d = pathOf(edge.points);
  }
  const width = Math.max(0, ...nodes.map((node) => node.x + node.width)) + PAD;
  const height = Math.max(0, ...nodes.map((node) => node.y + node.height)) + PAD;
  return { layout: { nodes, edges: routed, width, height, crossings: crossingsOf(routed), bundles: [...bundles] }, tightest };
}

const nearest = (centres: readonly number[], x: number) => centres.reduce((best, centre, index) => (Math.abs(centre - x) < Math.abs(centres[best]! - x) ? index : best), 0);

/** Drops points that do not turn. */
function simplify(points: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last !== undefined && Math.abs(last[0] - point[0]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01) continue;
    const before = out.at(-2);
    if (before !== undefined && last !== undefined && ((Math.abs(before[0] - last[0]) < 0.01 && Math.abs(last[0] - point[0]) < 0.01) || (Math.abs(before[1] - last[1]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01))) out.pop();
    out.push(point);
  }
  return out;
}

const RADIUS = 5;

/** An orthogonal route as a path whose right angles are rounded; it starts and ends exactly on its ports. */
export function pathOf(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return "";
  const parts = [`M${points[0]![0].toFixed(1)} ${points[0]![1].toFixed(1)}`];
  for (let index = 1; index < points.length; index++) {
    const [x, y] = points[index]!;
    const next = points[index + 1];
    if (next === undefined) {
      parts.push(`L${x.toFixed(1)} ${y.toFixed(1)}`);
      continue;
    }
    const [px, py] = points[index - 1]!;
    const into = Math.hypot(x - px, y - py);
    const out = Math.hypot(next[0] - x, next[1] - y);
    const r = Math.min(RADIUS, into / 2, out / 2);
    const ax = x - ((x - px) / (into || 1)) * r;
    const ay = y - ((y - py) / (into || 1)) * r;
    const bx = x + ((next[0] - x) / (out || 1)) * r;
    const by = y + ((next[1] - y) / (out || 1)) * r;
    parts.push(`L${ax.toFixed(1)} ${ay.toFixed(1)}`, `Q${x.toFixed(1)} ${y.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`);
  }
  return parts.join(" ");
}

/** Strict crossings of one edge's horizontal runs with another's vertical runs; a join at a shared port is not one. */
export function crossingsOf(edges: readonly RoutedEdge[]): number {
  const runs = edges.map((edge) => {
    const horizontal: Array<[number, number, number]> = [];
    const vertical: Array<[number, number, number]> = [];
    for (let index = 1; index < edge.points.length; index++) {
      const [x1, y1] = edge.points[index - 1]!;
      const [x2, y2] = edge.points[index]!;
      if (Math.abs(y1 - y2) < 0.01) horizontal.push([Math.min(x1, x2), Math.max(x1, x2), y1]);
      else vertical.push([Math.min(y1, y2), Math.max(y1, y2), x1]);
    }
    return { horizontal, vertical };
  });
  let count = 0;
  for (let a = 0; a < runs.length; a++)
    for (let b = 0; b < runs.length; b++) {
      if (a === b) continue;
      for (const [x1, x2, y] of runs[a]!.horizontal) for (const [y1, y2, x] of runs[b]!.vertical) if (x > x1 + 0.5 && x < x2 - 0.5 && y > y1 + 0.5 && y < y2 - 0.5) count += 1;
    }
  return count;
}
