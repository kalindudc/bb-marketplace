import { modelKey, type RecentModel } from "./lineup";

export interface ThreadSummary {
  id: string;
  providerId: string;
  updatedAt: number;
}

/** Threads past this many are not read, so one call stays bounded on a large history. */
export const MAX_THREADS_SCANNED = 400;
export const THREAD_PAGE_SIZE = 500;
/** A ceiling on pages, in case a server ignores `offset` and keeps sending the same page. */
export const MAX_THREAD_PAGES = 40;

/**
 * Every thread, read page by page. bb's thread list is not ordered by
 * activity, so the newest threads can sit anywhere in it: Recent has to see
 * the whole list to find them, and pages explicitly so that no default page
 * size can cut the list short. Only the summaries are kept.
 */
export async function listAllThreads(
  page: (offset: number, limit: number) => Promise<readonly ThreadSummary[]>,
): Promise<ThreadSummary[]> {
  const all: ThreadSummary[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < MAX_THREAD_PAGES; index += 1) {
    const rows = await page(index * THREAD_PAGE_SIZE, THREAD_PAGE_SIZE);
    const fresh = rows.filter((row) => !seen.has(row.id));
    for (const row of fresh) {
      seen.add(row.id);
      all.push({ id: row.id, providerId: row.providerId, updatedAt: row.updatedAt });
    }
    if (rows.length < THREAD_PAGE_SIZE || fresh.length === 0) break;
  }
  return all;
}

/**
 * Remembers each thread's model by thread id and `updatedAt`, so a later scan
 * asks bb only about threads that changed since.
 */
export class ThreadModelCache {
  private readonly entries = new Map<string, { updatedAt: number; model: string | null }>();

  constructor(
    private readonly lookup: (threadId: string) => Promise<string | null>,
    private readonly onError: (thread: ThreadSummary, error: unknown) => void = () => {},
  ) {}

  /**
   * The thread's last model, or null when it has none. A failed lookup also
   * gives null, so one deleted or unreadable thread does not empty Recent; it
   * is not cached, so the next scan asks again.
   */
  async modelOf(thread: ThreadSummary): Promise<string | null> {
    const cached = this.entries.get(thread.id);
    if (cached !== undefined && cached.updatedAt === thread.updatedAt) return cached.model;
    let model: string | null;
    try {
      model = await this.lookup(thread.id);
    } catch (error) {
      this.onError(thread, error);
      return null;
    }
    this.entries.set(thread.id, { updatedAt: thread.updatedAt, model });
    return model;
  }
}

/**
 * The distinct provider and model pairs the most recently active threads ran
 * on, newest first, until `limit` models or `MAX_THREADS_SCANNED` threads.
 */
export async function collectRecent(
  threads: readonly ThreadSummary[],
  cache: ThreadModelCache,
  limit: number,
): Promise<RecentModel[]> {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set<string>();
  const out: RecentModel[] = [];
  for (const thread of sorted.slice(0, MAX_THREADS_SCANNED)) {
    if (out.length >= limit) break;
    const model = await cache.modelOf(thread);
    if (model === null) continue;
    const ref = { providerId: thread.providerId, model };
    const key = modelKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ref, usedAt: thread.updatedAt });
  }
  return out;
}
