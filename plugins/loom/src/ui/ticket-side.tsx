import { Fragment, useState } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon, ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ThreadDto, TicketDetail } from "../contract";
import { endLabel, formatDuration } from "../format";
import { Avatar, GHOST } from "./ticket-cards";

const SIDE_CARD = "min-w-0 rounded-md border border-[var(--loom-line)] p-3";
const TITLE = "mb-2 flex flex-wrap items-center gap-2 text-[12.5px] font-semibold";
const COUNT = "text-[11px] font-normal text-[var(--loom-muted)]";
const THREAD_STATE_TEXT = { spawning: "starting", active: "working", ending: "ending" } as const;

const EARS = /\b(THE SYSTEM SHALL|WHEN|WHILE|WHERE|IF|THEN)\b/;

/** A criterion with its EARS keywords set apart and its backticked text as code. Each split puts the matches at the odd indexes. */
function Criterion({ line }: { line: string }) {
  return (
    <>
      {line.split(/`([^`]+)`/).map((chunk, at) =>
        at % 2 === 1 ? (
          <code key={at} className="rounded bg-foreground/5 px-1 font-mono text-[11.5px]">
            {chunk}
          </code>
        ) : (
          <Fragment key={at}>
            {chunk.split(EARS).map((part, index) =>
              index % 2 === 1 ? (
                <span key={index} data-ears className="text-[11px] font-semibold tracking-wider text-[var(--loom-muted)]">
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </Fragment>
        ),
      )}
    </>
  );
}

function threadLabel(ticket: TicketDetail, thread: ThreadDto): string {
  if (thread.state !== "ended") return THREAD_STATE_TEXT[thread.state];
  if (thread.threadId === null && thread.endReason === "failed") return "could not start";
  const review = thread.role === "reviewer" && thread.threadId !== null ? ticket.reviews.find((candidate) => candidate.threadId === thread.threadId && candidate.verdict !== "pending") : undefined;
  return review === undefined ? endLabel(thread.endReason) : review.status;
}

function labelTone(label: string, live: boolean): string {
  if (live) return "bg-timeline-accent/15 text-[var(--loom-run)]";
  if (label === "merged" || label === "approved") return "bg-success/15 text-[var(--loom-ok)]";
  if (label === "blocked") return "bg-destructive-text/15 text-[var(--loom-bad)]";
  if (label === "changes requested") return "bg-warning/15 text-[var(--loom-warn)]";
  return "bg-muted-foreground/15 text-[var(--loom-muted)]";
}

export function Agents({ ticket, now }: { ticket: TicketDetail; now: number }) {
  const navigate = useBbNavigate();
  const threads = ticket.threads.filter((thread) => thread.role === "worker" || thread.role === "reviewer");
  const workers = threads.filter((thread) => thread.role === "worker");
  return (
    <section data-ticket-threads className={SIDE_CARD}>
      <h3 className={TITLE}>
        Agents <span className={COUNT}>{threads.length}</span>
      </h3>
      {threads.length === 0 && <p className="text-xs text-[var(--loom-muted)]">No worker has started yet.</p>}
      <ul className="space-y-2">
        {threads.map((thread, index) => {
          const worker = thread.role === "worker";
          const n = thread.attempt ?? workers.indexOf(thread) + 1;
          const label = threadLabel(ticket, thread);
          return (
            <li key={thread.threadId ?? `${thread.role}-${index}`} data-thread-row={thread.threadId ?? thread.role} className="flex items-center gap-2 text-xs">
              <Avatar kind={thread.role} />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block font-medium text-foreground">{worker ? `Worker · attempt ${n}` : `Reviewer · round ${thread.reviewRound}`}</span>
                {(thread.threadId !== null || thread.state !== "ended") && <span className="block text-[11px] text-[var(--loom-muted)]">{formatDuration((thread.endedAt ?? now) - thread.startedAt)}</span>}
              </span>
              <span className={`rounded-full px-2 text-[11px] font-semibold ${labelTone(label, thread.state !== "ended")}`}>{label}</span>
              {thread.threadId !== null && (
                <button
                  type="button"
                  aria-label={worker ? `Open worker thread (attempt ${n})` : `Open reviewer thread (round ${thread.reviewRound})`}
                  onClick={() => navigate.toThread(thread.threadId!)}
                  className={GHOST}
                >
                  ↗
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Criteria({ ticket }: { ticket: TicketDetail }) {
  const approved = ticket.reviews.some((review) => review.round === ticket.reviewRound && review.verdict === "approved");
  return (
    <section data-ac className={SIDE_CARD}>
      <h3 className={TITLE}>
        Acceptance criteria <span className={COUNT}>{ticket.acceptance.length}</span>
        {approved && <span className="rounded-full bg-success/15 px-2 text-[11px] font-semibold text-[var(--loom-ok)]">✓ approved, round {ticket.reviewRound}</span>}
      </h3>
      <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed [overflow-wrap:anywhere] marker:text-[var(--loom-muted)]">
        {ticket.acceptance.map((line, index) => (
          <li key={index}>
            <Criterion line={line} />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ScopeFiles({ ticket }: { ticket: TicketDetail }) {
  return (
    <section className={SIDE_CARD}>
      <h3 className={TITLE}>
        Files in scope <span className={COUNT}>{ticket.scope.length}</span>
      </h3>
      <ul className="space-y-0.5">
        {ticket.scope.map((path) => {
          const cut = path.lastIndexOf("/") + 1;
          return (
            <li key={path} data-scope-file className="font-mono text-xs [overflow-wrap:anywhere]">
              <span className="text-[var(--loom-muted)]">{path.slice(0, cut)}</span>
              <span className="font-semibold">{path.slice(cut)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Verify({ ticket }: { ticket: TicketDetail }) {
  return (
    <section data-verify className={SIDE_CARD}>
      <h3 className={TITLE}>Verify command</h3>
      {ticket.verify.length === 0 && <p className="text-xs text-[var(--loom-muted)]">No command of its own; only the project's checks run.</p>}
      <div className="space-y-1.5">
        {ticket.verify.map((command) => (
          <div key={command} className="flex items-start gap-2 rounded-md border border-[var(--loom-line)] bg-surface-recessed p-2">
            <code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{command}</code>
            <button type="button" aria-label="Copy the verify command" onClick={() => void experimental_copyToClipboard({ text: command })} className={GHOST}>
              <Icon name="Copy" aria-hidden className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Each attempt's worker and reviewer conversations, embedded: the threads newest first, one chosen, and its transcript
 * from bb (ThreadChat without its composer, since a note to the agent goes through the ticket's reply below it).
 */
export function Threads({ ticket, now }: { ticket: TicketDetail; now: number }) {
  const navigate = useBbNavigate();
  const threads = ticket.threads.filter((thread): thread is ThreadDto & { threadId: string } => (thread.role === "worker" || thread.role === "reviewer") && thread.threadId !== null).sort((a, b) => b.startedAt - a.startedAt);
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = threads.find((thread) => thread.threadId === picked) ?? threads.find((thread) => thread.state !== "ended") ?? threads[0];
  if (chosen === undefined) return <p data-ticket-threads-empty className="text-xs text-[var(--loom-muted)]">No worker or reviewer has started yet.</p>;
  const name = (thread: ThreadDto) => (thread.role === "worker" ? `Worker · attempt ${thread.attempt ?? "?"}` : `Reviewer · round ${thread.reviewRound}`);
  return (
    <div data-ticket-conversations className="grid gap-2">
      <ul aria-label={`${ticket.key}'s threads, newest first`} className="grid gap-px overflow-hidden rounded-md border border-[var(--loom-line)]">
        {threads.map((thread) => {
          const label = threadLabel(ticket, thread);
          const on = thread.threadId === chosen.threadId;
          return (
            <li key={thread.threadId}>
              <button type="button" aria-pressed={on} onClick={() => setPicked(thread.threadId)} className={`flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-xl/loom:min-h-11 pointer-coarse:min-h-11 ${on ? "bg-[var(--loom-sel)] font-semibold" : "hover:bg-state-hover"}`}>
                <Avatar kind={thread.role} />
                <span className="min-w-0 flex-1 truncate">{name(thread)}</span>
                {/* On the chosen row's tint the coloured words fall under 4.5:1, so they take the foreground there. */}
                <span className={`rounded-full px-2 text-[11px] font-semibold ${labelTone(label, thread.state !== "ended")} ${on ? "!text-foreground" : ""}`}>{label}</span>
                <span className="loom-num w-14 shrink-0 text-right text-[11px] text-[var(--loom-muted)]">{formatDuration(Math.max(0, now - thread.startedAt))}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <section aria-label={`${name(chosen)}'s conversation`} className="overflow-hidden rounded-md border border-[var(--loom-line)]">
        <header className="flex items-center gap-2 border-b border-[var(--loom-line)] px-2.5 py-1.5 text-xs">
          <Avatar kind={chosen.role} />
          <b className="font-semibold">{name(chosen)}</b>
          <span className="text-[var(--loom-muted)]">{threadLabel(ticket, chosen)}</span>
          <button type="button" onClick={() => navigate.toThread(chosen.threadId)} className={`ml-auto inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-xl/loom:h-11 pointer-coarse:h-11`}>
            Open
            <Icon name="ExternalLink" aria-hidden className="size-3.5" />
          </button>
        </header>
        <div data-thread-chat={chosen.threadId} className="h-[28rem] min-h-0 @max-xl/loom:h-[60vh]">
          <ThreadChat key={chosen.threadId} threadId={chosen.threadId} variant="timeline" layout="contained" />
        </div>
      </section>
    </div>
  );
}
