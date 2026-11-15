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
export type WidgetPanel = null | "asks" | "decided" | "brief";
const panels = new Map<string, WidgetPanel>();
const acknowledged = new Map<string, number>();
const expandedReveals = new Map<string, number>();
export function acknowledgeAskReveal(threadId: string, version: number) {
    if (!version || version <= (expandedReveals.get(threadId) ?? 0)) return false;
    expandedReveals.set(threadId, version);
    return true;
}
export function acknowledgeWidgetReveal(threadId: string, version: number) {
    if (!version || version <= (acknowledged.get(threadId) ?? 0)) return false;
    acknowledged.set(threadId, version);
    return true;
}
export function useWidgetPanel(threadId: string): [WidgetPanel, (panel: WidgetPanel) => void] {
    const panel = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => panels.get(threadId) ?? null, () => null);
    return [panel, value => { panels.set(threadId, value); listeners.forEach(fn => fn()); }];
}
export const threadDecorCache = new Map<string, ThreadDecor>();
let client: PluginRpcClient<typeof rpcContract> | null = null;
export function bindRpc(value: typeof client) { client = value; }
export function getRpc() { if (!client)
    throw new Error("Tavern is still loading. Try again in a moment."); return client; }
export function revealAsk(threadId: string, askId: string) { const previous = reveals.get(threadId) ?? empty; reveals.set(threadId, { revealAskId: askId, revealVersion: previous.revealVersion + 1 }); listeners.forEach(fn => fn()); }
export function useWidgetReveal(threadId: string) { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => reveals.get(threadId) ?? empty, () => empty); }
export function clearThreadState() { threadDecorCache.clear(); reveals.clear(); panels.clear(); acknowledged.clear(); expandedReveals.clear(); bindRpc(null); }
