import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { memoryContract } from "../shared/memory";
import { hasAgentOrCliMarker, requireUserAct } from "./authority";
import type { TavernRuntime } from "./runtime";

function client(context?: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller?.kind !== "client" || hasAgentOrCliMarker(context))
    throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Use Tavern's Memory page, or tavern_memory from a Tavern class." });
}
export function memoryHandlers(runtime: TavernRuntime): ExperimentalPluginRpcHandlersWithContext<typeof memoryContract> {
  return {
    memorySettings: (_input, context) => {
      client(context);
      return runtime.memory.store.settingsView();
    },
    memoryConfigure: (input, context) => {
      requireUserAct(context, "memoryConfigure");
      return runtime.memory.configure(input.revision, input.config, context?.experimental_signal);
    },
    memoryProjects: async (_input, context) => {
      client(context);
      const projects = await runtime.bb.sdk.projects.list({ includePersonal: true, signal: context?.experimental_signal });
      return projects.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    },
    memoryList: (input, context) => {
      client(context);
      return runtime.memory.list(input, context?.experimental_signal);
    },
    memoryPrevious: (input, context) => {
      client(context);
      return runtime.memory.previous(input.project, input.id);
    },
    memoryManage: (input, context) => {
      requireUserAct(context, "memoryManage");
      return runtime.memory.manage(input, context?.experimental_signal);
    },
  };
}
