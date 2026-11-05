import { useRef } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ConfirmButton, useAction, useLoomWrite } from "./common";
import type { TabBadge } from "./tab-badges";

const EDGE = { destructive: "border-l-destructive", warning: "border-l-warning" };

/** At the top of a tab with a badge: what the badge counts, the items behind it, and what makes it go away. */
export function BadgeNotice({ slug, tab, badge, onTicket }: { slug: string; tab: string; badge: TabBadge; onTicket(key: string): void }) {
  const navigate = useBbNavigate();
  const ackBadge = useLoomWrite("ackBadge");
  const { busy, act } = useAction();
  const ack = badge.ack;
  // The items as they were at the first click, so the second click acknowledges only what the human saw armed.
  const armedWith = useRef<string[]>([]);
  return (
    <section data-badge-notice={tab} aria-label="Why this tab has a badge" className={`space-y-1.5 rounded-md border border-l-4 border-border-seam bg-card px-3 py-2 ${EDGE[badge.tone]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[min(100%,16rem)] flex-1 text-sm">
          <b>{badge.label}.</b>{" "}
          <span className="text-muted-foreground">{badge.clears}</span>
        </p>
        {ack !== undefined && (
          <ConfirmButton
            // A new set of items disarms it: the button starts over, and the human sees the new items before acknowledging them.
            key={[...ack.items].sort().join("\n")}
            label="Acknowledge"
            confirmLabel="Click again to hide the badge"
            disabled={busy}
            onArm={() => (armedWith.current = [...ack.items])}
            onConfirm={() => void act(() => ackBadge({ slug, tab: ack.tab, items: armedWith.current, confirm: true }), "Badge hidden until something new comes up")}
          />
        )}
      </div>
      {badge.items.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {badge.items.map((item) => (
            <li key={item.id} data-badge-item={item.id} className="inline-flex min-w-0 items-center gap-1.5">
              {item.thread !== undefined ? (
                <button type="button" className="underline" onClick={() => navigate.toThread(item.thread!)}>
                  {item.text}
                </button>
              ) : item.ticket !== undefined ? (
                <button type="button" className="text-left underline [overflow-wrap:anywhere]" onClick={() => onTicket(item.ticket!)}>
                  {item.text}
                </button>
              ) : (
                <span className="[overflow-wrap:anywhere]">{item.text}</span>
              )}
              {item.url !== undefined && (
                <button type="button" aria-label={`Open ${item.ticket ?? item.text}'s pull request`} className="text-muted-foreground underline" onClick={() => navigate.openUrl(item.url!)}>
                  pull request
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
