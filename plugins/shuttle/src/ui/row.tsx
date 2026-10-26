import type { KeyboardEvent, ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { NextButton } from "./actions";
import { BUTTON_GHOST, Pill, SELECTED_ROW, onCardClick, type Tone } from "./common";
import { NEXT_ICONS, type Group } from "./constants";
import { age, shortKey, sizeOf, tinyKey } from "./format";
import { RowLabels } from "./manage";
import { AgentPill, ChecksPill, isLive, MyReviewPill, ReasonPills, ReviewPill, SizeChip, StalePill } from "./pills";
import type { Folding } from "./prefs";

const THREE_DAYS = 3 * 24 * 60 * 60_000;
const NEXT_TONES: Record<PrView["next"]["tone"], Tone> = { ok: "ok", bad: "bad", warn: "warn", info: "info", neutral: "neutral" };

export interface RowLayout {
  selected: string | null;
  /** The PR panel is open beside the list, or the screen is a phone: rows leave out their trailing action. */
  compact: boolean;
  phone: boolean;
  onSelect(key: string): void;
}

function Row({ pr, layout, meta, pills }: { pr: PrView; layout: RowLayout; meta: ReactNode; pills: ReactNode }) {
  const selected = pr.key === layout.selected;
  const primary = pr.next.primary;
  const onKey = (event: KeyboardEvent) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      layout.onSelect(pr.key);
    }
  };
  return (
    <li data-pr={pr.key} data-next={pr.next.kind} tabIndex={0} aria-current={selected ? "true" : undefined} onClick={onCardClick(() => layout.onSelect(pr.key))} onKeyDown={onKey}
      className={`flex cursor-pointer items-center gap-2.5 border-t border-border px-3.5 py-2.5 first:border-t-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${selected ? SELECTED_ROW : "hover:bg-accent/50"}`}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">{meta}</div>
        <div className={`mb-1.5 mt-0.5 text-[13px] font-semibold ${layout.phone ? "line-clamp-2" : "truncate"}`}>{pr.title}</div>
        <div className="flex flex-wrap gap-1">{pills}</div>
      </div>
      {!layout.compact && primary !== null && (
        <div className="shrink-0"><NextButton pr={pr} action={primary} primary={pr.next.inbox} small /></div>
      )}
      {layout.phone && <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </li>
  );
}

/**
 * One of your PRs: its checks, its reviews and its agent, and its next step on the right. `time` is the time its list
 * is sorted by; `group` names the section it would sit in, for a list that is not grouped.
 */
export function MineRow({ pr, layout, time = pr.updatedAt === null ? null : age(pr.updatedAt), group }: { pr: PrView; layout: RowLayout; time?: string | null; group?: string }) {
  const meta = (
    <>
      <span className="truncate font-mono" title={shortKey(pr)}>{tinyKey(pr)}</span>
      <span className="shrink-0">· {pr.serverName}{time !== null && ` · ${time}`}</span>
    </>
  );
  const pills = (
    <>
      {group !== undefined && <span data-row-group><Pill tone={NEXT_TONES[pr.next.tone]} icon={NEXT_ICONS[pr.next.kind]}>{group}</Pill></span>}
      {isLive(pr) ? (
        <>
          <ChecksPill pr={pr} />
          <ReviewPill pr={pr} />
          <AgentPill pr={pr} />
        </>
      ) : pr.state === "merged" ? <Pill tone="info" icon="GitMerge">Merged</Pill> : <Pill tone="bad" icon="GitPullRequestClosed">Closed</Pill>}
      {pr.snoozedUntil !== null && <Pill icon="Clock">Snoozed</Pill>}
      <StalePill pr={pr} />
      <RowLabels labels={pr.labels} />
    </>
  );
  return <Row pr={pr} layout={layout} meta={meta} pills={pills} />;
}

/** Someone else's PR: its size, how long it has asked you, where your review stands and why it is here. */
export function ReviewRow({ pr, layout }: { pr: PrView; layout: RowLayout }) {
  const waited = pr.requestedAt === null ? null : Date.now() - pr.requestedAt;
  const meta = (
    <>
      <span className="truncate font-mono" title={shortKey(pr)}>{tinyKey(pr)}</span>
      <span className="truncate">· {pr.author}</span>
      <SizeChip pr={{ ...pr, size: sizeOf(pr) }} />
      {waited !== null && <span className={`shrink-0 ${waited > THREE_DAYS ? "text-warning-text" : ""}`}>· asked {age(pr.requestedAt!)}</span>}
    </>
  );
  const pills = (
    <>
      <MyReviewPill pr={pr} />
      <ReasonPills pr={pr} />
      {pr.checks !== "passed" && <ChecksPill pr={pr} />}
      <StalePill pr={pr} />
      <RowLabels labels={pr.labels} />
    </>
  );
  return <Row pr={pr} layout={layout} meta={meta} pills={pills} />;
}

export function GroupHeader({ title, count, description, layout, folded, onFold }: {
  title: string;
  count: ReactNode;
  description?: string;
  layout: Pick<RowLayout, "compact" | "phone">;
  folded?: boolean;
  /** Makes the title a button that folds and unfolds the section. */
  onFold?(): void;
}) {
  const label = (
    <>
      <b className="text-xs uppercase tracking-wider">{title}</b>
      <span className="text-[11px] text-muted-foreground">{count}</span>
    </>
  );
  return (
    <div className="mb-1.5 mt-5 flex flex-wrap items-baseline gap-x-2">
      {onFold === undefined ? label : (
        <button type="button" aria-expanded={!folded} title={folded ? "Show this section" : "Fold this section"} onClick={onFold}
          className="-ml-1 inline-flex cursor-pointer items-baseline gap-x-2 rounded px-1 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&:hover_b]:underline [&:hover_b]:underline-offset-2">
          <Icon name={folded ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
          {label}
        </button>
      )}
      {description && layout.phone && !folded && <span className="w-full text-[11.5px] text-muted-foreground">{description}</span>}
      {description && !layout.compact && <span className="ml-auto text-right text-[11.5px] text-muted-foreground">{description}</span>}
    </div>
  );
}

/** The PRs whose next step is one of a group's kinds, under the group's title; nothing when none is. */
export function GroupList({ group, prs, layout, row, folding }: { group: Group; prs: readonly PrView[]; layout: RowLayout; row(pr: PrView): ReactNode; folding?: Folding }) {
  if (prs.length === 0) return null;
  const folded = folding?.folded(group.title) ?? false;
  return (
    <section aria-label={group.title} data-group={group.title} data-folded={folded ? "" : undefined}>
      <GroupHeader title={group.title} count={prs.length} description={group.description} layout={layout} folded={folded} onFold={folding && (() => folding.toggle(group.title))} />
      {!folded && <ul className="overflow-hidden rounded-lg border border-border bg-card">{prs.map(row)}</ul>}
    </section>
  );
}

/** Folds every section shown, or unfolds them all once every one is folded. */
export function FoldAllButton({ titles, folding }: { titles: readonly string[]; folding: Folding }) {
  if (titles.length === 0) return null;
  const all = titles.every((title) => folding.folded(title));
  return (
    <button type="button" className={BUTTON_GHOST} title={all ? "Show every section" : "Fold every section to its title"} onClick={() => folding.setAll(titles, !all)}>
      <Icon name={all ? "ChevronsDown" : "ChevronsUp"} fallback={all ? "ChevronDown" : "ChevronUp"} className="size-3.5" aria-hidden />
      {all ? "Expand all" : "Collapse all"}
    </button>
  );
}
