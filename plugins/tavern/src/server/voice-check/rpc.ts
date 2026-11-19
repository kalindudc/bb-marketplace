import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { requireUserAct, type UserActReceipt } from "../authority";
import type { VoiceDraft } from "../../shared/voice-check";
import type { VoiceCheckRunner } from "./run";

/** Only the person in the app starts or cancels a check: no agent tool, tick or other plugin can spend a model turn on it. */
function requireClient(context?: ExperimentalPluginRpcHandlerContext) {
  return requireUserAct(context, "voiceCheckStart");
}

export function voiceCheckHandlers(runner: () => VoiceCheckRunner | undefined) {
  const ready = () => {
    const r = runner();
    if (!r) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The voice check isn't ready yet; Tavern is still starting." });
    return r;
  };
  return {
    voiceCheck: ({ characterId }: { characterId: string }) => ready().view(characterId),
    voiceCheckStart: ({ characterId, draft }: { characterId: string; draft: VoiceDraft }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireClient(context);
      try { return ready().start(characterId, draft, receipt); }
      catch (e) { if (e instanceof experimental_PluginRpcRefusal) throw e; throw new experimental_PluginRpcRefusal({ code: "conflict", message: e instanceof Error ? e.message : String(e) }); }
    },
    voiceCheckCancel: ({ characterId, runId }: { characterId: string; runId: string }, context?: ExperimentalPluginRpcHandlerContext) => {
      requireClient(context);
      return ready().cancel(characterId, runId);
    },
  };
}
