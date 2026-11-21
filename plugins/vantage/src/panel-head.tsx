import { type ReactNode, type Ref } from "react";
import {
  experimental_Icon as Icon,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  useBbNavigate,
  useSdk,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Worktree } from "./contract";
import { ICON_BUTTON } from "./file-card";
import { isWorking, needsYou, type LiveThread } from "./live";
import { plural } from "./model";
import { Popover } from "./navigator";
import type { Subject } from "./reading-state";
import { openWorktreeTerminal } from "./terminal";

export const SOURCE_LABEL: Record<Subject["source"], string> = {
  checkout: "Checkout Git",
  branch: "Kept branch",
  recorded: "Recorded edits",
  unavailable: "Unavailable",
};

// Who a source belongs to, said next to it everywhere, so a shared checkout's diff never reads as one thread's work.
export function sourceQualifier(
  source: Subject["source"],
  owner: string,
  worktree: Pick<Worktree, "threadIds"> | undefined,
): string {
  if (source === "recorded") return `only ${owner}`;
  if (source === "branch") return "committed only";
  if (source === "unavailable") return "not read";
  const threads = worktree?.threadIds.length ?? 1;
  return threads > 1 ? `shared · ${threads} threads` : "its own checkout";
}

export const CHIP =
  "inline-flex h-7 min-w-0 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-seam bg-card px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const WARN_CHIP =
  "inline-flex h-7 min-w-0 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 text-xs text-foreground hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const FLAT_CHIP =
  "inline-flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border-seam px-2 text-xs text-muted-foreground";
const NOTE_CHIP =
  "inline-flex h-7 min-w-0 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border-seam px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BUTTON =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-seam bg-card px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const PRIMARY =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function threadTarget(sidebar: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: sidebar.id,
    projectId: sidebar.projectId,
    parentThreadId: sidebar.parentThreadId,
    archivedAt: sidebar.archivedAt,
    pinnedAt: sidebar.pinnedAt,
    sectionId: sidebar.sectionId,
    isUnread: sidebar.isUnread,
    status: sidebar.status,
    parentNotifications: sidebar.parentNotifications,
    environment: sidebar.environment?.id ? { id: sidebar.environment.id, path: sidebar.environment.path } : null,
  };
}

export function terminalBlock(
  worktree: Worktree,
  currentHostId: string | null,
  terminal: "thread" | "environment",
): string | null {
  if (worktree.kind === "branch") return "The worktree was removed, so there is no folder to open";
  if (worktree.state === "unavailable") return "This worktree cannot be read, so there is no folder to open";
  if (terminal === "thread" && currentHostId !== worktree.hostId)
    return "The worktree is on another machine than this thread, so its terminal cannot be shown here";
  return null;
}

// A chip that names a state and opens its explanation: never a hover-only title.
export function ExplainChip({
  label,
  icon,
  text,
  className = CHIP,
  children,
}: {
  label: string;
  icon: string;
  text?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover
      label={label}
      trigger={(props) => (
        <button type="button" {...props} className={className}>
          <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{text ?? label}</span>
        </button>
      )}
    >
      {children}
    </Popover>
  );
}

export function IncompleteChip({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" onClick={onOpen} className={CHIP}>
      <Icon name="CircleDashed" fallback="Circle" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">Recorded edits may be incomplete</span>
    </button>
  );
}

export function NotReadChip({ message }: { message: string | null }) {
  return (
    <ExplainChip label="Checkout Git not read" icon="Globe" className={NOTE_CHIP}>
      <p className="text-muted-foreground">{message ?? "Vantage could not read this checkout with Git."}</p>
      <p className="mt-1 text-muted-foreground">The thread's recorded edits are its evidence here.</p>
    </ExplainChip>
  );
}

// The selected thread's one title line: what it is, its state, and the actions that used to fill four lines.
export function ThreadLine({
  live,
  threadId,
  own,
  stub,
  narrow,
  worktree,
  currentThreadId,
  currentHostId,
  tab,
  onTab,
  chatButtonRef,
  onMessage,
  trailing,
}: {
  live: LiveThread;
  threadId: string;
  own: boolean;
  stub: boolean;
  narrow: boolean;
  worktree: Worktree | undefined;
  currentThreadId: string;
  currentHostId: string | null;
  tab: "changes" | "chat";
  onTab(tab: "changes" | "chat"): void;
  chatButtonRef: Ref<HTMLButtonElement>;
  onMessage(): void;
  trailing?: ReactNode;
}) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const title = own ? `This thread · ${live.title}` : live.title;
  const switcher = !own && !stub && !live.archived;
  const blocked = worktree === undefined ? null : terminalBlock(worktree, currentHostId, "thread");
  const startTerminal = () => {
    if (worktree === undefined) return;
    openWorktreeTerminal(sdk, navigate, {
      threadId: currentThreadId,
      path: worktree.root,
      title: `${live.title} · ${worktree.branch ?? "worktree"}`,
    }).then(
      (opened) => {
        if (!opened) toast.error("bb could not show the terminal");
      },
      (error: unknown) => toast.error(`Could not start a terminal: ${errorMessage(error)}`),
    );
  };
  const retry = () => {
    sdk.threads.retry({ threadId }).then(
      () => toast("Retrying the failed turn"),
      (error: unknown) => toast.error(`Could not retry: ${errorMessage(error)}`),
    );
  };
  let state: ReactNode = null;
  if (live.archived)
    state = <span className="shrink-0 rounded border border-border-seam px-1.5 py-px text-[11px]">Archived</span>;
  else if (live.indicator === "waiting-for-input")
    state = (
      <>
        <span
          className="shrink-0 rounded bg-surface-attention px-1.5 py-px text-[11px] text-foreground"
          title={live.sidebar?.indicatorLabel ?? undefined}
        >
          Needs you
        </span>
        <button type="button" className={PRIMARY} onClick={onMessage}>
          Answer
        </button>
      </>
    );
  else if (needsYou(live))
    state = (
      <>
        <span
          className="shrink-0 rounded bg-surface-destructive px-1.5 py-px text-[11px] text-destructive-text"
          title={live.sidebar?.indicatorLabel ?? undefined}
        >
          Failed
        </span>
        <button type="button" className={BUTTON} onClick={retry}>
          Retry
        </button>
        <button type="button" className={BUTTON} onClick={onMessage}>
          Message agent
        </button>
      </>
    );
  else if (isWorking(live))
    state = (
      <ExplainChip
        label="Working"
        icon="Info"
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded bg-state-hover px-1.5 text-[11px] text-foreground hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <p className="text-muted-foreground">
          The agent is still editing, so these diffs can change while you read. Ticks remember the version you reviewed.
        </p>
      </ExplainChip>
    );
  return (
    // Narrow, the breadcrumb names the thread, so the state and actions join the breadcrumb's own band.
    <div
      data-thread-line
      className={narrow ? "contents" : "relative flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 px-3 pt-1.5"}
    >
      {!narrow && (
        <>
          <span className="flex size-4 shrink-0 items-center justify-center">
            <ThreadStatusGlyph indicator={live.indicator} archived={live.archived} size="compact" />
          </span>
          <h2 className="min-w-0 flex-1 basis-32 truncate text-sm font-semibold text-foreground" title={live.title}>
            {title}
          </h2>
        </>
      )}
      {state}
      {!narrow && <span className="flex-1" />}
      {switcher && (
        <div role="group" aria-label="Show" className="inline-flex rounded-md bg-surface-recessed p-0.5">
          {(["changes", "chat"] as const).map((value) => (
            <button
              key={value}
              ref={value === "chat" ? chatButtonRef : undefined}
              type="button"
              aria-pressed={tab === value}
              onClick={() => onTab(value)}
              className={`h-6 cursor-pointer rounded px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${tab === value ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {value === "changes" ? "Changes" : "Chat"}
            </button>
          ))}
        </div>
      )}
      {!own && (
        <button
          type="button"
          aria-label="Open thread"
          title="Open the thread beside this one"
          onClick={() => navigate.toThread(threadId, { split: true })}
          className={`${ICON_BUTTON} size-7`}
        >
          <Icon name="PanelRight" className="size-3.5" aria-hidden />
        </button>
      )}
      {worktree !== undefined && (
        <button
          type="button"
          aria-label="Terminal"
          disabled={blocked !== null}
          title={blocked ?? "Open a shell in this worktree"}
          onClick={startTerminal}
          className={`${ICON_BUTTON} size-7`}
        >
          <Icon name="Terminal" className="size-3.5" aria-hidden />
        </button>
      )}
      {!own && live.sidebar !== null && (
        <ThreadActionsMenu
          thread={threadTarget(live.sidebar)}
          align="end"
          trigger={(triggerProps) => (
            <button
              {...triggerProps}
              aria-label="Thread actions"
              title="bb's thread menu: stop, archive and more"
              className={`${triggerProps.className ?? ""} ${ICON_BUTTON} size-7`}
            >
              <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
            </button>
          )}
        />
      )}
      {trailing}
    </div>
  );
}

export const shortSource = (subject: Subject, worktree: Pick<Worktree, "threadIds"> | undefined, owner: string) =>
  subject.source === "recorded"
    ? `Recorded · only ${owner}`
    : subject.source === "branch"
      ? "Kept branch"
      : subject.source === "checkout"
        ? (worktree?.threadIds.length ?? 1) > 1
          ? "Git · shared"
          : "Git · own"
        : "Unavailable";

export const filesLabel = (count: number | null): string => (count === null ? "loading" : plural(count, "file"));
