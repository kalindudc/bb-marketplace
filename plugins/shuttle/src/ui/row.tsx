import type { KeyboardEvent, MouseEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Preset, WatchMode } from "../config";
import type { LinkView, PrView } from "../contract";
import { ICON_BUTTON, ServerBadge } from "./common";
import { ROLE_LABELS } from "./constants";
import { ago, shortKey } from "./format";
import { PrPills } from "./pills";
import { ReviewButton } from "./review-button";

/** What a PR row and the detail drawer can ask the page to do. */
export interface PrActions {
  presets: readonly Preset[] | null;
  select(key: string): void;
  open(pr: PrView): void;
  openThread(threadId: string): void;
  link(pr: PrView, tab?: "existing" | "new"): void;
  customize(pr: PrView): void;
  /** Turning watching on asks for an owner thread first when the PR has none. */
  toggleWatch(pr: PrView): void;
  setWatchMode(pr: PrView, mode: WatchMode): void;
}

export const isReviewable = (pr: PrView) => !pr.mine && pr.state === "open";
export const isLive = (pr: PrView) => pr.state === "open" || pr.state === "draft";

const SHOWN_LINKS = 2;

function ThreadChip({ link, onOpen }: { link: LinkView; onOpen(threadId: string): void }) {
  return (
    <button type="button" title={`Open “${link.title}” (${ROLE_LABELS[link.role].short.toLowerCase()})`} onClick={() => onOpen(link.threadId)}
      className="inline-flex h-7 max-w-[13rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs text-foreground hover:bg-accent">
      <Icon name={link.archived ? "Archive" : "MessageSquare"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{link.title}</span>
    </button>
  );
}

function ThreadChips({ pr, actions }: { pr: PrView; actions: PrActions }) {
  if (pr.links.length === 0) {
    return (
      <button type="button" onClick={() => actions.link(pr)} title="Link this PR to a thread"
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <Icon name="Plus" className="size-3.5" aria-hidden />
        Thread
      </button>
    );
  }
  const hidden = pr.links.length - SHOWN_LINKS;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {pr.links.slice(0, SHOWN_LINKS).map((link) => <ThreadChip key={link.threadId} link={link} onOpen={actions.openThread} />)}
      {hidden > 0 && (
        <button type="button" onClick={() => actions.select(pr.key)} title={pr.links.slice(SHOWN_LINKS).map((link) => link.title).join("\n")}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          +{hidden}
        </button>
      )}
    </span>
  );
}

function WatchButton({ pr, onToggle }: { pr: PrView; onToggle(pr: PrView): void }) {
  const on = pr.watch !== null;
  return (
    <button type="button" aria-pressed={on} aria-label={on ? "Stop watching" : "Watch"} onClick={() => onToggle(pr)}
      title={on ? "Watching: new reviews go to the linked thread" : "Watch: send new reviews to the linked thread"}
      className={`${ICON_BUTTON} ${on ? "border-success/60 text-success" : ""}`}>
      <Icon name={on ? "Eye" : "EyeOff"} className="size-4" aria-hidden />
    </button>
  );
}

export function PrRow({ pr, selected, actions }: { pr: PrView; selected: boolean; actions: PrActions }) {
  const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();
  return (
    <li
      aria-current={selected ? "true" : undefined}
      data-pr={pr.key}
      tabIndex={0}
      onClick={() => actions.select(pr.key)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          actions.select(pr.key);
        }
      }}
      className={`grid cursor-pointer grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-t border-border px-4 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring lg:grid-cols-[28px_minmax(0,1fr)_auto] ${selected ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-accent/50"}`}
    >
      <div className="pt-px"><ServerBadge name={pr.serverName} /></div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{pr.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="whitespace-nowrap font-mono">{shortKey(pr)}</span>
          <span aria-hidden>·</span>
          <span>{pr.mine ? "you" : pr.author}</span>
          {pr.additions !== null && pr.deletions !== null && (
            <>
              <span aria-hidden>·</span>
              <span className="text-success">+{pr.additions.toLocaleString()}</span>
              <span className="text-destructive">−{pr.deletions.toLocaleString()}</span>
            </>
          )}
          {pr.updatedAt !== null && (
            <>
              <span aria-hidden>·</span>
              <span>{ago(pr.updatedAt)}</span>
            </>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1"><PrPills pr={pr} /></div>
      </div>
      <div className="col-start-2 flex flex-wrap items-start gap-1 lg:col-start-3 lg:justify-end" onClick={stop} onKeyDown={stop}>
        <ThreadChips pr={pr} actions={actions} />
        {isLive(pr) && <WatchButton pr={pr} onToggle={actions.toggleWatch} />}
        <button type="button" aria-label={`Open on ${pr.serverName}`} title={`Open on ${pr.serverName}`} className={ICON_BUTTON} onClick={() => actions.open(pr)}>
          <Icon name="ExternalLink" className="size-4" aria-hidden />
        </button>
        {isReviewable(pr) && <ReviewButton pr={pr} presets={actions.presets} onCustomize={actions.customize} />}
      </div>
    </li>
  );
}
