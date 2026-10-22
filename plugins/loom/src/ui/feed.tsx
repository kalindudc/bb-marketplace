import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { FeedRow, rpcContract } from "../contract";
import { messageOf } from "./common";

const KEEP = 500;
const when = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The project's events, newest first. A change reads only the events after the last one shown. `at` shows the events up to that id and takes no live updates. */
export function Feed({ slug, at = null }: { slug: string; at?: number | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const latest = useRef(rpc);
  latest.current = rpc;
  const generation = useRef(0);
  const lastId = useRef<number | undefined>(undefined);
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const mine = generation.current;
    const after = lastId.current;
    latest.current.call("feed", { slug, ...(after === undefined ? {} : { afterId: after }), ...(at === null ? {} : { at }) }).then(
      (result) => {
        if (mine !== generation.current) return;
        lastId.current = Math.max(lastId.current ?? 0, result.lastId);
        setRows((current) => {
          const seen = new Set((current ?? []).map((row) => row.id));
          return [...(current ?? []), ...result.rows.filter((row) => !seen.has(row.id))].slice(-KEEP);
        });
        setError(null);
      },
      (failure) => {
        if (mine === generation.current) setError(messageOf(failure));
      },
    );
  }, [slug, at]);
  useEffect(() => {
    generation.current += 1;
    lastId.current = undefined;
    setRows(null);
    setError(null);
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  useRealtime("loom:changed", (payload) => {
    if (at === null && (payload as { slug?: string } | null)?.slug === slug) load();
  });

  if (error !== null) return <p role="alert" className="p-4 text-sm text-destructive-text">Could not read the feed: {error}</p>;
  if (rows === null) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">No events yet.</p>;
  return (
    <ol data-feed className="divide-y divide-border-seam">
      {[...rows].reverse().map((row) => (
        <li key={row.id} data-feed-row={row.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
          <time dateTime={new Date(row.at).toISOString()} className="w-28 shrink-0 text-xs text-muted-foreground">{when(row.at)}</time>
          <span data-feed-text className="min-w-0 flex-1">{row.text}</span>
          {row.ticketKey !== null && (
            <button type="button" onClick={() => navigate.toPluginPanel("loom", { subPath: `${slug}/${row.ticketKey}` })} className="cursor-pointer rounded text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {row.ticketKey}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
