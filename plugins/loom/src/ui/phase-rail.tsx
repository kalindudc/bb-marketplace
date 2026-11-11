// The phase rail, the spine of every project view: each phase a card with its number, title, ticket bar and one count.
// A closed phase is closed, never "complete": its bar keeps done and cut tickets apart, and its count says both. An
// unphased project has one card per repo instead.
import { useLayoutEffect, useRef } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { BoardCard, ProjectView } from "../contract";
import type { PhaseView } from "../phases";
import { TapTip, sidewaysInto } from "./kit";
import { threadOf, TicketBar, TicketKey, ticketsLabel, type Thread } from "./ticket-bar";

export interface RailCard {
  id: string;
  /** 1-based; null for a repo card. */
  number: number | null;
  title: string;
  state: "planned" | "proposed" | "active" | "closed" | "repo";
  threads: Thread[];
  done: number;
  cancelled: number;
  /** Tickets counted against: the phase's tickets, or its budget while planned. */
  total: number;
  max: number;
}

const counts = (cards: readonly BoardCard[]) => ({ done: cards.filter((card) => card.state === "done").length, cancelled: cards.filter((card) => card.state === "cancelled").length });

/** The rail's cards: one per phase, or one per repo (one in all on a single-repo project) when the spec has no phases. */
export function railOf(view: Pick<ProjectView, "phases" | "board" | "overview">, proposed: { ref: string; count: number } | null = null): RailCard[] {
  const { phases, board, overview } = view;
  if (phases !== null) return phases.map((phase, index) => phaseCard(phase, index, board, proposed));
  const names = overview.repos.flatMap((repo) => (repo.name === null ? [] : [repo.name]));
  const groups = names.length === 0 ? [{ id: "all", title: overview.repos[0]?.bbProjectName ?? "All tickets", cards: board }] : names.map((name) => ({ id: name, title: name, cards: board.filter((card) => card.repo === name) }));
  return groups.map((group) => {
    const { done, cancelled } = counts(group.cards);
    return { id: group.id, number: null, title: group.title, state: "repo", threads: group.cards.map((card) => threadOf(card.state)), done, cancelled, total: group.cards.length, max: group.cards.length };
  });
}

function phaseCard(phase: PhaseView, index: number, board: readonly BoardCard[], proposed: { ref: string; count: number } | null): RailCard {
  const cards = board.filter((card) => card.phase === phase.ref);
  const base = { id: phase.ref, number: index + 1, title: phase.title, max: phase.maxTickets };
  if (phase.state === "planned") {
    if (proposed !== null && proposed.ref === phase.ref) return { ...base, state: "proposed", threads: Array.from({ length: proposed.count }, () => "proposed" as const), done: 0, cancelled: 0, total: proposed.count };
    return { ...base, state: "planned", threads: Array.from({ length: phase.maxTickets }, () => "planned" as const), done: 0, cancelled: 0, total: phase.maxTickets };
  }
  const threads = cards.length > 0 ? cards.map((card) => threadOf(card.state)) : [...Array<Thread>(phase.tickets.done).fill("done"), ...Array<Thread>(phase.tickets.cancelled).fill("cut"), ...Array<Thread>(phase.tickets.open).fill("open")];
  return { ...base, state: phase.state === "done" ? "closed" : "active", threads, done: phase.tickets.done, cancelled: phase.tickets.cancelled, total: phase.tickets.total };
}

/** "7 done · 1 cancelled", "closed: 0 done, 8 cancelled": a card's counts in words, as its label and tooltip say them. */
export function cardWords(card: RailCard): string {
  const cut = card.cancelled > 0 ? ` · ${card.cancelled} cancelled` : "";
  switch (card.state) {
    case "planned":
      return `planned · up to ${card.max} tickets`;
    case "proposed":
      return `proposed · ${card.total} of ${card.max} tickets`;
    case "closed":
      return `closed · ${card.done} done${cut}`;
    case "active":
      return `active · ${card.done} of ${card.total} done${cut}`;
    case "repo":
      return `${card.done} of ${card.total} done${cut}`;
  }
}

/** A phase's state as a mark drawn in CSS: a lit dot while active, a neutral ring with a dot once closed (never a success
 * tick, as a closed phase may have cut tickets), a dashed ring while planned or proposed. */
export function PhaseMark({ state }: { state: RailCard["state"] }) {
  if (state === "repo") return null;
  if (state === "active") return <span aria-hidden data-phase-mark="active" className="inline-block size-1.5 shrink-0 rounded-full bg-primary" />;
  if (state === "closed")
    return (
      <span aria-hidden data-phase-mark="closed" className="relative inline-block size-2.5 shrink-0 rounded-full border border-current">
        <span className="absolute inset-[2px] rounded-full bg-current" />
      </span>
    );
  return <span aria-hidden data-phase-mark={state} className={`inline-block size-2.5 shrink-0 rounded-full border border-dashed ${state === "proposed" ? "border-[var(--attention)]" : "border-current"}`} />;
}

const STATE_CHIP: Record<RailCard["state"], { word: string; className: string } | null> = {
  active: { word: "Active", className: "border-primary/60 text-foreground" },
  closed: { word: "Closed", className: "border-[var(--loom-line)] text-[var(--loom-muted)]" },
  planned: { word: "Planned", className: "border-dashed border-[var(--loom-line)] text-[var(--loom-muted)]" },
  proposed: { word: "Proposed", className: "border-dashed border-[var(--attention)] text-foreground" },
  repo: null,
};

function Count({ card }: { card: RailCard }) {
  if (card.state === "planned")
    return (
      <span className="loom-num text-[22px] leading-none font-semibold text-[var(--loom-muted)]">
        ≤{card.max}
      </span>
    );
  // Done over every ticket, with the cut ones said apart: a closed phase with one cancelled is 7/8 and 1 cut, never 8/8.
  const shown = card.state === "proposed" ? card.total : card.done;
  const of = card.state === "proposed" ? card.max : card.total;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="loom-num whitespace-nowrap text-[26px] leading-[1.15] font-extrabold tracking-tight">
        {shown}
        <small className="text-[14px] font-semibold tracking-normal text-[var(--loom-muted)]">/{of}</small>
      </span>
      {card.cancelled > 0 && <span className="loom-num mt-0.5 whitespace-nowrap text-[11px] leading-tight text-[var(--loom-muted)]">{card.cancelled} cut</span>}
    </span>
  );
}

function Card({ card, current, onPick }: { card: RailCard; current: boolean; onPick(card: RailCard): void }) {
  const chip = STATE_CHIP[card.state];
  const name = card.number === null ? card.title : `Phase ${card.number}, ${card.title}`;
  // The active title shows whole, so a long one takes a wider share of the row instead of more lines.
  const flex = Math.max(card.max, 4) * (current ? Math.max(1.5, card.title.length / 20) : 1);
  const titleWhole = current;
  return (
    <TapTip
      label={name}
      action={{ label: "Open Work", run: () => onPick(card) }}
      text={
        <span className="grid gap-1">
          <span>
            <b>{name}</b> · {cardWords(card)}
          </span>
          {card.state !== "planned" && <TicketKey threads={card.threads} />}
        </span>
      }
    >
      <button
        type="button"
        data-phase={card.number === null ? undefined : card.id}
        data-rail-card={card.id}
        data-rail-state={card.state}
        aria-current={current ? "true" : undefined}
        aria-label={`${name}: ${cardWords(card)}`}
        onClick={() => onPick(card)}
        style={{ flexGrow: flex, flexBasis: 0 }}
        data-on={current ? "true" : undefined}
        data-att={card.state === "proposed" ? "true" : undefined}
        className={`loom-selvedge group @container/card relative grid min-w-[9.5rem] cursor-pointer gap-1.5 py-2 pl-[14px] pr-3 text-left transition-transform duration-150 ease-out hover:-translate-y-px @max-xl/loom:shrink-0 ${titleWhole ? "@max-xl/loom:min-w-[16rem]" : ""} ${card.state === "planned" || card.state === "proposed" ? "border border-dashed border-[var(--loom-line)] bg-transparent" : `loom-card ${current ? "loom-lit" : ""}`}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {card.number === null ? <Icon name="FolderGit" aria-hidden className="size-3.5 shrink-0 text-[var(--loom-muted)]" /> : <span className="loom-num shrink-0 text-[15px] font-extrabold">{card.number}</span>}
          <span data-rail-title className={`min-w-0 text-[13px] font-semibold ${titleWhole ? "[overflow-wrap:anywhere]" : "truncate"}`}>{card.title}</span>
          {chip !== null && (
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-[18px] @max-3xl/loom:hidden ${chip.className}`}>
              <PhaseMark state={card.state} />
              {/* A narrow card keeps its title and says its state with the mark alone; the words are in its name and tip. */}
              <span className="@max-[15rem]/card:hidden">{current || card.state !== "active" ? chip.word : ""}</span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-end justify-between gap-3">
          <TicketBar threads={card.threads} height={8} label={ticketsLabel(card.threads)} className="mb-1.5 flex-1" />
          <span className="shrink-0">
            <Count card={card} />
          </span>
        </span>
      </button>
    </TapTip>
  );
}

/** Which card the page is on: the active phase, or the proposed one while the gate is open; no repo card is current. */
export function PhaseRail({ cards, currentId, onPick, label }: { cards: readonly RailCard[]; currentId: string | null; onPick(card: RailCard): void; label: string }) {
  const rail = useRef<HTMLElement>(null);
  // On a phone the rail scrolls sideways; the phase at work is brought into view, as the chosen view is in its row.
  useLayoutEffect(() => {
    const element = rail.current;
    const current = [...(element?.querySelectorAll<HTMLElement>("[data-rail-card]") ?? [])].find((card) => card.dataset.railCard === currentId);
    if (element == null || current == null || element.scrollWidth <= element.clientWidth) return;
    const left = sidewaysInto(element.getBoundingClientRect(), current.getBoundingClientRect(), element.scrollLeft);
    if (left !== null) element.scrollLeft = left;
  }, [currentId, cards.length]);
  if (cards.length === 0) return null;
  return (
    <nav ref={rail} aria-label={label} data-phase-rail className="flex flex-wrap gap-2.5 @max-xl/loom:-mx-1 @max-xl/loom:flex-nowrap @max-xl/loom:overflow-x-auto @max-xl/loom:px-1 @max-xl/loom:pb-1.5 @max-xl/loom:pt-1">
      {cards.map((card) => (
        <Card key={card.id} card={card} current={card.id === currentId} onPick={onPick} />
      ))}
    </nav>
  );
}
