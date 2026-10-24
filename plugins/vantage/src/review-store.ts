import { reviewMarksSchema, type ReviewMarks, type SetReviewedInput } from "./contract";

export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const REVIEWED_PREFIX = "reviewed:";
const MAX_MARKS = 2000;
// bb caps a kv row at 256 KiB of UTF-8.
const MAX_ROW_BYTES = 200_000;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

// Entry by entry, so one bad mark does not throw away every other tick of the worktree.
function parseMarks(value: unknown): ReviewMarks {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ReviewMarks = {};
  for (const [mark, signature] of Object.entries(value)) {
    if (reviewMarksSchema.safeParse({ [mark]: signature }).success) out[mark] = signature as string;
  }
  return out;
}

// Drops the oldest entries, the first in insertion order, until the row fits.
function fit<T>(entries: Array<[string, T]>, max: number): Record<string, T> {
  let kept = entries.slice(-max);
  while (kept.length > 0 && bytes(Object.fromEntries(kept)) > MAX_ROW_BYTES) kept = kept.slice(Math.ceil(kept.length / 10));
  return Object.fromEntries(kept);
}

// Reviewed marks, one kv row per worktree. Versions before 0.7 also kept per-thread watch and review choices in a
// "prefs" row; nothing reads it now.
export function createReviewStore(kv: () => KvStorage) {
  // Two quick writes to one row must not read the same old value.
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(run, run);
    const settled = next.then(() => {}, () => {});
    chains.set(key, settled);
    void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
    return next;
  };

  return {
    async reviewed(keys: readonly string[]): Promise<Record<string, ReviewMarks>> {
      const rows = await Promise.all(keys.map(async (key) => [key, parseMarks(await kv().get(REVIEWED_PREFIX + key))] as const));
      return Object.fromEntries(rows);
    },
    setReviewed(input: SetReviewedInput): Promise<ReviewMarks> {
      const row = REVIEWED_PREFIX + input.key;
      return serial(row, async () => {
        const current = parseMarks(await kv().get(row));
        for (const { mark, signature } of input.marks) {
          delete current[mark];
          if (signature !== null) current[mark] = signature;
        }
        const next = fit(Object.entries(current), MAX_MARKS);
        if (Object.keys(next).length === 0) await kv().delete(row);
        else await kv().set(row, next);
        return next;
      });
    },
  };
}
