import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import type { VoiceDraft } from "../../shared/voice-check";
import type { VoiceCheckRunner } from "./run";

/** Only the person in the app starts or cancels a check: no agent tool, tick or other plugin can spend a model turn on it. */
function requireClient(context?: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller.kind !== "client") throw new experimental_PluginRpcRefusal({
    code: "forbidden", message: "A voice check runs only when you press Run check in the voice editor; plugins and agents cannot start one.",
  });
}

export function voiceCheckHandlers(runner: () => VoiceCheckRunner | undefined) {
  const ready = () => {
    const r = runner();
    if (!r) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "The voice check isn't ready yet; Tavern is still starting." });
    return r;
  };
  return {
    voiceCheck: ({ characterId }: { characterId: string }) => ready().view(characterId),
    voiceCheckStart: ({ characterId, draft }: { characterId: string; draft: VoiceDraft }, context?: ExperimentalPluginRpcHandlerContext) => {
      requireClient(context);
      try { return ready().start(characterId, draft); }
      catch (e) { if (e instanceof experimental_PluginRpcRefusal) throw e; throw new experimental_PluginRpcRefusal({ code: "conflict", message: e instanceof Error ? e.message : String(e) }); }
    },
    voiceCheckCancel: ({ characterId, runId }: { characterId: string; runId: string }, context?: ExperimentalPluginRpcHandlerContext) => {
      requireClient(context);
      return ready().cancel(characterId, runId);
    },
  };
}
