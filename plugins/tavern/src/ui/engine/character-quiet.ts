import { useCallback, useSyncExternalStore } from "react";

const MAX_TIMER_MS = 2_147_483_647;

export function useCharacterQuiet(until = 0) {
  const active = useCallback(() => until > Date.now(), [until]);
  const subscribe = useCallback((notify: () => void) => {
    if (!active()) return () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      clearTimeout(timer);
      const left = until - Date.now();
      if (left > 0) timer = setTimeout(wake, Math.min(left, MAX_TIMER_MS));
      else {
        document.removeEventListener("visibilitychange", wake);
        notify();
      }
    };
    document.addEventListener("visibilitychange", wake);
    wake();
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [until, active]);
  return useSyncExternalStore(subscribe, active, active);
}
