import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createLayoutStore } from "./src/layout-store";
import { LAYOUT_CHANNEL } from "./src/layout";
import { rpcContract } from "./src/rpc";
import { SETTINGS_CHANNEL, SETTING_DESCRIPTORS } from "./src/settings";

export default function switchboard(bb: BbPluginApi): void {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  settings.onChange(() => bb.realtime.publish(SETTINGS_CHANNEL, {}));
  const store = createLayoutStore(bb.storage.kv, (patch) => bb.realtime.publish(LAYOUT_CHANNEL, patch));
  bb.rpc.register(rpcContract, {
    getLayout: async () => {
      const layout = await store.read();
      return {
        sectionOrder: [...layout.sectionOrder], sectionHues: { ...layout.sectionHues },
        collapsed: [...layout.collapsed],
        order: Object.fromEntries(Object.entries(layout.order).map(([key, ids]) => [key, [...ids]])),
        sectionSort: { ...layout.sectionSort }, snoozes: { ...layout.snoozes },
        sectionProjects: { ...layout.sectionProjects },
      };
    },
    setCollapsed: async ({ key, collapsed }) => ({ collapsed: [...await store.setCollapsed(key, collapsed)] }),
    setOrder: async ({ container, ids }) => ({ ids: [...await store.setOrder(container, ids)] }),
    setSectionOrder: async ({ ids }) => ({ ids: [...await store.setSectionOrder(ids)] }),
    setSectionHue: async ({ sectionId, hue }) => ({ sectionHues: { ...await store.setSectionHue(sectionId, hue) } }),
    setSectionSort: async ({ container, mode }) => ({ sectionSort: { ...await store.setSectionSort(container, mode) } }),
    setSectionProject: async ({ container, projectId }) =>
      ({ sectionProjects: { ...await store.setSectionProject(container, projectId) } }),
    snooze: async ({ threadIds, until }) => ({ snoozes: { ...await store.snooze(threadIds, until) } }),
    unsnooze: async ({ threadIds }) => ({ snoozes: { ...await store.unsnooze(threadIds) } }),
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    if (await bb.storage.kv.get(`snooze:${thread.id}`) !== undefined) await store.unsnooze([thread.id]);
  });
  bb.log.info("loaded");
}
