// Whether the journal's card section is actually on screen, so the context-row segment knows when the pane already shows it.
//
// bb reports `experimental_useThreadContextKind() === "card"` for any pane whose layout is not the banner, even while the card
// itself is hidden (bb draws the card `hidden` unless it is revealed, or pinned with content). A segment that trusted the kind
// vanished with the card. So the segment hides only when it can see the card's own container is shown; anything else (no card
// found, a section that never mounted) reads as not shown and leaves the segment above the composer. The approach is the one
// the Wakeup plugin uses (plugins/wakeup/src/app/card-shown.ts), copied rather than imported.
//
// Known limit: the store is keyed by thread, not by pane, because bb's SDK exposes no pane id. Two card-layout panes of one
// thread where only one shows its card both hide the segment.
import { useCallback, useRef, useSyncExternalStore } from "react";

/** bb's card container; its `hidden` attribute is how bb shows and hides it. */
const CARD = "[data-thread-context-card]";

const shown = new Map<string, Map<symbol, boolean>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;

/** True only while a journal card section for the thread sits inside a shown card; false when hidden, unmounted or not found. */
export function useCardShown(threadId: string): boolean {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const byThread = shown.get(threadId);
  if (!byThread) return false;
  for (const visible of byThread.values()) if (visible) return true;
  return false;
}

function report(threadId: string, key: symbol, visible: boolean | null) {
  const byThread = shown.get(threadId);
  if (visible === null ? !byThread?.has(key) : byThread?.get(key) === visible) return;
  const next = byThread ?? new Map<symbol, boolean>();
  if (visible === null) next.delete(key);
  else next.set(key, visible);
  if (next.size === 0) shown.delete(threadId);
  else shown.set(threadId, next);
  emit();
}

/**
 * A callback ref for the card section's root: reports whether it sits inside a shown thread context card, following `hidden`.
 * A callback ref, not a ref object, because the section draws nothing until its data loads, so the element mounts on a later
 * render than the hook and an effect keyed on the thread alone would never see it.
 */
export function useCardShownRef(threadId: string): (element: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((element: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    const card = element?.closest<HTMLElement>(CARD);
    if (!card || typeof MutationObserver === "undefined") return;
    const key = Symbol(threadId);
    const read = () => !card.hidden;
    report(threadId, key, read());
    const observer = new MutationObserver(() => report(threadId, key, read()));
    observer.observe(card, { attributes: true, attributeFilter: ["hidden"] });
    cleanup.current = () => { observer.disconnect(); report(threadId, key, null); };
  }, [threadId]);
}
