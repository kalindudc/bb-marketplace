// The ticket pane's head: its mark, key, state and age with its menu, the title, and the facts a person needs before
// answering (what it waits on, what it unblocks, the branch, the pull request and its checks), then one sentence on
// where it is. The ticket's actions live in its menu; Block and Cancel ask for a reason in place before they act.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { MergeItem, TicketAction, TicketDetail } from "../contract";
import { formatDuration, plural, retryText, reviewerLookupText, startWaitText } from "../format";
import { ActionButton, BUTTON, ConfirmButton, FIELD, RepoChip, SyncButton, TAP } from "./common";
import { PHONE_TEXT } from "./narrow";
import { isOpen, type DepIndex } from "./deps";
import { STATE_WORDS } from "./groups";
import { Menu, MenuItem, MenuSeparator, Tip } from "./kit";
import { StateMark } from "./marks";
import { ago, checksText, GHOST } from "./ticket-cards";

const FACT = "inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--loom-line)] px-2 py-0.5";
const LINK = "cursor-pointer rounded text-xs text-foreground underline underline-offset-2 hover:text-[var(--loom-bad)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function prOpenSummary(pr: TicketDetail["pr"], now: number): string {
  if (pr === null) return "The pull request is open; the ticket is done when it merges.";
  if (pr.forge === "none") return "Loom pushed the branch; the ticket is done when the remote's base branch contains it.";
  const commits = pr.commits === null ? "" : ` as ${plural(pr.commits, "commit")}`;
  if (!pr.follows) return `The pull request is open${commits}. Loom checks every 5 minutes whether it merged. It's done when you merge it.`;
  const checks = pr.checks === null ? "it waits for its checks" : `its checks: ${checksText(pr.checks)}${pr.checks.at < now ? `, read ${ago(pr.checks.at, now)}` : ""}`;
  return `The pull request is open${commits}. Loom follows its checks and reviews every 5 minutes and sends the worker what needs a fix; ${checks}. It's done when you merge it.`;
}

/** One sentence on where the ticket is; null for a blocked ticket, whose callout says it. */
export function summaryOf(ticket: TicketDetail, now: number): string | null {
  const { attempts } = ticket.activity;
  const newest = attempts.at(-1);
  const n = newest?.n ?? 0;
  const r = ticket.reviewRound;
  const pr = ticket.pr;
  const fixing = pr !== null && pr.pushedSha !== null;
  if (ticket.startWait !== null) return startWaitText(ticket.startWait, now);
  if (ticket.reviewerLookup !== null) return reviewerLookupText(ticket.reviewerLookup, now);
  if (ticket.retry !== null) return retryText(ticket.retry, now);
  switch (ticket.state) {
    case "queued":
      return newest === undefined ? "Waiting for a worker." : `Requeued after attempt ${n}; waiting for a worker.`;
    case "working":
      if (fixing) return `Fix round ${pr.rounds}: the worker is fixing the pull request's feedback (${formatDuration(now - ticket.stateAt)}). The fix goes through Loom's checks and review, then Loom pushes it as ${pr.commits === null ? "more commits" : "one more commit"}.`;
      return `Worker attempt ${n} is working for ${formatDuration(now - newest!.startedAt)}.`;
    case "checking":
      return `Loom is running the checks for attempt ${n}.`;
    case "review": {
      const reviewing = ticket.threads.some((thread) => thread.role === "reviewer" && thread.state !== "ended" && thread.threadId !== null && thread.reviewRound === r);
      return reviewing ? `Reviewer round ${r} is reviewing attempt ${n}.` : `Waiting for a reviewer for round ${r}.`;
    }
    case "approved":
      if (pr?.writing != null) {
        const took = formatDuration(now - pr.writing.since);
        return pr.writing.fix
          ? `Fix round ${pr.rounds} is approved. The worker is writing its commit message (${took}); Loom uses its own if it is not in within ${formatDuration(pr.writing.until - pr.writing.since)}.`
          : `Approved in round ${r}. The worker is writing the pull request's title, description and commit message (${took}); Loom uses its own template if they are not in within ${formatDuration(pr.writing.until - pr.writing.since)}.`;
      }
      return pr === null ? `Approved in round ${r}; waiting for its turn to merge.` : fixing ? `Fix round ${pr.rounds} is approved; waiting for its turn to push.` : `Approved in round ${r}; waiting for its turn to open its pull request.`;
    case "merging":
      return pr === null ? `Merging attempt ${n}.` : fixing ? `Loom is pushing fix round ${pr.rounds} to the pull request.` : "Loom is opening the pull request.";
    case "pr_open":
      return prOpenSummary(pr, now);
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

/** The pull request's facts: its number, the commits Loom pushed, its checks, the fix rounds, and the worker writing it. */
function PrFacts({ ticket, now }: { ticket: TicketDetail; now: number }) {
  const pr = ticket.pr;
  if (pr === null) return null;
  const number = pr.url === null ? null : (/(\d+)(?!.*\d)/u.exec(pr.url)?.[1] ?? null);
  const open = pr.pushedSha !== null && !["done", "cancelled"].includes(ticket.state);
  return (
    <>
      {pr.writing !== null && ticket.state === "approved" && (
        <span data-fact="pr-writing" className={FACT}>
          {pr.writing.fix ? "Writing the fix's commit message" : "Writing the pull request"} · {formatDuration(now - pr.writing.since)}
        </span>
      )}
      {number !== null && (
        <span data-fact="pr-number" className={FACT}>
          <span className="font-semibold">#{number}</span>
        </span>
      )}
      {pr.pushedSha !== null && (
        <span data-fact="pr-commits" className={`${FACT} font-mono`}>
          {pr.commits === null ? "" : `${plural(pr.commits, "commit")} · `}
          {pr.pushedSha.slice(0, 7)}
        </span>
      )}
      {open && pr.checks !== null && (
        <span data-fact="pr-checks" className={FACT}>
          <span className="text-[var(--loom-muted)]">checks</span>
          {pr.checks.passed > 0 && <span className="text-[var(--loom-ok)]">{pr.checks.passed} ✓</span>}
          {pr.checks.pending > 0 && <span className="text-[var(--loom-run)]">{pr.checks.pending} ●</span>}
          {pr.checks.failed > 0 && <span className="text-[var(--loom-bad)]">{pr.checks.failed} ✗</span>}
          <span className="text-[var(--loom-muted)]">· read {ago(pr.checks.at, now)}</span>
        </span>
      )}
      {(pr.follows || pr.rounds > 0) && pr.pushedSha !== null && (
        <span data-fact="pr-rounds" className={FACT}>
          Fix rounds {pr.counted} of {pr.maxFixRounds}
        </span>
      )}
    </>
  );
}

/** Whether the ticket page offers Sync now: an open pull request Loom follows, or the push-only forge's branch, on a running or paused project. */
export const canSyncTicket = (ticket: TicketDetail) =>
  ticket.at === null && ticket.state === "pr_open" && ticket.pr !== null && (ticket.pr.url !== null || ticket.pr.forge === "none") && (ticket.projectState === "running" || ticket.projectState === "paused");


const ICON_BUTTON = `inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP} max-[576px]:min-w-11 pointer-coarse:min-w-11`;
const FACT_ROW = "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1";
const FACT_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-[var(--loom-muted)]";

/** A ticket key that opens it, with its state mark. */
function KeyLink({ index, keyName, onOpen, kind, done = false }: { index?: DepIndex; keyName: string; onOpen?(key: string): void; kind?: string; done?: boolean }) {
  const card = index?.by.get(keyName);
  return (
    <span className="inline-flex items-center gap-1" data-dep={keyName}>
      {done ? (
        <span role="img" aria-label="done" className="text-[var(--loom-ok)]">
          ✓
        </span>
      ) : (
        card !== undefined && <StateMark state={card.state} className="size-3" />
      )}
      {onOpen === undefined ? (
        <span className="font-mono text-xs font-medium">{keyName}</span>
      ) : (
        <button type="button" onClick={() => onOpen(keyName)} className={`inline-flex min-h-6 cursor-pointer items-center justify-center rounded px-0.5 @max-xl/loom:min-h-11 @max-xl/loom:min-w-11 max-[576px]:min-h-11 max-[576px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 font-mono text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
          {keyName}
        </button>
      )}
      {kind !== undefined && kind !== "work" && <span className="text-[11px] text-[var(--loom-muted)]">{kind === "merge" ? "merge" : "live"}</span>}
    </span>
  );
}

/** What it waits on and what it unblocks: from the board when the pane has it, else from the ticket's own deps. */
function DepFacts({ ticket, index, onOpen }: { ticket: TicketDetail; index?: DepIndex; onOpen?(key: string): void }) {
  const prereqs = ticket.prereqs.length > 0 ? ticket.prereqs : ticket.deps.map((key) => ({ key, kind: "work" as const }));
  const dependents = index?.dependents(ticket.key) ?? [];
  const all = index?.inAll(ticket.key) ?? [];
  const direct = index?.direct(ticket.key) ?? [];
  return (
    <>
      <span data-fact="waits-on" className={FACT_ROW}>
        <span className={FACT_LABEL}>Waits on</span>
        {prereqs.length === 0 ? (
          <span className="text-xs text-[var(--loom-muted)]">nothing</span>
        ) : (
          prereqs.map((prereq) => (
            <KeyLink key={`${prereq.key}-${prereq.kind}`} index={index} keyName={prereq.key} onOpen={onOpen} kind={prereq.kind} done={prereq.kind === "work" && ticket.depsDone.includes(prereq.key)} />
          ))
        )}
      </span>
      {index !== undefined && (
        <span data-fact="unblocks" className={FACT_ROW}>
          <span className={FACT_LABEL}>Unblocks</span>
          {dependents.length === 0 ? (
            <span className="text-xs text-[var(--loom-muted)]">none</span>
          ) : (
            dependents.map((dep) => <KeyLink key={`${dep.key}-${dep.kind}`} index={index} keyName={dep.key} onOpen={onOpen} kind={dep.kind} />)
          )}
          {all.length > direct.length && <span className="text-xs text-[var(--loom-muted)]">{all.length} in all</span>}
        </span>
      )}
    </>
  );
}

/** Block or Cancel, opened from the menu: a reason, then the action; Cancel is final, so it asks once more. */
function ReasonForm({ action, ticketKey, busy, onAction, onBack }: { action: "block" | "cancel"; ticketKey: string; busy: boolean; onAction(action: TicketAction, note: string): Promise<boolean>; onBack(): void }) {
  const [reason, setReason] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const ready = reason.trim() !== "" && !busy;
  const run = () => void onAction(action, reason.trim()).then((done) => done && onBack());
  return (
    <div
      role="group"
      aria-label={action === "block" ? `Block ${ticketKey}` : `Cancel ${ticketKey}`}
      data-reason-form={action}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
      className="loom-pop grid gap-2 rounded-md border border-[var(--loom-line)] p-2.5"
    >
      <textarea ref={field} aria-label="Reason" value={reason} rows={2} placeholder={action === "block" ? "Why block it (required)" : "Why cancel it (required)"} onChange={(event) => setReason(event.target.value)} className={`${FIELD} ${PHONE_TEXT}`} />
      {/* Armed, Cancel brings its own Back, which disarms; the form's Back would sit beside it. */}
      <div className="flex flex-wrap items-center gap-2 [&:has([data-confirm-armed])>[data-form-back]]:hidden">
        {action === "block" ? <ActionButton label={`Block ${ticketKey}`} disabled={!ready} onClick={run} /> : <ConfirmButton label="Cancel ticket" confirmLabel={`Yes, cancel ${ticketKey}`} disarmKey={ticketKey} danger disabled={!ready} onConfirm={run} />}
        <button type="button" data-form-back onClick={onBack} className={BUTTON}>
          Back
        </button>
        <span className="text-xs text-[var(--loom-muted)]">{action === "block" ? "The reason goes on the ticket; Requeue starts it again." : "Cancel is final."}</span>
      </div>
    </div>
  );
}

/** The ticket at a glance, in the pane: the key line with its menu, the title, the facts, and where it is. */
/** "LANE-16 is now in review." when the open ticket's state changes while it is shown; nothing when it opens. */
export function useStateNote(key: string, word: string): string {
  const [seen, setSeen] = useState({ key, word, note: "" });
  if (seen.key !== key || seen.word !== word) setSeen({ key, word, note: seen.key === key ? `${key} is now ${word}.` : "" });
  return seen.note;
}

export function TicketHeader({
  ticket,
  now,
  busy,
  onAction,
  index,
  onOpen,
  onClose,
  onReply,
  onChanges,
  sync,
  phaseLabel,
  children,
}: {
  ticket: TicketDetail;
  now: number;
  busy: boolean;
  onAction(action: TicketAction, note: string): Promise<boolean>;
  index?: DepIndex;
  onOpen?(key: string): void;
  onClose?(): void;
  onReply?(): void;
  onChanges?(): void;
  sync?: { syncing: boolean; onSync(): void };
  /** "phase 2", from the project's phases. */
  phaseLabel?: string;
  children?: ReactNode;
}) {
  const navigate = useBbNavigate();
  const [form, setForm] = useState<"block" | "cancel" | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const final = !isOpen(ticket);
  const past = ticket.at !== null;
  const worker = ticket.threads.filter((thread) => thread.role === "worker" && thread.state !== "ended" && thread.threadId !== null).at(-1);
  const summary = summaryOf(ticket, now);
  const first = ticket.activity.attempts[0];
  const word = STATE_WORDS[ticket.state];
  const stateNote = useStateNote(ticket.key, word);
  const canSync = sync !== undefined && canSyncTicket(ticket);
  const back = () => {
    setForm(null);
    menuButton.current?.focus();
  };
  return (
    <header data-ticket-header className="grid grid-cols-1 gap-2">
      <p role="status" data-state-note className="sr-only">
        {stateNote}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StateMark state={ticket.state} draft={ticket.draft === "held"} className="size-4" />
        <span className="font-mono text-sm font-semibold">{ticket.key}</span>
        <span data-state-badge className="text-sm text-foreground">
          {word}
        </span>
        <span className="loom-num text-xs text-[var(--loom-muted)]">{formatDuration(Math.max(0, now - ticket.stateAt))}</span>
        <span className="flex-1" />
        {worker !== undefined && ticket.state === "working" && (
          <Tip text="Open worker thread">
            <button type="button" aria-label="Open worker thread" onClick={() => navigate.toThread(worker.threadId!)} className={ICON_BUTTON}>
              <Icon name="ExternalLink" aria-hidden className="size-4" />
            </button>
          </Tip>
        )}
        <Menu
          label={`${ticket.key} actions`}
          trigger={
            <button ref={menuButton} type="button" aria-label="Ticket actions" className={ICON_BUTTON}>
              <Icon name="MoreHorizontal" aria-hidden className="size-4" />
            </button>
          }
        >
          {worker !== undefined && (
            <MenuItem icon="ExternalLink" onSelect={() => navigate.toThread(worker.threadId!)}>
              Worker thread
            </MenuItem>
          )}
          <MenuItem icon="Copy" onSelect={() => void experimental_copyToClipboard({ text: ticket.key })}>
            Copy key
          </MenuItem>
          {ticket.branch !== null && (
            <MenuItem icon="GitBranch" onSelect={() => void experimental_copyToClipboard({ text: ticket.branch! })}>
              Copy branch
            </MenuItem>
          )}
          {ticket.prUrl !== null && (
            <MenuItem icon="GitPullRequest" onSelect={() => navigate.openUrl(ticket.prUrl!)}>
              Open the pull request
            </MenuItem>
          )}
          {canSync && (
            <MenuItem icon="ArrowReloadHorizontal" disabled={busy || sync!.syncing} onSelect={sync!.onSync}>
              Sync now
            </MenuItem>
          )}
          {onChanges !== undefined && (
            <MenuItem icon="FileDiff" onSelect={onChanges}>
              Changes
            </MenuItem>
          )}
          {onReply !== undefined && !past && (
            <MenuItem icon="MessageSquare" onSelect={onReply}>
              Reply on the ticket
            </MenuItem>
          )}
          {!final && !past && (
            <>
              <MenuSeparator />
              {ticket.state !== "blocked" && (
                <MenuItem icon="Pause" disabled={busy} onSelect={() => setForm("block")}>
                  Block…
                </MenuItem>
              )}
              <MenuItem icon="Unavailable" danger disabled={busy} onSelect={() => setForm("cancel")}>
                Cancel ticket…
              </MenuItem>
            </>
          )}
        </Menu>
        {onClose !== undefined && (
          <Tip text="Close" keys="Esc">
            <button type="button" aria-label="Close the ticket" onClick={onClose} className={`${ICON_BUTTON} @max-4xl/loom:hidden`}>
              <Icon name="X" aria-hidden className="size-4" />
            </button>
          </Tip>
        )}
      </div>
      <h1 className="m-0 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{ticket.title}</h1>
      <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--loom-muted)] [&>span+span]:before:mr-1.5 [&>span+span]:before:content-['·']">
        {ticket.repo !== null && <RepoChip name={ticket.repo} />}
        {ticket.phase !== null && <span data-fact="phase">{phaseLabel ?? `phase ${ticket.phase}`}</span>}
        {ticket.attempt > 0 && <span>{plural(ticket.attempt, "attempt")}</span>}
        {ticket.reviewRound > 0 && <span>{plural(ticket.reviewRound, "review round")}</span>}
        {ticket.state === "done" && first !== undefined && <span data-fact="time">{formatDuration(ticket.stateAt - first.startedAt)}</span>}
      </p>
      {form !== null && <ReasonForm action={form} ticketKey={ticket.key} busy={busy} onAction={onAction} onBack={back} />}
      <div data-ticket-facts className="grid grid-cols-1 gap-1.5 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          <DepFacts ticket={ticket} index={index} onOpen={onOpen} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {ticket.branch !== null && (
            <span className={FACT}>
              <Icon name="GitBranch" aria-hidden className="size-3.5 shrink-0 text-[var(--loom-muted)]" />
              <span data-ticket-branch className="font-mono text-[var(--loom-muted)] [overflow-wrap:anywhere]">
                {ticket.branch}
              </span>
              <button type="button" aria-label="Copy the branch name" onClick={() => void experimental_copyToClipboard({ text: ticket.branch! })} className={`${GHOST} justify-center @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-w-11`}>
                <Icon name="Copy" aria-hidden className="size-3.5" />
              </button>
            </span>
          )}
          <PrFacts ticket={ticket} now={now} />
          {ticket.prUrl !== null && (
            <button type="button" aria-label="Open the pull request" onClick={() => navigate.openUrl(ticket.prUrl!)} className={BUTTON}>
              <Icon name="ExternalLink" aria-hidden className="size-3.5" />
              Pull request
            </button>
          )}
          {canSync && <SyncButton label="Sync now" title="Read this pull request now instead of at its next check, and act on what it says" syncing={sync!.syncing} disabled={busy} onSync={sync!.onSync} />}
        </div>
      </div>
      {summary !== null && (
        <p data-ticket-summary className="m-0 text-[13px] text-[var(--loom-muted)]">
          {summary}
        </p>
      )}
      {children}
    </header>
  );
}
