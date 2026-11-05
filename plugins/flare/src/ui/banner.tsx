import { useState } from "react";
import { Markdown, experimental_useAppPanel, experimental_useRpcMutation, experimental_useRpcQuery, useComposer } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { previewBody } from "../blocks";
import { rpcContract, type BannerDto } from "../contract";
import { ago } from "../format";
import { KIND_LABELS } from "../kinds";
import { ChildLink, KindIcon } from "./flare-card";
import { FLARES_TAB } from "./tab";
import { useNow } from "./use-now";

// A flare newer than the dismissal survives it, even while the prediction replays over a fresh read.
const dismissedThrough =
  (through: number) =>
  (current: BannerDto): BannerDto =>
    current.flare === null || current.flare.createdAt > through ? current : { ...current, flare: null, count: 0, childCount: 0 };

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onClick}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

/** The newest flare of the current or last turn, above the thread's message box. */
export function FlareBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  return threadId === null ? null : <ThreadBanner threadId={threadId} />;
}

export function ThreadBanner({ threadId }: { threadId: string }) {
  const now = useNow();
  const panel = experimental_useAppPanel();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "banner", input: { threadId } });
  const dismiss = experimental_useRpcMutation({
    contract: rpcContract,
    method: "dismiss",
    optimistic: (input, cache) => cache.update("banner", { threadId: input.threadId }, dismissedThrough(input.through)),
  });
  const flare = data?.flare ?? null;
  if (data === undefined || flare === null) return null;

  // The banner is the quick look: prose only. Blocks another plugin draws wait in the Flares tab.
  const preview = previewBody(flare.body);
  const expandable = preview.text !== "" || preview.blocks > 0;
  const expanded = expandedId === flare.id && expandable;
  // Only a flare from the failed turn itself carries the failure; one that arrived after it is news of its own.
  const failed = data.run?.outcome === "failed" && data.run.endedAt !== null && flare.createdAt <= data.run.endedAt;
  const more = data.count - 1;
  const openTab = () => panel.openTab({ tab: FLARES_TAB, title: "Flares" });

  return (
    <section
      aria-label="Latest flare"
      data-flare-banner
      className={cn(
        "rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-card-foreground shadow-xs",
        flare.kind === "blocker" && "border-l-2 border-l-destructive",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <KindIcon kind={flare.kind} />
        <span className={cn("shrink-0 text-xs font-medium", failed ? "text-destructive" : "text-muted-foreground")}>
          {failed ? `Turn failed · ${KIND_LABELS[flare.kind]}` : KIND_LABELS[flare.kind]}
        </span>
        <button
          type="button"
          className={cn("min-w-0 flex-1 truncate text-left font-medium text-foreground", expandable ? "cursor-pointer hover:underline" : "cursor-default")}
          aria-expanded={expandable ? expanded : undefined}
          title={!expandable ? flare.title : expanded ? "Hide the detail" : "Show the detail"}
          onClick={() => expandable && setExpandedId(expanded ? null : flare.id)}
        >
          {flare.title}
        </button>
        {flare.fromChild !== null && <ChildLink child={flare.fromChild} />}
        <span className="shrink-0 text-xs text-muted-foreground">{ago(flare.createdAt, now)}</span>
        {more > 0 && (
          <button type="button" className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={openTab}>
            +{more} more
          </button>
        )}
        <IconButton icon="PanelRight" label="Open the Flares tab" onClick={openTab} />
        <IconButton icon="X" label="Dismiss" onClick={() => void dismiss.mutate({ threadId, through: flare.createdAt }).catch(() => undefined)} />
      </div>
      {expanded && (
        <div className="mt-1.5 max-h-64 overflow-auto border-t border-border pt-1.5 pl-6">
          {preview.text !== "" && <Markdown content={preview.text} />}
          {preview.blocks > 0 && (
            <button type="button" className="mt-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={openTab}>
              {preview.blocks === 1 ? "1 view in the Flares tab" : `${preview.blocks} views in the Flares tab`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
