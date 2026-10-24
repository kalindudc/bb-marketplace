import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { EventView } from "../contract";
import { ErrorNote, type Tone } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { ago } from "./format";

const ACTIVITY_LIMIT = 200;

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  ok: "border-success/40 text-success",
  bad: "border-destructive/40 text-destructive",
  warn: "border-warning/40 text-warning-text",
  info: "border-primary/40 text-primary",
  brand: "border-ring/40 text-foreground",
};

type Look = { icon: string; tone: Tone };

/** The kinds the server writes today; a kind it adds later shows with the plain glyph. */
const EVENT_LOOKS: Record<string, Look> = {
  review: { icon: "Bot", tone: "brand" },
  review_failed: { icon: "AlertTriangle", tone: "bad" },
  auto_failed: { icon: "AlertTriangle", tone: "bad" },
  auto_capped: { icon: "Pause", tone: "warn" },
  forwarded: { icon: "Sent", tone: "ok" },
  forward_failed: { icon: "AlertTriangle", tone: "bad" },
  sync_ok: { icon: "ArrowReloadHorizontal", tone: "neutral" },
  sync_failed: { icon: "AlertTriangle", tone: "bad" },
  linked: { icon: "Link", tone: "neutral" },
  unlinked: { icon: "Link", tone: "neutral" },
  watch: { icon: "Eye", tone: "ok" },
  config: { icon: "Settings", tone: "neutral" },
};
const PLAIN_LOOK: Look = { icon: "ListView", tone: "neutral" };

export function ActivityView({ onOpenPr, onOpenThread }: { onOpenPr(key: string): void; onOpenThread(threadId: string): void }) {
  const activity = useShuttleQuery("activity", { limit: ACTIVITY_LIMIT });
  const events = activity.data?.events;
  return (
    <section aria-label="Activity" className="min-w-0">
      <div className="px-4 pb-2.5 pt-3.5">
        <h2 className="text-sm font-semibold">Activity</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">What Shuttle did by itself, newest first.</p>
      </div>
      <div className="px-4 pb-4">
        {activity.error !== null && <ErrorNote>Could not load activity: {messageOf(activity.error)}</ErrorNote>}
        {events === undefined && activity.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
        {events?.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">Nothing yet.</div>}
        <ul>
          {events?.map((event: EventView) => {
            const look = EVENT_LOOKS[event.kind] ?? PLAIN_LOOK;
            return (
              <li key={event.id} data-event={event.kind} className="flex items-start gap-2.5 border-t border-border py-2.5">
                <span className={`inline-flex h-5 w-7 shrink-0 items-center justify-center rounded-full border ${TONE_CLASSES[look.tone]}`}>
                  <Icon name={look.icon} fallback="Circle" className="size-3" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <div>{event.text}</div>
                  <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {event.key !== null && (
                      <button type="button" className="cursor-pointer font-mono hover:underline" onClick={() => onOpenPr(event.key!)}>{event.key}</button>
                    )}
                    {event.threadId !== null && (
                      <button type="button" className="cursor-pointer hover:underline" onClick={() => onOpenThread(event.threadId!)}>Open thread</button>
                    )}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground" title={new Date(event.at).toLocaleString()}>{ago(event.at)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
