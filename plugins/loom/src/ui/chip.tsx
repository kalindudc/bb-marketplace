import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRealtime, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { ThreadInfo, rpcContract } from "../contract";

/** A worker, reviewer or planner thread's link to its ticket (or project) on the Loom page. Other threads show nothing. */
export function TicketChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [info, setInfo] = useState<ThreadInfo | null>(null);
  const latest = useRef({ rpc, info });
  latest.current = { rpc, info };

  // Bumped when the thread changes and when the chip unmounts, so a response to an earlier thread's request, whoever sent it, is dropped.
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [threadId],
  );

  const load = useCallback(() => {
    const asked = generation.current;
    latest.current.rpc.call("threadInfo", { threadId }).then(
      (next) => generation.current === asked && setInfo(next),
      () => generation.current === asked && setInfo(null),
    );
  }, [threadId]);
  useEffect(() => {
    if (isCompactViewport) return;
    setInfo(null);
    load();
  }, [load, isCompactViewport]);
  // Its state moves with the ticket; a thread that was not a Loom thread a moment ago may have become one.
  useRealtime("loom:changed", (payload) => {
    const { info: shown } = latest.current;
    if (!isCompactViewport && (shown === null || (payload as { slug?: string } | null)?.slug === shown.slug)) load();
  });

  if (isCompactViewport || info === null) return null;
  const label = info.key === null ? info.slug : `${info.key} · ${info.state}`;
  return (
    <button
      type="button"
      aria-label={`Open ${info.key ?? info.slug} in Loom`}
      onClick={() => navigate.toPluginPanel("loom", { subPath: info.key === null ? info.slug : `${info.slug}/${info.key}` })}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="Layers" className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}
