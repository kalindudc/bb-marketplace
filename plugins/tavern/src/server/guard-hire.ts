import { createHash } from "node:crypto";
import type { Member } from "../shared/schema";
import type { Keeper } from "./keeper/service";
import type { HireIntent } from "./keeper/store";

export class DetectionApprovalRequired extends Error {
  constructor(readonly askId: string, reason: string) {
    super(reason);
  }
}

export function authorizeGuardedHire(
  k: Keeper,
  token: string,
  intent: HireIntent,
  providerId: string,
  model: string | undefined,
  recipe: unknown,
  requestApproval: boolean,
  approvalAskId?: string,
): NonNullable<Member["guardPosture"]> {
  if (!model)
    throw new Error(`Cannot verify the model for this scoped hire. Set classes.${intent.classId}.model to an available model.`);
  if (providerId === "pi")
    return {
      providerId,
      mode: "pre-exec",
      label: "Pi pre-exec guard and watcher",
      approvalAskId: null,
    };
  const reason = `Cannot hire scoped model ${model} on ${providerId}: only pi can block commands before they run. No member was hired. Request a detection-only scope ask with requestDetectionOnly: true, or choose a model Pi offers in Tavern class settings.`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ providerId, model, recipe }))
    .digest("hex");
  const keeperId = intent.owner.keeperThreadId;
  if (!approvalAskId) {
    if (!requestApproval) throw new Error(reason);
    const existing = k.store.openAsks(keeperId).find(candidate =>
      candidate.kind === "scope" &&
      candidate.effect?.type === "detection-hire" && candidate.effect.binding.fingerprint === fingerprint,
    );
    const ask = existing ?? k.store.atomic(() => {
      const created = k.ask(keeperId, { effect: { type: "detection-hire", binding: { fingerprint, providerId, model, characterId: intent.characterId, displayName: intent.owner.displayName ?? (intent.classId.charAt(0).toUpperCase() + intent.classId.slice(1)) } },
        boardQuestId: intent.owner.boardQuestId,
        kind: "scope",
        question: `Hire ${intent.owner.displayName ?? (intent.classId.charAt(0).toUpperCase() + intent.classId.slice(1))} on ${providerId} with detection only? Tavern can stop the turn after a push or merge, but can't prevent it.`,
        why: "Only Pi can block commands before execution. This exception permits detection only for one exact hire; it is not approval for a push or merge.",
        options: [
          {
            id: "approve",
            label: "Hire with detection only",
            detail: `${model}: detection only (not prevented). Existing action approvals still apply.`,
            recommended: false,
          },
          {
            id: "deny",
            label: "Do not hire on this provider",
            detail: "No widening granted. Choose a model Pi can guard before execution.",
            recommended: true,
          },
        ],
        meanwhile: "Do not hire this member or send its brief. Choose a Pi model, or wait for the user's answer.",
        holds: intent.owner.waypointId ? [intent.owner.waypointId] : [],
      });

      return created;
    });
    throw new DetectionApprovalRequired(ask.id, reason);
  }
  const ask = k.store.get("asks", approvalAskId);
  const binding = ask?.effect?.type === "detection-hire" ? ask.effect.binding : null;
  if (
    !binding || binding.fingerprint !== fingerprint ||
    ask?.keeperThreadId !== keeperId || ask.boardQuestId !== intent.owner.boardQuestId ||
    ask.kind !== "scope" || ask.proceedAt !== null
  )
    throw new Error("The detection-only approval does not match this exact hire. Request a fresh scope ask.");
  if (ask.state !== "answered" || ask.answer?.by !== "user" || ask.answer.optionId !== "approve")
    throw new Error("A detection-only hire needs the user's explicit approval of this exact scope ask.");
  if (
    binding.characterId !== intent.characterId ||
    binding.displayName !== (intent.owner.displayName ?? (intent.classId.charAt(0).toUpperCase() + intent.classId.slice(1)))
  )
    throw new Error("The approved member is no longer available for this exact hire. Request a fresh scope ask.");
  if (binding.token && binding.token !== token)
    throw new Error("This detection-only approval was already used for a hire.");
  k.store.atomic(() => {
    k.store.put("asks", ask.id, { ...ask, effect: { type: "detection-hire", binding: { ...binding, token } } });
    intent.guardApprovalAskId = ask.id;
    k.store.put("hires", token, intent);
  });
  return {
    providerId,
    mode: "detection-only",
    label: "detection only (not prevented)",
    approvalAskId,
  };
}
