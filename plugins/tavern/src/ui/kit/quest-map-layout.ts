import type { BoardQuestSummary } from "../../shared/contract";
import { settled } from "../../shared/waypoint";

type Waypoint = BoardQuestSummary["waypoints"][number];
export type MapStep = Pick<Waypoint, "id" | "actor" | "state" | "dependsOn" | "askId">;
const MIN_CARD_WIDTH = 156;
export const PORT_Y = 18;
const CREST_RADIUS = 12;
const GAP = 12;
const PAD = 6;
const GUTTER = 48;
const LEFT = PAD + CREST_RADIUS;
const TRAIL_SPINE = 8;
const TRAIL_DOT = 5;

type Road = { from: string; to: string; walked: boolean; lit: boolean };
type Link = Road & { chain: number[] };
type Box = { x: number; y: number; width: number; height: number };
type Layout = { width: number; height: number; cards: Map<string, Box>; roads: (Road & { path: string })[]; dots: { id: string; x: number; y: number }[] };
type ColumnItem = { column: number; id?: string; preds: number[]; succs: number[] };

function levels(waypoints: readonly MapStep[]) {
  const result = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(waypoints.map(w => [w.id, w]));
  function level(id: string): number {
    const known = result.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`Quest map has a dependency cycle at ${id}`);
    const waypoint = byId.get(id);
    if (!waypoint) throw new Error(`Quest map references missing waypoint ${id}`);
    visiting.add(id);
    const n = waypoint.dependsOn.length ? Math.max(...waypoint.dependsOn.map(level)) + 1 : 0;
    visiting.delete(id);
    result.set(id, n);
    return n;
  }
  waypoints.forEach(w => level(w.id));
  return result;
}

export function orderWaypoints(waypoints: Waypoint[]) {
  const columns = levels(waypoints);
  return [...waypoints].sort((a, b) => columns.get(a.id)! - columns.get(b.id)!);
}

export function layoutWaypoints(waypoints: Waypoint[], laneGap = 96) {
  const columns = levels(waypoints);
  const lanes = new Map<number, number>();
  return waypoints.map(waypoint => {
    const column = columns.get(waypoint.id)!, lane = lanes.get(column) ?? 0;
    lanes.set(column, lane + 1);
    return { waypoint, column, lane, x: 62 + column * 132, y: 22 + lane * laneGap };
  });
}

function orderColumns(columns: number[][], items: ColumnItem[]) {
  const ranks = () => {
    const positions: number[] = [];
    for (const column of columns) column.forEach((item, rank) => { positions[item] = rank; });
    return positions;
  };
  const crossings = () => {
    const rank = ranks();
    let count = 0;
    for (const column of columns) for (const [i, item] of column.entries()) {
      for (let j = i + 1; j < column.length; j++) {
        for (const a of items[item]!.succs) for (const b of items[column[j]!]!.succs) if (rank[a]! > rank[b]!) count++;
      }
    }
    return count;
  };
  let best = columns.map(col => [...col]), score = crossings();
  while (score > 0) {
    const before = score;
    for (const down of [true, false]) {
      const sweep = down ? columns.slice(1) : columns.slice(0, -1).reverse();
      for (const column of sweep) {
        const rank = ranks();
        const center = new Map(column.map((item, i) => {
          const neighbors = items[item]![down ? "preds" : "succs"];
          return [item, neighbors.length ? neighbors.reduce((sum, n) => sum + rank[n]!, 0) / neighbors.length : i];
        }));
        column.sort((a, b) => center.get(a)! - center.get(b)!);
      }
      let count = crossings();
      for (const column of columns) for (let i = 1; i < column.length && count > 0; i++) {
        [column[i - 1], column[i]] = [column[i]!, column[i - 1]!];
        const swapped = crossings();
        if (swapped < count) count = swapped;
        else [column[i - 1], column[i]] = [column[i]!, column[i - 1]!];
      }
      if (count < score) { best = columns.map(col => [...col]); score = count; }
      if (score === 0) return best;
    }
    if (score === before) break;
  }
  return best;
}

function longestUnfinished(columns: readonly number[][], steps: readonly MapStep[], next: readonly Link[][], needsYou: ReadonlySet<string>) {
  const longest = new Map<number, string[]>();
  for (const i of columns.flat().reverse()) {
    const w = steps[i];
    if (!w || settled(w)) continue;
    let tail: string[] = [];
    for (const link of next[i]!) {
      const candidate = longest.get(link.chain.at(-1)!);
      if (candidate && candidate.length > tail.length) tail = candidate;
    }
    longest.set(i, [w.id, ...tail]);
  }
  const rank = (w: MapStep) => needsYou.has(w.id) ? 4 : w.state === "blocked" ? 3 : w.state === "rejected" ? 2 : w.state === "doing" ? 1 : 0;
  let lit: string[] = [], headRank = -1;
  steps.forEach((step, i) => {
    const chain = longest.get(i);
    if (chain && (chain.length > lit.length || (chain.length === lit.length && rank(step) > headRank))) {
      lit = chain;
      headRank = rank(step);
    }
  });
  return lit;
}

export function buildQuestGraph(steps: readonly MapStep[], live = true) {
  const depth = levels(steps);
  const byId = new Map(steps.map(w => [w.id, w]));
  const needsYou = new Set(steps.filter(w => !settled(w) && (w.askId || (live && w.actor === "user" && w.dependsOn.every(p => settled(byId.get(p)!))))).map(w => w.id));
  const items: ColumnItem[] = steps.map(w => ({ column: depth.get(w.id)!, id: w.id, preds: [], succs: [] }));
  const columns = Array.from({ length: Math.max(-1, ...depth.values()) + 1 }, (): number[] => []);
  const byIndex = new Map(steps.map((w, i) => [w.id, i]));
  items.forEach((item, i) => columns[item.column]!.push(i));
  const next = steps.map((): Link[] => []);
  const links: Link[] = steps.flatMap((w, target) => w.dependsOn.map(from => {
    const source = byIndex.get(from)!;
    const chain = [source];
    for (let col = depth.get(from)! + 1; col < depth.get(w.id)!; col++) {
      chain.push(items.length);
      columns[col]!.push(items.length);
      items.push({ column: col, preds: [], succs: [] });
    }
    chain.push(target);
    chain.slice(1).forEach((b, i) => { const a = chain[i]!; items[a]!.succs.push(b); items[b]!.preds.push(a); });
    const link = { from, to: w.id, chain, walked: settled(w), lit: false };
    next[source]!.push(link);
    return link;
  }));
  const lit = longestUnfinished(columns, steps, next, needsYou);
  const litNext = new Map(lit.slice(1).map((id, i) => [lit[i]!, id]));
  links.forEach(link => { link.lit = litNext.get(link.from) === link.to; });
  return { steps, items, columns: orderColumns(columns, items), links, needsYou, lit };
}

type Graph = ReturnType<typeof buildQuestGraph>;
const median = (a: number[]) => { a.sort((x, y) => x - y); return a.length ? (a[Math.floor((a.length - 1) / 2)]! + a[Math.floor(a.length / 2)]!) / 2 : 0; };
const cardHeight = (heights: ReadonlyMap<string, number>, id: string) => heights.get(id) ?? 84;

const gutterSpace = (columns: number) => LEFT + PAD + Math.max(0, columns - 1) * GUTTER;

export function gutterFits(graph: Graph, available: number) {
  const columns = graph.columns.length;
  return columns === 0 || columns * MIN_CARD_WIDTH + gutterSpace(columns) <= available;
}

export function gutterLayout(graph: Graph, heights: ReadonlyMap<string, number>, available: number, stretch = false): Layout {
  const { columns, items, links } = graph;
  const cards = new Map<string, Box>();
  if (!columns.length) return { width: 0, height: 0, cards, roads: [], dots: [] };
  const space = gutterSpace(columns.length);
  const cardWidth = Math.max(MIN_CARD_WIDTH, Math.min(stretch ? 300 : 280, Math.floor((available - space) / columns.length)));
  const width = columns.length * cardWidth + space;
  const x = (col: number) => LEFT + col * (cardWidth + GUTTER);
  const y: number[] = [];
  const heightOf = (i: number) => items[i]!.id === undefined ? GAP : cardHeight(heights, items[i]!.id!);
  const port = (i: number) => y[i]! + (items[i]!.id === undefined ? GAP / 2 : PORT_Y);
  const sizes = columns.map(col => col.reduce((top, i) => { y[i] = top; return top + heightOf(i) + GAP; }, PAD) - GAP + PAD);
  const height = Math.max(...sizes);
  for (const [col, ids] of columns.entries()) {
    // Shift the packed column as a block so that aligning ports never closes a long edge's channel.
    const shift = Math.max(0, Math.min(height - sizes[col]!, median(ids.filter(i => items[i]!.preds.length).map(i => median(items[i]!.preds.map(port)) - port(i)))));
    for (const i of ids) {
      y[i]! += shift;
      const id = items[i]!.id;
      if (id !== undefined) cards.set(id, { x: x(col), y: y[i]!, width: cardWidth, height: heightOf(i) });
    }
  }
  const roads = links.map(({ chain, ...road }) => {
    const path = chain.slice(1).reduce((d, b, i) => {
      const a = chain[i]!, start = x(items[a]!.column) + cardWidth, edge = x(items[b]!.column);
      // All cubics in a gutter have the same x coordinates; changing their lengths could cross otherwise ordered roads.
      const end = edge - CREST_RADIUS + 2, mid = (start + end) / 2, y1 = port(a), y2 = port(b);
      return d + (i === 0 ? `M${start} ${y1}` : "") + `C${mid} ${y1} ${mid} ${y2} ${end} ${y2}` + (items[b]!.id === undefined ? `H${edge + cardWidth}` : "");
    }, "");
    return { ...road, path };
  });
  const dots = [...new Set(links.map(link => link.from))].map(id => { const card = cards.get(id)!; return { id, x: card.x + card.width, y: card.y + PORT_Y }; });
  return { width, height, cards, roads, dots };
}

export function trailLayout(graph: Graph, heights: ReadonlyMap<string, number>, width: number): Layout {
  const { steps, links, needsYou } = graph;
  const row = new Map<string, number>();
  while (row.size < steps.length) {
    const ready = steps.filter(w => !row.has(w.id) && w.dependsOn.every(p => row.has(p)));
    const last = (w: MapStep) => Math.max(-1, ...w.dependsOn.map(p => row.get(p)!));
    ready.sort((a, b) => Number(needsYou.has(b.id)) - Number(needsYou.has(a.id)) || last(b) - last(a));
    row.set(ready[0]!.id, row.size);
  }
  const loops = links.filter(l => row.get(l.to)! - row.get(l.from)! > 1);
  const groupBy = (roads: Link[], port: "from" | "to") => {
    const groups = new Map<string, Link[]>();
    for (const road of roads) {
      const group = groups.get(road[port]);
      if (group) group.push(road);
      else groups.set(road[port], [road]);
    }
    return groups;
  };
  const bySource = groupBy(loops, "from");
  const forks = [...bySource.values()].filter(group => group.length > 1);
  const joins = groupBy(loops.filter(l => bySource.get(l.from)!.length === 1), "to");
  const buses = [...forks, ...joins.values()].map(edges => ({ edges, first: Math.min(...edges.map(l => row.get(l.from)!)), last: Math.max(...edges.map(l => row.get(l.to)!)) }));
  const occupied: typeof buses[] = [];
  const lane = new Map<Link, number>();
  // Put shorter loops inside longer ones; non-overlapping loops can share a track.
  buses.sort((a, b) => (a.last - a.first) - (b.last - b.first) || a.first - b.first);
  for (const bus of buses) {
    const free = occupied.findIndex(others => others.every(o => o.last <= bus.first || o.first >= bus.last));
    const i = free < 0 ? occupied.length : free;
    (occupied[i] ??= []).push(bus);
    bus.edges.forEach(l => lane.set(l, i));
  }
  const pitch = Math.min(12, width / 4 / Math.max(1, occupied.length));
  const x = TRAIL_SPINE + TRAIL_DOT + PAD + occupied.length * pitch + PAD;
  const cards = new Map<string, Box>();
  let y = PAD;
  for (const id of row.keys()) { const height = cardHeight(heights, id); cards.set(id, { x, y, width: width - x - PAD, height }); y += height + GAP; }
  const port = (id: string) => cards.get(id)!.y + PORT_Y;
  const roads = links.map(link => {
    const { chain: _, ...road } = link;
    const y1 = port(road.from), y2 = port(road.to), track = lane.get(link);
    if (track === undefined) return { ...road, path: `M${TRAIL_SPINE} ${y1 + TRAIL_DOT}V${y2 - TRAIL_DOT}` };
    const start = TRAIL_SPINE + TRAIL_DOT, turn = start + PAD + (track + 1) * pitch, r = Math.min(12, (turn - start) * .55);
    return { ...road, path: `M${start} ${y1}H${turn - r}C${turn} ${y1} ${turn} ${y1} ${turn} ${y1 + r}V${y2 - r}C${turn} ${y2} ${turn} ${y2} ${turn - r} ${y2}H${start}` };
  });
  return { width, height: y - GAP + PAD, cards, roads, dots: [...row.keys()].map(id => ({ id, x: TRAIL_SPINE, y: port(id) })) };
}
