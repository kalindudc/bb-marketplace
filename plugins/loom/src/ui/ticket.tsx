import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, TicketAction, TicketDetail } from "../contract";
import { plural } from "../format";
import { useRemote, useRun } from "./common";
import { TicketHeader } from "./ticket-header";
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

/** The sticky side column. Its height cap is measured, 16 px above the bottom of the page's scroller or of the window, whichever comes first; the CSS cap stays where nothing is laid out. */
function SideColumn({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const side = root.current!;
    const scroller = side.closest("[data-loom-scroll]");
    if (scroller === null) return;
    const fit = () => {
      const box = scroller.getBoundingClientRect();
      const top = parseFloat(getComputedStyle(side).top);
      side.style.maxHeight = box.height > 0 ? `${Math.min(window.innerHeight, box.bottom) - box.top - (Number.isNaN(top) ? 0 : top) - 16}px` : "";
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <aside ref={root} data-ticket-side className="hidden flex-col gap-3 @4xl:sticky @4xl:top-4 @4xl:flex @4xl:max-h-[calc(100dvh-6rem)] @4xl:self-start @4xl:overflow-y-auto">
      {children}
    </aside>
  );
}

export function TicketView({ slug, ticketKey }: { slug: string; ticketKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const remote = useRemote((client) => client.call("ticket", { key: ticketKey }), `ticket:${ticketKey}`, slug);
  const { busy, error, run } = useRun();
  const now = useNow(30_000);
  const [tab, setTab] = useState<Tab>("activity");
  const [jumpTo, setJumpTo] = useState<{ postId: number; seq: number } | null>(null);
  const ticket: TicketDetail | null = remote.data;

  if (ticket === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load {ticketKey}: {remote.error}</p>;
  }
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
  const { brief } = ticket.activity;
  // While Details is chosen, a wide page shows the stream with Activity marked, so widening the page shows the stream once.
  const activityTone = tab === "activity" ? TAB_ON : tab === "details" ? `${TAB_OFF} @4xl:border-foreground @4xl:font-semibold @4xl:text-foreground` : TAB_OFF;

  return (
    <div data-ticket={ticket.key} className="@container mx-auto w-full max-w-6xl space-y-4 p-4">
      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_300px]">
        <TicketHeader ticket={ticket} now={now} busy={busy} onAction={act} onJump={jump} />
        {error !== null && (
          <p role="alert" className="text-xs text-destructive-text @4xl:col-span-2">
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
          </div>
          {tab !== "brief" && (
            <div className={`space-y-3 ${tab === "details" ? "hidden @4xl:block" : ""}`}>
              <Stream ticket={ticket} now={now} busy={busy} onReply={reply} onBrief={() => choose("brief")} jumpTo={jumpTo} />
              <ReplyBox textLabel="New reply" sendLabel="Send reply" busy={busy} hint={replyHint(ticket.replyTo)} placeholder={`Write on ${ticket.key}…`} onSend={(body) => reply(body)} />
            </div>
          )}
          {tab === "details" && (
            <div data-ticket-details className="space-y-3 @4xl:hidden">
              <SideCards ticket={ticket} now={now} />
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
        <SideColumn>
          <SideCards ticket={ticket} now={now} />
        </SideColumn>
      </div>
    </div>
  );
}
