import { toast } from "sonner";
import type { AgentMode, AgentTarget, PrView } from "../contract";
import { patchPr, undoToast, useShuttleMutation } from "./data";
import { tinyKey } from "./format";

const WATCH_OF: Record<AgentMode, PrView["watch"]> = { fix: "act", notify: "forward", off: null };

const tomorrowAtNine = () => {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at.getTime();
};

const MODE_TOASTS: Record<AgentMode, (pr: PrView) => string> = {
  fix: () => "The agent now fixes new feedback.",
  notify: () => "The agent is now told about new feedback, and not asked to fix it.",
  off: (pr) => `The agent of ${tinyKey(pr)} is off. New feedback waits in your Inbox.`,
};

/** The agent a PR has now, as the target that puts it back. */
const targetOf = (pr: PrView): { target: AgentTarget; mode?: AgentMode } =>
  pr.agent === null ? { target: { kind: "none" } } : { target: { kind: "existing", threadId: pr.agent.threadId }, mode: pr.agent.mode };

/**
 * The writes every PR surface shares. Agent mode, Track, Snooze and "I'll do it" show at once
 * everywhere the PR is loaded; each reversible write offers Undo, and a refusal puts the PR back
 * and shows the server's message.
 */
export function usePrWrites(threadIds: readonly string[]) {
  const setAgentMode = useShuttleMutation("setAgentMode", ({ key, mode }, cache) =>
    patchPr(cache, key, (pr) => (pr.agent === null ? pr : { ...pr, agent: { ...pr.agent, mode }, watch: WATCH_OF[mode] }), threadIds));
  const track = useShuttleMutation("track", ({ key, on }, cache) => patchPr(cache, key, (pr) => ({ ...pr, tracked: on }), threadIds));
  const snooze = useShuttleMutation("snooze", ({ key, until }, cache) => patchPr(cache, key, (pr) => (until === null
    ? { ...pr, snoozedUntil: null, next: { ...pr.next, inbox: pr.snoozedUntil !== null || pr.next.inbox } }
    : { ...pr, snoozedUntil: until === "tomorrow" ? tomorrowAtNine() : null, next: { ...pr.next, inbox: false } }), threadIds));
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

  const setSnooze = async (pr: PrView, until: "tomorrow" | "update" | null) => {
    if ((await snooze.run({ key: pr.key, until })) === null) return;
    if (until === null) return void toast.success(`${tinyKey(pr)} is back in your Inbox.`);
    const message = until === "tomorrow" ? `Snoozed ${tinyKey(pr)} until tomorrow 9:00, or until something new happens.` : `${tinyKey(pr)} stays in Reviews and leaves the Inbox.`;
    undoToast(message, () => void setSnooze({ ...pr, snoozedUntil: tomorrowAtNine() }, null));
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

  return { changeMode, giveAgent, setTracked, setSnooze, setHandled, discard, setAutoAgent, cancelAuto };
}

export type PrWrites = ReturnType<typeof usePrWrites>;
