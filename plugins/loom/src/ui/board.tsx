import { useState, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BoardCard } from "../contract";
import { formatDuration, mergeRetryText, startWaitText } from "../format";
import type { TicketState } from "../states";
import { HEADING, RepoChip, plural } from "./common";

// The board stacks a row per stage down the page, grouped by what the human does with it, so a large project grows
// downward instead of sideways. Cards wrap in a grid inside each row.
interface Row {
  id: TicketState;
  title: string;
  /** What the row holds, under its title. */
  hint: (strategy: "integration" | "pr") => string;
  states: readonly TicketState[];
}

interface Group {
  id: string;
  title: string;
  rows: readonly Row[];
}

const SHIPPING: Row = { id: "approved", title: "Shipping", hint: (strategy) => (strategy === "pr" ? "approved · merging · PR open" : "approved · merging"), states: ["approved", "merging", "pr_open"] };

const GROUPS: readonly Group[] = [
  {
    id: "progress",
    title: "In progress",
    rows: [
      { id: "working", title: "Working", hint: () => "a worker holds it", states: ["working"] },
      { id: "checking", title: "Checking", hint: () => "Loom runs the checks", states: ["checking"] },
      { id: "review", title: "Review", hint: () => "reviewers judge it", states: ["review"] },
      SHIPPING,
    ],
  },
];

const STATE_NAMES: Record<TicketState, string> = { queued: "queued", working: "working", checking: "checking", review: "review", approved: "approved", merging: "merging", pr_open: "PR open", done: "done", blocked: "blocked", cancelled: "cancelled" };
const STATE_TINTS: Partial<Record<TicketState, string>> = { approved: "bg-success/15 text-success-foreground", merging: "bg-success/15 text-success-foreground", pr_open: "bg-success/15 text-success-foreground" };

const LINK = "cursor-pointer rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2";
const COUNT = "text-xs font-normal normal-case tracking-normal text-muted-foreground";

function DraftCard({ card }: { card: BoardCard }) {
  return (
    <div data-card={card.key} data-draft className="min-w-0 rounded-md border border-dashed border-border-seam p-2.5">
      <span className="text-xs font-medium text-muted-foreground">{card.key} · draft</span>
      {card.repo !== null && <RepoChip name={card.repo} className="ml-1.5" />}
      <span className="mt-0.5 block text-sm">{card.title}</span>
      {!card.ready && card.waitingOn.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Waits on {card.waitingOn.join(", ")}</p>}
    </div>
  );
}

function Card({ slug, card, now, draft, onChanges, withState }: { card: BoardCard; withState: boolean } & CardProps) {
  const navigate = useBbNavigate();
  if (draft) return <DraftCard card={card} />;
  const detail = [`${formatDuration(Math.max(0, now - card.stateAt))} in ${STATE_NAMES[card.state]}`, card.attempt > 0 ? `attempt ${card.attempt}` : null, card.reviewRound > 0 ? `round ${card.reviewRound}` : null].filter((part) => part !== null);
  return (
    <div data-card={card.key} className="min-w-0 rounded-md border border-border-seam bg-card p-2.5">
      <button type="button" data-open-ticket onClick={() => navigate.toPluginPanel("loom", { subPath: `${slug}/${card.key}` })} className="block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="text-xs font-medium text-muted-foreground">{card.key}</span>
        {card.repo !== null && <RepoChip name={card.repo} className="ml-1.5" />}
        {withState && (
          <span data-card-state className={`ml-1.5 rounded-full px-1.5 text-[10.5px] font-semibold ${STATE_TINTS[card.state] ?? "bg-foreground/5 text-muted-foreground"}`}>
            {STATE_NAMES[card.state]}
          </span>
        )}
        <span className="mt-0.5 block text-sm [overflow-wrap:anywhere]">{card.title}</span>
      </button>
      <p className="mt-1 text-xs text-muted-foreground">{detail.join(" · ")}</p>
      {card.state === "queued" && !card.ready && card.waitingOn.length > 0 && <p className="mt-1 text-xs text-warning-text">Waiting on {card.waitingOn.join(", ")}</p>}
      {card.startWait !== null && <p data-start-wait className="mt-1 text-xs text-warning-text [overflow-wrap:anywhere]">{startWaitText(card.startWait, now)}</p>}
      {card.mergeWait !== null && <p data-merge-wait className="mt-1 text-xs text-warning-text [overflow-wrap:anywhere]">{mergeRetryText(card.mergeWait, now)}</p>}
      {card.stackedOn.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Stacked on {card.stackedOn.join(", ")}</p>}
      {card.holding !== null && <p className="mt-1 text-xs text-warning-text">{card.holding}</p>}
      {card.waitsForSlot && <p data-slot-wait className="mt-1 text-xs text-warning-text">Waits for a free worker slot</p>}
      {card.state === "blocked" && card.blockedReason !== null && <p className="mt-1 text-xs text-destructive-text [overflow-wrap:anywhere]">{card.blockedReason}</p>}
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

/** One stage: its title and what it holds on the left (above on a narrow page), its cards in a grid beside it. */
function StageRow({ id, title, hint, cards, attention = false, withState = false, lane = true, children, ...rest }: { id: string; title: string; hint?: string; cards: BoardCard[]; attention?: boolean; withState?: boolean; lane?: boolean; children?: ReactNode } & CardProps) {
  return (
    <section
      {...(lane ? { "data-lane": id } : { "data-row": id })}
      className={`grid gap-2 py-2.5 @2xl:grid-cols-[8.5rem_minmax(0,1fr)] @2xl:gap-3 ${attention ? "rounded-lg bg-destructive-text/5 px-3 shadow-[inset_3px_0_0_var(--destructive-text)]" : "border-t border-border-seam first:border-t-0"}`}
    >
      <div>
        <h3 className={`${HEADING} ${attention ? "text-destructive-text" : ""}`}>
          {title} <span className={COUNT}>{cards.length}</span>
        </h3>
        {hint !== undefined && <p className="mt-0.5 text-[11px] text-subtle-foreground">{hint}</p>}
      </div>
      {children ??
        (cards.length === 0 ? (
          <p className="text-xs text-muted-foreground">None</p>
        ) : (
          <div className={GRID}>
            {cards.map((card) => (
              <Card key={card.key} card={card} withState={withState} {...rest} />
            ))}
          </div>
        ))}
    </section>
  );
}

/** Done and cancelled fold to one line, which opens their cards. */
function FoldedRow({ id, title, cards, ...rest }: { id: TicketState; title: string; cards: BoardCard[] } & CardProps) {
  const [open, setOpen] = useState(false);
  return (
    <StageRow id={id} title={title} cards={cards} {...rest}>
      <div className="space-y-2">
        {cards.length === 0 ? (
          <p className="text-xs text-muted-foreground">None</p>
        ) : (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${LINK} text-left`}>
            {open ? "Hide" : "Show"} {plural(cards.length, `${title.toLowerCase()} ticket`)}
          </button>
        )}
        {open && (
          <div className={GRID}>
            {cards.map((card) => (
              <Card key={card.key} card={card} withState={false} {...rest} />
            ))}
          </div>
        )}
      </div>
    </StageRow>
  );
}

function GroupHeading({ title }: { title: string }) {
  return <h2 className="mt-4 text-xs font-semibold text-foreground first:mt-0">{title}</h2>;
}

/** How far the project is: done, shipping, in progress, up next and blocked as shares of one bar, with their counts. */
function Progress({ cards }: { cards: BoardCard[] }) {
  const count = (...states: TicketState[]) => cards.filter((card) => states.includes(card.state)).length;
  const parts = [
    { id: "done", label: "done", count: count("done"), tone: "bg-success" },
    { id: "shipping", label: "shipping", count: count("approved", "merging", "pr_open"), tone: "bg-success/55" },
    { id: "progress", label: "in progress", count: count("working", "checking", "review"), tone: "bg-timeline-accent" },
    { id: "next", label: "up next", count: count("queued"), tone: "bg-muted-foreground/40" },
    { id: "blocked", label: "blocked", count: count("blocked"), tone: "bg-destructive-text" },
  ];
  const total = cards.length - count("cancelled");
  if (total === 0) return null;
  return (
    <div data-board-progress className="mb-3 space-y-2">
      <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-muted-foreground/15">
        {parts.map((part) => (part.count === 0 ? null : <span key={part.id} className={part.tone} style={{ flexGrow: part.count }} />))}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {parts.map((part) => (
          <span key={part.id} data-progress={part.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${part.tone}`} />
            {part.count} {part.label}
          </span>
        ))}
        <span className="text-subtle-foreground">
          · {count("done")} of {total} done
        </span>
      </p>
    </div>
  );
}

/** `draftVersion` is set before approval: the cards are the draft's tickets, not yet on the board. */
export function Board({ slug, cards, strategy, now, draftVersion, onChanges }: { slug: string; cards: BoardCard[]; strategy: "integration" | "pr"; now: number; draftVersion: number | null; onChanges?: (key: string) => void }) {
  const draft = draftVersion !== null;
  const props: CardProps = { slug, now, draft, onChanges };
  const of = (states: readonly TicketState[]) => cards.filter((card) => states.includes(card.state));
  const queued = of(["queued"]);
  const blocked = of(["blocked"]);
  const upNext = (
    <>
      <GroupHeading title="Up next" />
      <div data-lane="queued">
        <div data-queue-group="ready">
          <StageRow id="ready" lane={false} title="Ready" hint="the next free worker takes it" cards={queued.filter((card) => card.ready)} {...props} />
        </div>
        <div data-queue-group="waiting">
          <StageRow id="waiting" lane={false} title="Waiting" hint="on a dependency or overlapping work" cards={queued.filter((card) => !card.ready)} {...props} />
        </div>
      </div>
    </>
  );
  return (
    <div>
      {draft && (
        <p data-draft-note className="mx-4 mt-4 rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
          Draft v{draftVersion}: {cards.length === 1 ? "approving creates this ticket. Its dashed card is" : `approving creates these ${plural(cards.length, "ticket")}. Dashed cards are`} not on the board yet.
        </p>
      )}
      <div data-board={slug} className="@container p-4">
        {draft ? (
          upNext
        ) : (
          <>
            <Progress cards={cards} />
            {blocked.length > 0 && (
              <>
                <GroupHeading title="Needs you" />
                <StageRow id="blocked" title="Blocked" hint="answer on the ticket, then requeue" cards={blocked} attention {...props} />
              </>
            )}
            {GROUPS.map((group) => (
              <div key={group.id} data-board-group={group.id}>
                <GroupHeading title={group.title} />
                {group.rows.map((row) => (
                  <StageRow key={row.id} id={row.id} title={row.title} hint={row.hint(strategy)} cards={of(row.states)} withState={row.states.length > 1} {...props} />
                ))}
              </div>
            ))}
            {upNext}
            <GroupHeading title="Finished" />
            <FoldedRow id="done" title="Done" cards={of(["done"])} {...props} />
            <FoldedRow id="cancelled" title="Cancelled" cards={of(["cancelled"])} {...props} />
          </>
        )}
      </div>
    </div>
  );
}
