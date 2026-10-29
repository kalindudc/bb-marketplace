import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_RECENT_LIMIT,
  EMPTY_STATE,
  MAX_LINEUP,
  MAX_RECENT_LIMIT,
  normalizeLineup,
  VIEWS,
  type CatalogProvider,
  type LineupState,
} from "./src/lineup";
import { collectRecent, ThreadModelCache } from "./src/recent";

const id = z.string().min(1).max(300);
const modelRef = z.object({ providerId: id, model: id });
const view = z.enum(VIEWS as [string, ...string[]]).transform((value) => value as LineupState["lastView"]);
const stateSchema = z.object({ lineup: z.array(modelRef).max(MAX_LINEUP * 2), lastView: view });

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: stateSchema },
  saveLineup: { input: z.object({ lineup: z.array(modelRef).max(MAX_LINEUP * 2) }), output: stateSchema },
  setLastView: { input: z.object({ view }), output: stateSchema },
  recent: {
    input: z.null(),
    output: z.object({ models: z.array(modelRef.extend({ usedAt: z.number() })) }),
  },
  catalog: {
    input: z.null(),
    output: z.object({
      providers: z.array(
        z.object({
          id,
          displayName: z.string(),
          brandPrefix: z.string().optional(),
          models: z.array(
            z.object({ model: id, displayName: z.string(), routeProviderId: z.string().optional() }),
          ),
        }),
      ),
    }),
  },
});

/** Every window refetches on this signal: the lineup, the last tab or the recent limit changed. */
export const STATE_CHANGED = "state-changed";
const KV_KEY = "state";
const CATALOG_TTL_MS = 60_000;
const RECENT_TTL_MS = 10_000;

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    recentLimit: {
      type: "number",
      label: "Models in Recent",
      description: `How many of the models your threads used most recently the Recent tab lists (1 to ${MAX_RECENT_LIMIT}).`,
      default: DEFAULT_RECENT_LIMIT,
      experimental_schema: z.number().int().min(1).max(MAX_RECENT_LIMIT),
    },
  });
  settings.onChange(() => {
    recentCache = null;
    bb.realtime.publish(STATE_CHANGED, { reason: "settings" });
  });

  async function read(): Promise<LineupState> {
    const raw = await bb.storage.kv.get<unknown>(KV_KEY);
    if (raw === undefined || raw === null) return EMPTY_STATE;
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((issue) => issue.message).join("; ");
      bb.log.warn(`stored Lineup state does not match the schema, so it starts empty: ${issues}`);
      return EMPTY_STATE;
    }
    return { lineup: normalizeLineup(parsed.data.lineup), lastView: parsed.data.lastView };
  }

  async function write(change: (state: LineupState) => LineupState): Promise<LineupState> {
    const next = change(await read());
    const clean = { lineup: normalizeLineup(next.lineup), lastView: next.lastView };
    await bb.storage.kv.set(KV_KEY, clean);
    bb.realtime.publish(STATE_CHANGED, { reason: "state" });
    return clean;
  }

  const threadModels = new ThreadModelCache(async (threadId) => {
    const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    return options?.model ?? null;
  });
  let recentCache: { at: number; value: Awaited<ReturnType<typeof collectRecent>> } | null = null;

  async function recent() {
    if (recentCache !== null && Date.now() - recentCache.at < RECENT_TTL_MS) return recentCache.value;
    const { recentLimit } = await settings.get();
    const threads = await bb.sdk.threads.list();
    const value = await collectRecent(
      threads.map((thread) => ({ id: thread.id, providerId: thread.providerId, updatedAt: thread.updatedAt })),
      threadModels,
      recentLimit,
    );
    recentCache = { at: Date.now(), value };
    return value;
  }

  const modelCache = new Map<string, { at: number; models: CatalogProvider["models"] }>();

  async function modelsOf(providerId: string): Promise<CatalogProvider["models"]> {
    const cached = modelCache.get(providerId);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
    const result = await bb.sdk.providers.models({ providerId });
    const models = [...result.models, ...result.selectedOnlyModels].map((model) => ({
      model: model.model,
      displayName: model.displayName || model.model,
      ...(model.routeProviderId ? { routeProviderId: model.routeProviderId } : {}),
    }));
    modelCache.set(providerId, { at: Date.now(), models });
    return models;
  }

  async function catalog(): Promise<CatalogProvider[]> {
    const providers = await bb.sdk.providers.list();
    const loaded = await Promise.all(
      providers.map(async (provider): Promise<CatalogProvider | null> => {
        try {
          const brandPrefix = provider.strings?.brandPrefix;
          return {
            id: provider.id,
            displayName: provider.displayName,
            ...(brandPrefix ? { brandPrefix } : {}),
            models: await modelsOf(provider.id),
          };
        } catch (error) {
          bb.log.warn(`could not load ${provider.id} models: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
    return loaded.filter((provider): provider is CatalogProvider => provider !== null);
  }

  bb.rpc.register(rpcContract, {
    state: () => read(),
    saveLineup: ({ lineup }) => write((state) => ({ ...state, lineup })),
    setLastView: ({ view: next }) => write((state) => ({ ...state, lastView: next })),
    recent: async () => ({ models: await recent() }),
    catalog: async () => ({ providers: await catalog() }),
  });
}
