import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Picker, PickerAction } from "./picker";
import type { PrTab } from "./pr-state";

export interface TabEntry {
  id: PrTab;
  label: string;
  badge?: { text: string; tone: "neutral" | "bad" | "warn" | "info" };
}

/** bb's own count badge (bg-surface-recessed, text-2xs), tinted only when it asks for attention. */
const BADGE_TONES = {
  neutral: "bg-surface-recessed text-muted-foreground",
  bad: "bg-surface-destructive text-destructive-text",
  warn: "bg-warning/10 text-warning-text",
  info: "bg-surface-recessed text-foreground",
} as const;

/** The dot on More when a tab under it asks for attention. */
const DOT_TONES = { bad: "bg-destructive", warn: "bg-warning" } as const;

/** The flex gap between tabs (gap-0.5). */
const GAP = 2;
const TAB = "-mb-px inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-2.5 text-[13px]";
const TAB_ON = `${TAB} border-foreground font-semibold text-foreground`;
const TAB_OFF = `${TAB} border-transparent text-muted-foreground hover:text-foreground`;
const MORE = "-mb-px inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-2 py-2.5 text-[13px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground";
/** A tab as it is measured: bold, as the current one is, so no tab is counted narrower than it can get. */
const TAB_RULER = `${TAB} border-transparent font-semibold`;

export const tabId = (base: string, tab: PrTab) => `${base}-tab-${tab}`;

/**
 * Which tabs the bar shows, by index: all of them when they fit, else as many as fit in their order with room
 * left for More, and always the current one. Widths, room and More's width each include one gap.
 */
export function fitTabs(widths: readonly number[], room: number, more: number, current: number): number[] {
  const all = widths.map((_, index) => index);
  if (widths.reduce((total, width) => total + width, 0) <= room) return all;
  let left = room - more - (widths[current] ?? 0);
  const shown: number[] = [];
  for (const index of all) {
    if (index === current) continue;
    if (widths[index]! > left) break;
    left -= widths[index]!;
    shown.push(index);
  }
  return current >= 0 && current < widths.length ? [...shown, current].sort((a, b) => a - b) : shown;
}

interface Fit {
  room: number;
  widths: readonly number[];
  more: number;
}

const sameFit = (a: Fit | null, b: Fit) => a !== null && a.room === b.room && a.more === b.more && a.widths.length === b.widths.length && a.widths.every((width, index) => width === b.widths[index]);

function Badge({ badge }: { badge: NonNullable<TabEntry["badge"]> }) {
  return <span className={`rounded-full px-1.5 text-2xs font-normal leading-4 tabular-nums ${BADGE_TONES[badge.tone]}`}>{badge.text}</span>;
}

/**
 * The tabs, with the keyboard pattern of a tab list: one stop in the Tab order, the arrows, Home and End move between tabs.
 * Tabs that do not fit the width go under More, which carries a dot when one of them has failing or running checks
 * or open threads; the current tab always stays in the bar. Without a ResizeObserver every tab shows and the bar scrolls.
 */
export function TabBar({ tabs, current, sticky, inset, phone, barRef, panelId, onTab }: {
  tabs: readonly TabEntry[];
  current: PrTab;
  sticky: string;
  inset: boolean;
  phone: boolean;
  barRef: RefObject<HTMLDivElement | null>;
  panelId: string;
  onTab(tab: PrTab): void;
}) {
  const ruler = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const focusNext = useRef<PrTab | null>(null);

  const measure = useCallback(() => {
    const bar = barRef.current;
    const cells = ruler.current === null ? [] : [...ruler.current.children] as HTMLElement[];
    if (bar === null || cells.length < 2) return;
    const style = getComputedStyle(bar);
    const room = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) + GAP;
    const widths = cells.slice(0, -1).map((cell) => Math.ceil(cell.getBoundingClientRect().width) + GAP);
    const next = { room, widths, more: Math.ceil(cells.at(-1)!.getBoundingClientRect().width) + GAP };
    setFit((prev) => (sameFit(prev, next) ? prev : next));
  }, [barRef]);

  const signature = tabs.map((tab) => `${tab.id}:${tab.label}:${tab.badge?.text ?? ""}`).join("|");
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "undefined") measure();
  }, [measure, signature]);
  useEffect(() => {
    const bar = barRef.current;
    if (bar === null || ruler.current === null || typeof ResizeObserver === "undefined") return;
    // The bar for its width; the ruler for its tabs' widths, which change as fonts load.
    const observer = new ResizeObserver(() => measure());
    observer.observe(bar);
    observer.observe(ruler.current);
    return () => observer.disconnect();
  }, [barRef, measure]);

  const at = tabs.findIndex((tab) => tab.id === current);
  const shown = fit === null || fit.widths.length !== tabs.length ? tabs.map((_, index) => index) : fitTabs(fit.widths, fit.room, fit.more, at);
  const visible = shown.map((index) => tabs[index]!);
  const hidden = tabs.filter((_, index) => !shown.includes(index));
  const urgent = hidden.some((tab) => tab.badge?.tone === "bad") ? "bad" : hidden.some((tab) => tab.badge?.tone === "warn") ? "warn" : null;

  // A tab the arrows reach under More joins the bar on the next render; it takes focus then.
  useLayoutEffect(() => {
    if (focusNext.current === null) return;
    barRef.current?.querySelector<HTMLElement>(`[role="tab"][data-tab="${focusNext.current}"]`)?.focus();
    focusNext.current = null;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0 || at < 0) return;
    event.preventDefault();
    const id = tabs[next]!.id;
    onTab(id);
    const node = barRef.current?.querySelector<HTMLElement>(`[role="tab"][data-tab="${id}"]`);
    if (node) node.focus();
    else focusNext.current = id;
  };

  return (
    <div ref={barRef} className={`sticky ${sticky} z-10 mt-4 flex border-b border-border bg-background ${inset ? "px-2.5" : ""}`}>
      <div role="tablist" aria-label="Pull request sections" onKeyDown={onKeyDown} className={`flex min-w-0 gap-0.5 ${fit === null ? "overflow-x-auto [scrollbar-width:none]" : ""}`}>
        {visible.map((tab) => (
          <button key={tab.id} id={tabId(panelId, tab.id)} type="button" role="tab" aria-selected={tab.id === current} aria-controls={panelId} tabIndex={tab.id === current ? 0 : -1} data-tab={tab.id} onClick={() => onTab(tab.id)}
            className={tab.id === current ? TAB_ON : TAB_OFF}>
            {tab.label}
            {tab.badge && <Badge badge={tab.badge} />}
          </button>
        ))}
      </div>
      {hidden.length > 0 && (
        <span data-tabs-more className="ml-0.5 inline-flex">
          <Picker phone={phone} title="More sections" triggerLabel={`More sections: ${hidden.map((tab) => tab.label).join(", ")}`} triggerClassName={MORE} align="start" width="w-56"
            trigger={<>More<Icon name="ChevronDown" className="size-3.5" aria-hidden />{urgent !== null && <span data-urgent={urgent} aria-hidden className={`size-1.5 rounded-full ${DOT_TONES[urgent]}`} />}</>}>
            {hidden.map((tab) => (
              <PickerAction key={tab.id} onSelect={() => onTab(tab.id)}>
                <span data-tab-more={tab.id} className="flex flex-1 items-center justify-between gap-2">{tab.label}{tab.badge && <Badge badge={tab.badge} />}</span>
              </PickerAction>
            ))}
          </Picker>
        </span>
      )}
      {/* Clipped to nothing, so the full row it measures never makes the panel scroll sideways. */}
      <div aria-hidden className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={ruler} data-tab-ruler className="flex w-max gap-0.5">
          {tabs.map((tab) => <span key={tab.id} className={TAB_RULER}>{tab.label}{tab.badge && <Badge badge={tab.badge} />}</span>)}
          <span className={MORE}>More<Icon name="ChevronDown" className="size-3.5" aria-hidden /><span className="size-1.5" /></span>
        </div>
      </div>
    </div>
  );
}
