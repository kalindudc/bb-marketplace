import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  Markdown,
  experimental_useAppPanel,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  useSettings,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { previewBody } from "../blocks";
import { rpcContract, type BannerDto, type FlareDto } from "../contract";
import { ago } from "../format";
import { KIND_LABELS } from "../kinds";
import type { DisplayMode } from "../settings";
import { ChildLink, KindIcon } from "./flare-card";
import { FLARES_TAB } from "./tab";
import { useNow } from "./use-now";

/** Which flare the expanded widget shows, and which ones were new when it opened, per thread. */
interface OpenState {
  /** Set once the list opens; until then the list chooses for itself. */
  started: boolean;
  /** The flare whose detail shows; null when the person closed it. */
  flareId: string | null;
  marked: ReadonlySet<string>;
}

const CLOSED: OpenState = { started: false, flareId: null, marked: new Set() };
const openStates = new Map<string, OpenState>();
const listeners = new Set<() => void>();

/** How many panes have each thread's list open; the shared state resets only when the last one closes. */
const openPanes = new Map<string, number>();

function retainOpen(threadId: string): () => void {
  openPanes.set(threadId, (openPanes.get(threadId) ?? 0) + 1);
  return () => {
    const left = (openPanes.get(threadId) ?? 1) - 1;
    if (left > 0) return void openPanes.set(threadId, left);
    openPanes.delete(threadId);
    setOpenState(threadId, CLOSED);
  };
}

function setOpenState(threadId: string, next: OpenState): void {
  openStates.set(threadId, next);
  for (const listener of listeners) listener();
}

function useOpenState(threadId: string): OpenState {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return useSyncExternalStore(subscribe, () => openStates.get(threadId) ?? CLOSED);
}

// Predictions replay over every fresh read until the write lands, so they keep the flares newer than their cutoff.
// The list holds the newest flares, so the flares newer than a recent cutoff are all in it.
export const dismissedThrough =
  (through: number) =>
  (current: BannerDto): BannerDto => {
    const kept = current.flares.filter((entry) => entry.createdAt > through);
    return {
      ...current,
      flare: kept[0] ?? null,
      flares: kept,
      count: kept.length,
      childCount: kept.filter((entry) => entry.fromChild !== null).length,
      fresh: Math.min(current.fresh, kept.length),
    };
  };

export const lookedThrough =
  (through: number) =>
  (current: BannerDto): BannerDto => ({
    ...current,
    fresh: Math.min(current.fresh, current.flares.filter((entry) => entry.createdAt > through).length),
  });

function useWidget(threadId: string) {
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "banner", input: { threadId } });
  const dismiss = experimental_useRpcMutation({
    contract: rpcContract,
    method: "dismiss",
    optimistic: (input, cache) => cache.update("banner", { threadId: input.threadId }, dismissedThrough(input.through)),
  });
  return { data, dismiss: (through: number) => void dismiss.mutate({ threadId, through }).catch(() => undefined), look: useLook(threadId) };
}

/** Marks the thread's flares up to `through` as seen: they stop counting as new. */
export function useLook(threadId: string): (through: number) => void {
  const look = experimental_useRpcMutation({
    contract: rpcContract,
    method: "look",
    optimistic: (input, cache) => cache.update("banner", { threadId: input.threadId }, lookedThrough(input.through)),
  });
  return (through: number) => void look.mutate({ threadId, through }).catch(() => undefined);
}

/** Where the newest flare shows, from the settings; null until they load, so neither place flashes up first. */
export function useDisplay(): DisplayMode | null {
  const { values } = useSettings();
  if (values === undefined) return null;
  return values.display === "widget" ? "widget" : "banner";
}

export const useFlareSegmentVisible = ({ threadId }: ExperimentalThreadContextSegmentInput): boolean => {
  const widget = useDisplay() === "widget";
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "banner", input: { threadId }, enabled: widget });
  return widget && (data?.flare ?? null) !== null;
};

/** The flares that arrived since the last look: the newest `fresh` of the list. */
const freshIds = (data: BannerDto): ReadonlySet<string> => new Set(data.flares.slice(0, data.fresh).map((entry) => entry.id));

// Only a flare from the failed turn itself carries the failure; one that arrived after it is news of its own.
const turnFailed = (data: BannerDto, flare: FlareDto): boolean =>
  data.run?.outcome === "failed" && data.run.endedAt !== null && flare.createdAt <= data.run.endedAt;

/** The newest flare in bb's thread context row: its kind, title and age, how many arrived since the last look, and a dismiss button. */
export function FlareSegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const now = useNow();
  const { data, dismiss, look } = useWidget(threadId);
  const flare = data?.flare ?? null;
  if (data === undefined || flare === null) return null;

  const failed = turnFailed(data, flare);
  const open = () => {
    if (isExpanded) return onToggle();
    // Another pane with this thread's list open keeps what it has open; this pane joins it and adds the new marks.
    const current = openStates.get(threadId) ?? CLOSED;
    setOpenState(
      threadId,
      current.started
        ? { ...current, marked: new Set([...current.marked, ...freshIds(data)]) }
        : { started: true, flareId: flare.id, marked: freshIds(data) },
    );
    onToggle();
    if (data.fresh > 0) look(flare.createdAt);
  };
  const label = [
    `Flare: ${failed ? "turn failed, " : ""}${KIND_LABELS[flare.kind]}: ${flare.title}`,
    ago(flare.createdAt, now),
    flare.fromChild === null ? null : `from ${flare.fromChild.title ?? "a child thread"}`,
    data.fresh > 0 ? `${data.fresh} new since you last looked` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  const action = isExpanded ? "Hide this turn's flares" : "Show this turn's flares";

  return (
    // bb's Cortex segment grows from nothing, so a segment sized to its content would leave Cortex an icon. Growing
    // three to its one shares the free space and keeps both readable.
    <span
      data-flare-segment
      className={cn(
        "group/flare inline-flex min-w-0 max-w-max flex-[3_1_0%] items-center rounded transition-colors hover:bg-state-hover",
        isExpanded && "bg-state-hover",
      )}
    >
      <button
        type="button"
        data-segment-summary
        aria-expanded={isExpanded}
        aria-label={`${label}. ${action}`}
        title={`${label}. ${action}`}
        onClick={open}
        className={cn(
          "flex min-h-6 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded py-1 pr-0.5 pl-1.5 text-xs text-muted-foreground group-hover/flare:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isExpanded && "text-foreground",
        )}
      >
        {failed ? <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-destructive-text" aria-hidden /> : <KindIcon kind={flare.kind} className="size-3.5" />}
        <span data-flare-title className="min-w-0 max-w-[13rem] truncate text-foreground @max-[24rem]/promptbox-shell:hidden">
          {flare.title}
        </span>
        {data.fresh > 0 && (
          <span data-flare-fresh className="shrink-0 tabular-nums">
            <span aria-hidden className="@max-[24rem]/promptbox-shell:hidden">· </span>
            {data.fresh} new
          </span>
        )}
        <span data-flare-metadata className="shrink-0 @max-[44rem]/promptbox-shell:hidden">
          · {ago(flare.createdAt, now)}
        </span>
        {flare.fromChild !== null && <Icon name="ChildThread" className="size-3 shrink-0 @max-[44rem]/promptbox-shell:hidden" aria-hidden />}
        <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 @max-[24rem]/promptbox-shell:hidden" aria-hidden />
      </button>
      <button
        type="button"
        data-flare-dismiss
        aria-label="Dismiss Flare until the next flare"
        title="Dismiss until the next flare"
        onClick={() => {
          // bb keeps a hidden segment's expansion, and an expanded list would count the next flare as seen.
          if (isExpanded) onToggle();
          dismiss(flare.createdAt);
        }}
        className="mr-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="X" className="size-3" aria-hidden />
      </button>
    </span>
  );
}

function FlareRow({ flare, open, marked, now, onSelect, onOpenTab }: { flare: FlareDto; open: boolean; marked: boolean; now: number; onSelect: () => void; onOpenTab: () => void }) {
  const preview = previewBody(flare.body);
  const blocker = flare.kind === "blocker" || flare.urgent;
  return (
    <li data-flare-row={flare.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${KIND_LABELS[flare.kind]}: ${flare.title}, ${ago(flare.createdAt, now)}${marked ? ", new since you last looked" : ""}`}
        title={`${KIND_LABELS[flare.kind]}: ${flare.title}`}
        onClick={onSelect}
        className={cn(
          "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          open && "bg-surface-selected",
        )}
      >
        {marked ? (
          <span
            aria-hidden
            data-flare-marked
            className={cn("size-2 shrink-0 rounded-full", blocker ? "bg-destructive" : flare.kind === "decision" ? "bg-attention" : "bg-primary")}
          />
        ) : (
          <span aria-hidden className="size-2 shrink-0" />
        )}
        <KindIcon kind={flare.kind} className="size-3.5" />
        <span className="w-16 shrink-0 text-muted-foreground @max-[26rem]/promptbox-shell:hidden">{KIND_LABELS[flare.kind]}</span>
        <span className={cn("min-w-0 flex-1 text-foreground", open ? "font-medium" : "truncate")}>{flare.title}</span>
        <span className="shrink-0 text-muted-foreground">{ago(flare.createdAt, now)}</span>
      </button>
      {open && (preview.text !== "" || preview.blocks > 0 || flare.fromChild !== null) && (
        <div data-flare-detail className="max-h-56 overflow-y-auto py-1.5 pr-2 pl-12 text-sm @max-[26rem]/promptbox-shell:pl-4">
          {preview.text !== "" && <Markdown content={preview.text} />}
          {(flare.fromChild !== null || preview.blocks > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {flare.fromChild !== null && <ChildLink child={flare.fromChild} />}
              {preview.blocks > 0 && (
                <button type="button" className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onOpenTab}>
                  {preview.blocks === 1 ? "1 view in the Flares tab" : `${preview.blocks} views in the Flares tab`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Below the row while the segment is open: the turn's flares, one open at a time, and the widget's actions. */
export function FlareSegmentDetails({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const now = useNow();
  const panel = experimental_useAppPanel();
  const { data, dismiss, look } = useWidget(threadId);
  const state = useOpenState(threadId);
  const flare = data?.flare ?? null;
  const fresh = data?.fresh ?? 0;

  // The list is a look: flares that arrive while it is open are seen as they land, and keep their mark until it closes.
  useEffect(() => {
    if (!isExpanded || flare === null) return;
    const current = openStates.get(threadId) ?? CLOSED;
    if (current.started && fresh === 0) return;
    setOpenState(threadId, {
      started: true,
      flareId: current.started ? current.flareId : flare.id,
      marked: new Set([...current.marked, ...freshIds(data!)]),
    });
    if (fresh > 0) look(flare.createdAt);
  }, [isExpanded, flare?.id, fresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Panes showing the same thread share its open list; it resets only when the last of them closes it.
  useEffect(() => (isExpanded ? retainOpen(threadId) : undefined), [isExpanded, threadId]);

  if (!isExpanded || data === undefined || flare === null) return null;
  const openTab = () => {
    panel.openTab({ tab: FLARES_TAB, title: "Flares" });
    look(flare.createdAt);
  };
  const failed = turnFailed(data, flare);
  const earlier = data.count - data.flares.length;

  return (
    <div data-flare-details role="region" aria-label="This turn's flares" className="px-1 pt-0.5 pb-1.5">
      {failed && (
        <p role="alert" className="mx-1 mb-1 flex items-start gap-1.5 rounded bg-surface-destructive px-2 py-1.5 text-xs text-foreground">
          <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0 text-destructive-text" aria-hidden />
          <span>
            <span className="font-medium">Turn failed</span> after its last flare.{data.run?.error ? ` ${data.run.error}` : ""}
          </span>
        </p>
      )}
      <ul aria-label="Flares" className="flex max-h-72 flex-col overflow-y-auto">
        {data.flares.map((entry) => (
          <FlareRow
            key={entry.id}
            flare={entry}
            now={now}
            open={state.flareId === entry.id}
            marked={state.marked.has(entry.id)}
            onSelect={() => setOpenState(threadId, { ...state, started: true, flareId: state.flareId === entry.id ? null : entry.id })}
            onOpenTab={openTab}
          />
        ))}
      </ul>
      {earlier > 0 && (
        <button type="button" className="ml-6 mt-0.5 cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={openTab}>
          {earlier === 1 ? "1 earlier flare this turn in the Flares tab" : `${earlier} earlier flares this turn in the Flares tab`}
        </button>
      )}
      <div className="mt-1 flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={openTab}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-border px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="PanelRight" className="size-3.5" aria-hidden />
          Open Flares tab
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            onToggle();
            dismiss(flare.createdAt);
          }}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="EyeOff" fallback="X" className="size-3.5" aria-hidden />
          Dismiss until next flare
        </button>
      </div>
    </div>
  );
}
