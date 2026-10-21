import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { ProjectSummary, rpcContract } from "../contract";
import { TICKET_STATES } from "../states";

export type Rpc = PluginRpcClient<typeof rpcContract>;

export const BUTTON = "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border-seam px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const BUTTON_DANGER = `${BUTTON} text-destructive-text`;
export const BUTTON_PRIMARY = "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const CARD = "rounded-md border border-border-seam p-3";
export const FIELD = "w-full rounded-md border border-border-seam bg-transparent px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const HEADING = "text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground";

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const mergeLabel = (project: Pick<ProjectSummary, "strategy" | "branch">) => (project.strategy === "integration" ? `integration branch ${project.branch}` : "one pull request per ticket");
export const countsLabel = (counts: ProjectSummary["ticketCounts"]) =>
  TICKET_STATES.filter((state) => (counts[state] ?? 0) > 0)
    .map((state) => `${counts[state]} ${state.replace("_", " ")}`)
    .join(" · ") || "no tickets";

const BADGE_TONES: Record<string, string> = {
  draft: "text-muted-foreground",
  ready: "text-muted-foreground",
  queued: "text-muted-foreground",
  running: "text-primary",
  working: "text-primary",
  checking: "text-primary",
  review: "text-primary",
  approved: "text-success",
  merging: "text-success",
  pr_open: "text-success",
  done: "text-success",
  paused: "text-warning-text",
  blocked: "text-destructive-text",
  cancelled: "text-subtle-foreground",
  archived: "text-subtle-foreground",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span data-state-badge className={`inline-flex shrink-0 items-center rounded-full border border-border-seam px-2 py-0.5 text-[11px] leading-none ${BADGE_TONES[state] ?? "text-muted-foreground"}`}>
      {state.replace("_", " ")}
    </span>
  );
}

/** A two-step button: the first click asks "Confirm <label>" for five seconds, the second one acts. */
export function ConfirmButton({ label, onConfirm, disabled = false, danger = false }: { label: string; onConfirm(): void; disabled?: boolean; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={disabled}
      className={danger ? BUTTON_DANGER : BUTTON}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? `Confirm ${label.toLowerCase()}` : label}
    </button>
  );
}

/** Loads a view through the RPC and loads it again when the project it belongs to changes (`slug` null: any project). */
export function useRemote<T>(fetcher: (rpc: Rpc) => Promise<T>, id: string, slug: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const latest = useRef({ rpc, fetcher });
  latest.current = { rpc, fetcher };
  const seq = useRef(0);
  const [state, setState] = useState<{ id: string; data: T | null; error: string | null }>({ id, data: null, error: null });

  const load = useCallback(() => {
    seq.current += 1;
    const mine = seq.current;
    latest.current.fetcher(latest.current.rpc).then(
      (data) => mine === seq.current && setState({ id, data, error: null }),
      (error) => mine === seq.current && setState((before) => ({ id, data: before.id === id ? before.data : null, error: messageOf(error) })),
    );
  }, [id]);
  useEffect(() => {
    load();
    return () => {
      seq.current += 1;
    };
  }, [load]);
  useRealtime("loom:changed", (payload) => {
    if (slug === null || (payload as { slug?: string } | null)?.slug === slug) load();
  });

  const set = useCallback(
    (data: T) => {
      seq.current += 1;
      setState({ id, data, error: null });
    },
    [id],
  );
  const current = state.id === id;
  return { data: current ? state.data : null, error: current ? state.error : null, reload: load, set };
}

/** Runs a change: one at a time, with its refusal kept for the page to show. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  /** Resolves true when the change went through, false when it was refused. */
  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (failure) {
      if (mounted.current) setError(messageOf(failure));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
