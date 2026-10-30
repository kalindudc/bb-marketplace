import { useRef } from "react";
import { toast } from "sonner";
import type { AgentMode, AgentTarget, InboxRule, PrView } from "../contract";
import { patchPr, undoToast, useShuttleMutation } from "./data";
import { atNine, plural, ruleText, tinyKey, when } from "./format";

const WATCH_OF: Record<AgentMode, PrView["watch"]> = { fix: "act", notify: "forward", off: null };

const MODE_TOASTS: Record<AgentMode, (pr: PrView) => string> = {
  fix: () => "The agent now fixes new feedback.",
  notify: () => "The agent is now told about new feedback, and not asked to fix it.",
  off: (pr) => `The agent of ${tinyKey(pr)} is off. New feedback waits in your Inbox.`,
};

const SEEN_BATCH = 500;

/** "world#2311622" for one PR, "3 PRs" for more. */
const prsLabel = (prs: readonly PrView[]) => (prs.length === 1 ? tinyKey(prs[0]!) : plural(prs.length, "PR"));

/** The agent a PR has now, as the target that puts it back. */
const targetOf = (pr: PrView): { target: AgentTarget; mode?: AgentMode } =>
  pr.agent === null ? { target: { kind: "none" } } : { target: { kind: "existing", threadId: pr.agent.threadId }, mode: pr.agent.mode };

/**
 * The writes every PR surface shares. Agent mode, Track, Snooze, Dismiss and "I'll do it" show at once
 * everywhere the PR is loaded; each reversible write offers Undo, and a refusal puts the PR back
 * and shows the server's message.
 */
export function usePrWrites(threadIds: readonly string[]) {
  const setAgentMode = useShuttleMutation("setAgentMode", ({ key, mode }, cache) =>
    patchPr(cache, key, (pr) => (pr.agent === null ? pr : { ...pr, agent: { ...pr.agent, mode }, watch: WATCH_OF[mode] }), threadIds));
  const track = useShuttleMutation("track", ({ key, on }, cache) => patchPr(cache, key, (pr) => ({ ...pr, tracked: on }), threadIds));
  const snooze = useShuttleMutation("snooze", ({ keys, until }, cache) => {
    for (const key of keys) patchPr(cache, key, (pr) => {
      if (until !== null) return { ...pr, snoozed: true, snoozedUntil: until === "update" ? null : until, next: { ...pr.next, inbox: false } };
      // Whether its step puts it in the Inbox is the server's to say; the refetch this write causes places it.
      return { ...pr, snoozed: false, snoozedUntil: null };
    }, threadIds);
  });
  const dismiss = useShuttleMutation("dismiss", ({ keys, on }, cache) => {
    const at = Date.now();
    for (const key of keys) patchPr(cache, key, (pr) => {
      if (on) return { ...pr, dismissed: { at, activity: false }, snoozed: false, snoozedUntil: null, next: { ...pr.next, inbox: false } };
      return { ...pr, dismissed: null };
    }, threadIds);
  });
  const seen = useShuttleMutation("markSeen", ({ keys }, cache) => {
    for (const key of keys) patchPr(cache, key, (pr) => ({ ...pr, unseen: false }), threadIds);
  });
  const ruleAdd = useShuttleMutation("inboxRuleAdd");
  const ruleRemove = useShuttleMutation("inboxRuleRemove");
  // The Inbox's last change that Undo can take back, for its U key; a toast's Undo and U take it once.
  const lastUndo = useRef<(() => void) | null>(null);
  const offerUndo = (message: string, undo: () => void) => {
    const once = () => {
      if (lastUndo.current === once) lastUndo.current = null;
      undo();
    };
    lastUndo.current = once;
    undoToast(message, once);
  };
  const handle = useShuttleMutation("handle", ({ key, on }, cache) => patchPr(cache, key, (pr) => (on
    ? { ...pr, handled: true, next: { ...pr.next, inbox: false } }
    : { ...pr, handled: false, next: { ...pr.next, inbox: pr.handled || pr.next.inbox } }), threadIds));
  const setAgent = useShuttleMutation("setAgent");
  const discardDraft = useShuttleMutation("discardDraft", ({ key }, cache) => {
    patchPr(cache, key, (pr) => ({ ...pr, draft: null }), threadIds);
    cache.update("detail", { key }, (current) => ({ ...current, draft: null }));
  });
  const restoreDraft = useShuttleMutation("restoreDraft");
  const setSettings = useShuttleMutation("setSettings", ({ autoAgent }, cache) => {
    if (autoAgent !== undefined) cache.update("overview", {}, (current) => ({ ...current, autoAgent }));
  });
  const cancelAutoMerge = useShuttleMutation("cancelAutoMerge", ({ key }, cache) => patchPr(cache, key, (pr) => ({ ...pr, autoMerge: false }), threadIds));

  const changeMode = async (pr: PrView, mode: AgentMode, undoable = true) => {
    const before = pr.agent?.mode ?? null;
    if (before === null || before === mode) return;
    const out = await setAgentMode.run({ key: pr.key, mode });
    if (out === null) return;
    if (undoable) undoToast(MODE_TOASTS[mode](pr), () => void changeMode({ ...pr, agent: { ...pr.agent!, mode } }, before, false));
    else toast.success(MODE_TOASTS[mode](pr));
  };

  const giveAgent = async (pr: PrView, target: AgentTarget, mode?: AgentMode, undoable = true) => {
    const previous = targetOf(pr);
    const out = await setAgent.run({ key: pr.key, target, ...(mode === undefined ? {} : { mode }) });
    if (out === null) return null;
    const title = out.pr.agent?.title;
    const message = target.kind === "none" ? `${tinyKey(pr)} has no agent.` : title ? `“${title}” is the agent of ${tinyKey(pr)}.` : `A new thread is the agent of ${tinyKey(pr)}.`;
    // A new thread exists once it starts, so there is nothing for Undo to take back.
    if (undoable && target.kind !== "new") undoToast(message, () => void giveAgent(out.pr, previous.target, previous.mode, false));
    else toast.success(message);
    return out;
  };

  const setTracked = async (pr: PrView, on: boolean, undoable = true) => {
    if ((await track.run({ key: pr.key, on })) === null) return;
    const message = on ? `Tracking ${tinyKey(pr)}: it stays in Reviews › Tracked, and shows in your Inbox when it changes after your review.` : `Stopped tracking ${tinyKey(pr)}.`;
    if (undoable) undoToast(message, () => void setTracked({ ...pr, tracked: on }, !on, false));
    else toast.success(message);
  };

  /** Out of the Inbox until a time, until it changes ("update"), or back now (null); "tomorrow" is 9:00 tomorrow here. */
  const snoozePrs = async (prs: readonly PrView[], until: "tomorrow" | "update" | number | null, undoable = true): Promise<boolean> => {
    const at = until === "tomorrow" ? atNine(Date.now(), 1) : until;
    if ((await snooze.run({ keys: prs.map((pr) => pr.key), until: at })) === null) return false;
    const label = prsLabel(prs);
    if (at === null) {
      const message = `${label} ${prs.length === 1 ? "is" : "are"} back in your Inbox.`;
      const before = prs[0]!.snoozedUntil ?? "update";
      // Waking PRs that were snoozed until different times has no one time to put back.
      if (undoable && prs.every((pr) => pr.snoozed && (pr.snoozedUntil ?? "update") === before)) offerUndo(message, () => void snoozePrs(prs, before, false));
      else toast.success(message);
      return true;
    }
    const message = at === "update" ? `Snoozed ${label} until it changes.` : `Snoozed ${label} until ${when(at)}.`;
    if (undoable) offerUndo(message, () => void snoozePrs(prs, null, false));
    else toast.success(message);
    return true;
  };
  const setSnooze = (pr: PrView, until: "tomorrow" | "update" | number | null) => snoozePrs([pr], until);

  /** Out of the Inbox for good, even when it changes; off brings it back. */
  const dismissPrs = async (prs: readonly PrView[], on: boolean, undoable = true): Promise<boolean> => {
    if ((await dismiss.run({ keys: prs.map((pr) => pr.key), on })) === null) return false;
    const label = prsLabel(prs);
    const message = on ? `Dismissed ${label}.` : `${label} ${prs.length === 1 ? "is" : "are"} back in your Inbox.`;
    if (undoable) offerUndo(message, () => void dismissPrs(prs, !on, false));
    else toast.success(message);
    return true;
  };

  /** Opening a PR clears what is new on it; nothing to say about that. */
  const markSeen = async (keys: readonly string[]) => {
    for (let start = 0; start < keys.length; start += SEEN_BATCH) await seen.run({ keys: keys.slice(start, start + SEEN_BATCH) });
  };

  const addRule = async (rule: Pick<InboxRule, "kind" | "server" | "value">, undoable = true): Promise<InboxRule | null> => {
    const out = await ruleAdd.run({ kind: rule.kind, server: rule.server, value: rule.value });
    if (out === null) return null;
    // Undo would remove a rule the user already had.
    if (!out.created) {
      toast(`${ruleText(out.rule)} already stay out of the Inbox.`);
      return out.rule;
    }
    const left = out.rule.keeps.length;
    const message = `${ruleText(out.rule)} now stay out of the Inbox${left > 0 ? `; ${plural(left, "PR")} left it` : ""}.`;
    if (undoable) offerUndo(message, () => void removeRule(out.rule, false));
    else toast.success(message);
    return out.rule;
  };

  const removeRule = async (rule: InboxRule, undoable = true) => {
    if ((await ruleRemove.run({ id: rule.id })) === null) return;
    const message = `${ruleText(rule)} can come to the Inbox again.`;
    if (undoable) offerUndo(message, () => void addRule(rule, false));
    else toast.success(message);
  };

  /** Takes back the Inbox's last change, as its toast's Undo would; false when there is none. */
  const undoLast = () => {
    const undo = lastUndo.current;
    if (undo === null) return false;
    undo();
    return true;
  };

  const setHandled = async (pr: PrView, on: boolean, undoable = true) => {
    if ((await handle.run({ key: pr.key, on })) === null) return;
    const message = on ? `${tinyKey(pr)} is yours. It leaves the Inbox until new feedback arrives.` : `${tinyKey(pr)} is back in your Inbox.`;
    if (undoable) undoToast(message, () => void setHandled({ ...pr, handled: on }, !on, false));
    else toast.success(message);
  };

  const discard = async (pr: PrView, draftId: number) => {
    if ((await discardDraft.run({ key: pr.key, draftId })) === null) return;
    undoToast("Discarded the draft. Nothing was posted.", () => {
      void restoreDraft.run({ key: pr.key, draftId }).then((out) => out !== null && toast.success("The draft is back."));
    });
  };

  const setAutoAgent = async (on: boolean, undoable = true) => {
    if ((await setSettings.run({ autoAgent: on })) === null) return;
    const message = on ? "Auto agent is on. The thread that opens a PR becomes its agent." : "Auto agent is off. Existing agents stay.";
    if (undoable) undoToast(message, () => void setAutoAgent(!on, false));
    else toast.success(message);
  };

  const cancelAuto = async (pr: PrView) => {
    if ((await cancelAutoMerge.run({ key: pr.key })) !== null) toast.success(`Auto-merge is off for ${tinyKey(pr)}.`);
  };

  return { changeMode, giveAgent, setTracked, setSnooze, snoozePrs, dismissPrs, markSeen, addRule, removeRule, undoLast, setHandled, discard, setAutoAgent, cancelAuto };
}

export type PrWrites = ReturnType<typeof usePrWrites>;
