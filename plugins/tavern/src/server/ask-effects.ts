import type { Ask } from "../shared/schema";
import type { Records, Runtime } from "./keeper/store";
import { authorize, type Act } from "./authority";

export type { AskEffect } from "../shared/schema";
import type { AskEffect } from "../shared/schema";

export function legacyAskEffect(ask: Ask, meta: Records["askMeta"] | null, runtime: Partial<Runtime>): AskEffect {
  if (meta?.guardHire) return { type: "detection-hire", binding: meta.guardHire };
  if (meta?.scopeThreadId) return { type: "scope-blocker", memberThreadId: meta.scopeThreadId };
  if (ask.releaseHoldId) return { type: "release-hold", holdId: ask.releaseHoldId };
  if (ask.kind === "greenlight" && typeof meta?.planVersion === "number") return { type: "greenlight", planVersion: meta.planVersion };
  if (ask.kind === "conclude" && meta?.wrapDraft) return { type: "conclude", draft: meta.wrapDraft };
  if (meta?.briefDelivery) return { type: "retry-brief", ...meta.briefDelivery };
  if (meta?.stopMemberThreadId) return { type: "retry-stop", memberThreadId: meta.stopMemberThreadId };
  if (meta?.stopHireTokens) return { type: "retry-stop", hireTokens: meta.stopHireTokens };
  if (ask.kind === "scope" && ask.scopeChange) return { type: "grant-scope", memberThreadId: ask.scopeChange.memberThreadId };
  if (ask.id && runtime.failureAskId === ask.id) return { type: "retry-provider" };
  if (ask.id && runtime.tickDeliveryAskId === ask.id) return { type: "retry-tick" };
  if (ask.kind === "blocker") return { type: "answer-blocker" };
  return { type: "decision" };
}
export function scopeAskMember(effect: Ask["effect"]): string | undefined {
  if (effect?.type === "scope-blocker" || effect?.type === "grant-scope" || effect?.type === "repair-guard") return effect.memberThreadId;
}

export function askMemberTarget(ask: Pick<Ask, "effect" | "scopeChange" | "runThreadId">): string | undefined {
  const effect = ask.effect;
  return scopeAskMember(effect) ?? (effect?.type === "grant-shell-act" ? effect.memberThreadId :
    effect?.type === "communication-hold" ? effect.hold.threadId : undefined) ?? ask.scopeChange?.memberThreadId ?? ask.runThreadId;
}

export type EffectHandlers = { [K in AskEffect["type"]]: (effect: AskEffect) => void };
export const ASK_EFFECTS: Record<AskEffect["type"], { act: Act; handler: keyof EffectHandlers; answerOnly?: true; noticeOnly?: true; keeperRecovery?: readonly string[] }> = {
  greenlight: { act: "greenlight", handler: "greenlight" },
  "lead-plan": { act: "greenlight", handler: "lead-plan" },
  conclude: { act: "conclude", handler: "conclude" },
  "close-early": { act: "closeEarly", handler: "close-early" },
  "release-hold": { act: "releaseCheckerHandoff", handler: "release-hold" },
  "settle-waypoint": { act: "answerAsk", handler: "settle-waypoint" },
  "user-waypoint": { act: "answerAsk", handler: "user-waypoint" },
  "quest-start": { act: "answerAsk", handler: "quest-start" },
  "member-schedules": { act: "answerAsk", handler: "member-schedules" },
  "soft-limit": { act: "answerAsk", handler: "soft-limit" },
  "review-allowance": { act: "allowReview", handler: "review-allowance" },
  "communication-hold": { act: "answerAsk", handler: "communication-hold", answerOnly: true },
  "pull-request-draft": { act: "answerAsk", handler: "pull-request-draft", answerOnly: true },
  "retry-stop": { act: "answerAsk", handler: "retry-stop", keeperRecovery: ["retry"] },
  "retry-brief": { act: "answerAsk", handler: "retry-brief", keeperRecovery: ["retry", "release"] },
  "grant-scope": { act: "answerAsk", handler: "grant-scope" },
  "grant-shell-act": { act: "answerAsk", handler: "grant-shell-act" },
  "retry-provider": { act: "answerAsk", handler: "retry-provider" },
  "retry-tick": { act: "answerAsk", handler: "retry-tick" },
  "placement-blocker": { act: "answerAsk", handler: "placement-blocker", keeperRecovery: ["retry"] },
  "answer-blocker": { act: "answerAsk", handler: "answer-blocker", answerOnly: true },
  "registry-blocker": { act: "answerAsk", handler: "registry-blocker", noticeOnly: true },
  decision: { act: "answerAsk", handler: "decision", answerOnly: true },
  "scope-blocker": { act: "answerAsk", handler: "scope-blocker", noticeOnly: true },
  "repair-guard": { act: "answerAsk", handler: "repair-guard" },
  "detection-hire": { act: "answerAsk", handler: "detection-hire", answerOnly: true },
};
export const isNoticeEffect = (effect: AskEffect) => ASK_EFFECTS[effect.type].noticeOnly === true;
export const keeperRecoveryOptions = (effect: AskEffect) => ASK_EFFECTS[effect.type].keeperRecovery;
export const needsKeeperReview = (effect: AskEffect) => effect.type === "communication-hold" && effect.keeperReview === true;
export const keeperOwnsBlock = (effect: AskEffect) => isNoticeEffect(effect) || !!keeperRecoveryOptions(effect) || needsKeeperReview(effect);

export function hasUserAskOutcome(ask: Pick<Ask, "options">, effect: AskEffect): boolean {
  return !keeperOwnsBlock(effect) && (effect.type !== "answer-blocker" || ask.options.length > 1);
}

export function applyAskEffect(effect: AskEffect, handlers: Partial<EffectHandlers>, receipt: { by: "user" | "default" | "keeper" | "preapproval"; id: string }) {
  if (receipt.by === "default" && effect.type !== "decision") throw new Error("Only a reversible plain decision may default");
  const row = ASK_EFFECTS[effect.type];
  if (row.noticeOnly) throw new Error("This block belongs to the Keeper, not to a user answer.");
  if (receipt.by === "preapproval" && effect.type === "close-early") throw new Error("Closing early requires your explicit answer");
  if (effect.type === "quest-start" && receipt.by !== "user") throw new Error("This quest placement needs your explicit answer.");
  if (effect.type === "lead-plan" && receipt.by !== "user") throw new Error("This lead plan needs your explicit answer.");
  if (receipt.by === "preapproval" && effect.type === "grant-shell-act") throw new Error("Pre-approval cannot issue a shell grant");
  if (receipt.by === "keeper" && !row.keeperRecovery && effect.type !== "decision" && !(effect.type === "communication-hold" && effect.hold.act === "draft") && effect.type !== "pull-request-draft" && effect.type !== "grant-shell-act") throw new Error("Keeper answers cannot apply user-only transitions");
  authorize(receipt.by === "default" || receipt.by === "keeper" ? "defaultDecision" : row.act, { level: receipt.by === "default" || receipt.by === "keeper" ? "keeper" : "user-explicit", receipt: receipt.id });
  const handler = handlers[row.handler];
  if (!handler) {
    if (row.answerOnly) return;
    throw new Error(`No transition handler for ${effect.type}`);
  }
  handler(effect);
}
