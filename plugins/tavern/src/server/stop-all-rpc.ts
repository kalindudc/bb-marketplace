import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import type { TavernRuntime } from "./runtime";

function hasAgentOrCliMarker(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return typeof value === "string" && /(?:^|[^a-z])(agent|cli)(?:$|[^a-z])/i.test(value);
  return Object.entries(value).some(([key, item]) => {
    if (key === "experimental_signal" || item === null || item === undefined || item === false || item === "") return false;
    const name = key.replaceAll(/[_-]/g, "").toLowerCase();
    return /thread|agent|^iscli$|^cli$|originplugin/.test(name) || hasAgentOrCliMarker(item, depth + 1);
  });
}

export function stopAllHandlers(runtime: TavernRuntime) {
  return {
    stopAllStatus: () => runtime.stopAll.snapshot(),
    stopAll: (_input: Record<string, never>, context?: ExperimentalPluginRpcHandlerContext) => {
      const caller = context?.experimental_caller;
      return runtime.stopAll.stop({ kind: "tavern" }, caller?.kind === "plugin"
        ? { surface: "plugin RPC", pluginId: caller.pluginId } : { surface: "client RPC (unattested)" });
    },
    resumeAll: (_input: Record<string, never>, context?: ExperimentalPluginRpcHandlerContext) => {
      if (context?.experimental_caller.kind !== "client" || hasAgentOrCliMarker(context)) throw new experimental_PluginRpcRefusal({
        code: "forbidden", message: "Resuming Tavern requires a client call without agent or CLI markers; agent, CLI and plugin callers are refused.",
      });
      return runtime.stopAll.resume("client RPC (unattested)");
    },
  };
}
