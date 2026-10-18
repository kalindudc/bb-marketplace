import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PI_SERVICES_RPC } from "./src/contract";
import { SETTINGS_CHANNEL, SETTING_DESCRIPTORS } from "./src/settings";
import { createAiService, piComplete } from "./src/service";

export default function piServices(bb: BbPluginApi): void {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  const ctx = { bb, settings };

  bb.experimental_aiServices.register(createAiService(ctx));

  bb.rpc.register(PI_SERVICES_RPC, {
    regenerateTitle: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const currentTitle = thread?.title ?? null;
      const context = currentTitle ? `Current title: ${currentTitle}\n` : "";
      const prompt =
        "Write a concise thread title (max 8 words, no quotes, no trailing punctuation) " +
        "for this coding conversation.\n" +
        context;
      const title = await piComplete(ctx, prompt, AbortSignal.timeout(4500));
      if (!title) throw new Error("pi returned an empty title");
      await bb.sdk.threads.update({ threadId, title });
      return { title };
    },
    updateSettings: async ({ executable, model }) => {
      const values = await settings.experimental_set({ executable, model });
      return { executable: values.executable, model: values.model };
    },
  });

  settings.onChange(() => bb.realtime.publish(SETTINGS_CHANNEL, {}));
  bb.log.info("pi-services loaded");
}
