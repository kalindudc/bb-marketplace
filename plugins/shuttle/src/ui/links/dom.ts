// The page script: finds git links in thread messages that Shuttle can read, marks them for links.css, and
// hands hover, focus and taps to the overlay (overlay.tsx), which owns the card. A page script has no RPC
// or config of its own, so the overlay registers itself as the bridge and says which links are Shuttle's.
//
// Only links in the timeline are taken: bb's own chrome and other plugins' panels keep their behaviour, and
// a link git-cards already decorates is left to it.

export interface LinkTargetRef {
  el: HTMLAnchorElement;
  url: string;
  key: string;
  kind: string;
}

export interface Bridge {
  /** What a link names, as `{ key, kind }`; null for a link Shuttle cannot read. */
  read(url: string): { key: string; kind: string } | null;
  enter(target: LinkTargetRef): void;
  leave(): void;
  /** A touch on a link: the card opens as a sheet instead of the link. */
  tap(target: LinkTargetRef): void;
  /** Links whose PR state nobody has asked for yet. */
  want(urls: string[]): void;
  /** Down on a focused link whose card is open: focus moves into the card. False when no card is showing. */
  into(): boolean;
}

// bb's timeline rows and message columns; not a published contract, so a bb release can move them.
const SCOPE = "[data-timeline-row-id], [data-message-column]";
const MARKED = "a[data-shuttle-link]";

let bridge: Bridge | null = null;
let schedule: () => void = () => {};
const states = new Map<string, string>();
/** What a link turned out to name, when that is not what it looks like: an issue link whose number is a PR's. */
const kinds = new Map<string, string>();
const wanted = new Set<string>();

function inScope(a: HTMLAnchorElement): boolean {
  return a.closest(SCOPE) !== null && !a.closest('[contenteditable="true"], [data-shuttle-card]') && !a.hasAttribute("data-gh-card");
}

function undecorate(a: HTMLAnchorElement): void {
  delete a.dataset.shuttleLink;
  delete a.dataset.shuttleKey;
  delete a.dataset.shuttleState;
  delete a.dataset.shuttleOpen;
}

/** Marks the links in scope; returns the hrefs whose state is not known yet, one per key. */
function decorate(root: ParentNode): string[] {
  if (bridge === null) return [];
  const fresh = new Map<string, string>();
  root.querySelectorAll<HTMLAnchorElement>("a[href^='http']").forEach((a) => {
    const read = inScope(a) ? bridge!.read(a.href) : null;
    if (read === null) {
      if (a.dataset.shuttleLink !== undefined) undecorate(a);
      return;
    }
    // A streamed message can change an anchor's href in place; follow it.
    const kind = kinds.get(read.key) ?? read.kind;
    if (a.dataset.shuttleKey !== read.key || a.dataset.shuttleLink !== kind) {
      a.dataset.shuttleLink = kind;
      a.dataset.shuttleKey = read.key;
    }
    const state = states.get(read.key);
    if (state !== undefined) {
      if (state === "") delete a.dataset.shuttleState;
      else a.dataset.shuttleState = state;
    } else if (!wanted.has(read.key) && !fresh.has(read.key)) {
      fresh.set(read.key, a.href);
    }
  });
  for (const key of fresh.keys()) wanted.add(key);
  return [...fresh.values()];
}

/** The PR or issue state of every link to `key`; "" when Shuttle does not know it. `kind` corrects what it names. */
export function paintState(key: string, state: string | null, kind?: string): void {
  states.set(key, state ?? "");
  if (kind !== undefined) kinds.set(key, kind);
  wanted.delete(key);
  document.querySelectorAll<HTMLAnchorElement>(MARKED).forEach((a) => {
    if (a.dataset.shuttleKey !== key) return;
    if (kind !== undefined) a.dataset.shuttleLink = kind;
    if (state) a.dataset.shuttleState = state;
    else delete a.dataset.shuttleState;
  });
}

/** The link whose card is open keeps its hover look. */
export function markOpen(el: HTMLAnchorElement | null): void {
  document.querySelectorAll<HTMLAnchorElement>(`${MARKED}[data-shuttle-open]`).forEach((a) => {
    if (a !== el) delete a.dataset.shuttleOpen;
  });
  if (el) el.dataset.shuttleOpen = "";
}

export function registerBridge(next: Bridge): () => void {
  bridge = next;
  states.clear();
  kinds.clear();
  wanted.clear();
  schedule();
  return () => {
    if (bridge !== next) return;
    bridge = null;
    document.querySelectorAll<HTMLAnchorElement>(MARKED).forEach(undecorate);
  };
}

function linkFrom(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement>(MARKED) : null;
}

function targetOf(a: HTMLAnchorElement): LinkTargetRef | null {
  const { shuttleKey: key, shuttleLink: kind } = a.dataset;
  return key && kind ? { el: a, url: a.href, key, kind } : null;
}

/** Mounts the page script; returns its cleanup. */
export function mountLinks(signal: AbortSignal): () => void {
  let frame = 0;
  const pass = () => {
    frame = 0;
    const fresh = decorate(document.body);
    if (fresh.length > 0) bridge?.want(fresh);
  };
  schedule = () => {
    if (!frame) frame = requestAnimationFrame(pass);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
  schedule();

  const opts = { capture: true, signal } as const;
  let current: HTMLAnchorElement | null = null;
  let touch = false;
  const enter = (a: HTMLAnchorElement) => {
    if (current === a) return;
    current = a;
    const target = targetOf(a);
    if (target) bridge?.enter(target);
  };
  const leave = () => {
    if (!current) return;
    current = null;
    bridge?.leave();
  };
  window.addEventListener("pointerdown", (event) => { touch = event.pointerType === "touch"; }, opts);
  window.addEventListener("keydown", (event) => {
    // A keyboard is in use again, whatever the last pointer was.
    touch = false;
    if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey || current === null || document.activeElement !== current) return;
    if (bridge?.into()) event.preventDefault();
  }, opts);
  window.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const a = linkFrom(event.target);
    if (a) enter(a);
  }, opts);
  window.addEventListener("pointerout", (event) => {
    if (current && !current.contains(event.relatedTarget as Node | null)) leave();
  }, opts);
  window.addEventListener("focusin", (event) => {
    if (touch) return;
    const a = linkFrom(event.target);
    if (a) enter(a);
  }, opts);
  window.addEventListener("focusout", (event) => {
    if (current && linkFrom(event.target) === current) leave();
  }, opts);
  // A touch has no hover: the first tap opens the card, whose Open button follows the link.
  window.addEventListener("click", (event) => {
    // A click says which pointer made it where the browser fills pointerType; otherwise the last pointerdown does.
    const kind = "pointerType" in event ? (event as PointerEvent).pointerType : "";
    if (!(kind ? kind === "touch" : touch)) return;
    const a = linkFrom(event.target);
    const target = a ? targetOf(a) : null;
    if (!target || !bridge) return;
    event.preventDefault();
    event.stopPropagation();
    bridge.tap(target);
  }, opts);

  // A PR merges while its link is on screen: ask Shuttle's copy again now and then. It costs no server call.
  const recheck = setInterval(() => {
    states.clear();
    wanted.clear();
    schedule();
  }, 2 * 60_000);

  return () => {
    observer.disconnect();
    clearInterval(recheck);
    if (frame) cancelAnimationFrame(frame);
    schedule = () => {};
    document.querySelectorAll<HTMLAnchorElement>(MARKED).forEach(undecorate);
  };
}
