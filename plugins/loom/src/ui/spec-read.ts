// The spec versions this page tried and could not read, per project, so an Approve elsewhere on the page says the person
// approves a version they have not seen ("Yes, approve v21 unread"). Kept in memory: a reload reads them again.
import { useSyncExternalStore } from "react";

const unread = new Map<string, ReadonlySet<number>>();
const listeners = new Set<() => void>();
const NONE: ReadonlySet<number> = new Set();

export function markUnread(slug: string, version: number, on: boolean): void {
  const now = unread.get(slug) ?? NONE;
  if (now.has(version) === on) return;
  const next = new Set(now);
  if (on) next.add(version);
  else next.delete(version);
  unread.set(slug, next);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useUnread(slug: string): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, () => unread.get(slug) ?? NONE);
}

/** For tests: forget every unread version. */
export function resetUnread(): void {
  unread.clear();
  for (const listener of listeners) listener();
}
