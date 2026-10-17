import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_ENTRIES, parseLayout, type CollapseKey, type ContainerKey, type HueId, type Layout, type LayoutPatch, type SnoozeEntry, type SortMode } from "./layout";

export interface LayoutStore {
  read(): Promise<Layout>;
  setCollapsed(key: CollapseKey, collapsed: boolean): Promise<readonly string[]>;
  setOrder(container: ContainerKey, ids: readonly string[]): Promise<readonly string[]>;
  setSectionOrder(ids: readonly string[]): Promise<readonly string[]>;
  setSectionHue(sectionId: string, hue: HueId | null): Promise<Readonly<Record<string, HueId>>>;
  setSectionSort(container: ContainerKey, mode: SortMode): Promise<Readonly<Record<string, SortMode>>>;
  snooze(threadIds: readonly string[], until: number): Promise<Readonly<Record<string, SnoozeEntry>>>;
  unsnooze(threadIds: readonly string[]): Promise<Readonly<Record<string, SnoozeEntry>>>;
}

export function createLayoutStore(
  kv: BbPluginApi["storage"]["kv"],
  publish: (patch: LayoutPatch) => void,
): LayoutStore {
  return {
    async read() {
      const [sectionOrder, sectionHues, collapsed, sectionSort, keys, snoozeKeys] = await Promise.all([
        kv.get("section-order"), kv.get("section-hues"), kv.get("collapsed"), kv.get("section-sort"),
        kv.list("order:"), kv.list("snooze:"),
      ]);
      const [entries, snoozeEntries] = await Promise.all([
        Promise.all(keys.slice(0, MAX_ENTRIES).map(async (key) => [key.slice(6), await kv.get(key)] as const)),
        Promise.all(snoozeKeys.slice(0, MAX_ENTRIES).map(async (key) => [key.slice(7), await kv.get(key)] as const)),
      ]);
      return parseLayout({ sectionOrder, sectionHues, collapsed, sectionSort,
        order: Object.fromEntries(entries), snoozes: Object.fromEntries(snoozeEntries) });
    },
    async setCollapsed(key, collapsed) {
      const stored = parseLayout({ collapsed: await kv.get("collapsed") }).collapsed;
      const next = stored.filter((entry) => entry !== key);
      if (collapsed) next.push(key);
      const value = next.slice(-MAX_ENTRIES);
      await kv.set("collapsed", value);
      publish({ key: "collapsed", value });
      return value;
    },
    async setOrder(container, ids) {
      const value = [...new Set(ids)].slice(0, MAX_ENTRIES);
      if (value.length) await kv.set(`order:${container}`, value);
      else await kv.delete(`order:${container}`);
      publish({ key: `order:${container}`, value });
      return value;
    },
    async setSectionOrder(ids) {
      const value = [...new Set(ids)].slice(0, MAX_ENTRIES);
      await kv.set("section-order", value);
      publish({ key: "section-order", value });
      return value;
    },
    async setSectionHue(sectionId, hue) {
      const value = { ...parseLayout({ sectionHues: await kv.get("section-hues") }).sectionHues };
      if (hue === null) delete value[sectionId];
      else value[sectionId] = hue;
      await kv.set("section-hues", value);
      publish({ key: "section-hues", value });
      return value;
    },
    async setSectionSort(container, mode) {
      const value = { ...parseLayout({ sectionSort: await kv.get("section-sort") }).sectionSort };
      if (mode === "manual") delete value[container];
      else value[container] = mode;
      await kv.set("section-sort", value);
      publish({ key: "section-sort", value });
      return value;
    },
    async snooze(threadIds, until) {
      const at = Date.now();
      await Promise.all([...new Set(threadIds)].map((threadId) => kv.set(`snooze:${threadId}`, { until, at })));
      const value = (await this.read()).snoozes;
      publish({ key: "snoozes", value });
      return value;
    },
    async unsnooze(threadIds) {
      await Promise.all([...new Set(threadIds)].map((threadId) => kv.delete(`snooze:${threadId}`)));
      const value = (await this.read()).snoozes;
      publish({ key: "snoozes", value });
      return value;
    },
  };
}
