import { createContext, useContext } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../config";
import type { NextAction, PrView } from "../contract";
import { BUTTON, BUTTON_PRIMARY, Tip } from "./common";
import type { useEditPrs } from "./edit";
import { sizeOf } from "./format";
import type { PrWrites } from "./writes";

/** What a surface asks the page to do next for one PR: open it, focus its composer, or scroll to its draft. */
export interface Intent {
  key: string;
  kind: "compose" | "draft";
  /** Text to put in the composer; `nudge` asks for the nudge comment, written once the PR has loaded. */
  text?: string;
  nudge?: true;
  nonce: number;
}

/** Everything a card, a row or the PR view can ask of the page; the page owns the dialogs and the route. */
export interface PageActions {
  phone: boolean;
  presets: readonly Preset[] | null;
  writes: PrWrites;
  edits: ReturnType<typeof useEditPrs>;
  selected: string | null;
  select(key: string): void;
  open(pr: PrView): void;
  openThread(threadId: string): void;
  link(pr: PrView, tab?: "existing" | "new"): void;
  merge(pr: PrView): void;
  pickAgent(pr: PrView, start?: "new"): void;
  startReview(pr: PrView): void;
  customize(pr: PrView, threadId?: string): void;
  approve(pr: PrView): void;
  compose(pr: PrView, text?: string): void;
  showDraft(pr: PrView): void;
  intent: Intent | null;
  done(intent: Intent): void;
}

const Context = createContext<PageActions | null>(null);
export const ActionsProvider = Context.Provider;

export function useActions(): PageActions {
  const actions = useContext(Context);
  if (actions === null) throw new Error("useActions needs the Shuttle page around it");
  return actions;
}

/** A comment that asks the requested people (not teams) to look, for Nudge reviewers. */
export function nudgeText(pr: PrView): string {
  const people = (pr.reviewers ?? []).filter((reviewer) => reviewer.state === "requested" && !reviewer.team).map((reviewer) => `@${reviewer.login}`);
  const size = sizeOf(pr);
  const change = size === null || pr.additions === null || pr.deletions === null ? "" : ` It is ${size === "S" ? "small" : `a ${size} change`}: +${pr.additions} −${pr.deletions}.`;
  return `${people.length > 0 ? `${people.join(" ")} could` : "Could"} one of you take a look when you have a moment?${change}`;
}

/** Carries out one of a next step's buttons. */
export function runNext(actions: PageActions, pr: PrView, id: NextAction): void {
  switch (id) {
    case "merge": return actions.merge(pr);
    case "assign_suggested":
      if (pr.suggestedAgent === null) return actions.pickAgent(pr);
      return void actions.writes.giveAgent(pr, { kind: "existing", threadId: pr.suggestedAgent.threadId });
    case "pick_agent": return actions.pickAgent(pr);
    case "handle": return void actions.writes.setHandled(pr, true);
    case "open_agent": return pr.agent === null ? actions.pickAgent(pr) : actions.openThread(pr.agent.threadId);
    case "ready": return actions.edits.apply(pr, { kind: "ready" });
    case "nudge": return actions.compose(pr, nudgeText(pr));
    case "cancel_auto_merge": return void actions.writes.cancelAuto(pr);
    case "choose": return actions.showDraft(pr);
    case "open_review": return pr.lastReview === null ? actions.select(pr.key) : actions.openThread(pr.lastReview.threadId);
    case "review": return actions.startReview(pr);
    case "approve": return actions.approve(pr);
    case "not_now": return void actions.writes.setSnooze(pr, "update");
    case "track": return void actions.writes.setTracked(pr, true);
    case "reopen": return actions.edits.apply(pr, { kind: "reopen" });
  }
}

const ACTION_ICONS: Partial<Record<NextAction, string>> = {
  merge: "GitMerge",
  assign_suggested: "Bot",
  pick_agent: "Bot",
  handle: "UserRound",
  open_agent: "MessageSquare",
  ready: "Check",
  nudge: "MessageSquare",
  choose: "Check",
  open_review: "MessageSquare",
  review: "Play",
  approve: "Check",
  track: "Pin",
  reopen: "RotateCcw",
};

/** What each next-step button does, for its tooltip. */
export const ACTION_HINTS: Record<NextAction, string> = {
  merge: "Choose how to merge it, then merge it",
  assign_suggested: "Make the thread that opened this PR its agent, so its reviews and failed checks go there",
  pick_agent: "Pick a thread to be this PR's agent; it gets the reviews and failed checks",
  handle: "Say you'll fix it yourself; it leaves the Inbox until new feedback arrives",
  open_agent: "Open the agent's thread",
  ready: "Mark it ready for review, so its reviewers are told",
  nudge: "Write a comment asking its reviewers to take a look",
  cancel_auto_merge: "Turn off auto-merge",
  choose: "Read the AI review's findings and choose what to post",
  open_review: "Open the review's thread",
  review: "Start an AI review with one of your presets",
  approve: "Approve it as yourself",
  not_now: "Leave it out of the Inbox until it changes",
  track: "Keep it in Reviews › Tracked",
  reopen: "Reopen it",
};

export function NextButton({ pr, action, primary, small = false }: { pr: PrView; action: { id: NextAction; label: string }; primary: boolean; small?: boolean }) {
  const actions = useActions();
  const icon = ACTION_ICONS[action.id];
  return (
    <Tip text={ACTION_HINTS[action.id]}>
      <button type="button" data-next={action.id} className={`${primary ? BUTTON_PRIMARY : BUTTON} ${small ? "" : "h-8 px-3 text-[13px]"}`}
        onClick={(event) => { event.stopPropagation(); runNext(actions, pr, action.id); }}>
        {icon && <Icon name={icon} className="size-3.5" aria-hidden />}
        {action.label}
      </button>
    </Tip>
  );
}

/** The next step's primary button and the rest, in the server's words. */
export function NextButtons({ pr }: { pr: PrView }) {
  const { primary, more } = pr.next;
  return (
    <>
      {primary !== null && <NextButton pr={pr} action={primary} primary />}
      {more.map((action) => <NextButton key={action.id} pr={pr} action={action} primary={false} />)}
    </>
  );
}
