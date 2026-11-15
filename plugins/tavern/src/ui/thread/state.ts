import { useSyncExternalStore } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadDecor } from "../../shared/contract";
type Reveal = {
    revealAskId: string | null;
    revealVersion: number;
};
const empty: Reveal = { revealAskId: null, revealVersion: 0 };
const reveals = new Map<string, Reveal>();
const listeners = new Set<() => void>();
export const threadDecorCache = new Map<string, ThreadDecor>();
let client: PluginRpcClient<typeof rpcContract> | null = null;
export function bindRpc(value: typeof client) { client = value; }
export function getRpc() { if (!client)
    throw new Error("Tavern is still loading. Try again in a moment."); return client; }
export function revealAsk(threadId: string, askId: string) { const previous = reveals.get(threadId) ?? empty; reveals.set(threadId, { revealAskId: askId, revealVersion: previous.revealVersion + 1 }); listeners.forEach(fn => fn()); }
export function useWidgetReveal(threadId: string) { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => reveals.get(threadId) ?? empty, () => empty); }
export function clearThreadState() { threadDecorCache.clear(); reveals.clear(); bindRpc(null); }
