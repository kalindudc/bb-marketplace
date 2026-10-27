import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery, type StandardSchemaV1InferInput } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ProjectSummary, rpcContract } from "../contract";
import { contract } from "./contract-client";
import { TICKET_STATES } from "../states";


export const BUTTON = "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border-seam px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const BUTTON_DANGER = `${BUTTON} text-destructive-text`;
export const BUTTON_PRIMARY = "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const BUTTON_CTA = "inline-flex h-9 shrink-0 cursor-pointer items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
const BUTTON_ARMED = "relative inline-flex shrink-0 cursor-pointer items-center overflow-hidden rounded-md bg-warning font-semibold text-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const CARD = "rounded-md border border-border-seam p-3";
export const FIELD = "w-full rounded-md border border-border-seam bg-transparent px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const HEADING = "text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground";
export const CHIP = "rounded-full border border-border-seam px-1.5 text-[10.5px] leading-4";

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** "Tue, Jan 6, 14:05": the moment a rewound page shows. */
export const momentLabel = (at: number) => new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export { plural } from "../format";
/** "a", "a and b", "a, b and c". */
export const listText = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The repo a ticket runs in, on a multi-repo project. */
export function RepoChip({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span data-repo-chip={name} title={`repo ${name}`} className={`${CHIP} inline-block font-mono text-muted-foreground [overflow-wrap:anywhere] ${className}`}>
      {name}
    </span>
  );
}

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
  merged: "text-success",
  paused: "text-warning-text",
  blocked: "text-destructive-text",
  cancelled: "text-subtle-foreground",
  archived: "text-subtle-foreground",
  rewound: "text-warning-text",
};

/** The text colour a state is drawn in. */
export const stateTone = (state: string) => BADGE_TONES[state] ?? "text-muted-foreground";

export function StateBadge({ state }: { state: string }) {
  return (
    <span data-state-badge className={`inline-flex shrink-0 items-center rounded-full border border-border-seam px-2 py-0.5 text-[11px] leading-none ${stateTone(state)}`}>
      {state.replace("_", " ")}
    </span>
  );
}

/** A two-step button: the first click turns it amber with "Click again to …" and a bar that drains for five seconds, beside Cancel; the second click acts. */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled = false, danger = false, primary = false }: { label: string; confirmLabel?: string; onConfirm(): void; disabled?: boolean; danger?: boolean; primary?: boolean }) {
  const [armed, setArmed] = useState(false);
  const drain = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  // Reading offsetWidth forces a layout at full width, so the transition runs from full to empty without keyframes.
  useLayoutEffect(() => {
    const bar = drain.current;
    if (!armed || bar === null) return;
    void bar.offsetWidth;
    bar.style.transform = "scaleX(0)";
  }, [armed]);
  const idle = primary ? BUTTON_CTA : danger ? BUTTON_DANGER : BUTTON;
  const size = primary ? "h-9 px-4 text-sm" : "h-7 px-2.5 text-xs";
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        data-confirming={armed ? "" : undefined}
        className={armed ? `${BUTTON_ARMED} ${size}` : idle}
        onClick={() => {
          if (!armed) return setArmed(true);
          setArmed(false);
          onConfirm();
        }}
      >
        {armed ? (confirmLabel ?? `Click again to ${label.toLowerCase()}`) : label}
        {armed && <span ref={drain} data-drain aria-hidden className="absolute bottom-0 left-0 h-[3px] w-full origin-left bg-black/40" style={{ transition: "transform 5s linear" }} />}
      </button>
      {armed && (
        <button type="button" className={BUTTON} onClick={() => setArmed(false)}>
          Cancel
        </button>
      )}
    </>
  );
}

/** A "⋯" button that shows the actions it holds below it; a mousedown anywhere else closes it, as does the `close` that function children get. */
export function MoreMenu({ children }: { children: ReactNode | ((close: () => void) => ReactNode) }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span ref={root} className="relative">
      <button type="button" aria-label="More actions" aria-expanded={open} className={BUTTON} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div data-more-menu className="absolute right-0 top-8 z-30 flex min-w-48 flex-col gap-1 rounded-md border border-border-seam bg-popover p-1 text-popover-foreground shadow-md">
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </span>
  );
}

type Contract = typeof rpcContract;
export type Method = keyof Contract & string;
type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;

/**
 * A live read through bb's query cache: it loads again when a change invalidates its tags (rpc-tags.ts) and after bb
 * reconnects, and reopens from the cache. `data` is undefined until it first loads. With `keep`, the last data stays while
 * another input loads, so a scrubbed view does not flash "Loading…", and goes once that input fails, so the page says
 * why. Until `enabled`, it loads nothing.
 */
export function useLoom<M extends Method>(method: M, input: Input<M>, options: { keep?: boolean; enabled?: boolean } = {}) {
  const query = experimental_useRpcQuery({ contract, method, input, enabled: options.enabled ?? true });
  const last = useRef(query.data);
  if (query.data !== undefined) last.current = query.data;
  const data = query.data !== undefined || options.keep !== true || query.error !== null ? query.data : last.current;
  return { data, error: query.error === null ? null : messageOf(query.error), reload: query.refetch };
}

/** A change: its reads refresh as soon as the server takes it, through the method's `invalidates`. */
export function useLoomWrite<M extends Method>(method: M) {
  return experimental_useRpcMutation({ contract, method }).mutate;
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

/**
 * Runs a page action, one at a time, and says in bb's toast when it went through. A refusal needs no toast of Loom's: bb's
 * query client shows one for every failed write. Resolves true when it went through.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const act = useCallback(async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      return true;
    } catch {
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, act };
}

/** Reads open pull requests now. A read changes nothing the human decides, so it needs one click, not two. */
export function SyncButton({ label, title, syncing, disabled = false, onSync }: { label: string; title: string; syncing: boolean; disabled?: boolean; onSync(): void }) {
  return (
    <button type="button" data-sync-prs title={title} aria-busy={syncing} disabled={disabled || syncing} className={BUTTON} onClick={onSync}>
      <span aria-hidden className={`mr-1 inline-block ${syncing ? "animate-spin" : ""}`}>
        ↻
      </span>
      {syncing ? "Syncing…" : label}
    </button>
  );
}

/**
 * Reads the project's open pull requests now, or only `key`'s, and says in bb's toast what the reads found: a warning when
 * one failed, waits or is still going. A refusal gets bb's own toast, as every failed write does.
 */
export function useSyncPullRequests(slug: string) {
  const sync = useLoomWrite("syncPullRequests");
  const [syncing, setSyncing] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const run = useCallback(
    async (key?: string): Promise<void> => {
      setSyncing(true);
      try {
        const result = await sync({ slug, ...(key === undefined ? {} : { key }), confirm: true });
        if (result.problem) toast.warning(result.message);
        else toast.success(result.message);
      } catch {
        // bb's query client already showed the refusal.
      } finally {
        if (mounted.current) setSyncing(false);
      }
    },
    [sync, slug],
  );
  return { syncing, sync: run };
}
