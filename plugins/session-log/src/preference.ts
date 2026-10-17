export const EXPANDED_STORAGE_KEY = "bb-plugin-session-log:expanded";

export interface ExpandedPreference {
  isExpanded(): boolean;
  setExpanded(expanded: boolean): void;
  toggle(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createPreference(win: Window): ExpandedPreference {
  const storage = win.localStorage;
  const listeners = new Set<() => void>();
  const read = () => storage.getItem(EXPANDED_STORAGE_KEY) === "true";
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === EXPANDED_STORAGE_KEY || event.key === null) notify();
  };
  const setExpanded = (expanded: boolean) => {
    if (expanded === read()) return;
    storage.setItem(EXPANDED_STORAGE_KEY, String(expanded));
    notify();
  };

  return {
    isExpanded: read,
    setExpanded,
    toggle() {
      setExpanded(!read());
      return read();
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
