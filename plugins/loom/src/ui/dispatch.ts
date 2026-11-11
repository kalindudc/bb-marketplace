// State the page, its title bar, its sidebar and bb's palette share: the rewound moment, which guards every write, and the
// overlays any of them can open. Each is a small store outside React, because those surfaces are separate React trees.
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type Store<T> = ReturnType<typeof createStore<T>>;

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The project the page shows rewound, and the event it shows it at; null while every view is live. */
export const rewind = createStore<{ slug: string; at: number } | null>(null);

export const useRewound = (): boolean => useStore(rewind) !== null;

/** What a control refused while rewound says, in its tooltip and in the toast. */
export const REWOUND_REASON = "Read-only while rewound: go back to now to act";

export class RewoundError extends Error {
  constructor() {
    super(REWOUND_REASON);
    this.name = "RewoundError";
  }
}

/**
 * The one rewind guard: every write that changes a project goes through it, from a button, the title bar's menu, the
 * palette or a key. Rewound, it refuses with a toast instead of sending, so no path round the disabled buttons can act.
 */
export function guardWrite(method: string): void {
  if (rewind.get() === null || !PROJECT_WRITES.has(method)) return;
  toast.error(REWOUND_REASON);
  throw new RewoundError();
}

// Forge profiles live in bb's Settings, apart from any project, so a rewound page leaves them alone.
const PROJECT_WRITES = new Set(["ackBadge", "askStepDone", "confirmMerge", "control", "dismissAsk", "markLive", "messagePlanner", "releaseDraft", "reply", "sendNotes", "syncPullRequests", "ticketAction", "startPlanning", "answerQuestions"]);

/** The page's own overlays, which the title bar and bb's palette open too. */
export const palette = createStore(false);
export const keysSheet = createStore(false);

/** Set by bb's "next thing that needs you" command; the page opens that item once home has loaded. */
export const intent = createStore<"next" | null>(null);

/** The ticket whose answer note Home opened it to write: its question form focuses the note once, then clears this. */
export const focusNote = createStore<string | null>(null);
