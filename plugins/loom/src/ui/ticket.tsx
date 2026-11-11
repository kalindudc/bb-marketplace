// A ticket in Work's pane, beside the compact list: its head and facts, the answer when it waits on the person, the
// map of what it waits on and unblocks, then Activity, Brief and Agents. A ticket's error and empty states show in the
// pane, with the list still beside it.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { TicketAction, TicketDetail } from "../contract";
import { plural } from "../format";
import { BlockedAsk } from "./blocked-ask";
import { BUTTON, momentLabel, useAction, useLoom, useLoomWrite, useNow, useRun, useSyncPullRequests } from "./common";
import type { DepIndex } from "./deps";
import { DraftHold } from "./draft-hold";
import { MergeConfirm } from "./merge-confirm";
import { TicketHeader } from "./ticket-header";
import { Criteria, ScopeFiles, Verify, Agents, Threads } from "./ticket-side";
import { ReplyBox, replyHint, Stream } from "./ticket-stream";

const ACTION_DONE: Record<TicketAction, string> = { requeue: "requeued", review: "sent back as it is", block: "blocked", cancel: "cancelled" };

type Tab = "activity" | "threads" | "brief" | "agents";

const TAB = "inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 text-[13px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-xl/loom:min-h-11 pointer-coarse:min-h-11";
const TAB_ON = "border-foreground font-semibold text-foreground";
const TAB_OFF = "border-transparent text-[var(--loom-muted)] hover:text-foreground";

/** What the pane gets from the Work view around it: the board's dependencies and the ways out of the ticket. */
export interface PaneContext {
  index: DepIndex;
  phaseLabel?: string;
  /** The map of what it waits on and unblocks; null where the Map view beside it shows that. */
  map: ReactNode;
  /** Merging its pull request, for the tickets that wait on it, in Ship's words. */
  mergeThen: string | null;
  /** What the rollout says against merging it now, as Ship's Do next holds it; null when nothing does. */
  mergeHold?: string | null;
  onOpen(key: string): void;
  onClose(): void;
  onChanges?(): void;
}

/**
 * The ticket in the pane. With `at`, the ticket as it was at that event, with every control disabled. `threads` false
 * leaves out the embedded conversations, where the ticket shows beside its own thread.
 */
export function TicketView({ ticketKey, at = null, onNow, context, threads = true }: { ticketKey: string; at?: number | null; onNow?(): void; context?: PaneContext; threads?: boolean }) {
  const remote = useLoom("ticket", at === null ? { key: ticketKey } : { key: ticketKey, at });
  const send = useLoomWrite("reply");
  const change = useLoomWrite("ticketAction");
  const { busy: sending, error, run } = useRun();
  const { busy: acting, act: report } = useAction();
  const { syncing, sync } = useSyncPullRequests(remote.data?.slug ?? "");
  const busy = sending || acting;
  const now = useNow(30_000);
  const [tab, setTab] = useState<Tab>("activity");
  const [jumpTo, setJumpTo] = useState<{ postId: number; seq: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  // A new ticket opens on its activity.
  useEffect(() => {
    setTab("activity");
    setJumpTo(null);
  }, [ticketKey]);
  const ticket: TicketDetail | undefined = remote.data?.key === ticketKey ? remote.data : undefined;

  if (ticket === undefined) {
    return (
      <section data-ticket={ticketKey} aria-label={ticketKey} className="grid grid-cols-1 gap-2 p-3">
        {remote.error === null ? (
          <p role="status" className="m-0 text-sm text-[var(--loom-muted)]">
            Loading {ticketKey}…
          </p>
        ) : (
          <div role="alert" data-ticket-error className="grid grid-cols-1 gap-2">
            <p className="m-0 text-sm font-semibold">Could not load {ticketKey}</p>
            <p className="m-0 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">{remote.error}</p>
            <span className="flex gap-2">
              <button type="button" className={BUTTON} onClick={() => void remote.reload()}>
                Try again
              </button>
              {context !== undefined && (
                <button type="button" className={BUTTON} onClick={context.onClose}>
                  Close
                </button>
              )}
            </span>
          </div>
        )}
      </section>
    );
  }
  const past = ticket.at !== null;
  const shown = past ? ticket.now : now;
  const locked = busy || past;
  const reply = (body: string, parentId?: number) =>
    run(async () => {
      await send({ key: ticketKey, body, ...(parentId === undefined ? {} : { parentId }), confirm: true });
    });
  const act = (action: TicketAction, note: string) => report(() => change({ key: ticketKey, action, note, confirm: true }), `${ticketKey} ${ACTION_DONE[action]}`);
  const choose = (next: Tab) => {
    setTab(next);
    setJumpTo(null);
  };
  const jump = (postId: number) => {
    setTab("activity");
    setJumpTo((before) => ({ postId, seq: (before?.seq ?? 0) + 1 }));
  };
  const focusReply = () => {
    choose("activity");
    requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>("[data-new-reply] textarea")?.focus());
  };
  const { brief } = ticket.activity;
  const agents = ticket.threads.filter((thread) => thread.role === "worker" || thread.role === "reviewer").length;
  const conversations = ticket.threads.filter((thread) => (thread.role === "worker" || thread.role === "reviewer") && thread.threadId !== null).length;
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "activity", label: "Activity", count: ticket.activity.attempts.length },
    ...(threads && !past ? [{ id: "threads" as const, label: "Threads", count: conversations }] : []),
    { id: "brief", label: "Brief" },
    { id: "agents", label: "Agents", count: agents },
  ];
  const roveTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((entry) => entry.id === tab);
    const next = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    choose(tabs[next]!.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  const action =
    ticket.state === "blocked" ? (
      <BlockedAsk key={`${ticket.key}-${ticket.attempt}`} ticket={ticket} now={shown} busy={locked} onAction={act} onJump={jump} />
    ) : ticket.mergeConfirm !== null ? (
      <section data-ticket-actions aria-label="Confirm merge" className={`loom-card grid gap-2 rounded-md p-3 ${ticket.mergeConfirm.ready && !ticket.mergeConfirm.confirmed ? "loom-lead" : ""}`}>
        <MergeConfirm ticketKey={ticket.key} confirm={ticket.mergeConfirm} disabled={locked} then={context?.mergeThen ?? null} hold={context?.mergeHold ?? null} />
      </section>
    ) : null;

  return (
    <section ref={root} data-ticket={ticket.key} aria-label={`${ticket.key}, ${ticket.state.replace("_", " ")}`} className="flex min-w-0 flex-col gap-3">
      {past && (
        <p data-ticket-rewound className="m-0 flex flex-wrap items-center gap-3 rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm text-[var(--loom-warn)]">
          <span className="min-w-0 flex-1">
            Rewound to {momentLabel(ticket.now)}. This is {ticket.key} as it was then.
          </span>
          <button type="button" className={BUTTON} onClick={onNow}>
            Back to now
          </button>
        </p>
      )}
      <TicketHeader
        ticket={ticket}
        now={shown}
        busy={locked}
        onAction={act}
        index={context?.index}
        onOpen={context?.onOpen}
        onClose={context?.onClose}
        onReply={focusReply}
        onChanges={context?.onChanges}
        phaseLabel={context?.phaseLabel}
        sync={{ syncing, onSync: () => void sync(ticketKey) }}
      />
      {error !== null && (
        <p role="alert" className="m-0 text-xs text-[var(--loom-bad)]">
          {error}
        </p>
      )}
      {action}
      {!past && <DraftHold ticketKey={ticket.key} prUrl={ticket.prUrl} draft={ticket.draft} publishWait={ticket.publishWait} requested={ticket.releaseRequested} disabled={locked} />}
      {context?.map}
      <div className="grid grid-cols-1 min-w-0 gap-3">
        <div data-ticket-tabs role="tablist" aria-label={`${ticket.key} details`} onKeyDown={roveTabs} className="flex flex-wrap border-b border-[var(--loom-line)]">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} tabIndex={tab === entry.id ? 0 : -1} onClick={() => choose(entry.id)} className={`${TAB} ${tab === entry.id ? TAB_ON : TAB_OFF}`}>
              {entry.label}
              {entry.count !== undefined && <span className="loom-num text-xs font-normal text-[var(--loom-muted)]">{entry.count}</span>}
            </button>
          ))}
        </div>
        {tab === "activity" && (
          <div role="tabpanel" aria-label="Activity" className="grid grid-cols-1 gap-3">
            <Stream ticket={ticket} now={shown} busy={locked} onReply={reply} onBrief={() => choose("brief")} jumpTo={jumpTo} />
            {!past && (
              <div data-new-reply>
                <ReplyBox textLabel="New reply" sendLabel="Send reply" busy={busy} hint={replyHint(ticket.replyTo, ticket)} placeholder={`Reply on ${ticket.key}…`} onSend={(body) => reply(body)} />
              </div>
            )}
          </div>
        )}
        {tab === "threads" && (
          <div role="tabpanel" aria-label="Threads" className="grid grid-cols-1 gap-3">
            <Threads ticket={ticket} now={shown} />
            <div data-new-reply>
              <ReplyBox textLabel="New reply" sendLabel="Send reply" busy={busy} hint={replyHint(ticket.replyTo, ticket)} placeholder={`Reply on ${ticket.key}…`} onSend={(body) => reply(body)} />
            </div>
          </div>
        )}
        {tab === "brief" && (
          <div role="tabpanel" aria-label="Brief" data-ticket-brief className="grid grid-cols-1 gap-3">
            <p className="m-0 text-xs text-[var(--loom-muted)]">
              Written by the planner{brief !== null && brief.edits > 0 && `, edited ${plural(brief.edits, "time")} since (${brief.fields.join(", ")})`}. This is the brief the next worker reads.
            </p>
            <Markdown content={ticket.body} className="text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
            <Criteria ticket={ticket} />
            <ScopeFiles ticket={ticket} />
            <Verify ticket={ticket} />
          </div>
        )}
        {tab === "agents" && (
          <div role="tabpanel" aria-label="Agents" data-ticket-details>
            <Agents ticket={ticket} now={shown} />
          </div>
        )}
      </div>
    </section>
  );
}
