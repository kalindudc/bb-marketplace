import { useCallback, type RefObject } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { CardSignal, studyContract } from "../../shared/study-events";

export type StudyCard = Omit<CardSignal, "action">;
type Send = (entries: CardSignal[]) => Promise<unknown>;
let pending: CardSignal[] = [];
function enqueue(signal: CardSignal, send: Send) {
  pending.push(signal);
  if (pending.length !== 1) return;
  requestAnimationFrame(() => {
    const batch = pending;
    pending = [];
    void send(batch).catch(() => console.warn("Tavern could not record local card measurements."));
  });
}

export function useStudyCard(card?: StudyCard, forwarded?: RefObject<HTMLElement | null>) {
  const { threadId, messageId, cardId, cardType, questId } = card ?? {};
  const rpc = useRpc<typeof studyContract>();
  const call = rpc.call;
  return useCallback((node: HTMLElement | null) => {
    if (forwarded) forwarded.current = node;
    if (!node || !threadId || !messageId || !cardId || !cardType || questId === undefined) return;
    const milestones = new Set<CardSignal["action"]>();
    const record = (action: CardSignal["action"]) => {
      if (milestones.has(action)) return;
      milestones.add(action);
      enqueue({ threadId, messageId, cardId, cardType, questId, action }, entries => call("recordCardSignals", entries));
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      record("first-seen");
      observer?.disconnect();
    }) : null;
    observer?.observe(node);
    const click = (event: MouseEvent) => {
      const control = event.target instanceof Element ? event.target.closest("button, a[href], summary, [role=button]") : null;
      if (!control || !node.contains(control) || control.matches(":disabled, [aria-disabled=true]")) return;
      record("first-seen");
      if (control.matches("[aria-expanded=true], details[open] > summary")) return;
      record(control.matches("[aria-expanded=false], summary") ? "expanded" : "acted");
    };
    node.addEventListener("click", click, true);
    return () => { observer?.disconnect(); node.removeEventListener("click", click, true); if (forwarded) forwarded.current = null; };
  }, [call, threadId, messageId, cardId, cardType, questId, forwarded]);
}
