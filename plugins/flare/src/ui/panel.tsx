import { useMemo, useState } from "react";
import { experimental_copyToClipboard, experimental_useRpcQuery, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { rpcContract } from "../contract";
import { FlareCard } from "./flare-card";
import { OUTCOME_LABELS, feedMarkdown, groupFlares, sectionTitle, type Section } from "./group";
import { FLARE_ICON } from "./tab";
import { useNow } from "./use-now";

function OutcomeBadge({ outcome }: { outcome: NonNullable<Section["run"]>["outcome"] }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-px text-[11px] font-medium",
        outcome === "failed" ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground",
      )}
    >
      {OUTCOME_LABELS[outcome]}
    </span>
  );
}

function TurnSection({ section, now }: { section: Section; now: number }) {
  const { run } = section;
  return (
    <section className="space-y-2" aria-label={sectionTitle(section, now)}>
      <header className="space-y-0.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{sectionTitle(section, now)}</span>
          {run !== null && <OutcomeBadge outcome={run.outcome} />}
        </div>
        {run?.prompt && <p className="line-clamp-2 text-xs italic text-muted-foreground">{run.prompt}</p>}
        {run?.outcome === "failed" && run.error && <p className="line-clamp-3 text-xs text-destructive">{run.error}</p>}
      </header>
      {section.flares.map((flare) => (
        <FlareCard key={flare.id} flare={flare} now={now} />
      ))}
    </section>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon name={FLARE_ICON} fallback="Zap" className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">No flares yet</p>
      <p className="max-w-72 text-xs text-muted-foreground">
        An agent sends a flare when it finds something worth telling you before its turn ends. Ask for it in your prompt, for example
        “send a flare when you find the cause”.
      </p>
    </div>
  );
}

/** Every flare of a thread and the threads it started, grouped by turn. */
export function FlaresPanel({ threadId }: { threadId: string }) {
  const now = useNow();
  const [children, setChildren] = useState(true);
  const { data, error, isLoading } = experimental_useRpcQuery({ contract: rpcContract, method: "feed", input: { threadId, children } });
  const sections = useMemo(() => (data === undefined ? [] : groupFlares(data)), [data]);
  const total = data?.flares.length ?? 0;
  const fromChildren = data?.flares.some((flare) => flare.fromChild !== null) ?? false;

  const copyAll = async () => {
    const copied = await experimental_copyToClipboard({ text: feedMarkdown(sections, Date.now()) });
    if (copied) toast.success(total === 1 ? "Copied 1 flare" : `Copied ${total} flares`);
    else toast.error("Could not copy the flares");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {isLoading ? "Loading flares…" : total === 1 ? "1 flare" : `${total}${data?.truncated ? "+" : ""} flares`}
        </p>
        {(fromChildren || !children) && (
          <Button variant="ghost" size="sm" aria-pressed={children} onClick={() => setChildren(!children)}>
            <Icon name={children ? "CircleCheck" : "Circle"} aria-hidden />
            Child threads
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={total === 0} onClick={() => void copyAll()}>
          <Icon name="Copy" aria-hidden />
          Copy all
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error !== null && data === undefined ? (
          <p className="text-sm text-destructive">Could not load the flares: {error.message}</p>
        ) : data !== undefined && total === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-5">
            {sections.map((section) => (
              <TurnSection key={section.key} section={section} now={now} />
            ))}
            {data?.truncated && <p className="text-center text-xs text-muted-foreground">Older flares are not shown; <code>bb flare list --limit 5000</code> prints more.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function FlaresTab({ threadId }: ExperimentalThreadActionTabProps) {
  return <FlaresPanel threadId={threadId} />;
}
