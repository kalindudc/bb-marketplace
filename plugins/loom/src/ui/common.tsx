import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery, type StandardSchemaV1InferInput } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ProjectSummary, rpcContract } from "../contract";
import { contract } from "./contract-client";
import { TICKET_STATES } from "../states";
import { REWOUND_REASON, guardWrite, useRewound } from "./dispatch";


// A button is at least 28 px (32 for the call to action) and never wider than its row: with enlarged or spaced text
// its label wraps and the button grows, rather than run out of its card (WCAG 1.4.4 and 1.4.12); a word longer than the
// room left breaks rather than spill.
// Decision 7: on a phone every control is at least 44 px tall. The page asks its own width, a popover the window's.
export const TAP = "@max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
export const BUTTON = "inline-flex min-h-7 max-w-full shrink-0 cursor-pointer py-1 text-left leading-tight [overflow-wrap:anywhere] items-center gap-1.5 rounded-md border border-border-seam px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-55 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
// Destructive text misses 4.5:1 in gruvbox dark, so a destructive button keeps the foreground and says so with its border.
export const BUTTON_DANGER = "inline-flex min-h-7 max-w-full shrink-0 cursor-pointer py-1 text-left leading-tight [overflow-wrap:anywhere] items-center gap-1.5 rounded-md border border-destructive/70 px-2.5 text-xs text-foreground hover:bg-surface-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-55 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
export const BUTTON_PRIMARY = "inline-flex min-h-7 max-w-full shrink-0 cursor-pointer py-1 text-left leading-tight [overflow-wrap:anywhere] items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
export const BUTTON_CTA = "inline-flex min-h-8 max-w-full shrink-0 cursor-pointer py-1 text-left leading-tight [overflow-wrap:anywhere] items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-55 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
// Yes keeps its natural width, up to the whole row: where Back does not fit beside it, Back wraps under it, rather than
// squeezing Yes to a word a line (at 200% text on a phone it was 91 px wide and taller than the screen).
const BUTTON_YES = "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-50 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
const BUTTON_YES_DANGER = "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-destructive font-semibold text-destructive-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-50 @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
export const CARD = "rounded-md border border-border-seam p-3";
// A field's boundary uses Loom's field line, 3:1 or more on every surface (WCAG 1.4.11); the focus ring stays bb's.
export const FIELD = "w-full rounded-md border border-[var(--loom-field-line)] bg-transparent px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const HEADING = "text-[11px] font-semibold uppercase tracking-wider text-[var(--loom-muted)]";
export const CHIP = "rounded-full border border-border-seam px-1.5 text-[11px] leading-4";

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** "Tue, Jan 6, 14:05": the moment a rewound page shows. */
export const momentLabel = (at: number) => new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export { plural } from "../format";
/** "a", "a and b", "a, b and c". */
export const listText = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The repo a ticket runs in, on a multi-repo project. */
export function RepoChip({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span data-repo-chip={name} title={`repo ${name}`} className={`${CHIP} inline-block font-mono text-[var(--loom-muted)] [overflow-wrap:anywhere] ${className}`}>
      {name}
    </span>
  );
}

export function PhaseChip({ name }: { name: string }) {
  return <span data-phase-chip={name} className={`${CHIP} inline-block text-[var(--loom-muted)]`}>phase {name}</span>;
}

export const mergeLabel = (project: Pick<ProjectSummary, "strategy" | "branch">) => (project.strategy === "integration" ? `integration branch ${project.branch}` : "one pull request per ticket");
export const countsLabel = (counts: ProjectSummary["ticketCounts"]) =>
  TICKET_STATES.filter((state) => (counts[state] ?? 0) > 0)
    .map((state) => `${counts[state]} ${state.replace("_", " ")}`)
    .join(" · ") || "no tickets";

const BADGE_TONES: Record<string, string> = {
  draft: "text-[var(--loom-muted)]",
  ready: "text-[var(--loom-muted)]",
  queued: "text-[var(--loom-muted)]",
  running: "text-[var(--loom-link)]",
  working: "text-[var(--loom-link)]",
  checking: "text-[var(--loom-link)]",
  review: "text-[var(--loom-link)]",
  approved: "text-[var(--loom-ok)]",
  merging: "text-[var(--loom-ok)]",
  pr_open: "text-[var(--loom-ok)]",
  done: "text-[var(--loom-ok)]",
  merged: "text-[var(--loom-ok)]",
  paused: "text-[var(--loom-warn)]",
  blocked: "text-[var(--loom-bad)]",
  cancelled: "text-[var(--loom-muted)]",
  archived: "text-[var(--loom-muted)]",
  rewound: "text-[var(--loom-warn)]",
};

/** The text colour a state is drawn in. */
export const stateTone = (state: string) => BADGE_TONES[state] ?? "text-[var(--loom-muted)]";

export function StateBadge({ state }: { state: string }) {
  return (
    <span data-state-badge className={`inline-flex shrink-0 items-center rounded-full border border-border-seam px-2 py-0.5 text-[11px] leading-none ${stateTone(state)}`}>
      {state.replace("_", " ")}
    </span>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** What an armed confirmation confirms: a change to any part of it disarms the button. */
export const confirmTarget = (label: string, confirmLabel: string | undefined, key: string | undefined): string => JSON.stringify([label, confirmLabel ?? null, key ?? null]);

/**
 * A risky action, confirmed in place: the first click turns the button into "Yes, <what it does>" beside Back, with focus
 * on Yes, and no timer. Enter on Yes acts; Esc or Back puts the button back and returns focus to it. It stays armed only
 * for what was armed: its label, its Yes text and `disarmKey` (what it acts on, such as a merge's commit or a spec
 * version). When any of them changes it is idle again in the same render, so Yes can never act on something the person
 * did not arm. Rewound, it is disabled with the reason, and the write guard refuses it anyway.
 */
/** The time, again every `ms`, so ages and "for 7m" stay current between refreshes. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function ConfirmButton({ label, confirmLabel, onConfirm, onArm, disabled = false, danger = false, primary = false, lead = false, disarmKey, icon }: { label: string; confirmLabel?: string; onConfirm(): void; onArm?(): void; disabled?: boolean; danger?: boolean; primary?: boolean; lead?: boolean; disarmKey?: string; icon?: ReactNode }) {
  const target = confirmTarget(label, confirmLabel, disarmKey);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const armed = armedFor !== null && armedFor === target;
  const rewound = useRewound();
  const trigger = useRef<HTMLButtonElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (armed) yes.current?.focus();
    else if (refocus.current) {
      refocus.current = false;
      trigger.current?.focus();
    }
  }, [armed]);
  // What it was armed for went away: forget it, and put focus back on the button if Yes took it with it.
  useEffect(() => {
    if (armedFor === null || armedFor === target) return;
    setArmedFor(null);
    if (document.activeElement === null || document.activeElement === document.body) trigger.current?.focus();
  }, [armedFor, target]);
  const setArmed = (next: boolean) => setArmedFor(next ? target : null);
  const back = () => {
    refocus.current = true;
    setArmed(false);
  };
  // The armed Yes says what it does, so it may be longer than the row has room for: it wraps and grows rather than run
  // past the screen (the gate's footer and Ship's Do next measured 69 px past a 320 px screen).
  const size = primary ? "min-h-8 px-3 py-1 text-sm" : "min-h-7 px-2.5 py-1 text-xs";
  if (armed && !rewound) {
    return (
      <span
        role="group"
        aria-label={label}
        data-confirm-armed
        className="loom-pop inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          back();
        }}
      >
        <button ref={yes} type="button" data-confirming disabled={disabled} className={`${danger ? BUTTON_YES_DANGER : BUTTON_YES} ${size} max-w-full text-left leading-snug [overflow-wrap:anywhere]`} onClick={() => { setArmed(false); onConfirm(); }}>
          {confirmLabel ?? `Yes, ${lowerFirst(label)}`}
        </button>
        <button type="button" className={BUTTON} onClick={back}>
          Back
        </button>
      </span>
    );
  }
  const idle = primary ? `${BUTTON_CTA}${lead ? " loom-lead" : ""}` : danger ? BUTTON_DANGER : BUTTON;
  return (
    <button
      ref={trigger}
      type="button"
      disabled={disabled}
      aria-disabled={rewound || undefined}
      title={rewound ? REWOUND_REASON : undefined}
      className={idle}
      onClick={() => {
        if (rewound) return void toast.error(REWOUND_REASON);
        onArm?.();
        setArmed(true);
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/** A reversible action: one click, no confirmation (Pause, Resume, Requeue once its note is typed, Mark live). */
export function ActionButton({ label, onClick, disabled = false, primary = false, danger = false, icon, title, className = "" }: { label: string; onClick(): void; disabled?: boolean; primary?: boolean; danger?: boolean; icon?: ReactNode; title?: string; className?: string }) {
  const rewound = useRewound();
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={rewound || undefined}
      title={rewound ? REWOUND_REASON : title}
      className={`${primary ? BUTTON_CTA : danger ? BUTTON_DANGER : BUTTON} ${className}`}
      onClick={() => (rewound ? void toast.error(REWOUND_REASON) : onClick())}
    >
      {icon}
      {label}
    </button>
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
    <span
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape" || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }}
    >
      <button type="button" aria-label="More actions" aria-haspopup="true" aria-expanded={open} className={BUTTON} onClick={() => setOpen(!open)}>
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
  const mutate = experimental_useRpcMutation({ contract, method }).mutate;
  return useCallback(((...args: Parameters<typeof mutate>) => {
    // The one rewind guard: refused here, a write cannot reach the server from any button, menu, key or palette row.
    try {
      guardWrite(method);
    } catch (refused) {
      return Promise.reject(refused);
    }
    return mutate(...args);
  }) as typeof mutate, [mutate, method]);
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
