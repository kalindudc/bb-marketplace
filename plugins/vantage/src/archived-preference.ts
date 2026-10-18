export type ArchivedSurface = "page" | "panel";

export const ARCHIVED_STORAGE_KEYS: Record<ArchivedSurface, string> = {
  page: "bb-plugin-vantage:page-archived",
  panel: "bb-plugin-vantage:panel-archived",
};

// The full-screen page covers many threads, so it starts without archived work; the side tab is about one tree's children.
const DEFAULTS: Record<ArchivedSurface, boolean> = { page: false, panel: true };

export interface ArchivedPreference {
  get(): boolean;
  set(value: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createArchivedPreference(win: Window, surface: ArchivedSurface): ArchivedPreference {
  const storage = win.localStorage;
  const key = ARCHIVED_STORAGE_KEYS[surface];
  const listeners = new Set<() => void>();
  const get = (): boolean => {
    const stored = storage.getItem(key);
    return stored === "true" ? true : stored === "false" ? false : DEFAULTS[surface];
  };
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) notify();
  };

  return {
    get,
    set(value) {
      if (value === get()) return;
      storage.setItem(key, String(value));
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) win.addEventListener("storage", onStorage);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) win.removeEventListener("storage", onStorage);
      };
    },
  };
}
