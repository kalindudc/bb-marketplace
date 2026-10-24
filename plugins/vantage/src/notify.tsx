import { useEffect, useMemo, useRef } from "react";
import { experimental_useSidebarThreads, useBbContext, useBbNavigate, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { needsYou, useSidebarIndex, type SidebarIndex } from "./live";
import { parentLookup, resolvePref, usePrefsState } from "./prefs";
import type { Prefs } from "./contract";

export interface Attention { id: string; title: string; failed: boolean }

// Threads Vantage watches, directly or through an ancestor, that wait for you or failed. Nothing is watched by default.
export function watchedAttention(live: SidebarIndex, prefs: Prefs): Attention[] {
  const parentOf = parentLookup(live.values());
  const out: Attention[] = [];
  for (const thread of live.values()) {
    if (thread.isArchived || thread.isHidden) continue;
    const state = { indicator: thread.indicator, archived: thread.isArchived };
    if (!needsYou(state) || !resolvePref(prefs, "watch", thread.id, parentOf).on) continue;
    out.push({ id: thread.id, title: thread.displayTitle, failed: thread.indicator === "unread-error" });
  }
  return out;
}

function useAttention(): { attention: Attention[]; ready: boolean } {
  const live = useSidebarIndex();
  const { status } = experimental_useSidebarThreads();
  const { prefs, loaded } = usePrefsState();
  const attention = useMemo(() => watchedAttention(live, prefs), [live, prefs]);
  return { attention, ready: loaded && status === "ready" };
}

export function useVantageBadge(): ExperimentalBadge | null {
  const { attention } = useAttention();
  if (attention.length === 0) return null;
  const count = attention.length;
  return { count, tone: "warning", label: `${count} watched ${count === 1 ? "thread needs" : "threads need"} you` };
}

// A toast when a watched thread starts waiting for you or fails, unless it is the thread on screen.
export function AttentionToasts() {
  const { attention, ready } = useAttention();
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const now = new Set(attention.map((entry) => entry.id));
    // The first answer is what was already waiting before this window opened, which bb's own sidebar already shows.
    if (seen.current === null) {
      seen.current = now;
      return;
    }
    for (const entry of attention) {
      if (seen.current.has(entry.id) || entry.id === threadId) continue;
      toast(entry.failed ? `${entry.title} failed` : `${entry.title} needs you`, {
        action: { label: "Open", onClick: () => navigate.toThread(entry.id) },
      });
    }
    seen.current = now;
  }, [attention, ready, threadId, navigate]);
  return null;
}
