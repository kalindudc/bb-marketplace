import type { WebConfig } from "../web/config.ts";

export const THREAD_POLICIES = ["settings", "docs", "fresh", "private", "off"] as const;
export type ThreadPolicy = (typeof THREAD_POLICIES)[number];
export const POLICY_METADATA_KEY = "webResearch";
const CACHE_MS = 30_000;

export function policyFromMetadata(metadata: unknown): ThreadPolicy {
 if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "settings";
 const value = (metadata as Record<string, unknown>)[POLICY_METADATA_KEY];
 return typeof value === "string" && (THREAD_POLICIES as readonly string[]).includes(value) ? value as ThreadPolicy : "settings";
}

// A thread can pick a different default profile or the private ceiling; it can never widen what settings allow.
export function applyThreadPolicy(config: WebConfig, policy: ThreadPolicy | undefined): WebConfig {
 if (!policy || policy === "settings" || policy === "off") return config;
 if (policy === "private") return { ...config, privacyProfile: "private" };
 if (config.privacyProfile === "private" || config.profile === "private") return config;
 return { ...config, profile: policy };
}

export interface ThreadPolicyStore {
 get(threadId: string, signal?: AbortSignal): Promise<ThreadPolicy>;
 prime(threadId: string, policy: ThreadPolicy): void;
 set(threadId: string, policy: ThreadPolicy): Promise<ThreadPolicy>;
 list(threadIds: readonly string[]): Promise<Record<string, ThreadPolicy>>;
 countCustom(): number;
}

export function createThreadPolicyStore(io: {
 read(threadId: string, signal?: AbortSignal): Promise<unknown>;
 readMany(threadIds: readonly string[]): Promise<Record<string, unknown>>;
 write(threadId: string, policy: ThreadPolicy): Promise<unknown>;
 now?: () => number;
}): ThreadPolicyStore {
 const now = io.now ?? Date.now;
 const cache = new Map<string, { policy: ThreadPolicy; at: number }>();
 const remember = (threadId: string, policy: ThreadPolicy) => {
  cache.set(threadId, { policy, at: now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
 };
 return {
  async get(threadId, signal) {
   const hit = cache.get(threadId);
   if (hit && now() - hit.at < CACHE_MS) return hit.policy;
   try {
    const policy = policyFromMetadata(await io.read(threadId, signal));
    remember(threadId, policy);
    return policy;
   } catch {
    // Unreadable metadata falls back to the settings ceiling, which is never wider than settings.
    return hit?.policy ?? "settings";
   }
  },
  prime: remember,
  async set(threadId, policy) {
   const result = policyFromMetadata(await io.write(threadId, policy));
   remember(threadId, result);
   return result;
  },
  async list(threadIds) {
   const values = await io.readMany(threadIds);
   const out: Record<string, ThreadPolicy> = {};
   for (const id of threadIds) { out[id] = policyFromMetadata(values[id]); remember(id, out[id]!); }
   return out;
  },
  countCustom() {
   let n = 0;
   for (const entry of cache.values()) if (entry.policy !== "settings") n++;
   return n;
  },
 };
}
