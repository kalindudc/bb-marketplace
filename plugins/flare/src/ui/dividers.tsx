import { useSyncExternalStore } from "react";
import type { ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { FlareDto } from "../contract";
import { ago } from "../format";
import { KIND_LABELS } from "../kinds";
import { ChildLink, KindIcon } from "./flare-card";
import { OUTCOME_LABELS, clock, sectionTitle, type Section } from "./group";
import { useNow } from "./use-now";

// The rendered view is bb's own conversation view of a companion thread, so Flare cannot put its dividers between the
// messages itself. bb's message metadata slot renders a component above each message instead; the Flares tab
// publishes here which flare each companion turn shows, and the divider reads it. Any other thread finds nothing and
// renders nothing.

export interface Mark {
  flare: FlareDto;
  section: Section;
  /** The first flare of its turn in this view, which also draws the turn's header. */
  first: boolean;
}

type Marks = ReadonlyMap<string, Mark>;

const published = new Map<string, Marks>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};

/** Shows these marks over the companion's messages; `null` takes them away. */
export function publishMarks(companionId: string, marks: Marks | null): void {
  if (marks === null) published.delete(companionId);
  else published.set(companionId, marks);
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function useMark(threadId: string, turnId: string | null): Mark | null {
  return useSyncExternalStore(subscribe, () => (turnId === null ? null : (published.get(threadId)?.get(turnId) ?? null)));
}

export function OutcomeBadge({ outcome }: { outcome: NonNullable<Section["run"]>["outcome"] }) {
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

/** A turn's title, status, the message that started it and its error: the same header in both views. */
export function TurnHeader({ section, now }: { section: Section; now: number }) {
  const { run } = section;
  return (
    <header className="space-y-0.5" data-flare-turn>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{sectionTitle(section, now)}</span>
        {run !== null && <OutcomeBadge outcome={run.outcome} />}
      </div>
      {run?.prompt && <p className="line-clamp-2 text-xs italic text-muted-foreground">{run.prompt}</p>}
      {run?.outcome === "failed" && run.error && <p className="line-clamp-3 text-xs text-destructive">{run.error}</p>}
    </header>
  );
}

/** A rule with the flare's kind, the time it arrived, how long ago, and the child thread it came from. */
export function TimeDivider({ flare, now }: { flare: FlareDto; now: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-flare-divider>
      <KindIcon kind={flare.kind} className="size-3.5" />
      <span className="shrink-0 font-medium">{KIND_LABELS[flare.kind]}</span>
      <span aria-hidden>·</span>
      <time className="shrink-0" dateTime={new Date(flare.createdAt).toISOString()} title={new Date(flare.createdAt).toLocaleString()}>
        {clock(flare.createdAt, now)} · {ago(flare.createdAt, now)}
      </time>
      {flare.fromChild !== null && (
        <>
          <span aria-hidden>·</span>
          <ChildLink child={flare.fromChild} />
        </>
      )}
      {flare.pushed && <span className="shrink-0">· notified</span>}
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

function Divider({ mark }: { mark: Mark }) {
  const now = useNow();
  return (
    <div className={cn("w-full space-y-2", mark.first ? "pt-3" : "pt-1")}>
      {mark.first && <TurnHeader section={mark.section} now={now} />}
      <TimeDivider flare={mark.flare} now={now} />
    </div>
  );
}

/** bb's message metadata slot: a divider over each flare in a companion thread, nothing anywhere else. */
export function FlareDivider({ message }: ExperimentalMessageMetadataProps) {
  const mark = useMark(message.threadId, message.turnId);
  if (mark === null || message.role !== "assistant") return null;
  return <Divider mark={mark} />;
}

/** The marks for a companion: each drawn flare by the turn that shows it, with its turn's header on the first. */
export function buildMarks(sections: readonly Section[], turns: Readonly<Record<string, string>>): Map<string, Mark> {
  const byFlare = new Map<string, Mark>();
  for (const section of sections) {
    let first = true;
    for (const flare of section.flares) {
      if (!flare.drawn) continue;
      byFlare.set(flare.id, { flare, section, first });
      first = false;
    }
  }
  const marks = new Map<string, Mark>();
  for (const [turnId, flareId] of Object.entries(turns)) {
    const mark = byFlare.get(flareId);
    if (mark !== undefined) marks.set(turnId, mark);
  }
  return marks;
}
