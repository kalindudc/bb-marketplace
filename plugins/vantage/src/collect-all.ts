import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { CollectDeps, Environment } from "./collect";
import type { ThreadSummary } from "./contract";
import { mapLimit } from "./limit";

export interface AllOptions { windowHours: number; maxThreads: number; now?: number }
export interface Collected {
  threads: ThreadSummary[]; environments: Map<string, Environment>; truncated: boolean;
  /** Archived threads that matched but were left out, so a toggle can say how many it would bring back. */
  archivedHidden: number;
}

type Listed = Awaited<ReturnType<PluginBbSdk["threads"]["list"]>>[number];
type ThreadFields = Pick<Listed, "id" | "title" | "titleFallback" | "parentThreadId" | "archivedAt" | "environmentId" | "status">;

export const FETCH_CONCURRENCY = 8;
const MAX_TITLE = 500;
const PAGE_SIZE = 100;
const MAX_ACTIVE_SCANNED = 1000;
const MAX_ARCHIVED_SCANNED = 500;
const RUNNING = new Set(["active", "starting", "pending"]);
const HOUR_MS = 3_600_000;

export function summarizeThread(thread: ThreadFields, depth: number, rootThreadId: string): ThreadSummary {
  return {
    id: thread.id,
    title: (thread.title ?? thread.titleFallback ?? thread.id).slice(0, MAX_TITLE),
    parentThreadId: thread.parentThreadId,
    archived: thread.archivedAt !== null,
    depth,
    environmentId: thread.environmentId,
    status: thread.status,
    rootThreadId,
  };
}

export async function loadEnvironments(
  sdk: PluginBbSdk, threads: readonly ThreadSummary[], signal?: AbortSignal,
): Promise<Map<string, Environment>> {
  const environmentIds = [...new Set(threads.flatMap((thread) => (thread.environmentId === null ? [] : [thread.environmentId])))];
  const environments = new Map<string, Environment>();
  await mapLimit(environmentIds, FETCH_CONCURRENCY, async (environmentId) => {
    const environment = await sdk.environments.get({ environmentId, signal }).catch(() => null);
    if (environment !== null) environments.set(environmentId, environment);
  });
  return environments;
}

async function listAll(sdk: PluginBbSdk, archived: boolean, maxScanned: number, signal?: AbortSignal): Promise<Listed[]> {
  const found: Listed[] = [];
  for (let offset = 0; offset < maxScanned; offset += PAGE_SIZE) {
    const page = await sdk.threads.list({ archived, includeHidden: true, limit: PAGE_SIZE, offset, signal });
    found.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return found;
}

export async function collectAll(
  deps: CollectDeps, options: AllOptions & { includeArchived: boolean }, signal?: AbortSignal,
): Promise<Collected> {
  const { sdk } = deps;
  const cutoff = (options.now ?? Date.now()) - options.windowHours * HOUR_MS;
  const active = (await listAll(sdk, false, MAX_ACTIVE_SCANNED, signal))
    .filter((thread) => thread.updatedAt >= cutoff || RUNNING.has(thread.status));
  // The archived list is paged even when it is hidden: one page costs about 10 ms and gives the count.
  const archivedInWindow = (await listAll(sdk, true, MAX_ARCHIVED_SCANNED, signal))
    .filter((thread) => thread.archivedAt !== null && thread.archivedAt >= cutoff);
  const archived = options.includeArchived ? archivedInWindow : [];
  const matched = [...new Map([...active, ...archived].map((thread) => [thread.id, thread])).values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const kept = matched.slice(0, options.maxThreads);

  const byId = new Map(kept.map((thread) => [thread.id, thread]));
  const placed = new Map<string, { depth: number; root: string }>();
  const place = (thread: Listed, chain: ReadonlySet<string>): { depth: number; root: string } => {
    const known = placed.get(thread.id);
    if (known !== undefined) return known;
    const parent = thread.parentThreadId === null ? undefined : byId.get(thread.parentThreadId);
    let result = { depth: 0, root: thread.id };
    if (parent !== undefined && !chain.has(parent.id)) {
      const above = place(parent, new Set(chain).add(thread.id));
      result = { depth: above.depth + 1, root: above.root };
    }
    placed.set(thread.id, result);
    return result;
  };
  const threads = kept.map((thread) => {
    const { depth, root } = place(thread, new Set());
    return summarizeThread(thread, depth, root);
  });
  return {
    threads, environments: await loadEnvironments(sdk, threads, signal), truncated: matched.length > kept.length,
    archivedHidden: options.includeArchived ? 0 : archivedInWindow.length,
  };
}
