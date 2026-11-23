import { useCallback, useEffect, useRef, useState } from "react";

export const FEEDBACK_MS = 8000;

/**
 * A one-line result that clears itself after `FEEDBACK_MS`, so a refusal never outlives the state
 * it described. Render its text inside an element that stays mounted (a live region).
 */
export function useFeedback(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const show = useCallback((next: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    setText(next);
    timer.current = next ? setTimeout(() => { timer.current = null; setText(""); }, FEEDBACK_MS) : null;
  }, []);
  return [text, show];
}

/**
 * A synchronous guard for writes. The SDK's `isPending` arrives a tick after `mutate` starts, so a
 * quick second click could send the same write twice; this one is set before the call goes out.
 */
export function useInflight<K>(): { has(key: K): boolean; run(key: K, task: () => Promise<void>): Promise<void> } {
  const keys = useRef(new Set<K>());
  const [, rerender] = useState(0);
  const run = useCallback(async (key: K, task: () => Promise<void>) => {
    if (keys.current.has(key)) return;
    keys.current.add(key);
    rerender((n) => n + 1);
    try {
      await task();
    } finally {
      keys.current.delete(key);
      rerender((n) => n + 1);
    }
  }, []);
  return { has: (key: K) => keys.current.has(key), run };
}

export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/**
 * The current time, read again whenever `value` changes and then every `everyMs`: once a second
 * while something counts down, and slowly otherwise so "N min ago" keeps moving.
 */
export function useNow(everyMs: number, value: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, value]);
  return now;
}

/** When this value was received: the base for the status's `remainingSeconds` countdowns. */
export function useReceivedAt(value: unknown): number {
  const seen = useRef<{ value: unknown; at: number } | null>(null);
  if (seen.current === null || seen.current.value !== value) seen.current = { value, at: Date.now() };
  return seen.current.at;
}

/** Remembers the previous distinct value, for spotting a transition between two reads. */
export function usePrevious<T>(value: T): T | undefined {
  const state = useRef<{ current: T; previous: T | undefined }>({ current: value, previous: undefined });
  if (state.current.current !== value) state.current = { current: value, previous: state.current.current };
  return state.current.previous;
}
