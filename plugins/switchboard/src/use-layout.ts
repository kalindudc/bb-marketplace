import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_usePluginId, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { applyLayoutPatch, EMPTY_LAYOUT, LAYOUT_CHANNEL, parseLayout, type CollapseKey, type ContainerKey, type HueId, type Layout, type SortMode } from "./layout";
import type { RpcContract } from "./rpc";

export interface LayoutApi {
  layout: Layout;
  setCollapsed(key: CollapseKey, collapsed: boolean): void;
  setOrder(container: ContainerKey, ids: readonly string[]): void;
  setSectionOrder(ids: readonly string[]): void;
  setSectionHue(sectionId: string, hue: HueId | null): void;
  setSectionSort(container: ContainerKey, mode: SortMode): void;
  snooze(threadIds: readonly string[], until: number): void;
  unsnooze(threadIds: readonly string[]): void;
  refetch(): void;
}

function cacheKey(pluginId: string): string { return `${pluginId}:layout:v1`; }
function cachedLayout(pluginId: string): Layout {
  try {
    const stored = localStorage.getItem(cacheKey(pluginId));
    return stored ? parseLayout(JSON.parse(stored)) : EMPTY_LAYOUT;
  } catch { return EMPTY_LAYOUT; }
}
function cacheLayout(pluginId: string, layout: Layout): void {
  try { localStorage.setItem(cacheKey(pluginId), JSON.stringify(layout)); }
  catch { /* Storage may be unavailable in a private window. */ }
}

export function useLayout(): LayoutApi {
  const pluginId = experimental_usePluginId();
  const rpc = useRpc<RpcContract>();
  const connection = useRealtimeConnectionState();
  const [layout, setLayout] = useState<Layout>(() => cachedLayout(pluginId));
  const [version, setVersion] = useState(0);
  const previousConnection = useRef(connection);
  const update = useCallback((change: (current: Layout) => Layout) => {
    setLayout((current) => {
      const next = change(current);
      if (next !== current) cacheLayout(pluginId, next);
      return next;
    });
  }, [pluginId]);

  useRealtime(LAYOUT_CHANNEL, (payload) => update((current) => applyLayoutPatch(current, payload)));
  const refetch = useCallback(() => setVersion((current) => current + 1), []);
  const onWriteError = useCallback(() => {
    toast.error("Switchboard could not save that change");
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") {
      refetch();
    }
    previousConnection.current = connection;
  }, [connection, refetch]);

  useEffect(() => {
    let cancelled = false;
    rpc.call("getLayout").then((value) => {
      if (!cancelled) update(() => parseLayout(value));
    }).catch((error: unknown) => {
      if (!cancelled) console.warn("Switchboard could not load its layout.", error);
    });
    return () => { cancelled = true; };
  }, [rpc, update, version]);

  const setCollapsed = useCallback((key: CollapseKey, collapsed: boolean) => {
    update((current) => {
      const entries = current.collapsed.filter((entry) => entry !== key);
      if (collapsed) entries.push(key);
      return { ...current, collapsed: entries };
    });
    void rpc.call("setCollapsed", { key, collapsed }).then(({ collapsed: entries }) =>
      update((current) => applyLayoutPatch(current, { key: "collapsed", value: entries }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  const setOrder = useCallback((container: ContainerKey, ids: readonly string[]) => {
    const value = [...new Set(ids)];
    update((current) => applyLayoutPatch(current, { key: `order:${container}`, value }));
    void rpc.call("setOrder", { container, ids: value }).then(({ ids: result }) =>
      update((current) => applyLayoutPatch(current, { key: `order:${container}`, value: result }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  const setSectionOrder = useCallback((ids: readonly string[]) => {
    const value = [...new Set(ids)];
    update((current) => applyLayoutPatch(current, { key: "section-order", value }));
    void rpc.call("setSectionOrder", { ids: value }).then(({ ids: result }) =>
      update((current) => applyLayoutPatch(current, { key: "section-order", value: result }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  const setSectionHue = useCallback((sectionId: string, hue: HueId | null) => {
    update((current) => {
      const sectionHues = { ...current.sectionHues };
      if (hue === null) delete sectionHues[sectionId];
      else sectionHues[sectionId] = hue;
      return applyLayoutPatch(current, { key: "section-hues", value: sectionHues });
    });
    void rpc.call("setSectionHue", { sectionId, hue }).then(({ sectionHues }) =>
      update((current) => applyLayoutPatch(current, { key: "section-hues", value: sectionHues }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  const setSectionSort = useCallback((container: ContainerKey, mode: SortMode) => {
    update((current) => {
      const sectionSort = { ...current.sectionSort };
      if (mode === "manual") delete sectionSort[container];
      else sectionSort[container] = mode;
      return applyLayoutPatch(current, { key: "section-sort", value: sectionSort });
    });
    void rpc.call("setSectionSort", { container, mode }).then(({ sectionSort }) =>
      update((current) => applyLayoutPatch(current, { key: "section-sort", value: sectionSort }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  const snooze = useCallback((threadIds: readonly string[], until: number) => {
    update((current) => {
      const snoozes = { ...current.snoozes };
      const at = Date.now();
      for (const id of threadIds) snoozes[id] = { until, at };
      return applyLayoutPatch(current, { key: "snoozes", value: snoozes });
    });
    void rpc.call("snooze", { threadIds: [...threadIds], until }).then(({ snoozes }) =>
      update((current) => applyLayoutPatch(current, { key: "snoozes", value: snoozes }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  const unsnooze = useCallback((threadIds: readonly string[]) => {
    update((current) => {
      const snoozes = { ...current.snoozes };
      for (const id of threadIds) delete snoozes[id];
      return applyLayoutPatch(current, { key: "snoozes", value: snoozes });
    });
    void rpc.call("unsnooze", { threadIds: [...threadIds] }).then(({ snoozes }) =>
      update((current) => applyLayoutPatch(current, { key: "snoozes", value: snoozes }))
    ).catch(onWriteError);
  }, [rpc, update, onWriteError]);

  return { layout, setCollapsed, setOrder, setSectionOrder, setSectionHue, setSectionSort, snooze, unsnooze, refetch };
}
