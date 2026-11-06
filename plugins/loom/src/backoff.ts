// How long Loom waits before it tries again a step whose last try failed in a way that the tick would otherwise repeat every
// 15 seconds for as long as it lasts: bringing a worker's commit home, sending a hand-back to a worker, running a submit's host
// steps. The wait is 15 seconds, then 30, 60 and 120, and 5 minutes from the fifth failure on, plus up to a tenth more so
// tickets that failed together do not retry together. The state is in memory, as the engine's other retry guards are, so a
// restart tries once at its first tick.
import type { Store } from "./db/store";

export const RETRY_STEPS_MS = [15_000, 30_000, 60_000, 120_000];
export const RETRY_LONGEST_MS = 300_000;
export const RETRY_JITTER = 0.1;

/** The wait after `failures` failures in a row (at least one). */
export function retryDelayMs(failures: number, random: () => number = Math.random): number {
  const step = RETRY_STEPS_MS[failures - 1] ?? RETRY_LONGEST_MS;
  return Math.round(step * (1 + RETRY_JITTER * random()));
}

export interface RetryState {
  failures: number;
  retryAt: number;
  message: string;
}

export class Retries {
  private readonly states = new Map<string | number, RetryState>();

  constructor(private readonly random: () => number = Math.random) {}

  /** Records one more failure of `key`. `changed` is true for the first failure and whenever `message` differs from the last one's, which is when to log it. */
  failed(key: string | number, now: number, message: string): RetryState & { changed: boolean } {
    const previous = this.states.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const state = { failures, retryAt: now + retryDelayMs(failures, this.random), message };
    this.states.set(key, state);
    return { ...state, changed: previous?.message !== message };
  }

  /** How long until `key` may be tried again; 0 when it may be now. */
  waitMs(key: string | number, now: number): number {
    return Math.max(0, (this.states.get(key)?.retryAt ?? 0) - now);
  }

  state(key: string | number): RetryState | null {
    return this.states.get(key) ?? null;
  }

  reset(key: string | number): void {
    this.states.delete(key);
  }
}

export interface StoreRetries {
  /** Bringing an ending worker's work home, by thread row id. */
  ending: Retries;
  /** A submit whose host steps got no answer, by ticket id. */
  checks: Retries;
  /** A hand-back bb did not take, by ticket id and worker thread, so a new worker does not wait out the old one's failures. */
  sends: Retries;
}

const byStore = new WeakMap<Store, StoreRetries>();

export const retriesOf = (store: Store): StoreRetries => byStore.get(store) ?? byStore.set(store, { ending: new Retries(), checks: new Retries(), sends: new Retries() }).get(store)!;
