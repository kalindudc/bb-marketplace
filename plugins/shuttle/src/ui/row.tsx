import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { NextKind, PrView } from "../contract";
import { mentionOnly } from "../next";
import { NextButton } from "./actions";
import { Avatar, swatchOf } from "./avatar";
import { BUTTON_GHOST, Pill, SELECTED_ROW, Tip, TONE_TEXT, onCardClick, type Tone } from "./common";
import { NEXT_ICONS, type Group } from "./constants";
import { age, ago, clock, plural, shortKey, sizeOf, tinyKey, when } from "./format";
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
  selection?: { checked: boolean; onToggle(): void };
  onSelect(key: string): void;
}

function Row({ pr, layout, meta, pills }: { pr: PrView; layout: RowLayout; meta: ReactNode; pills: ReactNode }) {
  const selected = pr.key === layout.selected || layout.selection?.checked === true;
  const primary = pr.next.primary;
  const onKey = (event: KeyboardEvent) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      layout.onSelect(pr.key);
    }
  };
  return (
    <li data-pr={pr.key} data-next={pr.next.kind} tabIndex={0} aria-current={selected ? "true" : undefined} onClick={onCardClick(() => layout.onSelect(pr.key))} onKeyDown={onKey}
      className={`flex cursor-pointer items-start gap-2.5 border-t border-border px-3.5 py-2.5 first:border-t-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${selected ? SELECTED_ROW : "hover:bg-state-hover"}`}>
      {layout.selection && (
        <input type="checkbox" aria-label={`Select ${pr.title}`} checked={layout.selection.checked} onChange={() => layout.selection?.onToggle()} className="mt-1 size-4 shrink-0 cursor-pointer accent-foreground" />
      )}
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
      {pr.snoozed && <Pill icon="Clock">Snoozed</Pill>}
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

/** A repo as a chip: a colour that is the same on every row, the owner muted and the name; the server in its tooltip. */
export function RepoChip({ pr, short = false, shrink = false }: { pr: Pick<PrView, "repo" | "serverName">; short?: boolean; shrink?: boolean }) {
  const at = pr.repo.lastIndexOf("/");
  const owner = pr.repo.slice(0, at + 1);
  return (
    <span data-repo title={`${pr.repo} on ${pr.serverName}`} className={`inline-flex h-5 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface-recessed pl-1.5 pr-[7px] text-[11.5px] ${shrink ? "shrink" : "shrink-0"}`}>
      <span aria-hidden className="size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: swatchOf(pr.repo) }} />
      <span className="min-w-0 truncate">
        {owner !== "" && <span className={`text-muted-foreground ${short ? "hidden" : "@max-[720px]:hidden"}`}>{owner}</span>}
        <b className="font-semibold">{pr.repo.slice(at + 1)}</b>
      </span>
    </span>
  );
}

const KIND_CHIPS: Partial<Record<NextKind, string>> = {
  agent_waiting: "Agent needs you",
  nobody: "Nobody on it",
  ready_to_merge: "Ready to merge",
  post: "AI review ready",
  review_done: "AI review done",
  review_failed: "Review failed",
  rereview: "Updated since review",
  new_request: "New request",
};

export const mentionsYouOnly = (pr: PrView) => mentionOnly({ mine: pr.mine, reasons: pr.reasons.map((item) => item.reason) });

/** What the next step is, for a row whose section does not already say. */
export function KindChip({ pr }: { pr: PrView }) {
  const mention = pr.next.kind === "new_request" && mentionsYouOnly(pr);
  return (
    <span data-kind-chip className="inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-full border border-border bg-surface-recessed px-1.5 text-[11px] text-foreground">
      <Icon name={mention ? "AtSign" : NEXT_ICONS[pr.next.kind]} fallback="Circle" className={`size-[11px] ${TONE_TEXT[pr.next.tone]}`} aria-hidden />
      {mention ? "Mentioned you" : KIND_CHIPS[pr.next.kind] ?? pr.next.label}
    </span>
  );
}

interface Fact {
  text: string;
  icon?: string;
  tone?: "bad" | "warn";
  dashed?: true;
  strong?: true;
}

const FACT_TONES = { bad: "text-destructive-text", warn: "text-warning-text" } as const;
const DONE: Record<NonNullable<PrView["myReview"]>["verdict"], string> = { approve: "approved", changes: "requested changes", comment: "commented", dismissed: "reviewed" };

function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** Only the specifics and exceptions of a PR in the Inbox; its section or kind chip, avatar and time say the rest. */
function inboxFacts(pr: PrView, kindChip: boolean): Fact[] {
  const out: Fact[] = [];
  const has = (reason: string) => pr.reasons.some((item) => item.reason === reason);
  const people = (state: string) => (pr.reviewers ?? []).filter((reviewer) => reviewer.state === state && !reviewer.team).map((reviewer) => reviewer.login);
  if (!pr.mine) out.push({ text: pr.author, strong: true });
  if (pr.next.kind === "agent_waiting" && pr.agent !== null) out.push({ text: `\u201c${pr.agent.title}\u201d asked you something`, icon: "Bot", tone: "warn" });
  if (pr.mine && pr.review === "changes") {
    const who = people("changes");
    out.push({ text: who.length > 0 ? `Changes requested by ${names(who)}` : "Changes requested", tone: "bad" });
  }
  if (pr.checks === "failed") out.push({ text: pr.checkCounts !== null && pr.checkCounts.failed > 0 ? `${plural(pr.checkCounts.failed, "check")} fail` : "Checks fail", icon: "X", tone: "bad" });
  if (pr.mine && pr.next.kind === "nobody") {
    if (pr.agent === null || pr.agent.mode === "off") out.push({ text: "No agent", icon: "Bot", dashed: true });
    else if (pr.agent.status === "archived") out.push({ text: "Agent\u2019s thread archived", icon: "Bot", dashed: true });
  }
  if (pr.mine && pr.review === "approved") {
    const who = people("approved");
    out.push({ text: who.length > 0 ? `${names(who)} approved` : "Approved" });
  }
  if (pr.draft !== null) out.push({ text: `${plural(pr.draft.findings, "finding")}${pr.lastReview?.trigger === "auto" ? " from auto review" : ""}` });
  if (pr.next.kind === "review_failed" && !kindChip) out.push({ text: "The review thread failed", icon: "AlertTriangle", tone: "bad" });
  if (pr.next.kind === "rereview" && pr.myReview !== null) {
    const done = DONE[pr.myReview.verdict];
    // Asked by name again after reviewing: the server lists you as requested once more.
    out.push({ text: has("requested") ? `Asked again since you ${done}` : `New commits since you ${done}` });
  }
  if (mentionsYouOnly(pr) && !(kindChip && pr.next.kind === "new_request")) out.push({ text: "Mentioned you", icon: "AtSign" });
  if (pr.checks === "pending") out.push({ text: pr.checkCounts !== null ? `Checks ${pr.checkCounts.passed}/${pr.checkCounts.total}` : "Checks running", icon: "Clock", tone: "warn" });
  if (pr.stale) out.push({ text: pr.staleSince === null ? "May be out of date" : `Data from ${clock(pr.staleSince)}`, icon: "Clock", tone: "warn" });
  return out;
}

function FactView({ fact }: { fact: Fact }) {
  const look = fact.strong ? "font-semibold text-foreground" : fact.tone !== undefined ? FACT_TONES[fact.tone] : "";
  return (
    <span data-fact className={`inline-flex min-w-0 items-center gap-1 whitespace-nowrap ${look} ${fact.dashed ? "h-[18px] rounded-full border border-dashed border-border px-1.5" : ""}`}>
      {fact.icon && <Icon name={fact.icon} fallback="Circle" className="size-3 shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">{fact.text}</span>
    </span>
  );
}

function SizeFact({ pr }: { pr: PrView }) {
  const size = sizeOf(pr);
  if (size === null) return null;
  return (
    <span data-fact title={`${(pr.additions ?? 0) + (pr.deletions ?? 0)} lines${pr.files === null ? "" : ` in ${plural(pr.files, "file")}`}`} className="inline-flex items-center gap-1 whitespace-nowrap">
      <SizeChip pr={{ ...pr, size }} />
      <span className="text-success">+{pr.additions}</span>
      <span className="text-destructive-text">−{pr.deletions}</span>
    </span>
  );
}

/** One line of whole items: one that does not fit wraps out of sight, and only a lone long one is cut short. */
function FactLine({ items }: { items: readonly ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <div data-facts className="flex max-h-[18px] min-w-0 flex-wrap items-center gap-x-2 overflow-hidden text-xs leading-[18px] text-muted-foreground">
      {items.map((item, index) => (
        <span key={index} className="inline-flex min-w-0 max-w-full items-center gap-2">
          {index > 0 && <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-muted-foreground" />}
          {item}
        </span>
      ))}
    </div>
  );
}

export type InboxRowMode = "inbox" | "snoozed" | "dismissed";

function lineTwo(pr: PrView, mode: InboxRowMode, kindChip: boolean): ReactNode[] {
  if (mode === "snoozed") return [<FactView key="back" fact={{ text: pr.snoozedUntil === null ? "Back when it changes" : `Back ${when(pr.snoozedUntil)}`, icon: "Clock" }} />];
  if (mode === "dismissed") {
    const dismissed = pr.dismissed;
    return [
      <FactView key="at" fact={{ text: dismissed === null ? "Dismissed" : `Dismissed ${ago(dismissed.at)}` }} />,
      ...(dismissed?.activity ? [(
        <span key="new" data-new-activity title="It changed after you dismissed it, and stays out of the Inbox" className="inline-flex h-[18px] items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-raised px-2 text-[11px] text-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-foreground" />New activity
        </span>
      )] : []),
    ];
  }
  return [
    ...(kindChip ? [<KindChip key="kind" pr={pr} />] : []),
    ...inboxFacts(pr, kindChip).map((fact, index) => <FactView key={`fact-${index}`} fact={fact} />),
    ...(pr.mine ? [] : [<SizeFact key="size" pr={pr} />]),
  ];
}

// The row's colour is a variable, so the hover overlay fades into whatever the row shows under it. A theme's selection
// colour can be see-through, so the overlay lays it over the card's colour, as the row itself sits on the card.
const ROW_PLAIN = "[--row:var(--card)] hover:[--row:color-mix(in_srgb,var(--foreground)_4%,var(--card))]";
const ROW_CHECKED = "[--row:color-mix(in_srgb,var(--foreground)_7%,var(--card))]";
const ROW_SELECTED = "[--row:var(--surface-selected)]";
const EDGE_SELECTED = "shadow-[inset_3px_0_0_var(--primary),inset_0_0_0_1px_var(--surface-selected-border)]";
const EDGE_CURSOR = "shadow-[inset_3px_0_0_var(--muted-foreground)]";
const SWIPE_PX = 90;

export interface InboxRowProps {
  pr: PrView;
  mode: InboxRowMode;
  phone: boolean;
  /** Open in the PR panel. */
  selected: boolean;
  checked: boolean;
  /** Some row is checked, so every row shows its checkbox. */
  selecting: boolean;
  /** The keyboard's row; it shows its overlay as a hovered row does. */
  cursor: boolean;
  /** A menu of this row is open, so its overlay stays. */
  active: boolean;
  /** Grouped other than by what to do: line 2 starts with the kind. */
  kindChip: boolean;
  /** Grouped by repository: the heading names the repo, so the row does not. */
  repoChip?: boolean;
  onOpen(): void;
  onCheck(range: boolean): void;
  /** The row or a control in it took focus, so the keyboard acts on it. */
  onFocus?(): void;
  /** The hover overlay's buttons on a desktop. */
  overlay?: ReactNode;
  /** The ⋯ menu, always shown on a phone. */
  menu?: ReactNode;
  /** What stands at the right instead of the time, such as Wake now. */
  trailing?: ReactNode;
  /** A phone's swipes: left dismisses, right snoozes. */
  onSwipe?: { left(): void; right(): void };
}

/** A PR in the Inbox, its Snoozed list or its Dismissed list: one row style, about 44 to 58 pixels tall. */
export function InboxRow({ pr, mode, phone, selected, checked, selecting, cursor, active, kindChip, repoChip = true, onOpen, onCheck, onFocus, overlay, menu, trailing, onSwipe }: InboxRowProps) {
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; active: boolean } | null>(null);
  const dragged = useRef(false);
  const [swipe, setSwipe] = useState<{ side: "left" | "right"; armed: boolean } | null>(null);
  const unseen = mode === "inbox" && pr.unseen;
  const showBox = selecting || cursor || checked;
  const time = pr.updatedAt;

  const onKey = (event: KeyboardEvent) => {
    if (event.target === event.currentTarget && event.key === "Enter") {
      event.preventDefault();
      onOpen();
    }
  };
  const settle = () => {
    const node = body.current;
    if (node === null) return;
    node.style.transition = "transform 180ms ease";
    node.style.transform = "";
    setTimeout(() => {
      node.style.transition = "";
      setSwipe(null);
    }, 200);
  };
  const swipeHandlers = onSwipe === undefined ? {} : {
    onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => {
      dragged.current = false;
      if ((event.target as Element).closest("button, input, a") !== null) return;
      drag.current = { x: event.clientX, y: event.clientY, dx: 0, active: false };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLLIElement>) => {
      const state = drag.current;
      if (state === null) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      if (!state.active) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          state.active = true;
          // A pointer that has already been released cannot be captured; the swipe still follows the moves it gets.
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // See above.
          }
        } else if (Math.abs(dy) > 10) {
          drag.current = null;
          return;
        }
      }
      if (!state.active) return;
      state.dx = dx;
      if (body.current !== null) body.current.style.transform = `translateX(${dx}px)`;
      setSwipe({ side: dx < 0 ? "left" : "right", armed: Math.abs(dx) > SWIPE_PX });
    },
    onPointerUp: () => {
      const state = drag.current;
      drag.current = null;
      if (state === null || !state.active) return;
      // Touch sends no click after a pan, so the flag must not wait for one to clear it.
      dragged.current = true;
      setTimeout(() => { dragged.current = false; }, 60);
      settle();
      if (state.dx < -SWIPE_PX) onSwipe.left();
      else if (state.dx > SWIPE_PX) onSwipe.right();
    },
    onPointerCancel: () => {
      if (drag.current?.active) settle();
      drag.current = null;
    },
  };
  const open = onCardClick(onOpen);
  const onClick = (event: { target: EventTarget; currentTarget: HTMLElement }) => {
    // The click a finger's release sends after a swipe is not a tap.
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    open(event);
  };

  const lead = (
    <span className={`relative flex items-center justify-center ${phone ? "h-5 w-2.5" : "size-4"}`}>
      {unseen && <span data-unseen aria-hidden title="New since you last opened it" className={`size-2 rounded-full bg-foreground ${showBox && !phone ? "hidden" : phone ? "" : "group-hover/row:hidden"}`} />}
      {mode === "inbox" && !phone && (
        <Tip text={checked ? "Unselect it" : "Select it; Shift-click selects a range"} keys="X">
          <input type="checkbox" aria-label={`Select ${tinyKey(pr)}`} checked={checked} readOnly onClick={(event) => { event.stopPropagation(); onCheck(event.shiftKey); }}
            className={`absolute inset-0 m-auto size-[15px] cursor-pointer accent-foreground ${showBox ? "" : "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"}`} />
        </Tip>
      )}
    </span>
  );
  const who = pr.mine ? (
    <span data-mine-mark title="Your PR" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-recessed text-muted-foreground">
      <Icon name="GitPullRequest" className="size-3.5" aria-hidden />
    </span>
  ) : <span title={pr.author} className="inline-flex"><Avatar login={pr.author} bot={pr.bot} size={28} /></span>;
  const id = (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${phone ? "max-w-full" : "shrink-0 @max-[560px]:order-2 @max-[560px]:max-w-[65%] @max-[560px]:shrink"}`}>
      {repoChip && <RepoChip pr={pr} short={phone} shrink />}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{pr.sep}{pr.number}</span>
    </span>
  );
  const title = (
    <span data-title title={pr.title} className={`min-w-0 text-[13.5px] ${unseen ? "font-bold" : "font-medium"} ${phone ? "line-clamp-2 leading-[1.3]" : "flex-1 basis-0 truncate @max-[560px]:order-1 @max-[560px]:basis-full"}`}>{unseen && <span className="sr-only">New: </span>}{pr.title}</span>
  );
  const facts = <FactLine items={lineTwo(pr, mode, kindChip)} />;
  const ageText = mode === "inbox" && time !== null && (
    <span data-age title={`Last activity ${clock(time)} (${ago(time)})`} className="min-w-[26px] text-right text-[11.5px] tabular-nums text-muted-foreground">{age(time)}</span>
  );
  const right = trailing ?? (phone ? <span className="flex h-[22px] items-center gap-0.5">{ageText}{menu}</span> : ageText);
  const tint = selected ? ROW_SELECTED : checked ? ROW_CHECKED : ROW_PLAIN;
  const edge = selected ? EDGE_SELECTED : cursor ? EDGE_CURSOR : "";
  return (
    <li data-row={pr.key} data-next={pr.next.kind} data-cursor={cursor ? "" : undefined} tabIndex={0} aria-current={selected ? "true" : undefined} onClick={onClick} onKeyDown={onKey} onFocus={onFocus} {...swipeHandlers}
      className={`group/row relative cursor-pointer border-t border-border first:border-t-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${tint} ${phone ? "touch-pan-y select-none" : ""}`}>
      {swipe !== null && (
        <div aria-hidden className={`absolute inset-0 flex items-center px-[18px] text-[12.5px] font-semibold ${swipe.side === "right"
          ? `justify-start ${swipe.armed ? "bg-warning text-background" : "bg-warning/50 text-foreground"}`
          : `justify-end ${swipe.armed ? "bg-destructive text-background" : "bg-destructive/50 text-foreground"}`}`}>
          {swipe.side === "right"
            ? <span className="inline-flex items-center gap-1.5"><Icon name="Clock" className="size-3.5" />Snooze</span>
            : <span className="inline-flex items-center gap-1.5">Dismiss<Icon name="ArchiveX" fallback="Archive" className="size-3.5" /></span>}
        </div>
      )}
      <div ref={body} className={`relative grid min-h-11 bg-(--row) ${edge} ${phone
        ? "grid-cols-[10px_28px_minmax(0,1fr)_auto] items-start gap-x-2 py-2.5 pl-2 pr-1.5"
        : "grid-cols-[16px_28px_minmax(0,1fr)_auto] items-center gap-x-2.5 py-[7px] pl-2.5 pr-3"}`}>
        {lead}
        {who}
        <div className={phone ? "flex min-w-0 flex-col gap-[3px]" : "flex min-w-0 flex-wrap items-center gap-x-[7px] gap-y-1"}>
          {id}
          {title}
          {phone ? facts : <div className="min-w-0 basis-full @max-[560px]:order-3 @max-[560px]:flex-1 @max-[560px]:basis-0">{facts}</div>}
        </div>
        <div className="flex items-center gap-1.5">{right}</div>
        {!phone && overlay !== undefined && (
          <div data-overlay className={`absolute inset-y-px right-px flex items-center gap-0.5 pr-[7px] bg-[linear-gradient(to_right,transparent,var(--row)_32px),linear-gradient(to_right,transparent,var(--card)_32px)] pl-8 ${active || cursor
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100"}`}>
            {overlay}
          </div>
        )}
      </div>
    </li>
  );
}
