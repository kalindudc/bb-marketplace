import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ActionButton, useAction, useLoomWrite } from "./common";
import type { TabBadge } from "./tab-badges";

const EDGE = { destructive: "border-l-destructive", warning: "border-l-warning" };

/**
 * At the top of a tab with a badge: what the badge counts, the items behind it, and what makes it go away. `listed`
 * leaves the items out where the view below already lists them first (Work's Needs you).
 */
export function BadgeNotice({ slug, tab, badge, onTicket, listed = false }: { slug: string; tab: string; badge: TabBadge; onTicket(key: string): void; listed?: boolean }) {
  const navigate = useBbNavigate();
  const ackBadge = useLoomWrite("ackBadge");
  const { busy, act } = useAction();
  const ack = badge.ack;
  // The items as they were at the first click, so the second click acknowledges only what the human saw armed.
  return (
    <section data-badge-notice={tab} aria-label="Why this tab has a badge" className={`space-y-1.5 rounded-md border border-l-4 border-border-seam bg-card px-3 py-2 ${EDGE[badge.tone]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[min(100%,16rem)] flex-1 text-sm">
          <b>{badge.label}.</b>{" "}
          {/* Where the view lists the items first, a phone keeps the notice to its one line. */}
          <span className={`text-[var(--loom-muted)] ${listed ? "@max-xl/loom:hidden" : ""}`}>{badge.clears}</span>
        </p>
        {ack !== undefined && (
          <ActionButton
            label="Acknowledge"
            title="Hides the badge until something new comes up"
            disabled={busy}
            // Acknowledges the items shown when it was clicked, so one that arrives meanwhile keeps the badge.
            onClick={() => void act(() => ackBadge({ slug, tab: ack.tab, items: [...ack.items], confirm: true }), "Badge hidden until something new comes up")}
          />
        )}
      </div>
      {badge.items.length > 0 && !listed && (
        <ul className="flex flex-wrap gap-x-3 text-xs">
          {badge.items.map((item) => (
            <li key={item.id} data-badge-item={item.id} className="inline-flex min-w-0 items-center gap-1.5">
              {item.thread !== undefined ? (
                <button type="button" className="min-h-6 cursor-pointer @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11 underline" onClick={() => navigate.toThread(item.thread!)}>
                  {item.text}
                </button>
              ) : item.ticket !== undefined ? (
                <button type="button" className="min-h-6 cursor-pointer @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11 text-left underline [overflow-wrap:anywhere]" onClick={() => onTicket(item.ticket!)}>
                  {item.text}
                </button>
              ) : (
                <span className="[overflow-wrap:anywhere]">{item.text}</span>
              )}
              {item.url !== undefined && (
                <button type="button" aria-label={`Open ${item.ticket ?? item.text}'s pull request`} className="text-[var(--loom-muted)] underline" onClick={() => navigate.openUrl(item.url!)}>
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
