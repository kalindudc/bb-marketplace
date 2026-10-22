import { useState } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { MergeItem, TicketAction, TicketDetail } from "../contract";
import { formatDuration, plural } from "../format";
import type { TicketState } from "../states";
import { BUTTON, BUTTON_PRIMARY, ConfirmButton, FIELD, MoreMenu } from "./common";
import { ago, GHOST } from "./ticket-cards";

const STAGES = [
  ["queued", "Queued"],
  ["working", "Working"],
  ["checking", "Checking"],
  ["review", "Review"],
  ["merging", "Merging"],
  ["done", "Done"],
] as const;
// A blocked or cancelled ticket marks the stage it stopped from (stoppedFrom); these are the entries for that stage.
const STAGE_INDEX: Record<TicketState, number> = { queued: 0, working: 1, blocked: 1, checking: 2, review: 3, approved: 4, merging: 4, pr_open: 4, done: 5, cancelled: 0 };
const STATE_TINTS: Record<TicketState, string> = {
  queued: "bg-muted-foreground/15 text-muted-foreground",
  working: "bg-timeline-accent/15 text-timeline-accent",
  checking: "bg-timeline-accent/15 text-timeline-accent",
  review: "bg-timeline-accent/15 text-timeline-accent",
  approved: "bg-success/15 text-success-foreground",
  merging: "bg-success/15 text-success-foreground",
  pr_open: "bg-success/15 text-success-foreground",
  done: "bg-success/15 text-success-foreground",
  blocked: "bg-destructive-text/15 text-destructive-text",
  cancelled: "bg-muted-foreground/15 text-muted-foreground",
};
const PULSING: readonly TicketState[] = ["working", "checking", "review", "merging"];
const FACT = "inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border-seam px-2 py-0.5";
const LINK = "cursor-pointer rounded text-xs text-foreground underline underline-offset-2 hover:text-destructive-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** One sentence on where the ticket is; null for a blocked ticket, whose callout says it. */
function summaryOf(ticket: TicketDetail, now: number): string | null {
  const { attempts } = ticket.activity;
  const newest = attempts.at(-1);
  const n = newest?.n ?? 0;
  const r = ticket.reviewRound;
  switch (ticket.state) {
    case "queued":
      return newest === undefined ? "Waiting for a worker." : `Requeued after attempt ${n}; waiting for a worker.`;
    case "working":
      return `Worker attempt ${n} is working for ${formatDuration(now - newest!.startedAt)}.`;
    case "checking":
      return `Loom is running the checks for attempt ${n}.`;
    case "review": {
      const reviewing = ticket.threads.some((thread) => thread.role === "reviewer" && thread.state !== "ended" && thread.threadId !== null && thread.reviewRound === r);
      return reviewing ? `Reviewer round ${r} is reviewing attempt ${n}.` : `Waiting for a reviewer for round ${r}.`;
    }
    case "approved":
      return `Approved in round ${r}; waiting for its turn to merge.`;
    case "merging":
      return `Merging attempt ${n}.`;
    case "pr_open":
      return "The pull request is open; the ticket is done when it merges.";
    case "done": {
      const merged = attempts.flatMap((attempt) => attempt.items.filter((item): item is MergeItem => item.type === "merge" && item.outcome === "merged")).at(-1);
      const into = merged?.into ?? null;
      const lead = `${into === null ? "The pull request merged" : `Merged into ${into}`} ${ago(ticket.stateAt, now)}`;
      const counts = [ticket.attempt > 0 ? plural(ticket.attempt, "attempt") : null, r > 0 ? plural(r, "review round") : null].filter((part) => part !== null);
      return counts.length === 0 ? `${lead}.` : `${lead}, after ${counts.join(" and ")}.`;
    }
    case "cancelled":
      return ticket.posts.filter((post) => post.kind === "system" && post.body.startsWith("Cancelled:")).at(-1)?.body ?? "Cancelled.";
    case "blocked":
      return null;
  }
}

function Tracker({ state, stoppedFrom }: Pick<TicketDetail, "state" | "stoppedFrom">) {
  const stopped = state === "blocked" || state === "cancelled";
  const at = STAGE_INDEX[stopped && stoppedFrom !== null ? stoppedFrom : state];
  const markOf = (index: number) => (state === "done" || index < at ? "done" : index > at ? "todo" : stopped ? "stop" : "now");
  const DOTS = {
    done: "bg-success text-success-foreground",
    now: "border-2 border-timeline-accent bg-card ring-2 ring-timeline-accent/30",
    stop: state === "blocked" ? "bg-destructive-text text-background" : "bg-muted-foreground text-background",
    todo: "border-2 border-border-seam bg-card",
  };
  return (
    <ol data-stage-tracker className="flex items-start">
      {STAGES.map(([key, name], index) => {
        const mark = markOf(index);
        const line = index === 0 ? "" : `before:absolute before:right-1/2 before:top-2 before:h-0.5 before:w-full before:content-[''] ${mark === "done" ? "before:bg-success" : "before:bg-border-seam"}`;
        return (
          <li key={key} data-stage={key} data-mark={mark} className={`relative flex flex-1 flex-col items-center gap-1 text-[11px] ${mark === "now" ? "font-semibold text-foreground" : mark === "stop" && state === "blocked" ? "font-semibold text-destructive-text" : "text-muted-foreground"} ${line}`}>
            <span aria-hidden className={`relative z-10 grid size-[18px] place-items-center rounded-full text-[10px] font-bold ${DOTS[mark]}`}>
              {mark === "done" ? "✓" : mark === "stop" ? (state === "blocked" ? "!" : "×") : ""}
            </span>
            <span>{mark === "stop" ? (state === "blocked" ? "Blocked" : "Cancelled") : name}</span>
          </li>
        );
      })}
    </ol>
  );
}

function BlockedCallout({ ticket, busy, onAction, onJump }: { ticket: TicketDetail; busy: boolean; onAction(action: TicketAction, note: string): Promise<boolean>; onJump(postId: number): void }) {
  const [note, setNote] = useState("");
  const block = ticket.posts.filter((post) => post.kind === "block").at(-1);
  return (
    <div data-blocked-callout data-ticket-actions className="space-y-2 rounded-lg border border-destructive-text/40 bg-destructive-text/10 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive-text">
        <Icon name="AlertTriangle" aria-hidden className="size-4" />
        {block?.authorKind === "worker" ? "Blocked: the worker needs an answer" : "Blocked"}
      </p>
      {ticket.blockedReason !== null && <p className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{ticket.blockedReason}</p>}
      {block !== undefined && (
        <button type="button" aria-label="Read the post that blocked it" onClick={() => onJump(block.id)} className={LINK}>
          Read the post
        </button>
      )}
      <textarea aria-label="Note" value={note} rows={2} placeholder="Your answer for the next worker (required)" onChange={(event) => setNote(event.target.value)} className={FIELD} />
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmButton label="Requeue" disabled={busy || note.trim() === ""} onConfirm={() => void onAction("requeue", note.trim()).then((done) => done && setNote(""))} />
        {ticket.replyTo === "planner" && <span className="text-[11px] text-subtle-foreground">Or reply on the post: the planner gets it now and can requeue the ticket itself.</span>}
      </div>
    </div>
  );
}

/** The ticket at a glance: its key, state, title, a summary, the stage tracker and the facts, with the actions it needs. */
export function TicketHeader({ ticket, now, busy, onAction, onJump }: { ticket: TicketDetail; now: number; busy: boolean; onAction(action: TicketAction, note: string): Promise<boolean>; onJump(postId: number): void }) {
  const navigate = useBbNavigate();
  const [reason, setReason] = useState("");
  const final = ticket.state === "done" || ticket.state === "cancelled";
  const worker = ticket.state === "working" ? ticket.threads.filter((thread) => thread.role === "worker" && thread.state !== "ended" && thread.threadId !== null).at(-1) : undefined;
  const summary = summaryOf(ticket, now);
  const first = ticket.activity.attempts[0];
  const steer = (action: TicketAction, close: () => void) =>
    void onAction(action, reason.trim()).then((done) => {
      if (!done) return;
      setReason("");
      close();
    });
  return (
    <header data-ticket-header className="space-y-3 rounded-lg border border-border-seam bg-card p-4 @4xl:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-border-seam px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{ticket.key}</span>
        <span data-state-badge className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_TINTS[ticket.state]}`}>
          {PULSING.includes(ticket.state) && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />}
          {ticket.state.replace("_", " ")}
        </span>
        <span className="flex-1" />
        {worker !== undefined && (
          <button type="button" onClick={() => navigate.toThread(worker.threadId!)} className={BUTTON_PRIMARY}>
            <span aria-hidden className="mr-1">
              ↗
            </span>
            Open worker thread
          </button>
        )}
        {!final && (
          <MoreMenu>
            {(close) => (
              <div className="w-64 space-y-2 p-2">
                <textarea aria-label="Reason" value={reason} rows={2} placeholder="Why (required)" onChange={(event) => setReason(event.target.value)} className={FIELD} />
                <div className="flex flex-wrap gap-2">
                  {ticket.state !== "blocked" && <ConfirmButton label="Block" disabled={busy || reason.trim() === ""} onConfirm={() => steer("block", close)} />}
                  <ConfirmButton label="Cancel ticket" danger disabled={busy || reason.trim() === ""} onConfirm={() => steer("cancel", close)} />
                </div>
                <p className="text-[11px] text-subtle-foreground">Each needs a reason and a second click.</p>
              </div>
            )}
          </MoreMenu>
        )}
      </div>
      <h1 className="text-lg font-semibold [overflow-wrap:anywhere]">{ticket.title}</h1>
      {summary !== null && (
        <p data-ticket-summary className="text-sm text-muted-foreground">
          {summary}
        </p>
      )}
      {ticket.state === "blocked" && <BlockedCallout ticket={ticket} busy={busy} onAction={onAction} onJump={onJump} />}
      <Tracker state={ticket.state} stoppedFrom={ticket.stoppedFrom} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {ticket.attempt > 0 && <span className={FACT}>{plural(ticket.attempt, "attempt")}</span>}
        {ticket.reviewRound > 0 && <span className={FACT}>{plural(ticket.reviewRound, "review round")}</span>}
        {ticket.state === "done" && first !== undefined && (
          <span data-fact="time" className={FACT}>
            {formatDuration(ticket.stateAt - first.startedAt)}
          </span>
        )}
        {ticket.deps.length > 0 && (
          <span className={FACT}>
            <span className="text-muted-foreground">after</span>
            {ticket.deps.map((dep) => (
              <span key={dep} className="inline-flex items-center gap-1">
                <button type="button" onClick={() => navigate.toPluginPanel("loom", { subPath: `${ticket.slug}/${dep}` })} className="cursor-pointer font-medium text-foreground hover:underline">
                  {dep}
                </button>
                {ticket.depsDone.includes(dep) && (
                  <span aria-hidden className="text-success-foreground">
                    ✓
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
        {ticket.branch !== null && (
          <span className={FACT}>
            <Icon name="GitBranch" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span data-ticket-branch className="font-mono text-muted-foreground [overflow-wrap:anywhere]">
              {ticket.branch}
            </span>
            <button type="button" aria-label="Copy the branch name" onClick={() => void experimental_copyToClipboard({ text: ticket.branch! })} className={GHOST}>
              <Icon name="Copy" aria-hidden className="size-3.5" />
            </button>
          </span>
        )}
        {ticket.prUrl !== null && (
          <button type="button" aria-label="Open the pull request" onClick={() => navigate.openUrl(ticket.prUrl!)} className={BUTTON}>
            Pull request
          </button>
        )}
      </div>
    </header>
  );
}
