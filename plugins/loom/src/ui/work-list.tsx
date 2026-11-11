// Work's list: the tickets grouped by whose move it is, in a fixed order, each row a named button with Loom's own state
// word and at most three facts. Every group shows its heading on the first screen: rows per group shrink to fit, and
// each fold says how many it hides. With a ticket open the list turns compact, one line per row, beside a wide pane.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { BoardCard, MergeEntry, ProjectSummary } from "../contract";
import { TAP } from "./common";
import type { DepIndex } from "./deps";
import { isOpen } from "./deps";
import { GROUP_ORDER, ageOf, distinguishingEnd, groupName, groupOf, rowFacts, rowsShown, type Group, type ListFit } from "./groups";
import { Tip } from "./kit";
import { StateMark } from "./marks";
import { useFlip } from "./moments";

export interface ListRow {
  card: BoardCard;
  group: Group;
  entry: MergeEntry | undefined;
}

export function rowsOf(cards: readonly BoardCard[], projectState: ProjectSummary["state"], entries: readonly MergeEntry[]): ListRow[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return cards.map((card) => ({ card, group: groupOf(card, projectState, byKey.get(card.key)), entry: byKey.get(card.key) }));
}

/** The dots either side of a bar: hollow for what it waits on, filled for what it unblocks in all, three at most. */
export function DepGlyph({ waits, unblocks }: { waits: number; unblocks: number }) {
  const dots = (n: number, x0: number, dir: number, filled: boolean) => (
    <>
      {Array.from({ length: Math.min(n, 3) }, (_, i) => (
        <circle key={i} cx={x0 + dir * i * 6} cy={7} r={2.2} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.2} />
      ))}
      {n > 3 && <path d={`M${x0 + dir * 18 - 2} 7h4M${x0 + dir * 18} 5v4`} stroke="currentColor" strokeWidth={1.2} />}
    </>
  );
  return (
    <svg width={46} height={14} viewBox="0 0 46 14" aria-hidden className="shrink-0">
      {dots(waits, 16, -1, false)}
      <rect x={21.5} y={2} width={3} height={10} fill="currentColor" />
      {dots(unblocks, 30, 1, true)}
    </svg>
  );
}

const ROW = "group/row relative flex min-w-0 items-center gap-2 rounded-md pr-1.5";

function Row({ row, index, open, compact, multiRepo, titles, now, draft, cut, onOpen, onDeps }: { row: ListRow; index: DepIndex; open: boolean; compact: boolean; multiRepo: boolean; titles: readonly string[]; now: number; draft: boolean; cut: boolean; onOpen(key: string): void; onDeps?(key: string): void }) {
  const { card, group, entry } = row;
  const { word, facts } = rowFacts(card, group, entry);
  const waits = index.prereqs(card.key).filter((prereq) => isOpen(index.by.get(prereq.key)!)).length;
  const unblocks = index.inAll(card.key).length;
  const end = distinguishingEnd(card.title, titles);
  const name = `${card.key}, ${word}: ${card.title}`;
  const tone = group === "need" ? "bg-[var(--loom-att-tint)]" : "";
  const body = (
    <>
      {draft ? <span aria-hidden className="size-3.5 shrink-0 rounded-full border border-dashed border-[var(--loom-muted)]" /> : <StateMark state={card.state} failed={group === "failed"} draft={card.draft === "held"} />}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
            <span className="shrink-0 font-mono text-xs font-semibold">{card.key}</span>
            <span data-row-title className="min-w-0 truncate">{card.title}</span>
            {end !== null && <span className="shrink-0 text-[var(--loom-muted)]">…{end}</span>}
          </span>
          {!compact && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--loom-muted)]">
              {multiRepo && card.repo !== null && (
                <span data-repo-chip className="shrink-0 rounded-sm border border-[var(--loom-line)] px-1 font-mono text-[11px] leading-4">
                  {card.repo}
                </span>
              )}
              <span className="shrink-0 font-semibold text-foreground">{draft ? "proposed" : word}</span>
              {facts.length > 0 && <span className="min-w-0 truncate">{` · ${facts.join(" · ")}`}</span>}
            </span>
          )}
        </span>
    </>
  );
  const BOX = `flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 text-left ${compact ? "min-h-8" : "min-h-11"}`;
  return (
    <li data-row={card.key} data-draft={draft ? "" : undefined} data-group={group} data-flip={card.key} className={`${ROW} ${tone} ${open ? "bg-[var(--loom-sel)] shadow-[inset_3px_0_0_var(--primary)]" : draft ? "" : "hover:bg-state-hover"}`}>
      {draft ? (
        <div aria-label={`${card.key}, proposed: ${card.title}`} className={BOX}>
          {body}
        </div>
      ) : (
        // A title the row cuts shows whole in a tip, on keyboard focus as on hover.
        <TipWhen when={cut} text={card.title}>
          <button type="button" data-open-row={card.key} aria-label={name} aria-current={open ? "true" : undefined} onClick={() => onOpen(card.key)} className={`${BOX} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
            {body}
          </button>
        </TipWhen>
      )}
      {!compact && !draft && (waits > 0 || unblocks > 0) && onDeps !== undefined && (
        <Tip text={`Waits on ${waits} open · unblocks ${unblocks} in all`}>
          <button type="button" data-dep-glyph aria-label={`${card.key}: waits on ${waits} open, unblocks ${unblocks} in all. Show it on the map`} onClick={() => onDeps(card.key)} className={`inline-flex h-7 shrink-0 cursor-pointer items-center rounded px-1 text-[var(--loom-muted)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
            <DepGlyph waits={waits} unblocks={unblocks} />
          </button>
        </Tip>
      )}
      <span className="loom-num w-12 shrink-0 text-right text-xs text-[var(--loom-muted)]">{draft || card.state === "done" || card.state === "cancelled" ? "" : ageOf(card, now)}</span>
    </li>
  );
}

function TipWhen({ when, text, children }: { when: boolean; text: string; children: ReactElement }) {
  return when ? (
    <Tip text={text} side="bottom">
      {children}
    </Tip>
  ) : (
    children
  );
}

/** The keys of the rows whose title is cut, measured after each layout and again when the list resizes. */
function useCutTitles(list: RefObject<HTMLDivElement | null>, deps: readonly unknown[]): ReadonlySet<string> {
  const [cut, setCut] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const node = list.current;
    if (node === null) return;
    const measure = () => {
      const keys = [...node.querySelectorAll<HTMLElement>("[data-row-title]")].filter((title) => title.scrollWidth > title.clientWidth + 1).map((title) => title.closest<HTMLElement>("[data-row]")!.dataset.row!);
      setCut((before) => (before.size === keys.length && keys.every((key) => before.has(key)) ? before : new Set(keys)));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, deps);
  return cut;
}

const HEAD = "flex items-center gap-2 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--loom-muted)]";
const COUNT = "loom-num rounded-sm border border-[var(--loom-line)] px-1 text-[11px] leading-4 text-foreground";

/**
 * Measures what the list's first screen holds: the page's height below the list's top (as if scrolled to the top), and
 * the rendered heights of a heading, a row and a fold. Again when the page or anything above the list resizes, such as a
 * pane opening or a notice closing. Null where nothing has a height (tests).
 */
function useListFit(list: RefObject<HTMLDivElement | null>, groups: number, done: boolean): ListFit | null {
  const [fit, setFit] = useState<ListFit | null>(null);
  useLayoutEffect(() => {
    const node = list.current;
    const page = node?.closest<HTMLElement>("[data-loom-scroll]") ?? null;
    if (node === null || page === null) return;
    const measure = () => {
      if (page.clientHeight === 0) return setFit(null);
      const height = (selector: string, fallback: number) => {
        const one = node.querySelector<HTMLElement>(selector);
        return one === null ? fallback : Math.ceil(one.getBoundingClientRect().height);
      };
      const top = node.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
      // A folded heading is a button, 44 px on a phone, and an open one is not: count every heading at the taller.
      const head = Math.max(height("[data-move-group]:not([data-move-group=done]):not([data-folded]) > h3", 0), height("[data-move-group][data-folded] > h3", 0), height("[data-move-group=done] > h3", 0)) || 30;
      const next = {
        // The list card's own bottom padding and the page's below it.
        room: Math.floor(page.clientHeight - top - 20),
        fixed: (groups + (done ? 1 : 0)) * head,
        row: height("[data-row]", 44) + 1,
        fold: height("[data-fold]", 28) + 4,
      };
      setFit((before) => (before !== null && before.room === next.room && before.fixed === next.fixed && before.row === next.row && before.fold === next.fold ? before : next));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(page);
    if (page.firstElementChild !== null) observer?.observe(page.firstElementChild);
    return () => observer?.disconnect();
  }, [groups, done]);
  return fit;
}

/**
 * The grouped rows, folded so the first screen shows every heading, Done's included: each group shows the rows that fit
 * and a count of the rest, or, when room runs out, only its heading, which opens it. Folds a person opens stay open.
 */
export function GroupedRows({ rows, index, projectState, openKey, compact, multiRepo, now, onOpen, onDeps }: { rows: readonly ListRow[]; index: DepIndex; projectState: ProjectSummary["state"]; openKey: string | null; compact: boolean; multiRepo: boolean; now: number; onOpen(key: string): void; onDeps?(key: string): void }) {
  const draft = projectState === "draft";
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [doneOpen, setDoneOpen] = useState(false);
  const titles = useMemo(() => rows.map((row) => row.card.title), [rows]);
  const groups = GROUP_ORDER.filter((group) => group !== "done").map((group) => ({ group, rows: rows.filter((row) => row.group === group) })).filter((entry) => entry.rows.length > 0);
  const done = rows.filter((row) => row.group === "done");
  const list = useRef<HTMLDivElement>(null);
  const fit = useListFit(list, groups.length, done.length > 0);
  const shown = rowsShown(groups.map((entry) => entry.rows.length), fit);
  const cutTitles = useCutTitles(list, [rows, compact, fit, unfolded, doneOpen]);
  useFlip(list, [rows, unfolded, doneOpen]);
  const toggle = (group: string) => setUnfolded((before) => new Set(before.has(group) ? [...before].filter((one) => one !== group) : [...before, group]));
  const rowProps = { index, compact, multiRepo, titles, now, draft, onOpen, onDeps };
  return (
    <div ref={list} data-groups className="grid">
      {groups.map(({ group, rows: inGroup }, at) => {
        const all = unfolded.has(group);
        // The open ticket always shows, even in a fold.
        const cut = all ? inGroup.length : shown[at]!;
        const visible = inGroup.filter((row, position) => position < cut || row.card.key === openKey);
        const name = groupName(group, projectState);
        const count = <span className={`${COUNT} ${group === "need" ? "border-transparent bg-[var(--attention)] !text-[var(--attention-foreground)]" : ""}`}>{inGroup.length}</span>;
        // Folded to its heading: the heading opens the group, as Done's does.
        const headingOnly = visible.length === 0 && !all;
        return (
          <section key={group} data-move-group={group} data-folded={headingOnly ? "" : undefined} aria-label={`${name}, ${inGroup.length}`} className="grid">
            {headingOnly ? (
              <h3 className="m-0">
                <button type="button" data-flip={`g-${group}`} aria-expanded={false} onClick={() => toggle(group)} className={`${HEAD} w-full cursor-pointer rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
                  <Icon name="ChevronRight" aria-hidden className="size-3" />
                  <span className={group === "need" ? "text-foreground" : ""}>{name}</span>
                  {count}
                </button>
              </h3>
            ) : (
              <h3 data-flip={`g-${group}`} className={HEAD}>
                <span className={group === "need" ? "text-foreground" : ""}>{name}</span>
                {count}
              </h3>
            )}
            <ul aria-label={name} className="grid gap-px">
              {visible.map((row) => (
                <Row key={row.card.key} row={row} open={row.card.key === openKey} cut={cutTitles.has(row.card.key)} {...rowProps} />
              ))}
            </ul>
            {inGroup.length > cut && !all && !headingOnly && (
              <button type="button" data-fold={group} onClick={() => toggle(group)} className={`mx-2 my-0.5 inline-flex h-7 w-fit cursor-pointer items-center gap-1 rounded px-1 text-xs text-[var(--loom-muted)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
                <Icon name="ChevronDown" aria-hidden className="size-3" />
                {inGroup.length - visible.length} more
              </button>
            )}
            {all && inGroup.length > shown[at]! && (
              <button type="button" data-fold={group} onClick={() => toggle(group)} className={`mx-2 my-0.5 inline-flex h-7 w-fit cursor-pointer items-center gap-1 rounded px-1 text-xs text-[var(--loom-muted)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
                <Icon name="ChevronUp" aria-hidden className="size-3" />
                Fewer
              </button>
            )}
          </section>
        );
      })}
      {done.length > 0 && (
        <section data-move-group="done" aria-label={`Done, ${done.length}`} className="grid">
          <h3 className="m-0">
            <button type="button" data-flip="g-done" aria-expanded={doneOpen || done.some((row) => row.card.key === openKey)} onClick={() => setDoneOpen(!doneOpen)} className={`${HEAD} w-full cursor-pointer rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
              <Icon name={doneOpen ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3" />
              Done
              <span data-done-count className={COUNT}>
                {done.filter((row) => row.card.state === "done").length}
              </span>
              {done.some((row) => row.card.state === "cancelled") && (
                <>
                  Cancelled <span className={COUNT}>{done.filter((row) => row.card.state === "cancelled").length}</span>
                </>
              )}
            </button>
          </h3>
          {(doneOpen || done.some((row) => row.card.key === openKey)) && (
            <ul aria-label="Done" className="grid gap-px">
              {done.filter((row) => doneOpen || row.card.key === openKey).map((row) => (
                <Row key={row.card.key} row={row} open={row.card.key === openKey} cut={cutTitles.has(row.card.key)} {...rowProps} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** j and k move between rows, Enter opens; the list's own keys, so nothing listens on the document. */
export function onListKeys(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== "j" && event.key !== "k") return;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable]") !== null) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-open-row]")];
  if (rows.length === 0) return;
  const at = rows.findIndex((row) => row === target || row.contains(target));
  const current = at === -1 ? rows.findIndex((row) => row.getAttribute("aria-current") === "true") : at;
  const next = current === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "j" ? 1 : -1)));
  event.preventDefault();
  rows[next]!.focus();
  rows[next]!.scrollIntoView?.({ block: "nearest" });
}
