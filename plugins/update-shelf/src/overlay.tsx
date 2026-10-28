import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { experimental_usePluginId, useRpc } from "@get-bb/plugin-sdk/app";
import { watchInstalledGrid } from "./anchor";
import type { PendingUpdate, rpcContract } from "./contract";
import { UpdatesGroup } from "./group";

export const IDLE_REFRESH_MS = 10_000;
export const ACTIVE_REFRESH_MS = 2_000;

/** Mounted once per window; draws the group only while the Installed plugins page is on screen. */
export function UpdatesOverlay() {
  const pluginId = experimental_usePluginId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => watchInstalledGrid(document, pluginId, setHost), [pluginId]);
  return host === null ? null : createPortal(<InstalledUpdates pluginId={pluginId} />, host);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isActive = (update: PendingUpdate) => update.job?.state === "queued" || update.job?.state === "running";

function InstalledUpdates({ pluginId }: { pluginId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [updates, setUpdates] = useState<readonly PendingUpdate[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(true);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissed, setDismissed] = useDismissedJobs(pluginId);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const result = await rpcRef.current.call("list");
      setUpdates(result.updates);
      setListError(null);
      setCheckedAt(Date.now());
    } catch (error) {
      setListError(message(error));
    } finally {
      setLoaded(true);
      setChecking(false);
    }
  }, []);

  // One read at a time: the next starts only after the last one answered, so a server busy building an update
  // is never handed a pile of overlapping reads.
  const fast = starting.size > 0 || updates.some(isActive);
  const fastRef = useRef(fast);
  fastRef.current = fast;
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      timer = null;
      await refresh();
      if (!alive) return;
      timer = setTimeout(() => void loop(), fastRef.current ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    };
    // After starting updates, poll at the fast pace now instead of after the idle wait already scheduled.
    wake.current = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = setTimeout(() => void loop(), ACTIVE_REFRESH_MS);
    };
    void loop();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      wake.current = () => {};
    };
  }, [refresh]);

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
        wake.current();
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
        Update Shelf couldn’t read the waiting updates: {listError}
      </p>
    );
  }
  return (
    <UpdatesGroup
      updates={updates}
      loading={!loaded}
      checking={checking}
      checkedAt={checkedAt}
      starting={starting}
      dismissed={dismissed}
      onUpdate={(ids) => void onUpdate(ids)}
      onClear={(jobIds) => setDismissed(jobIds)}
      loadChangelog={loadChangelog}
    />
  );
}

/** Finished jobs cleared from the group, kept for the browser session; bb itself forgets them after ten minutes. */
function useDismissedJobs(pluginId: string): [ReadonlySet<string>, (jobIds: string[]) => void] {
  const key = `${pluginId}:dismissed-jobs`;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(readIds(key)));
  const add = useCallback(
    (jobIds: string[]) => {
      setDismissed((current) => {
        const next = new Set([...current, ...jobIds]);
        try {
          sessionStorage.setItem(key, JSON.stringify([...next].slice(-200)));
        } catch {
          // Storage can be full or blocked; the cleared rows then come back after a reload, which is harmless.
        }
        return next;
      });
    },
    [key],
  );
  return [dismissed, add];
}

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
