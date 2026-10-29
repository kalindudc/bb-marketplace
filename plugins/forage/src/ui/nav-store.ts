import { useCallback, useSyncExternalStore } from "react";
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import type { SourceScope } from "../web/contracts.ts";

export const RESEARCH_TAB_ID = "sources";
export const CHECK_TAB_ID = "check";

export type ResearchRequest =
 | { view: "activity" | "sources" | "crawls" }
 | { view: "reader"; scope: SourceScope; sourceId: string; snapshotId?: string; lines?: [number, number] }
 | { view: "check"; text: string }
 | { view: "search" };

// The Research tab is a fixed tab, which bb opens without a target, so the target waits here for the tab to read.
const pending = new Map<string, { request: ResearchRequest; seq: number }>();
const listeners = new Set<() => void>();
let seq = 0;
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function requestResearch(threadId: string, request: ResearchRequest): void {
 seq += 1;
 pending.set(threadId, { request, seq });
 emit();
}
// Taking a request consumes it, so a tab that remounts later does not replay it.
export function takeResearchRequest(threadId: string, after: number): { request: ResearchRequest; seq: number } | null {
 const value = pending.get(threadId);
 if (!value || value.seq <= after) return null;
 pending.delete(threadId);
 return value;
}
export function useResearchRequest(threadId: string): { request: ResearchRequest; seq: number } | null {
 return useSyncExternalStore(subscribe, () => pending.get(threadId) ?? null, () => null);
}

export function useOpenResearch(): (threadId: string, request?: ResearchRequest) => boolean {
 const panel = experimental_useAppPanel();
 return useCallback((threadId: string, request?: ResearchRequest) => {
  if (request) requestResearch(threadId, request);
  const opened = panel.experimental_openTab({ surface: { kind: "current" }, tab: { id: RESEARCH_TAB_ID, context: { kind: "thread" }, availability: "fixed" } });
  if (!opened) pending.delete(threadId);
  return opened;
 }, [panel]);
}

// Commands run outside React; each visible thread's header chip registers how to open its Research tab.
const openers = new Map<string, (request?: ResearchRequest) => boolean>();
export function registerOpener(threadId: string, open: (request?: ResearchRequest) => boolean): () => void {
 openers.set(threadId, open);
 return () => { if (openers.get(threadId) === open) openers.delete(threadId); };
}
export function openFromCommand(threadId: string, request?: ResearchRequest): boolean {
 return openers.get(threadId)?.(request) ?? false;
}
export const canOpenFromCommand = (threadId: string) => openers.has(threadId);
