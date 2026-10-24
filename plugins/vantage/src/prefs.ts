import { useCallback, useMemo } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Prefs, type SetThreadPrefInput } from "./contract";

export type PrefField = "watch" | "reviews";
export interface Resolved { on: boolean; from: "thread" | "ancestor" | "default"; threadId: string | null }
export type ParentOf = (threadId: string) => string | null | undefined;

export const DEFAULT_PREFS: Prefs = { watchByDefault: false, reviewsByDefault: false, threads: {} };
const MAX_DEPTH = 64;

// A thread's own choice, else its nearest ancestor's, else the setting: opting in on a parent covers its whole tree.
export function resolvePref(prefs: Prefs, field: PrefField, threadId: string, parentOf: ParentOf): Resolved {
  let id: string | null | undefined = threadId;
  for (let depth = 0; id !== null && id !== undefined && depth < MAX_DEPTH; depth++) {
    const value = prefs.threads[id]?.[field];
    if (value !== undefined) return { on: value, from: id === threadId ? "thread" : "ancestor", threadId: id };
    id = parentOf(id);
  }
  return { on: field === "watch" ? prefs.watchByDefault : prefs.reviewsByDefault, from: "default", threadId: null };
}

export function parentLookup(...sources: Array<Iterable<{ id: string; parentThreadId: string | null }>>): ParentOf {
  const parents = new Map<string, string | null>();
  for (const source of sources) for (const thread of source) if (!parents.has(thread.id)) parents.set(thread.id, thread.parentThreadId);
  return (id) => parents.get(id);
}

export function usePrefsState(): { prefs: Prefs; loaded: boolean } {
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "prefs", input: {} });
  return { prefs: data ?? DEFAULT_PREFS, loaded: data !== undefined };
}

export function usePrefs(): Prefs {
  return usePrefsState().prefs;
}

export type SetPref = (input: SetThreadPrefInput) => Promise<void>;

export function useSetPref(): SetPref {
  const mutation = experimental_useRpcMutation({
    contract: rpcContract,
    method: "setThreadPref",
    optimistic(input, cache) {
      cache.update("prefs", {}, (current) => {
        const pref = { ...current.threads[input.threadId] };
        for (const field of ["watch", "reviews"] as const) {
          const value = input[field];
          if (value === null) delete pref[field];
          else if (value !== undefined) pref[field] = value;
        }
        const threads = { ...current.threads };
        delete threads[input.threadId];
        if (pref.watch !== undefined || pref.reviews !== undefined) threads[input.threadId] = pref;
        return { ...current, threads };
      });
    },
  });
  const { mutate } = mutation;
  return useCallback(async (input) => { await mutate(input); }, [mutate]);
}

// Turning a tree on or off writes the thread's own choice; turning it back to what the default gives clears that choice.
export function toggleInput(prefs: Prefs, field: PrefField, threadId: string, parentOf: ParentOf): SetThreadPrefInput {
  const current = resolvePref(prefs, field, threadId, parentOf);
  const wanted = !current.on;
  const inherited = resolvePref({ ...prefs, threads: { ...prefs.threads, [threadId]: {} } }, field, threadId, parentOf);
  return { threadId, [field]: inherited.on === wanted ? null : wanted };
}

export function useTreePrefs(prefs: Prefs, parentOf: ParentOf) {
  return useMemo(() => ({
    watched: (threadId: string) => resolvePref(prefs, "watch", threadId, parentOf).on,
    reviewing: (threadId: string) => resolvePref(prefs, "reviews", threadId, parentOf).on,
  }), [prefs, parentOf]);
}
