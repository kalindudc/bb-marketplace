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
export type WidgetPanel = null | "asks" | "decided" | "brief" | "quests";
const panels = new Map<string, WidgetPanel>();
const acknowledged = new Map<string, number>();
const expandedReveals = new Map<string, number>();
const memberFolds = new Map<string, Map<string, boolean>>();
const memberOpenings = new Set<string>();
const memberSeen = new Map<string, number>();
const memberNew = new Map<string, readonly number[]>();
const memberUnderlines = new Set<string>();
export function claimMemberUnderline(threadId: string, version: number) { const key = `${threadId}:${version}`; if (memberUnderlines.has(key)) return false; memberUnderlines.add(key); return true; }
export function setMemberFold(threadId: string, section: string, open: boolean) {
    let folds = memberFolds.get(threadId);
    if (!folds) { folds = new Map(); memberFolds.set(threadId, folds); }
    folds.set(section, open);
    listeners.forEach(fn => fn());
}
export function useMemberFold(threadId: string, section: string): [boolean, (open: boolean) => void] {
    const open = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => memberFolds.get(threadId)?.get(section) ?? false, () => false);
    return [open, value => setMemberFold(threadId, section, value)];
}
export function memberVisit(threadId: string) { return { manual: memberOpenings.has(threadId), seen: memberSeen.get(threadId), newVersions: memberNew.get(threadId) ?? [] }; }
export function recordMemberVisit(threadId: string, newest?: number) { if (!memberOpenings.delete(threadId)) return; memberNew.set(threadId, []); if (newest !== undefined) memberSeen.set(threadId, Math.max(memberSeen.get(threadId) ?? 0, newest)); }
export function rememberMemberNew(threadId: string, versions: readonly number[]) { memberNew.set(threadId, versions); }
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
    return [panel, value => { if (value === "brief" && panels.get(threadId) !== "brief") memberOpenings.add(threadId); panels.set(threadId, value); listeners.forEach(fn => fn()); }];
}
export const threadDecorCache = new Map<string, ThreadDecor>();
let client: PluginRpcClient<typeof rpcContract> | null = null;
export function bindRpc(value: typeof client) { client = value; }
export function getRpc() { if (!client)
    throw new Error("Tavern is still loading. Try again in a moment."); return client; }
export function revealAsk(threadId: string, askId: string) { const previous = reveals.get(threadId) ?? empty; reveals.set(threadId, { revealAskId: askId, revealVersion: previous.revealVersion + 1 }); listeners.forEach(fn => fn()); }
export function useWidgetReveal(threadId: string) { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => reveals.get(threadId) ?? empty, () => empty); }
export function clearThreadState() { threadDecorCache.clear(); reveals.clear(); panels.clear(); acknowledged.clear(); expandedReveals.clear(); memberFolds.clear(); memberOpenings.clear(); memberSeen.clear(); memberNew.clear(); memberUnderlines.clear(); bindRpc(null); }
