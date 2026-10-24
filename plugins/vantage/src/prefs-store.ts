import { reviewMarksSchema, threadPrefSchema, type ReviewMarks, type SetReviewedInput, type SetThreadPrefInput, type ThreadPref } from "./contract";

export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const PREFS_KEY = "prefs";
const REVIEWED_PREFIX = "reviewed:";
const MAX_THREAD_PREFS = 5000;
const MAX_MARKS = 2000;
// bb caps a kv row at 256 KiB of UTF-8.
const MAX_ROW_BYTES = 200_000;
const MAX_THREAD_ID = 4096;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

// Stored rows are parsed on the way in, so a row an older version wrote cannot break the reply.
function parsePrefs(value: unknown): Record<string, ThreadPref> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, ThreadPref> = {};
  for (const [id, pref] of Object.entries(value)) {
    if (id.length === 0 || id.length > MAX_THREAD_ID) continue;
    const parsed = threadPrefSchema.safeParse(pref);
    if (parsed.success && (parsed.data.watch !== undefined || parsed.data.reviews !== undefined)) out[id] = parsed.data;
  }
  return out;
}

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

export function createPrefsStore(kv: () => KvStorage) {
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
    async threadPrefs(): Promise<Record<string, ThreadPref>> {
      return parsePrefs(await kv().get(PREFS_KEY));
    },
    setThreadPref(input: SetThreadPrefInput): Promise<Record<string, ThreadPref>> {
      return serial(PREFS_KEY, async () => {
        const current = parsePrefs(await kv().get(PREFS_KEY));
        const pref: ThreadPref = { ...current[input.threadId] };
        for (const field of ["watch", "reviews"] as const) {
          const value = input[field];
          if (value === null) delete pref[field];
          else if (value !== undefined) pref[field] = value;
        }
        delete current[input.threadId];
        if (pref.watch !== undefined || pref.reviews !== undefined) current[input.threadId] = pref;
        const next = fit(Object.entries(current), MAX_THREAD_PREFS);
        await kv().set(PREFS_KEY, next);
        return next;
      });
    },
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
