import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BoardCard } from "../contract";
import { formatDuration } from "../format";
import type { TicketState } from "../states";
import { HEADING, RepoChip, plural } from "./common";

interface Lane {
  id: TicketState;
  title: string;
  states: readonly TicketState[];
  collapsed?: boolean;
}

const LANES: readonly Lane[] = [
  { id: "queued", title: "Queued", states: ["queued"] },
  { id: "working", title: "Working", states: ["working"] },
  { id: "checking", title: "Checking", states: ["checking"] },
  { id: "review", title: "Review", states: ["review"] },
  { id: "approved", title: "Approved and merging", states: ["approved", "merging"] },
  { id: "pr_open", title: "PR open", states: ["pr_open"] },
  { id: "done", title: "Done", states: ["done"] },
  { id: "blocked", title: "Blocked", states: ["blocked"] },
  { id: "cancelled", title: "Cancelled", states: ["cancelled"], collapsed: true },
];

const LINK = "cursor-pointer rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function DraftCard({ card }: { card: BoardCard }) {
  return (
    <div data-card={card.key} data-draft className="rounded-md border border-dashed border-border-seam p-2.5">
      <span className="text-xs font-medium text-muted-foreground">{card.key} · draft</span>
      {card.repo !== null && <RepoChip name={card.repo} className="ml-1.5" />}
      <span className="mt-0.5 block text-sm">{card.title}</span>
      {!card.ready && card.waitingOn.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Waits on {card.waitingOn.join(", ")}</p>}
    </div>
  );
}

function Card({ slug, card, now, draft, onChanges }: { slug: string; card: BoardCard; now: number; draft: boolean; onChanges?: (key: string) => void }) {
  const navigate = useBbNavigate();
  if (draft) return <DraftCard card={card} />;
  const detail = [`${formatDuration(Math.max(0, now - card.stateAt))} in ${card.state.replace("_", " ")}`, card.attempt > 0 ? `attempt ${card.attempt}` : null, card.reviewRound > 0 ? `round ${card.reviewRound}` : null].filter((part) => part !== null);
  return (
    <div data-card={card.key} className="rounded-md border border-border-seam p-2.5">
      <button type="button" data-open-ticket onClick={() => navigate.toPluginPanel("loom", { subPath: `${slug}/${card.key}` })} className="block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="text-xs font-medium text-muted-foreground">{card.key}</span>
        {card.repo !== null && <RepoChip name={card.repo} className="ml-1.5" />}
        <span className="mt-0.5 block text-sm">{card.title}</span>
      </button>
      <p className="mt-1 text-xs text-muted-foreground">{detail.join(" · ")}</p>
      {card.state === "queued" && !card.ready && card.waitingOn.length > 0 && <p className="mt-1 text-xs text-warning-text">Waiting on {card.waitingOn.join(", ")}</p>}
      {card.state === "blocked" && card.blockedReason !== null && <p className="mt-1 text-xs text-destructive-text">{card.blockedReason}</p>}
      <div className="mt-1.5 flex flex-wrap gap-3">
        {card.threadId !== null && (
          <button type="button" aria-label={`Open thread for ${card.key}`} onClick={() => navigate.toThread(card.threadId!)} className={LINK}>
            Thread
          </button>
        )}
        {card.hasChanges && onChanges !== undefined && (
          <button type="button" aria-label={`Show the changes of ${card.key}`} onClick={() => onChanges(card.key)} className={LINK}>
            Changes
          </button>
        )}
        {card.prUrl !== null && (
          <button type="button" aria-label={`Open the pull request for ${card.key}`} onClick={() => navigate.openUrl(card.prUrl!)} className={LINK}>
            Pull request
          </button>
        )}
      </div>
    </div>
  );
}

type CardProps = { slug: string; now: number; draft: boolean; onChanges?: (key: string) => void };

function QueueGroup({ id, title, cards, ...rest }: { id: string; title: string; cards: BoardCard[] } & CardProps) {
  if (cards.length === 0) return null;
  return (
    <div data-queue-group={id} className="space-y-2">
      <h4 className={HEADING}>{title}</h4>
      {cards.map((card) => (
        <Card key={card.key} card={card} {...rest} />
      ))}
    </div>
  );
}

function LaneColumn({ lane, cards, ...rest }: { lane: Lane; cards: BoardCard[] } & CardProps) {
  const [open, setOpen] = useState(lane.collapsed !== true);
  return (
    <section data-lane={lane.id} className="flex w-64 shrink-0 flex-col gap-2">
      <h3>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span className={HEADING}>{lane.title}</span>
          <span className="text-xs text-muted-foreground">{cards.length}</span>
        </button>
      </h3>
      {open && lane.id === "queued" && (
        <div className="space-y-3">
          <QueueGroup id="ready" title="Ready" cards={cards.filter((card) => card.ready)} {...rest} />
          <QueueGroup id="waiting" title="Waiting" cards={cards.filter((card) => !card.ready)} {...rest} />
        </div>
      )}
      {open && lane.id !== "queued" && (
        <div className="space-y-2">
          {cards.map((card) => (
            <Card key={card.key} card={card} {...rest} />
          ))}
        </div>
      )}
    </section>
  );
}

/** `draftVersion` is set before approval: the cards are the draft's tickets, not yet on the board. */
export function Board({ slug, cards, strategy, now, draftVersion, onChanges }: { slug: string; cards: BoardCard[]; strategy: "integration" | "pr"; now: number; draftVersion: number | null; onChanges?: (key: string) => void }) {
  const draft = draftVersion !== null;
  return (
    <div>
      {draft && (
        <p data-draft-note className="mx-4 mt-4 rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
          Draft v{draftVersion}: {cards.length === 1 ? "approving creates this ticket. Its dashed card is" : `approving creates these ${plural(cards.length, "ticket")}. Dashed cards are`} not on the board yet.
        </p>
      )}
      <div data-board={slug} className="flex items-start gap-3 overflow-x-auto p-4">
        {LANES.filter((lane) => lane.id !== "pr_open" || strategy === "pr").map((lane) => (
          <LaneColumn key={lane.id} lane={lane} cards={cards.filter((card) => lane.states.includes(card.state))} slug={slug} now={now} draft={draft} onChanges={onChanges} />
        ))}
      </div>
    </div>
  );
}
