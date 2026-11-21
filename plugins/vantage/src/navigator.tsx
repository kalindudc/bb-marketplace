import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ICON_BUTTON } from "./file-card";
import { plural } from "./model";

// The side panel puts the navigator beside the diffs from this width of its own up, and in a modal sheet below it.
export const CUTOVER_PX = 720;

// bb's muted and diff colours miss 4.5:1 on tinted rows in some dark themes, so the navigator lifts them toward the
// foreground. Mixed from the theme's own tokens under new names, never by redefining a token in terms of itself.
export const NAV_TONES = {
  "--vantage-nav-muted": "color-mix(in oklab, var(--muted-foreground) 60%, var(--foreground))",
  "--vantage-nav-added": "color-mix(in oklab, var(--diff-added) 60%, var(--foreground))",
  "--vantage-nav-removed": "color-mix(in oklab, var(--diff-removed) 60%, var(--foreground))",
  "--vantage-nav-warning": "color-mix(in oklab, var(--warning-text) 60%, var(--foreground))",
  "--vantage-nav-destructive": "color-mix(in oklab, var(--destructive-text) 60%, var(--foreground))",
  "--vantage-nav-selected": "color-mix(in oklab, var(--primary) 10%, transparent)",
  "--vantage-nav-hover": "color-mix(in oklab, var(--state-hover) 60%, transparent)",
} as CSSProperties;
export const NAV_MUTED = "text-[color:var(--vantage-nav-muted)]";
export const NAV_HOVER = "hover:bg-[color:var(--vantage-nav-hover)]";
export const NAV_SELECTED = "bg-[color:var(--vantage-nav-selected)]";
export const NAV_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const INDENT_PX = 16;

export const Chevron = ({ open }: { open: boolean }) => (
  <span data-chevron className="inline-flex size-3.5 shrink-0 items-center justify-center">
    <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
  </span>
);
// Group and disclosure rows: no fill, a chevron and muted text, one line.
export const QUIET_ROW = `flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-xs ${NAV_HOVER} ${NAV_FOCUS}`;

// One vertical guide per ancestor, under that ancestor's chevron.
export function IndentGuides({ depth, offset = 12 }: { depth: number; offset?: number }) {
  return Array.from({ length: depth }, (_, level) => (
    <span
      key={level}
      data-indent-guide
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px bg-border-seam"
      style={{ left: level * INDENT_PX + offset }}
    />
  ));
}

// The one selection mark, on the selected thread and the selected file.
export const SelectionBar = () => (
  <span data-selection-bar aria-hidden className="pointer-events-none absolute inset-y-0.5 left-0 w-0.5 bg-primary" />
);

export const NAV_WIDTH_MIN = 220;
const NAV_WIDTH_STEP = 16;
const NAV_WIDTH_DEFAULT = "clamp(260px, 34%, 380px)";
const defaultWidth = (panel: number): number => Math.min(380, Math.max(260, Math.round(panel * 0.34)));
const widthMax = (panel: number): number => Math.max(NAV_WIDTH_MIN, Math.floor(panel / 2));
// The column's CSS width: the default clamp until the person sizes it, then their width kept between 220 px and half.
export const navWidth = (width: number | null): string =>
  width === null ? NAV_WIDTH_DEFAULT : `clamp(${NAV_WIDTH_MIN}px, ${width}px, 50%)`;

// The navigator's right edge: drag it, or focus it and use the arrows, with Home back to the default.
export function ResizeHandle({
  panel,
  width,
  onDrag,
  onWidth,
}: {
  panel: number;
  width: number | null;
  // While dragging: drawn, not yet remembered.
  onDrag(width: number): void;
  // Remembered for the side panel; null goes back to the default.
  onWidth(width: number | null): void;
}) {
  const drag = useRef<{ from: number; start: number; last: number | null } | null>(null);
  const max = widthMax(panel);
  const clamp = (value: number) => Math.min(max, Math.max(NAV_WIDTH_MIN, Math.round(value)));
  const current = clamp(width ?? defaultWidth(panel));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? NAV_WIDTH_STEP * 4 : NAV_WIDTH_STEP;
    if (event.key === "ArrowRight") onWidth(clamp(current + step));
    else if (event.key === "ArrowLeft") onWidth(clamp(current - step));
    else if (event.key === "Home") onWidth(null);
    else if (event.key === "End") onWidth(max);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { from: event.clientX, start: current, last: null };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragging = drag.current;
    if (dragging === null) return;
    dragging.last = clamp(dragging.start + event.clientX - dragging.from);
    onDrag(dragging.last);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const last = drag.current?.last ?? null;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (last !== null) onWidth(last);
  };
  return (
    <div
      role="separator"
      aria-label="Resize the trail"
      aria-orientation="vertical"
      aria-valuemin={NAV_WIDTH_MIN}
      aria-valuemax={max}
      aria-valuenow={current}
      tabIndex={0}
      title="Drag, or use the arrow keys, to resize the trail. Home resets it."
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        onWidth(width);
      }}
      onDoubleClick={() => onWidth(null)}
      className="absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-ring"
    />
  );
}

// The panel's own width, not the window's. Null until measured, which jsdom never does.
export function usePanelWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    const measured = element.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries.at(-1)?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

export type PanelLayout = "columns" | "sheet";

// What the side panel tells the shared review components; the full page provides none, so they draw as they always have.
export interface PanelNav {
  layout: PanelLayout;
  // The navigator lists the selected thread's sources, so the review leaves its own source switch out.
  sourcesShown: boolean;
  // Where the selected source's file tree goes inside the navigator, or null while the navigator is not showing.
  treeSlot: HTMLElement | null;
  // The navigator's Files section: the source it lists, and whether the person folded the list away.
  files: { id: string; label: string; hidden: boolean; toggle(): void };
  filesTabStop: boolean;
  onFilesFocus(): void;
  // Stable: the file tree reports when it is drawn and when it goes.
  onFilesPresent(present: boolean): void;
  onFilePicked(): void;
  showIncomplete(): void;
  refreshRecords(): void;
  openFullScreen(): void;
  recordedOf(threadId: string): number | null;
  isHelper(threadId: string): boolean;
}
export const PanelNavContext = createContext<PanelNav | null>(null);
export const usePanelNav = (): PanelNav | null => useContext(PanelNavContext);

const TABBABLE =
  'button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
export const tabbables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => element.closest("[inert]") === null);

// Keeps Tab inside a sheet or popover: from the last control to the first, and back. Takes a native event too, for a
// container that holds portalled content React would route elsewhere.
export function trapTab(event: { key: string; shiftKey: boolean; preventDefault(): void }, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = tabbables(root);
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = !root.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

export interface PopoverTrigger {
  ref: Ref<HTMLButtonElement>;
  onClick(): void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

// A small non-modal dialog under the band that holds its trigger. It takes focus, keeps Tab inside, and Esc, its Close
// button or a click elsewhere closes it; Esc and Close hand focus back to the trigger.
export function Popover({
  label,
  heading,
  trigger,
  children,
}: {
  label: string;
  heading?: ReactNode;
  trigger(props: PopoverTrigger): ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!open || content === null) return;
    (tabbables(content).find((element) => element.dataset.popoverClose === undefined) ?? content).focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!contentRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <span className="contents">
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((shown) => !shown),
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
      })}
      {open && (
        <div
          ref={contentRef}
          id={id}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          data-popover
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else trapTab(event, event.currentTarget);
          }}
          className="absolute left-2 right-2 top-full z-30 mt-1 max-h-[min(28rem,70vh)] max-w-[26rem] overflow-y-auto rounded-lg border border-border-seam bg-card p-3 text-xs text-foreground shadow-lg outline-none"
        >
          <div className="mb-2 flex items-start gap-2">
            <h3 className="min-w-0 flex-1 text-xs font-semibold">{heading ?? label}</h3>
            <button type="button" data-popover-close aria-label="Close" onClick={close} className={ICON_BUTTON}>
              <Icon name="X" className="size-3.5" aria-hidden />
            </button>
          </div>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </span>
  );
}

const ITEM = "[data-nav-item], [data-file-nav]";
const GROUP = "[data-tree-dir], [data-nav-group]";
const headerOf = (group: Element): HTMLElement | null => group.querySelector<HTMLElement>(ITEM);

function parentItem(item: HTMLElement, root: HTMLElement): HTMLElement | undefined {
  const own = item.closest(GROUP);
  const from = own !== null && headerOf(own) === item ? own.parentElement : own;
  const parent = from?.closest(GROUP);
  const found = (parent && root.contains(parent) && headerOf(parent)) || undefined;
  if (found !== undefined) return found;
  // The Files section sits below the Trail, but its top rows belong to the source that lists them.
  if (item.closest("[data-navigator-files]") === null) return undefined;
  return root.querySelector<HTMLElement>('[data-nav-item][aria-current="true"][aria-controls]') ?? undefined;
}

// A source row's files are shown in the separate Files section it controls.
function controlled(item: HTMLElement, root: HTMLElement): HTMLElement | null {
  const id = item.getAttribute("aria-controls");
  if (id === null || !item.hasAttribute("data-nav-item")) return null;
  const region = root.ownerDocument.getElementById(id);
  return region !== null && root.contains(region) ? region : null;
}

// The control that opens or folds an item: a folder or group row toggles itself, a thread or source row has a fold button.
function foldOf(item: HTMLElement): HTMLElement {
  if (item.hasAttribute("data-file-nav") || item.hasAttribute("data-nav-fold")) return item;
  return item.parentElement?.querySelector<HTMLElement>("[data-nav-fold]") ?? item;
}

// The navigator's threads, sources, folders and files are one tree with one Tab stop: arrows move, Right and Left open and
// fold, Home and End jump. A native listener on the navigator's own element, so it also hears the file tree a review portals
// in, which React would send through the review instead.
export function useTreeKeys(root: HTMLElement | null): void {
  useEffect(() => {
    if (root === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(ITEM) : null;
      if (target === null || !root.contains(target)) return;
      const items = [...root.querySelectorAll<HTMLElement>(ITEM)];
      const at = items.indexOf(target);
      const expanded = target.getAttribute("aria-expanded");
      let next: HTMLElement | undefined;
      if (event.key === "ArrowDown") next = items[at + 1];
      else if (event.key === "ArrowUp") next = items[at - 1];
      else if (event.key === "Home") next = items[0];
      else if (event.key === "End") next = items.at(-1);
      else if (event.key === "ArrowRight") {
        const region = controlled(target, root);
        if (region !== null) {
          if (expanded === "false") region.querySelector<HTMLElement>("[data-files-toggle]")?.click();
          else next = region.querySelector<HTMLElement>(ITEM) ?? undefined;
        } else if (expanded === "false") foldOf(target).click();
        else if (expanded === "true") next = items[at + 1];
      } else if (event.key === "ArrowLeft") {
        if (expanded === "true" && controlled(target, root) === null) foldOf(target).click();
        else next = parentItem(target, root);
      } else return;
      event.preventDefault();
      event.stopPropagation();
      next?.focus();
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [root]);
}

export interface IncompleteThread {
  id: string;
  title: string;
  recorded: number;
}

// The one place that explains incomplete records: under the Trail, its own Tab stop, opening in place.
export function IncompleteRecords({
  threads,
  open,
  onToggle,
  onRefresh,
  onSelect,
  buttonRef,
}: {
  threads: readonly IncompleteThread[];
  open: boolean;
  onToggle(): void;
  onRefresh(): void;
  onSelect(threadId: string): void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const id = useId();
  if (threads.length === 0) return null;
  return (
    <div data-incomplete-records className="mt-1">
      <button
        ref={buttonRef}
        type="button"
        data-quiet
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Recorded edits may be incomplete · ${threads.length}`}
        onClick={onToggle}
        className={`${QUIET_ROW} ${NAV_MUTED}`}
      >
        <Chevron open={open} />
        <Icon name="CircleDashed" fallback="Circle" className="size-3.5 shrink-0" aria-hidden />
        <span data-row-title className="min-w-0 flex-1 truncate">
          Recorded edits may be incomplete
        </span>
        <span className="shrink-0 tabular-nums">{threads.length}</span>
      </button>
      {open && (
        <div
          id={id}
          role="region"
          aria-label="Incomplete recorded edits"
          className="space-y-2 pb-2 pl-7 pr-1.5 text-xs"
        >
          <p className={NAV_MUTED}>
            bb's records may miss the last edits made before these threads were archived. A count of 0 is not proof that
            nothing changed.
          </p>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="ArrowReloadHorizontal" fallback="RotateCcw" className="size-3.5" aria-hidden />
            Refresh records
          </button>
          <ul>
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  data-incomplete-thread={thread.id}
                  title={thread.title}
                  onClick={() => onSelect(thread.id)}
                  className={`flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left ${NAV_HOVER} ${NAV_FOCUS}`}
                >
                  <Icon name="CircleDashed" fallback="Circle" className={`size-3 shrink-0 ${NAV_MUTED}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  <span className={`shrink-0 ${NAV_MUTED}`}>{plural(thread.recorded, "recorded path")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Flare's companion threads draw flares and edit nothing, so they are counted here rather than listed in the Trail.
export function FlareHelpers({ helpers }: { helpers: ReadonlyArray<{ id: string; title: string }> }) {
  const [open, setOpen] = useState(false);
  if (helpers.length === 0) return null;
  return (
    <div data-flare-helpers className="mt-1">
      <button
        type="button"
        data-quiet
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
        className={`${QUIET_ROW} ${NAV_MUTED}`}
      >
        <Chevron open={open} />
        <Icon name="Zap" fallback="Sparkles" className="size-3.5 shrink-0" aria-hidden />
        <span data-row-title className="min-w-0 flex-1 truncate">
          {plural(helpers.length, "Flare helper")} · no edits
        </span>
      </button>
      {open && (
        <ul className={`mb-1 ml-12 space-y-0.5 text-xs ${NAV_MUTED}`}>
          {helpers.map((helper) => (
            <li key={helper.id} className="truncate" title={helper.title}>
              {helper.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
