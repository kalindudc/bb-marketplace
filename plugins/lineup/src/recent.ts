import { modelKey, type RecentModel } from "./lineup";

export interface ThreadSummary {
  id: string;
  providerId: string;
  updatedAt: number;
}

/** Threads past this many are not read, so one call stays bounded on a large history. */
export const MAX_THREADS_SCANNED = 400;

/**
 * Remembers each thread's model by thread id and `updatedAt`, so a later scan
 * asks bb only about threads that changed since.
 */
export class ThreadModelCache {
  private readonly entries = new Map<string, { updatedAt: number; model: string | null }>();

  constructor(private readonly lookup: (threadId: string) => Promise<string | null>) {}

  async modelOf(thread: ThreadSummary): Promise<string | null> {
    const cached = this.entries.get(thread.id);
    if (cached !== undefined && cached.updatedAt === thread.updatedAt) return cached.model;
    const model = await this.lookup(thread.id);
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
