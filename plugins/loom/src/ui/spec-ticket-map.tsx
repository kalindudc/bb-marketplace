import { useMemo, useState } from "react";
import type { TicketSpec } from "../spec";
import { dependencyChain, wavesOf } from "../spec-paths";
import { plural } from "./common";

const WIDTH = 168;
const HEIGHT = 58;
const GAP_X = 36;
const GAP_Y = 10;
const TOP = 28;
const PAD = 12;
export const PRIORITY_COLOURS = ["bg-destructive-text", "bg-warning", "bg-primary", "bg-subtle-foreground"];

export type TicketMark = "new" | "changed" | "same" | null;

/** The tickets of each wave in rows that follow their dependencies: each ticket sits near the average row of the tickets it waits for. */
function layout(tickets: readonly TicketSpec[]) {
  const waves = wavesOf(tickets);
  const columns: string[][] = [];
  for (const ticket of tickets) (columns[waves[ticket.ref]!] ??= []).push(ticket.ref);
  const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket]));
  const ancestors = new Map<string, Set<string>>();
  const above = (ref: string): Set<string> => {
    const known = ancestors.get(ref);
    if (known !== undefined) return known;
    const set = new Set(dependencyChain(tickets, ref).up);
    ancestors.set(ref, set);
    return set;
  };
  // An arrow another path already implies is left off, so a ticket that waits for everything does not fan in ten arrows.
  const shown = new Map(
    tickets.map((ticket) => {
      const deps = ticket.depends_on.filter((dep) => byRef.has(dep));
      return [ticket.ref, deps.filter((dep) => !deps.some((other) => other !== dep && above(other).has(dep)))];
    }),
  );
  const row = new Map<string, number>();
  columns.forEach((column, wave) => {
    if (wave > 0) {
      const centre = (ref: string) => {
        const deps = shown.get(ref)!;
        return deps.length === 0 ? 0 : deps.reduce((sum, dep) => sum + row.get(dep)!, 0) / deps.length;
      };
      column.sort((a, b) => centre(a) - centre(b));
    }
    column.forEach((ref, index) => row.set(ref, index));
  });
  const rows = Math.max(...columns.map((column) => column.length));
  const at = new Map<string, { x: number; y: number }>();
  columns.forEach((column, wave) => {
    const offset = ((rows - column.length) * (HEIGHT + GAP_Y)) / 2;
    column.forEach((ref, index) => at.set(ref, { x: PAD + wave * (WIDTH + GAP_X), y: TOP + offset + index * (HEIGHT + GAP_Y) }));
  });
  const width = PAD * 2 + columns.length * WIDTH + (columns.length - 1) * GAP_X;
  const height = TOP + rows * HEIGHT + (rows - 1) * GAP_Y + PAD;
  const edges = tickets.flatMap((ticket) => shown.get(ticket.ref)!.map((dep) => ({ from: dep, to: ticket.ref })));
  return { columns, at, width, height, edges };
}

/**
 * The tickets as a map of their waves from left to right, with an arrow from each ticket to the ones that wait for it.
 * Hovering a ticket lights up what it waits for and what it unblocks; clicking it picks it. `fadedOf` names the tickets
 * the filter would hide.
 */
export function TicketMap({ tickets, selected, onSelect, markOf, pinsOf, fadedOf }: { tickets: readonly TicketSpec[]; selected: string | null; onSelect(ref: string): void; markOf(ref: string): TicketMark; pinsOf(ref: string): number; fadedOf(ref: string): boolean }) {
  const map = useMemo(() => layout(tickets), [tickets]);
  const [hovered, setHovered] = useState<string | null>(null);
  const chain = useMemo(() => {
    if (hovered === null) return null;
    const { up, down } = dependencyChain(tickets, hovered);
    return new Set([hovered, ...up, ...down]);
  }, [tickets, hovered]);
  const byRef = new Map(tickets.map((ticket) => [ticket.ref, ticket]));

  return (
    <div data-ticket-map className="overflow-x-auto rounded-lg border border-border-seam bg-card">
      <div className="relative" style={{ width: map.width, height: map.height }}>
        <svg aria-hidden width={map.width} height={map.height} className="pointer-events-none absolute inset-0 text-subtle-foreground">
          <defs>
            <marker id="loom-map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {map.edges.map(({ from, to }) => {
            const a = map.at.get(from)!;
            const b = map.at.get(to)!;
            const x1 = a.x + WIDTH;
            const y1 = a.y + HEIGHT / 2;
            const x2 = b.x - 3;
            const y2 = b.y + HEIGHT / 2;
            const bend = (x2 - x1) / 2;
            const lit = chain !== null && chain.has(from) && chain.has(to);
            return (
              <path
                key={`${from}>${to}`}
                data-edge={`${from}>${to}`}
                d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={lit ? 1.8 : 1.2}
                markerEnd="url(#loom-map-arrow)"
                className={lit ? "text-primary" : ""}
                opacity={chain === null ? 0.6 : lit ? 1 : 0.15}
              />
            );
          })}
        </svg>
        {map.columns.map((column, wave) => (
          <span key={wave} className="absolute top-2 text-[11px] font-semibold text-muted-foreground" style={{ left: PAD + wave * (WIDTH + GAP_X) }}>
            Wave {wave + 1} <span className="font-normal text-subtle-foreground">· {wave === 0 ? "starts at once" : plural(column.length, "ticket")}</span>
          </span>
        ))}
        {[...map.at].map(([ref, { x, y }]) => {
          const ticket = byRef.get(ref)!;
          const mark = markOf(ref);
          const pins = pinsOf(ref);
          const dim = chain !== null ? !chain.has(ref) : fadedOf(ref);
          return (
            <button
              key={ref}
              type="button"
              data-map-node={ref}
              data-mark={mark ?? undefined}
              aria-pressed={ref === selected}
              onClick={() => onSelect(ref)}
              onMouseEnter={() => setHovered(ref)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(ref)}
              onBlur={() => setHovered(null)}
              style={{ left: x, top: y, width: WIDTH, height: HEIGHT }}
              className={`absolute flex cursor-pointer flex-col justify-center overflow-hidden rounded-lg border bg-card py-1 pr-2 pl-3 text-left transition-opacity ${dim ? "opacity-35" : ""} ${
                mark === "new" ? "border-success ring-2 ring-success" : mark === "changed" ? "border-primary ring-2 ring-primary" : ref === selected ? "border-primary ring-1 ring-primary" : "border-border-seam hover:bg-state-hover"
              }`}
            >
              <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${PRIORITY_COLOURS[ticket.priority] ?? "bg-border-seam"}`} />
              <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <span className="truncate">{ref}</span>
                {mark === "new" && <span className="ml-auto rounded bg-success px-1 font-sans text-[9.5px] font-bold text-success-foreground">NEW</span>}
                {pins > 0 && <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 font-sans text-[10px] font-semibold text-black">{pins}</span>}
              </span>
              <span className="line-clamp-2 text-xs leading-tight">{ticket.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
