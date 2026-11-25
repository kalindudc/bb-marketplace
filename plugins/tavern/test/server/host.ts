import { afterEach, vi } from "vitest";
import { createFakePluginHost as createSdkHost } from "@get-bb/plugin-sdk/testing";
import { SdkContractError, validateSdkCall } from "./sdk-contract";
import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginRpcContract,
  PluginRpcHandlers,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
const rpcHosts = new Set<ReturnType<typeof createSdkHost>>();
afterEach(async () => {
  const hosts = [...rpcHosts];
  rpcHosts.clear();
  await Promise.all(hosts.map(host => host.harness.lifecycle.dispose()));
});
type Thread = PluginThreadEventPayloads["thread.active"]["thread"];
export function makeThreadResponse(patch: Partial<Thread> = {}): Thread {
  return {
    id: "test",
    status: "idle",
    projectId: "project",
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: 1_000_000,
    createdAt: 1_000_000,
    environmentId: null,
    queuedMessageCount: 0,
    activeBackgroundAgentCount: 0,
    title: null,
    providerId: "pi",
    runtime: { displayStatus: "idle" },
    ...patch,
  } as Thread;
}
export function makePluginAgentConfigurationContext(
  patch: { thread?: { id: string }; pluginMetadata?: Record<string, string> } = {},
): PluginAgentConfigurationContext {
  return {
    thread: {
      id: "test",
      title: null,
      parentThreadId: null,
      sourceThreadId: null,
      ...patch.thread,
    },
    project: { id: "project", name: "Project", kind: "standard", gitRemoteUrl: null },
    environment: {
      id: "env",
      path: null,
      name: null,
      branchName: null,
      workspaceProvisionType: null,
    },
    host: { id: "host", name: "Host" },
    provider: { id: "pi", model: "test", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: null },
    pluginMetadata: patch.pluginMetadata ?? {},
  };
}
export function makeMessageDispatchHookContext(patch: {
  thread?: Partial<Thread>;
  project?: { id: string };
  initiator?: MessageDispatchHookContext["initiator"];
  input?: MessageDispatchHookContext["input"];
  originPluginId?: string;
  experimental_submission?: MessageDispatchHookContext["experimental_submission"];
}): MessageDispatchHookContext {
  return {
    project: {
      id: "project",
      name: "Project",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      ...patch.project,
    },
    environment: null,
    host: null,
    environmentIntent: null,
    input: { text: "hello", blocks: [] },
    requestedExecution: {
      providerId: "pi",
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    },
    executionSources: {
      providerId: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    },
    attempt: "start-turn",
    initiator: "user",
    senderThreadId: null,
    queuedMessages: [],
    experimental_submission: null,
    origin: "app",
    originPluginId: null,
    parentThreadId: null,
    ...patch,
    thread: makeThreadResponse(patch.thread),
  } as MessageDispatchHookContext;
}
export function createFakePluginHost(options: {
  pluginId: string;
  agentSkillIds?: string[];
  sdk: Record<string, unknown>;
}) {
  let configure: (ctx: PluginAgentConfigurationContext) => PluginAgentConfiguration;
  type Tool = {
    name: string;
    description: string;
    execute(input: unknown, ctx: PluginAgentToolContext): unknown;
    presentation?: unknown;
  };
  const tools: Tool[] = [];
  const cli: Parameters<BbPluginApi["cli"]["register"]>[0][] = [];
  let rpcHost: ReturnType<typeof createSdkHost> | undefined;
  const calls: { path: string; args: unknown[] }[] = [];
  const environments = new Map<string, string | null>();
  function tracked(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
    const cache = new Map<PropertyKey, { value: unknown; wrapped: unknown }>();
    return new Proxy(obj, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof key !== "string" || (!value || (typeof value !== "function" && typeof value !== "object"))) return value;
        const cached = cache.get(key);
        if (cached && cached.value === value) return cached.wrapped;
        const path = prefix ? `${prefix}.${key}` : key;
        const wrapped = typeof value === "function" ? new Proxy(value, {
          apply(fn, thisArg, args) {
            calls.push({ path, args });
            try {
              validateSdkCall(path, args);
              if (path === "threads.storageLocation" && environments.get(args[0].threadId) === null)
                throw new SdkContractError("Thread environment is not available", 409, "thread_environment_unavailable");
              const result = Reflect.apply(fn, thisArg, args);
              if (path === "threads.get" || path === "threads.spawn") {
                const observe = (thread: unknown) => {
                  if (thread && typeof thread === "object" && "id" in thread && typeof thread.id === "string" && "environmentId" in thread && (thread.environmentId === null || typeof thread.environmentId === "string")) environments.set(thread.id, thread.environmentId);
                };
                if (result && typeof result === "object" && "then" in result && typeof result.then === "function") void result.then(observe, () => {});
                else observe(result);
              }
              return result;
            } catch (error) { return Promise.reject(error); }
          },
        }) : tracked(value as Record<string, unknown>, path);
        cache.set(key, { value, wrapped });
        return wrapped;
      },
    });
  }
  const bb = {
    pluginId: options.pluginId,
    log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
    agents: {
      registerTool: (tool: Tool) => tools.push(tool),
      configure: (callback: typeof configure) => {
        configure = callback;
      },
    },
    cli: { register: (command: (typeof cli)[number]) => cli.push(command) },
    providers: { register: vi.fn(), experimental_contributeEnv: vi.fn() },
    experimental_hooks: { recheck: vi.fn(async () => {}) },
    events: { on: vi.fn() },
    http: { experimental_websocket: vi.fn() },
    onDispose: vi.fn(),
    rpc: {
      register: <C extends PluginRpcContract>(contract: C, value: PluginRpcHandlers<C>) => {
        if (!rpcHost) {
          rpcHost = createSdkHost({ pluginId: options.pluginId });
          rpcHosts.add(rpcHost);
        }
        rpcHost.bb.rpc.register(contract, value);
      },
      experimental_invalidate: vi.fn(),
    },
    sdk: tracked(options.sdk),
  } as unknown as BbPluginApi;
  return {
    bb,
    harness: {
      inspection: {
        registrations: { agentTools: tools, cli, get rpcMethods() { return rpcHost?.harness.registrations.rpcMethods ?? []; } },
        sdk: { callsTo: (path: string) => calls.filter((c) => c.path === path) },
      },
      invokeRpc: async (name: string, input: unknown, context?: Parameters<NonNullable<typeof rpcHost>["harness"]["behavior"]["callRpc"]>[2]) => {
        if (!rpcHost) throw new Error("No RPC methods registered");
        return rpcHost.harness.behavior.callRpc(name, input, context);
      },
      behavior: {
        resolveAgentConfiguration: async (ctx: PluginAgentConfigurationContext) => {
          const config = configure(ctx);
          const choices = new Map(config.tools.map(tool => typeof tool === "string" ? [tool, undefined] : [tool.name, tool.parameters]));
          return { ...config, tools: tools.flatMap(tool => {
            if (!choices.has(tool.name)) return [];
            const parameters = choices.get(tool.name);
            return [parameters ? { ...tool, parameters } : tool];
          }) };
        },
        invokeAgentTool: async (name: string, input: unknown, ctx: { threadId: string }) =>
          tools
            .find((t) => t.name === name)!
            .execute(input, { ...ctx, projectId: "project", signal: new AbortController().signal }),
      },
    },
  };
}
