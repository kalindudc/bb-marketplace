import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { PRODUCTION_WAKE_HOURS, type AwayReturnCause, type AwayWindow } from "../../shared/away";
import { isUser } from "../dispatch";

type InputBlocks = MessageDispatchHookContext["queuedMessages"][number]["content"];
function visibleInput(blocks: Readonly<InputBlocks>, text = "") {
  if (blocks.length === 0) return text.trim().length > 0;
  return blocks.some(block => block.type !== "text" || block.visibility !== "agent-only" && block.text.trim().length > 0);
}

export function awayReturnFromDispatch(window: AwayWindow | null, ctx: MessageDispatchHookContext, tavernThread: boolean): AwayReturnCause | null {
  if (!tavernThread || window === null || window.returnedAt !== null) return null;
  if (ctx.queuedMessages.length > 0) {
    // A queued row stamped in the closing millisecond may have preceded the close.
    const user = ctx.queuedMessages.find(row => isUser(row) && row.createdAt > window.closedAt && visibleInput(row.content));
    return user ? { kind: "user-message", threadId: ctx.thread.id, refId: user.id } : null;
  }
  return isUser(ctx) && visibleInput(ctx.input.blocks, ctx.input.text)
    ? { kind: "user-message", threadId: ctx.thread.id, refId: null }
    : null;
}

export type AwayExecutionPolicy = { mode: "open" | "guarded" | "watched"; reason: null }
  | { mode: "held"; reason: "paused" | "not-pinned" | "not-prevented" };
export function awayExecutionPolicy(window: AwayWindow | null, questId: string | null, prevention: boolean): AwayExecutionPolicy {
  if (window === null || window.returnedAt !== null) return { mode: "open", reason: null };
  const quest = window.quests.find(item => item.questId === questId);
  if (quest === undefined) return { mode: "held", reason: "not-pinned" };
  if (quest.endState === "pause") return { mode: "held", reason: "paused" };
  if (prevention || window.stopList.length === 0) return { mode: "guarded", reason: null };
  return window.allowWatched ? { mode: "watched", reason: null } : { mode: "held", reason: "not-prevented" };
}

export function awayShouldNotify(window: AwayWindow | null, kind: string, openedAt: number, now: number): boolean {
  if (window === null || window.returnedAt !== null) return true;
  if (kind === "blocker") return window.wakeRules.blockers;
  return kind === "production" && window.wakeRules.productionAsksAfterTwoHours && now - openedAt >= (window.productionWakeHours ?? PRODUCTION_WAKE_HOURS.default) * 60 * 60 * 1000;
}
