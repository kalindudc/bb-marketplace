import { Fragment } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ThreadDto, TicketDetail } from "../contract";
import { endLabel, formatDuration } from "../format";
import { Avatar, GHOST } from "./ticket-cards";

const SIDE_CARD = "min-w-0 rounded-lg border border-border-seam bg-card p-3.5";
const TITLE = "mb-2 flex flex-wrap items-center gap-2 text-[12.5px] font-semibold";
const COUNT = "text-[11px] font-normal text-subtle-foreground";
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
                <span key={index} data-ears className="text-[10px] font-semibold tracking-wider text-subtle-foreground">
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
  if (live) return "bg-timeline-accent/15 text-timeline-accent";
  if (label === "merged" || label === "approved") return "bg-success/15 text-success-foreground";
  if (label === "blocked") return "bg-destructive-text/15 text-destructive-text";
  if (label === "changes requested") return "bg-warning/15 text-warning-text";
  return "bg-muted-foreground/15 text-muted-foreground";
}

function Agents({ ticket, now }: { ticket: TicketDetail; now: number }) {
  const navigate = useBbNavigate();
  const threads = ticket.threads.filter((thread) => thread.role === "worker" || thread.role === "reviewer");
  const workers = threads.filter((thread) => thread.role === "worker");
  return (
    <section data-ticket-threads className={SIDE_CARD}>
      <h3 className={TITLE}>
        Agents <span className={COUNT}>{threads.length}</span>
      </h3>
      {threads.length === 0 && <p className="text-xs text-muted-foreground">No worker has started yet.</p>}
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
                {(thread.threadId !== null || thread.state !== "ended") && <span className="block text-[11px] text-subtle-foreground">{formatDuration((thread.endedAt ?? now) - thread.startedAt)}</span>}
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

/** The acceptance criteria, the files in scope, the verify command and every worker and reviewer thread: the aside, or the Details tab on a narrow page. */
export function SideCards({ ticket, now }: { ticket: TicketDetail; now: number }) {
  const approved = ticket.reviews.some((review) => review.round === ticket.reviewRound && review.verdict === "approved");
  return (
    <>
      <section data-ac className={SIDE_CARD}>
        <h3 className={TITLE}>
          Acceptance criteria <span className={COUNT}>{ticket.acceptance.length}</span>
          {approved && <span className="rounded-full bg-success/15 px-2 text-[11px] font-semibold text-success-foreground">✓ approved, round {ticket.reviewRound}</span>}
        </h3>
        <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed [overflow-wrap:anywhere] marker:text-subtle-foreground">
          {ticket.acceptance.map((line, index) => (
            <li key={index}>
              <Criterion line={line} />
            </li>
          ))}
        </ol>
      </section>
      <section className={SIDE_CARD}>
        <h3 className={TITLE}>
          Files in scope <span className={COUNT}>{ticket.scope.length}</span>
        </h3>
        <ul className="space-y-0.5">
          {ticket.scope.map((path) => {
            const cut = path.lastIndexOf("/") + 1;
            return (
              <li key={path} data-scope-file className="font-mono text-xs [overflow-wrap:anywhere]">
                <span className="text-subtle-foreground">{path.slice(0, cut)}</span>
                <span className="font-semibold">{path.slice(cut)}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section data-verify className={SIDE_CARD}>
        <h3 className={TITLE}>Verify command</h3>
        {ticket.verify.length === 0 && <p className="text-xs text-muted-foreground">No command of its own; only the project's checks run.</p>}
        <div className="space-y-1.5">
          {ticket.verify.map((command) => (
            <div key={command} className="flex items-start gap-2 rounded-md border border-border-seam bg-surface-recessed p-2">
              <code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">{command}</code>
              <button type="button" aria-label="Copy the verify command" onClick={() => void experimental_copyToClipboard({ text: command })} className={GHOST}>
                <Icon name="Copy" aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </section>
      <Agents ticket={ticket} now={now} />
    </>
  );
}
