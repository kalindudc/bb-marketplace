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
export type EffectHandlers = { [K in AskEffect["type"]]: (effect: AskEffect) => void };
export const ASK_EFFECTS: Record<AskEffect["type"], { act: Act; handler: keyof EffectHandlers; answerOnly?: true }> = {
  greenlight: { act: "greenlight", handler: "greenlight" },
  conclude: { act: "conclude", handler: "conclude" },
  "close-early": { act: "closeEarly", handler: "close-early" },
  "release-hold": { act: "releaseCheckerHandoff", handler: "release-hold" },
  "settle-waypoint": { act: "answerAsk", handler: "settle-waypoint" },
  "soft-limit": { act: "answerAsk", handler: "soft-limit" },
  "pull-request-draft": { act: "answerAsk", handler: "pull-request-draft", answerOnly: true },
  "retry-stop": { act: "answerAsk", handler: "retry-stop" },
  "retry-brief": { act: "answerAsk", handler: "retry-brief" },
  "grant-scope": { act: "answerAsk", handler: "grant-scope" },
  "retry-provider": { act: "answerAsk", handler: "retry-provider" },
  "retry-tick": { act: "answerAsk", handler: "retry-tick" },
  "placement-blocker": { act: "answerAsk", handler: "placement-blocker", answerOnly: true },
  "answer-blocker": { act: "answerAsk", handler: "answer-blocker", answerOnly: true },
  decision: { act: "answerAsk", handler: "decision", answerOnly: true },
  "scope-blocker": { act: "answerAsk", handler: "scope-blocker", answerOnly: true },
  "detection-hire": { act: "answerAsk", handler: "detection-hire", answerOnly: true },
};
export function applyAskEffect(effect: AskEffect, handlers: Partial<EffectHandlers>, receipt: { by: "user" | "default" | "keeper" | "preapproval"; id: string }) {
  if (receipt.by === "default" && effect.type !== "decision") throw new Error("Only a reversible plain decision may default");
  const row = ASK_EFFECTS[effect.type];
  if (receipt.by === "preapproval" && effect.type === "close-early") throw new Error("Closing early requires your explicit answer");
  if (receipt.by === "keeper" && effect.type !== "decision" && effect.type !== "pull-request-draft") throw new Error("Keeper answers cannot apply user-only transitions");
  authorize(receipt.by === "default" || receipt.by === "keeper" ? "defaultDecision" : row.act, { level: receipt.by === "default" || receipt.by === "keeper" ? "keeper" : "user-explicit", receipt: receipt.id });
  const handler = handlers[row.handler];
  if (!handler) {
    if (row.answerOnly) return;
    throw new Error(`No transition handler for ${effect.type}`);
  }
  handler(effect);
}
