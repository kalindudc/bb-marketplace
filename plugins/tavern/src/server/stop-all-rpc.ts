import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { requireUserAct } from "./authority";
import type { TavernRuntime } from "./runtime";

export function stopAllHandlers(runtime: TavernRuntime) {
  return {
    stopAllStatus: () => runtime.stopAll.snapshot(),
    stopAll: (_input: Record<string, never>, context?: ExperimentalPluginRpcHandlerContext) => {
      const caller = context?.experimental_caller;
      return runtime.stopAll.stop({ kind: "tavern" }, caller?.kind === "plugin"
        ? { surface: "plugin RPC", pluginId: caller.pluginId } : { surface: "client RPC (unattested)" });
    },
    resumeAll: (_input: Record<string, never>, context?: ExperimentalPluginRpcHandlerContext) => {
      const receipt = requireUserAct(context, "resumeAll");
      return runtime.stopAll.resume(receipt.surface);
    },
  };
}
