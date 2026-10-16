export const ENABLED_STORAGE_KEY = "bb-plugin-follow-thinking:enabled";

export interface FollowThinkingPreference {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /** Flips the preference and returns the new value. */
  toggle(): boolean;
  subscribe(listener: () => void): () => void;
}

/**
 * The on/off switch, kept in localStorage so it survives reloads and is shared
 * by every bb window on this machine. It defaults to on.
 */
export function createPreference(win: Window): FollowThinkingPreference {
  const storage = win.localStorage;
  const listeners = new Set<() => void>();
  const read = () => storage.getItem(ENABLED_STORAGE_KEY) !== "false";
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const onStorage = (event: StorageEvent) => {
    // A null key means another window cleared the whole storage area.
    if (event.key === ENABLED_STORAGE_KEY || event.key === null) notify();
  };

  const setEnabled = (enabled: boolean) => {
    if (enabled === read()) return;
    storage.setItem(ENABLED_STORAGE_KEY, String(enabled));
    notify();
  };

  return {
    isEnabled: read,
    setEnabled,
    toggle() {
      setEnabled(!read());
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
