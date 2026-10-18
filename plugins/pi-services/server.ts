import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PI_SERVICES_RPC } from "./src/contract";
import { SETTINGS_CHANNEL } from "./src/settings";
import { createAiService, createSettingsStore, piComplete, piListModels } from "./src/service";

export default function piServices(bb: BbPluginApi): void {
  const settings = createSettingsStore(bb.storage);
  const ctx = { bb, settings };

  bb.experimental_aiServices.register(createAiService(ctx));

  bb.rpc.register(PI_SERVICES_RPC, {
    regenerateTitle: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const currentTitle = thread?.title ?? null;
      const history = await bb.sdk.threads.promptHistory({ threadId });
      const conversation = history
        .slice(-5)
        .map((entry) =>
          entry.input
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" ")
            .slice(0, 600),
        )
        .filter((text) => text.length > 0)
        .join("\n---\n");
      const context =
        (currentTitle ? `Current title: ${currentTitle}\n` : "") +
        (conversation ? `Recent conversation:\n${conversation}\n` : "");
      const prompt =
        "Reply with ONLY a short thread title (max 8 words, no quotes, no punctuation, no markdown, no explanation) for this coding conversation. " +
        "Do not echo the instructions. Output the title text alone.\n" +
        context;
      const title = await piComplete(ctx, prompt, AbortSignal.timeout(15_000), 15_000);
      if (!title) throw new Error("pi returned an empty title");
      await bb.sdk.threads.update({ threadId, title });
      return { title };
    },
    updateSettings: async ({ executable, model }) => {
      const values = await settings.set({
        ...(executable !== undefined && executable !== null ? { executable } : {}),
        ...(model !== undefined && model !== null ? { model } : {}),
      });
      bb.realtime.publish(SETTINGS_CHANNEL, values);
      return { executable: values.executable, model: values.model };
    },
    getSettings: async () => {
      const values = await settings.get();
      return { executable: values.executable, model: values.model };
    },
    listModels: async ({ search }) => {
      const models = await piListModels(ctx, AbortSignal.timeout(12_000));
      const filtered = search
        ? models.filter((m) => m.id.toLowerCase().includes(search.toLowerCase()))
        : models;
      return {
        models: filtered.map((m) => ({
          id: m.id,
          provider: m.provider,
          model: m.model,
          thinking: m.thinking,
          images: m.images,
        })),
      };
    },
  });

  bb.log.info("pi-services loaded");
}
