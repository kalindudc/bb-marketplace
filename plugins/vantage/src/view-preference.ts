export type VantageView = "worktrees" | "repositories";

export const VIEW_STORAGE_KEY = "bb-plugin-vantage:view";

export interface ViewPreference {
  get(): VantageView;
  set(view: VantageView): void;
  subscribe(listener: () => void): () => void;
}

export function createViewPreference(win: Window): ViewPreference {
  const storage = win.localStorage;
  const listeners = new Set<() => void>();
  const get = (): VantageView => (storage.getItem(VIEW_STORAGE_KEY) === "repositories" ? "repositories" : "worktrees");
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === VIEW_STORAGE_KEY || event.key === null) notify();
  };

  return {
    get,
    set(view) {
      if (view === get()) return;
      storage.setItem(VIEW_STORAGE_KEY, view);
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
