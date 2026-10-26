import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { EventView } from "../contract";
import { ErrorNote, type Tone } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { age, ago } from "./format";

const ACTIVITY_LIMIT = 200;

export const TONE_ICON: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  ok: "text-success",
  bad: "text-destructive",
  warn: "text-warning-text",
  info: "text-primary",
  brand: "text-foreground",
};

type Look = { icon: string; tone: Tone };

/** The kinds the server writes; a kind it adds later shows with the plain glyph. */
const EVENT_LOOKS: Record<string, Look> = {
  review: { icon: "Bot", tone: "info" },
  review_done: { icon: "Bot", tone: "info" },
  review_failed: { icon: "AlertTriangle", tone: "bad" },
  auto_failed: { icon: "AlertTriangle", tone: "bad" },
  auto_capped: { icon: "Pause", tone: "warn" },
  forwarded: { icon: "Sent", tone: "info" },
  forward_failed: { icon: "AlertTriangle", tone: "bad" },
  sync_ok: { icon: "ArrowReloadHorizontal", tone: "neutral" },
  sync_failed: { icon: "AlertTriangle", tone: "bad" },
  sync_partial: { icon: "AlertTriangle", tone: "warn" },
  section_failed: { icon: "AlertTriangle", tone: "bad" },
  linked: { icon: "Link", tone: "neutral" },
  unlinked: { icon: "Link", tone: "neutral" },
  watch: { icon: "Bot", tone: "neutral" },
  auto_agent: { icon: "Bot", tone: "info" },
  outcome: { icon: "GitCommit", tone: "ok" },
  draft: { icon: "Check", tone: "info" },
  merged: { icon: "GitMerge", tone: "ok" },
  auto_merge: { icon: "GitMerge", tone: "neutral" },
  commented: { icon: "MessageSquare", tone: "neutral" },
  reviewed: { icon: "Check", tone: "neutral" },
  replied: { icon: "MessageSquare", tone: "neutral" },
  resolved: { icon: "Check", tone: "neutral" },
  asked_agent: { icon: "Bot", tone: "neutral" },
  tracked: { icon: "Pin", tone: "neutral" },
  snoozed: { icon: "Clock", tone: "neutral" },
  archived: { icon: "Archive", tone: "neutral" },
  revived: { icon: "ArchiveRestore", tone: "neutral" },
  revive_failed: { icon: "AlertTriangle", tone: "warn" },
  handled: { icon: "UserRound", tone: "neutral" },
  edit: { icon: "Edit", tone: "neutral" },
  config: { icon: "Settings", tone: "neutral" },
};
const PLAIN_LOOK: Look = { icon: "ListView", tone: "neutral" };

export const lookOf = (kind: string): Look => EVENT_LOOKS[kind] ?? PLAIN_LOOK;

export function EventIcon({ kind }: { kind: string }) {
  const look = lookOf(kind);
  return <Icon name={look.icon} fallback="Circle" className={`mt-0.5 size-3.5 shrink-0 ${TONE_ICON[look.tone]}`} aria-hidden />;
}

/** Everything Shuttle did by itself, newest first: the Automation log under Insights. */
export function ActivityView({ onOpenPr, onOpenThread }: { onOpenPr(key: string): void; onOpenThread(threadId: string): void }) {
  const activity = useShuttleQuery("activity", { limit: ACTIVITY_LIMIT });
  const events = activity.data?.events;
  return (
    <div aria-label="Automation log" className="min-w-0">
      {activity.error !== null && <ErrorNote>Could not load the automation log: {messageOf(activity.error)}</ErrorNote>}
      {events === undefined && activity.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {events?.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">Nothing yet.</div>}
      {events !== undefined && events.length > 0 && (
        <ul className="rounded-lg border border-border bg-card px-3">
          {events.map((event: EventView) => (
            <li key={event.id} data-event={event.kind} className="flex items-start gap-2.5 border-t border-border py-2 first:border-t-0">
              <EventIcon kind={event.kind} />
              <div className="min-w-0 flex-1 text-[13px]">
                <div>{event.text}</div>
                {(event.key !== null || event.threadId !== null) && (
                  <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {event.key !== null && <button type="button" className="cursor-pointer font-mono hover:underline" onClick={() => onOpenPr(event.key!)}>{event.key}</button>}
                    {event.threadId !== null && <button type="button" className="cursor-pointer hover:underline" onClick={() => onOpenThread(event.threadId!)}>Open thread</button>}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground" title={`${new Date(event.at).toLocaleString()} (${ago(event.at)})`}>{age(event.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
