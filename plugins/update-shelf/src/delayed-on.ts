import { useEffect, useState } from "react";

/**
 * True once `active` has stayed on for `delayMs`, and false again as soon as it turns off. Placeholders wait this
 * long so an answer that arrives immediately never flashes one.
 */
export function useDelayedOn(active: boolean, delayMs: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const timer = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return on;
}
