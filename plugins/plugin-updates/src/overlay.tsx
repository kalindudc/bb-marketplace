import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { experimental_usePluginId, useRpc } from "@get-bb/plugin-sdk/app";
import { watchInstalledGrid } from "./anchor";
import type { PendingUpdate, rpcContract } from "./contract";
import { UpdatesGroup } from "./group";

const IDLE_REFRESH_MS = 10_000;
const ACTIVE_REFRESH_MS = 2_000;

/** Mounted once per window; draws the group only while the Installed plugins page is on screen. */
export function UpdatesOverlay() {
  const pluginId = experimental_usePluginId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => watchInstalledGrid(document, pluginId, setHost), [pluginId]);
  return host === null ? null : createPortal(<InstalledUpdates />, host);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function InstalledUpdates() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [updates, setUpdates] = useState<readonly PendingUpdate[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      const result = await rpcRef.current.call("list");
      setUpdates(result.updates);
      setListError(null);
    } catch (error) {
      setListError(message(error));
    }
  }, []);

  const active = starting.size > 0 || updates.some((update) => update.job?.state === "queued" || update.job?.state === "running");
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, active]);

  const onUpdate = useCallback(
    async (ids: string[]) => {
      setStarting((current) => new Set([...current, ...ids]));
      try {
        const result = await rpcRef.current.call("update", { ids });
        for (const failure of result.failed) {
          toast.error(`Couldn’t update ${updates.find((update) => update.id === failure.id)?.name ?? failure.id}`, {
            description: failure.error,
          });
        }
        await refresh();
      } catch (error) {
        toast.error("Couldn’t start the update", { description: message(error) });
      } finally {
        setStarting((current) => new Set([...current].filter((id) => !ids.includes(id))));
      }
    },
    [refresh, updates],
  );

  const loadChangelog = useCallback((id: string) => rpcRef.current.call("changelog", { id }), []);

  if (listError !== null && updates.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        Plugin Updates couldn’t read the waiting updates: {listError}
      </p>
    );
  }
  return <UpdatesGroup updates={updates} starting={starting} onUpdate={(ids) => void onUpdate(ids)} loadChangelog={loadChangelog} />;
}
