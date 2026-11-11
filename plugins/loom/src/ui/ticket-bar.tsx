// The ticket bar: a project's or a phase's tickets as one bar split by state, each block sized by its count, beside a
// count in numbers. It replaced a woven band of one thread per ticket, which could not be read at 30 tickets in a
// sidebar row. It encodes ticket outcomes and nothing else, and never stands without words: its label and the key in
// its tooltip say the same counts.
import type { TicketState } from "../states";

export type Thread = "done" | "shipping" | "flight" | "open" | "blocked" | "cut" | "planned" | "proposed";

const SHIPPING: readonly TicketState[] = ["approved", "merging", "pr_open"];
const FLIGHT: readonly TicketState[] = ["working", "checking", "review"];

export function threadOf(state: TicketState): Thread {
  if (state === "done") return "done";
  if (state === "cancelled") return "cut";
  if (state === "blocked") return "blocked";
  if (SHIPPING.includes(state)) return "shipping";
  if (FLIGHT.includes(state)) return "flight";
  return "open";
}

/** A project's tickets as threads, from its count of tickets in each state. */
export function threadsOfCounts(counts: Partial<Record<TicketState, number>>): Thread[] {
  return Object.entries(counts).flatMap(([state, count]) => Array<Thread>(count ?? 0).fill(threadOf(state as TicketState)));
}

// The board's progress bar's parts, in its order and tones, so the two bars read alike; cut tickets trail, apart.
const ORDER: readonly Thread[] = ["done", "shipping", "flight", "open", "blocked", "cut", "proposed", "planned"];
const WORDS: Record<Thread, string> = { done: "done", shipping: "shipping", flight: "in progress", open: "up next", blocked: "blocked", cut: "cancelled", proposed: "proposed", planned: "planned" };
const FILL: Record<Thread, string> = {
  done: "bg-success",
  shipping: "loom-ship",
  flight: "bg-timeline-accent",
  open: "bg-[var(--loom-mark-quiet)]",
  blocked: "bg-[var(--loom-mark-bad)]",
  cut: "loom-cut",
  proposed: "border border-dashed border-[var(--attention)]",
  planned: "border border-dashed border-[var(--loom-muted)]",
};

function countsOf(threads: readonly Thread[]): Array<[Thread, number]> {
  const counts = new Map<Thread, number>();
  for (const thread of threads) counts.set(thread, (counts.get(thread) ?? 0) + 1);
  return ORDER.flatMap((thread) => (counts.has(thread) ? [[thread, counts.get(thread)!] as [Thread, number]] : []));
}

/** "5 done · 2 shipping · 1 in progress · 2 up next · 1 blocked · 1 cancelled": what a bar draws, in words. */
export function ticketsLabel(threads: readonly Thread[]): string {
  const parts = countsOf(threads).map(([thread, count]) => `${count} ${WORDS[thread]}`);
  return parts.length === 0 ? "no tickets" : parts.join(" · ");
}

export function TicketBar({ threads, height = 6, label, className = "" }: { threads: readonly Thread[]; height?: number; label?: string; className?: string }) {
  const counts = countsOf(threads);
  return (
    <span role="img" aria-label={label ?? ticketsLabel(threads)} data-ticket-bar className={`flex min-w-0 gap-[2px] ${className}`} style={{ height }}>
      {counts.length === 0 ? (
        <span className="flex-1 rounded-[2px] bg-muted-foreground/15" />
      ) : (
        counts.map(([thread, count]) => <span key={thread} data-bar={thread} className={`rounded-[2px] ${FILL[thread]}`} style={{ flexGrow: count, flexBasis: 0, minWidth: 4 }} />)
      )}
    </span>
  );
}

/** The bar's colour key with each count, for its tooltip. */
export function TicketKey({ threads }: { threads: readonly Thread[] }) {
  const counts = countsOf(threads);
  if (counts.length === 0) return <span>no tickets yet</span>;
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
      {counts.map(([thread, count]) => (
        <span key={thread} className="inline-flex items-center gap-1 whitespace-nowrap">
          <span aria-hidden className={`inline-block size-2 rounded-[2px] ${FILL[thread]}`} />
          <span className="loom-num">{count}</span> {WORDS[thread]}
        </span>
      ))}
    </span>
  );
}
