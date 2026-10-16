import type { FollowThinkingPreference } from "./preference";

// bb has no plugin API for timeline rows, so this module reads the DOM that
// bb 0.46.1 renders (apps/app/src/components/thread/timeline in get-bb/bb):
// - ExpandablePanel puts each row's toggle button inside `.group/timeline-row`.
// - Reasoning rows ("Thought for 12s") lead with the AiBrain01 icon; the live
//   indicator at the bottom of a running thread has no icon and reads "Thinking…".
// - TimelineReasoningDetail is the only element with all three detail classes.
// If a bb update changes this markup, the plugin stops matching and does nothing.
const HEADER_SELECTOR = ".group\\/timeline-row > button[aria-expanded]";
const HEADER_WRAPPER_CLASS = "group/timeline-row";
const REASONING_ICON_SELECTOR = '[data-icon="AiBrain01"]';
const ANY_ICON_SELECTOR = "[data-icon]";
const LIVE_LABEL = /^Thinking\b/;
const DETAIL_SELECTOR = ".max-h-80.overflow-auto.whitespace-pre-wrap";
const ROW_ID_ATTRIBUTE = "data-timeline-row-id";
const MAX_DETAIL_TO_ROW_DEPTH = 8;

// The values bb uses for its own sticky scrollers (useStickyBottomScroll).
const STICKY_BOTTOM_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 350;

const DEFAULT_SCAN_DELAY_MS = 80;

type PageWindow = Window & typeof globalThis;

export interface MountFollowThinkingOptions {
  document: Document;
  preference: Pick<FollowThinkingPreference, "isEnabled" | "subscribe">;
  signal: AbortSignal;
  /** How long to batch DOM changes before looking for new thinking blocks. */
  scanDelayMs?: number;
}

export function isThinkingHeader(header: Element): boolean {
  if (header.querySelector(REASONING_ICON_SELECTOR) !== null) return true;
  return header.querySelector(ANY_ICON_SELECTOR) === null && hasLiveLabel(header);
}

function hasLiveLabel(header: Element): boolean {
  return LIVE_LABEL.test(header.textContent?.trim() ?? "");
}

function isExpanded(header: Element): boolean {
  return header.getAttribute("aria-expanded") === "true";
}

// Row ids survive remounts when the timeline windows rows in and out. The live
// indicator sits outside the row list, so it has no id of its own.
function rowKey(header: Element): string | null {
  if (header.querySelector(REASONING_ICON_SELECTOR) === null) return null;
  return header.closest(`[${ROW_ID_ATTRIBUTE}]`)?.getAttribute(ROW_ID_ATTRIBUTE) ?? null;
}

function headerOfDetail(detail: Element): Element | null {
  let node = detail.parentElement;
  for (let depth = 0; node !== null && depth < MAX_DETAIL_TO_ROW_DEPTH; depth += 1) {
    const first = node.firstElementChild;
    if (first?.classList.contains(HEADER_WRAPPER_CLASS)) {
      return first.querySelector(":scope > button[aria-expanded]");
    }
    node = node.parentElement;
  }
  return null;
}

/** Keeps one thinking text box scrolled to its end while the person has not scrolled away. */
class Follower {
  pointerActive = false;
  private stick: boolean;
  private userIntentUntil = 0;
  private readonly observer: MutationObserver;
  private readonly listeners = new AbortController();

  constructor(
    private readonly element: HTMLElement,
    private readonly win: PageWindow,
    live: boolean,
  ) {
    this.stick = live;
    const options = { passive: true, signal: this.listeners.signal };
    const markIntent = () => {
      this.userIntentUntil = this.win.performance.now() + USER_SCROLL_INTENT_MS;
    };
    element.addEventListener("scroll", () => this.onScroll(), options);
    element.addEventListener("wheel", markIntent, options);
    element.addEventListener("touchstart", markIntent, options);
    element.addEventListener("touchmove", markIntent, options);
    element.addEventListener("keydown", markIntent, options);
    element.addEventListener("pointerdown", () => (this.pointerActive = true), options);
    this.observer = new win.MutationObserver(() => this.follow());
    this.observer.observe(element, { characterData: true, childList: true, subtree: true });
    this.follow();
  }

  dispose(): void {
    this.observer.disconnect();
    this.listeners.abort();
  }

  private follow(): void {
    if (this.stick) this.element.scrollTop = this.element.scrollHeight;
  }

  private onScroll(): void {
    const { scrollHeight, clientHeight, scrollTop } = this.element;
    if (scrollHeight - clientHeight - scrollTop <= STICKY_BOTTOM_THRESHOLD_PX) {
      this.stick = true;
      return;
    }
    if (this.pointerActive || this.win.performance.now() <= this.userIntentUntil) {
      this.stick = false;
    }
  }
}

/**
 * Expands every thinking block once as it appears and keeps live thinking text
 * scrolled to its newest line. A block the person collapses stays collapsed;
 * turning the preference off collapses the blocks this opened.
 */
export function mountFollowThinking({
  document: doc,
  preference,
  signal,
  scanDelayMs = DEFAULT_SCAN_DELAY_MS,
}: MountFollowThinkingOptions): () => void {
  const win = doc.defaultView;
  if (win === null) throw new Error("follow-thinking needs a document that has a window");

  let enabled = preference.isEnabled();
  let handled = new WeakSet<Element>();
  const userChoice = new WeakMap<Element, boolean>();
  const userRowChoice = new Map<string, boolean>();
  const followers = new Map<HTMLElement, Follower>();
  let pressing = false;
  let scanTimer: number | null = null;
  let disposed = false;

  const choiceFor = (header: Element): boolean | undefined => {
    const own = userChoice.get(header);
    if (own !== undefined) return own;
    const key = rowKey(header);
    return key === null ? undefined : userRowChoice.get(key);
  };

  const press = (header: HTMLElement) => {
    pressing = true;
    header.click();
    pressing = false;
  };

  const thinkingHeaders = () =>
    Array.from(doc.querySelectorAll<HTMLElement>(HEADER_SELECTOR)).filter(isThinkingHeader);

  const disposeFollowers = () => {
    for (const follower of followers.values()) follower.dispose();
    followers.clear();
  };

  const scan = () => {
    for (const [element, follower] of followers) {
      if (element.isConnected) continue;
      follower.dispose();
      followers.delete(element);
    }
    if (!enabled) return;
    for (const header of thinkingHeaders()) {
      if (handled.has(header)) continue;
      handled.add(header);
      if (!isExpanded(header) && choiceFor(header) !== false) press(header);
    }
    for (const detail of doc.querySelectorAll<HTMLElement>(DETAIL_SELECTOR)) {
      if (followers.has(detail)) continue;
      const header = headerOfDetail(detail);
      followers.set(detail, new Follower(detail, win, header !== null && hasLiveLabel(header)));
    }
  };

  const cancelScan = () => {
    if (scanTimer === null) return;
    win.clearTimeout(scanTimer);
    scanTimer = null;
  };

  const scheduleScan = () => {
    if (scanTimer !== null) return;
    scanTimer = win.setTimeout(() => {
      scanTimer = null;
      scan();
    }, scanDelayMs);
  };

  const observer = new win.MutationObserver(scheduleScan);
  const observe = () => observer.observe(doc.body, { childList: true, subtree: true });

  // Runs before bb's own click handler, so aria-expanded still shows the state
  // the person is changing away from.
  const onClick = (event: MouseEvent) => {
    if (pressing || !(event.target instanceof win.Element)) return;
    const header = event.target.closest(HEADER_SELECTOR);
    if (header === null || !isThinkingHeader(header)) return;
    const willExpand = !isExpanded(header);
    userChoice.set(header, willExpand);
    const key = rowKey(header);
    if (key !== null) userRowChoice.set(key, willExpand);
  };

  const onPointerEnd = () => {
    for (const follower of followers.values()) follower.pointerActive = false;
  };

  const applyPreference = () => {
    const next = preference.isEnabled();
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      handled = new WeakSet();
      observe();
      scan();
      return;
    }
    observer.disconnect();
    cancelScan();
    disposeFollowers();
    for (const header of thinkingHeaders()) {
      if (isExpanded(header) && choiceFor(header) !== true) press(header);
    }
  };

  doc.addEventListener("click", onClick, true);
  win.addEventListener("pointerup", onPointerEnd, true);
  win.addEventListener("pointercancel", onPointerEnd, true);
  const unsubscribe = preference.subscribe(applyPreference);
  if (enabled) {
    observe();
    scan();
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    cancelScan();
    unsubscribe();
    doc.removeEventListener("click", onClick, true);
    win.removeEventListener("pointerup", onPointerEnd, true);
    win.removeEventListener("pointercancel", onPointerEnd, true);
    disposeFollowers();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
