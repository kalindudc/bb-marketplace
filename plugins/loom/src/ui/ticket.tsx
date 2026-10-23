import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, TicketAction, TicketDetail } from "../contract";
import { plural } from "../format";
import { BUTTON, momentLabel, useRemote, useRun } from "./common";
import { TicketHeader } from "./ticket-header";
import { GHOST } from "./ticket-cards";
import { SideCards } from "./ticket-side";
import { ReplyBox, replyHint, Stream } from "./ticket-stream";

type Tab = "activity" | "brief" | "details";

const TAB = "cursor-pointer border-b-2 px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const TAB_ON = "border-foreground font-semibold text-foreground";
const TAB_OFF = "border-transparent text-muted-foreground hover:text-foreground";

/** The time, again every `ms`, so ages and "for 7m" stay current between refreshes. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const SIDE_OPEN_KEY = "loom.ticket.sideOpen";
/** The gap the pinned side column keeps above and below it in the page's scroller. */
const PIN_GAP = 16;

// Storage can be unavailable: then the side column starts open and the choice is not remembered.
function savedSideOpen(): boolean {
  try {
    return localStorage.getItem(SIDE_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveSideOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDE_OPEN_KEY, String(open));
  } catch {}
}

/**
 * The side column scrolls with the page and never on its own. It stays pinned beside the activity only while all of it
 * fits in the page's scroller (or the window, whichever ends first); a taller one scrolls away with the page.
 */
function SideColumn({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const side = root.current!;
    const scroller = side.closest("[data-loom-scroll]");
    const fit = () => {
      const box = scroller?.getBoundingClientRect();
      const room = box === undefined || box.height === 0 ? 0 : Math.min(window.innerHeight, box.bottom) - Math.max(0, box.top) - 2 * PIN_GAP;
      setPinned(side.offsetHeight > 0 && side.offsetHeight <= room);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(side);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);
  return (
    <aside ref={root} data-ticket-side data-pinned={pinned ? "true" : "false"} className={`hidden min-w-0 flex-col gap-3 @4xl:flex @4xl:self-start ${pinned ? "@4xl:sticky @4xl:top-4" : ""}`}>
      {children}
    </aside>
  );
}

/** With `at`, the ticket as it was at that event, with every control disabled. */
export function TicketView({ slug, ticketKey, at = null, onNow }: { slug: string; ticketKey: string; at?: number | null; onNow?(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const remote = useRemote((client) => client.call("ticket", at === null ? { key: ticketKey } : { key: ticketKey, at }), at === null ? `ticket:${ticketKey}` : `ticket:${ticketKey}@${at}`, slug);
  const { busy, error, run } = useRun();
  const now = useNow(30_000);
  const [tab, setTab] = useState<Tab>("activity");
  const [jumpTo, setJumpTo] = useState<{ postId: number; seq: number } | null>(null);
  const [sideOpen, setSideOpen] = useState(savedSideOpen);
  const ticket: TicketDetail | null = remote.data;

  if (ticket === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load {ticketKey}: {remote.error}</p>;
  }
  const past = ticket.at !== null;
  const shown = past ? ticket.now : now;
  const locked = busy || past;
  const reply = (body: string, parentId?: number) =>
    run(async () => {
      remote.set(await rpc.call("reply", { key: ticketKey, body, ...(parentId === undefined ? {} : { parentId }), confirm: true }));
    });
  const act = (action: TicketAction, note: string) =>
    run(async () => {
      remote.set(await rpc.call("ticketAction", { key: ticketKey, action, note, confirm: true }));
    });
  const choose = (next: Tab) => {
    setTab(next);
    setJumpTo(null);
  };
  const jump = (postId: number) => {
    setTab("activity");
    setJumpTo((before) => ({ postId, seq: (before?.seq ?? 0) + 1 }));
  };
  const toggleSide = () => {
    saveSideOpen(!sideOpen);
    setSideOpen(!sideOpen);
  };
  const { brief } = ticket.activity;
  // While Details is chosen, a wide page shows the stream with Activity marked, so widening the page shows the stream once.
  const activityTone = tab === "activity" ? TAB_ON : tab === "details" ? `${TAB_OFF} @4xl:border-foreground @4xl:font-semibold @4xl:text-foreground` : TAB_OFF;

  return (
    <div data-ticket={ticket.key} className="@container mx-auto w-full max-w-[90rem] space-y-4 p-4">
      {past && (
        <p data-ticket-rewound className="flex flex-wrap items-center gap-3 rounded-md border border-warning bg-warning/10 px-4 py-2 text-sm text-warning-text">
          <span className="min-w-0 flex-1">
            Rewound to {momentLabel(ticket.now)}. This is {ticket.key} as it was then.
          </span>
          <button type="button" className={BUTTON} onClick={onNow}>
            Back to now
          </button>
        </p>
      )}
      <div data-ticket-grid className={`grid gap-4 ${sideOpen ? "@4xl:grid-cols-[minmax(0,1fr)_20rem] @6xl:grid-cols-[minmax(0,1fr)_24rem]" : ""}`}>
        <TicketHeader ticket={ticket} now={shown} busy={locked} onAction={act} onJump={jump} />
        {error !== null && (
          <p role="alert" className="col-span-full text-xs text-destructive-text">
            {error}
          </p>
        )}
        <div className="min-w-0 space-y-3">
          <div data-ticket-tabs role="tablist" className="flex border-b border-border-seam">
            <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => choose("activity")} className={`${TAB} ${activityTone}`}>
              Activity <span className="text-xs font-normal text-subtle-foreground">{plural(ticket.activity.attempts.length, "attempt")}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "brief"} onClick={() => choose("brief")} className={`${TAB} ${tab === "brief" ? TAB_ON : TAB_OFF}`}>
              Brief
            </button>
            <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => choose("details")} className={`${TAB} @4xl:hidden ${tab === "details" ? TAB_ON : TAB_OFF}`}>
              Details
            </button>
            <span className="flex-1" />
            <button type="button" data-side-toggle aria-expanded={sideOpen} onClick={toggleSide} className={`${GHOST} hidden self-center @4xl:inline-flex`}>
              <Icon name="ChevronRight" aria-hidden className={`size-3.5 ${sideOpen ? "" : "rotate-180"}`} />
              {sideOpen ? "Hide details" : "Show details"}
            </button>
          </div>
          {tab !== "brief" && (
            <div className={`space-y-3 ${tab === "details" ? "hidden @4xl:block" : ""}`}>
              <Stream ticket={ticket} now={shown} busy={locked} onReply={reply} onBrief={() => choose("brief")} jumpTo={jumpTo} />
              {!past && <ReplyBox textLabel="New reply" sendLabel="Send reply" busy={busy} hint={replyHint(ticket.replyTo, ticket)} placeholder={`Write on ${ticket.key}…`} onSend={(body) => reply(body)} />}
            </div>
          )}
          {tab === "details" && (
            <div data-ticket-details className="space-y-3 @4xl:hidden">
              <SideCards ticket={ticket} now={shown} />
            </div>
          )}
          {tab === "brief" && (
            <section data-ticket-brief className="space-y-3 rounded-lg border border-border-seam bg-card p-4">
              <p className="text-xs text-muted-foreground">
                Written by the planner{brief !== null && brief.edits > 0 && `, edited ${plural(brief.edits, "time")} since (${brief.fields.join(", ")})`}. This is the brief the next worker reads.
              </p>
              <Markdown content={ticket.body} className="text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
            </section>
          )}
        </div>
        {sideOpen && (
          <SideColumn>
            <SideCards ticket={ticket} now={shown} />
          </SideColumn>
        )}
      </div>
    </div>
  );
}
