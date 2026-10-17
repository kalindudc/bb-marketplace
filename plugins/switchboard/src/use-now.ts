import { useEffect, useState } from "react";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / intervalMs) * intervalMs);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / intervalMs) * intervalMs), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
