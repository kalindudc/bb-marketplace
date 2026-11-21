import { useEffect, useMemo, useRef } from "react";
import { experimental_useSidebarThreads, useBbContext, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { needsYou, useSidebarIndex, type SidebarIndex } from "./live";

export interface Attention {
  id: string;
  title: string;
  failed: boolean;
}

// Threads that wait for your answer or whose last turn failed, the same ones bb's sidebar marks.
export function attentionOf(live: SidebarIndex): Attention[] {
  const out: Attention[] = [];
  for (const thread of live.values()) {
    if (thread.isArchived || thread.isHidden) continue;
    if (!needsYou({ indicator: thread.indicator, archived: thread.isArchived })) continue;
    out.push({ id: thread.id, title: thread.displayTitle, failed: thread.indicator === "unread-error" });
  }
  return out;
}

// Toasts are a setting; nothing shows until bb has said what it is.
function useAlerts(): { toasts: boolean; loaded: boolean } {
  const { values } = useSettings();
  return { toasts: values?.toasts === true, loaded: values !== undefined };
}

// The threads to toast: new since the last look, not the one on screen. The first look is what was already waiting before
// this window opened, which bb's own sidebar shows. With toasts off nothing is toasted, but what was seen still moves on,
// so turning them on does not toast everything already waiting.
export function toastsFor(
  seen: ReadonlySet<string> | null,
  attention: readonly Attention[],
  onScreen: string | null,
  enabled: boolean,
): Attention[] {
  if (seen === null || !enabled) return [];
  return attention.filter((entry) => !seen.has(entry.id) && entry.id !== onScreen);
}

export function AttentionToasts() {
  const live = useSidebarIndex();
  const { status } = experimental_useSidebarThreads();
  const { toasts, loaded } = useAlerts();
  const attention = useMemo(() => attentionOf(live), [live]);
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded || status !== "ready") return;
    for (const entry of toastsFor(seen.current, attention, threadId, toasts)) {
      toast(entry.failed ? `${entry.title} failed` : `${entry.title} needs you`, {
        action: { label: "Open", onClick: () => navigate.toThread(entry.id) },
      });
    }
    seen.current = new Set(attention.map((entry) => entry.id));
  }, [attention, loaded, status, toasts, threadId, navigate]);
  return null;
}
