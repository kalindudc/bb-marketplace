import { useEffect, useRef, useState } from "react";
import type { PluginBrowserBbSdk, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { InfoCardMode } from "./settings";
import type { ExecutionOptions, Interactions, Outline, Usage, WorkspaceStatus } from "./info-format";

export type Resource<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" };
export interface Loader<T> { key: string; load(): Promise<T>; delayMs: number; prefetch: boolean }
export interface InfoLoaders {
  options: Loader<ExecutionOptions>; usage: Loader<Usage | null>; outline: Loader<Outline> | null;
  asks: Loader<Interactions> | null; changes: Loader<WorkspaceStatus> | null;
}

const MAX_AGE_MS = 2_000;
const MAX_ENTRIES = 200;
const GIT_DELAY_MS = 250;
const values = new Map<string, { value: unknown; at: number }>();
const inflight = new Map<string, Promise<unknown>>();

function remember(key: string, value: unknown): void {
  values.delete(key);
  values.set(key, { value, at: Date.now() });
  if (values.size > MAX_ENTRIES) values.delete(values.keys().next().value!);
}

// Promises are shared between cards, so no caller can abort one; the calls are small.
export function loadCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const stored = values.get(key);
  if (stored && Date.now() - stored.at < MAX_AGE_MS) return Promise.resolve(stored.value as T);
  const promise: Promise<T> = loader().then((value) => {
    if (inflight.get(key) === promise) { inflight.delete(key); remember(key, value); }
    return value;
  }, (cause: unknown) => {
    if (inflight.get(key) === promise) inflight.delete(key);
    throw cause;
  });
  inflight.set(key, promise);
  return promise;
}

function peek<T>(key: string | null): Resource<T> {
  const stored = key === null ? undefined : values.get(key);
  return stored ? { status: "ready", value: stored.value as T } : { status: "loading" };
}

export function useCached<T>(loader: Loader<T> | null): Resource<T> | null {
  const key = loader?.key ?? null;
  const latest = useRef(loader);
  latest.current = loader;
  const [entry, setEntry] = useState(() => ({ key, resource: peek<T>(key) }));
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const shown = (previous: { key: string | null; resource: Resource<T> }) => previous.key === key ? previous.resource : peek<T>(key);
    const revalidate = () => {
      loadCached(key, () => latest.current!.load()).then((value) => {
        if (live) setEntry((previous) => {
          const current = shown(previous);
          return previous.key === key && current.status === "ready" && current.value === value ? previous : { key, resource: { status: "ready", value } };
        });
      }, () => {
        if (live) setEntry((previous) => {
          const current = shown(previous);
          return { key, resource: current.status === "ready" ? current : { status: "error" } };
        });
      });
    };
    const delayMs = latest.current?.delayMs ?? 0;
    const timer = delayMs > 0 ? setTimeout(revalidate, delayMs) : null;
    if (timer === null) revalidate();
    return () => { live = false; if (timer !== null) clearTimeout(timer); };
  }, [key]);
  if (key === null) return null;
  return entry.key === key ? entry.resource : peek<T>(key);
}

export function infoLoaders(sdk: PluginBrowserBbSdk, thread: PluginSidebarThread, mode: Exclude<InfoCardMode, "off">): InfoLoaders {
  const threadId = thread.id;
  const environmentId = thread.environment?.id ?? null;
  return {
    options: { key: `options:${threadId}`, delayMs: 0, prefetch: true,
      load: async () => sdk.threads.defaultExecutionOptions({ threadId }) },
    usage: { key: `usage:${threadId}`, delayMs: 0, prefetch: true,
      load: async () => (await sdk.threads.context({ threadId })).usage },
    outline: mode === "glance" ? null : { key: `outline:${threadId}`, delayMs: 0, prefetch: true,
      load: async () => sdk.threads.conversationOutline({ threadId }) },
    asks: thread.hasPendingInteraction ? { key: `asks:${threadId}`, delayMs: 0, prefetch: true,
      load: async () => sdk.threads.interactions.list({ threadId }) } : null,
    // Without mergeBaseBranch, status reports no merge base and committed work reads as clean.
    changes: environmentId === null ? null : { key: `changes:${environmentId}`, delayMs: GIT_DELAY_MS, prefetch: false,
      load: async () => {
        const { mergeBaseBranch } = await sdk.environments.get({ environmentId });
        return sdk.environments.status({ environmentId, ...(mergeBaseBranch ? { mergeBaseBranch } : {}) });
      } },
  };
}

export function prefetchInfo(loaders: InfoLoaders): void {
  for (const loader of Object.values(loaders) as (Loader<unknown> | null)[]) {
    if (loader?.prefetch) loadCached(loader.key, () => loader.load()).catch(() => undefined);
  }
}

export function resetInfoCache(): void {
  values.clear();
  inflight.clear();
}
