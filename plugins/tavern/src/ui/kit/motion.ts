import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/**
 * Tavern's motion coordinator: one per document, shared by every Tavern root. Every cue, CSS or `element.animate()`, goes through it,
 * so the budgets, the stop conditions and reduced motion reach all of them. Design and measurements: design/motion/why.md.
 */

export const BURST_MAX_MS = 5000;
export const PAGE_SLOTS = 3;
export const THREAD_SLOTS = 1;
/** Burst slots in a thread while its widget row is held: an ask is in the row. */
export const THREAD_SLOTS_HELD = 0;
/** Burst slots in a thread's journal panel, its own surface: an agent's tick, the ribbon and the Warden's seal share it. The user's own tick takes none. */
export const JOURNAL_SLOTS = 1;
/** Semantic cues at once, across every cue type; the rest keep only their still mark. */
export const ONE_SHOT_CUES = 4;
/** A target does not replay within this. A guess, to tune with use. */
export const BURST_REST_MS = 30_000;
/** A surface moves for at most this long in any WINDOW_MS, overlapping cues counted once; own-window cues (the hearth) aren't part of it. A guess, to tune with use. */
export const MOTION_PER_WINDOW_MS = 5000;
/** The hearth's own motion on top of MOTION_PER_WINDOW_MS, at most this long per WINDOW_MS (one lighting flicker), so a window moves for 8.6 s at worst. */
export const OWN_PER_WINDOW_MS = 3600;
export const WINDOW_MS = 30_000;
/** Automatic cues on every surface hold for this long after the last input in any text field. A guess, to tune with use. */
export const TYPING_HOLD_MS = 2000;
/** A yielding cue plays only if at least this much of its surface's window is still free after it. */
export const YIELD_HEADROOM_MS = 2000;
/** What a person may be reading: an ask, a blocker or a failure, including any alert such as a refused action. A yielding cue gives way while one is on screen. */
export const STUCK_IN_VIEW = "[data-ask], [data-stuck], .t-bad, [role=alert]";
/** A move travels only if it is this short and crosses no row; otherwise it fades and rises 8 px where it lands. */
export const MAX_TRAVEL_PX = 160;

export type Surface = "page" | `thread:${string}` | `journal:${string}`;

export type CueOptions = {
  repeat?: boolean;
  /** Semantic identity (a quest id, a member thread id), not the DOM node, so the rest survives a re-render or remount. */
  key: string;
  /** Planned length, for the window budget; at most BURST_MAX_MS. */
  ms: number;
  /** A class the coordinator restarts on the element and removes when the cue ends. */
  className?: string;
  /** Starts `element.animate()` work; the Animations it returns are registered with the cue. */
  run?: (el: Element) => Animation[] | void;
  /** Takes a burst slot (busy dot, hearth flicker, road step). */
  ambient?: boolean;
  /** False for the user's own actions: registered, never refused by budgets. */
  auto?: boolean;
  /** The two moments: registered, never refused by budgets. */
  moment?: boolean;
  /** Settles when the surface's widget row becomes held. */
  region?: "widget";
  /** Runs once when the cue ends, settles or is refused, so the still state always lands. */
  onDone?: () => void;
  /**
   * A repeating cue that gives way to everything (the hearth replay): it skips its turn while any other cue runs on its surface, while
   * an ask, blocker or failure is on screen, or when less than YIELD_HEADROOM_MS of the window would be left after it. It counts toward
   * the window only when it decides whether it plays itself, never when another cue is checked.
   */
  yields?: boolean;
  /**
   * Counts toward the window only when it decides whether it plays itself, never when another cue is checked: every hearth cue, so the
   * hearth never takes motion time from a member setting out. When it decides, it counts every cue's motion, its own kind's included.
   * `yields` implies it.
   */
  ownWindow?: boolean;
  /** A yielding cue's own rest, in place of BURST_REST_MS; ignored on any other cue. */
  restMs?: number;
};

const ended = (a: Animation) => {
  if (a.playState === "finished") return true;
  const end = Number(a.effect?.getComputedTiming().endTime ?? Infinity);
  return a.currentTime !== null && Number(a.currentTime) >= end;
};
const settleOne = (a: Animation) => { try { if (a.playState !== "finished") a.finish(); } catch { a.cancel(); } };

export type Refusal = "reduced" | "paused" | "ask" | "held" | "merged" | "rest" | "slot" | "cues" | "window" | "yield";

export type Cue = {
  surface: Surface; kind: string; key: string; id: string; ambient: boolean; auto: boolean; moment: boolean; region?: "widget";
  el: Element; className?: string; anims: Animation[]; start: number; end: number; onDone?: () => void;
};

const TEXT_FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable=''], [contenteditable='true']";
const inTextField = (e: Event) => { const t = e.composedPath?.()[0] ?? e.target; return t instanceof Element && !!t.closest(TEXT_FIELD); };

function stuckInView() {
  for (const e of document.querySelectorAll(STUCK_IN_VIEW)) {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) return true;
  }
  return false;
}

function animationsOf(el: Element): Animation[] {
  return typeof el.getAnimations === "function" ? el.getAnimations({ subtree: true }) : [];
}

class Coordinator {
  readonly cues = new Set<Cue>();
  private history: { surface: Surface; start: number; end: number; own: boolean }[] = [];
  private last = new Map<string, number>();
  private held = new Map<Surface, boolean>();
  private paused = false;
  private pausedAt = 0;
  private reduced = false;
  private installed = false;
  private ended = false;
  private mounts = 0;
  private lastInputAt = -Infinity;
  private readonly debugGetter = () => this.snapshot();
  private composing = false;
  private listeners = new Set<() => void>();
  private teardown: (() => void)[] = [];
  /** The last 200 refusals; `at` is on the coordinator's clock (`now`). */
  readonly log: { surface: Surface; kind: string; key: string; reason: Refusal; at: number }[] = [];

  now = () => performance.now();

  install() {
    if (this.installed || this.ended || typeof window === "undefined") return;
    this.installed = true;
    this.reduced = this.readReduced();
    // Hidden pauses; blur doesn't: a visible bb window watched from another app is still watched.
    const onVisibility = () => this.setPaused(document.hidden);
    // Set without emitting, since install can run during a render; readers take the value when they subscribe.
    if (document.hidden) { this.paused = true; this.pausedAt = this.now(); }
    const onReduced = () => this.setReduced(this.readReduced());
    const onInput = (e: Event) => { if (inTextField(e)) this.typed(); };
    const onKey = (e: Event) => { const k = (e as KeyboardEvent); if (typeof k.key === "string" && k.key.length === 1 && !k.ctrlKey && !k.metaKey) onInput(e); };
    const onCompose = (e: Event) => { if (!inTextField(e)) return; this.composing = e.type !== "compositionend"; this.typed(); };
    // A field that loses focus ends its composition; without this, a compositionend lost with its field would hold every cue for good.
    const onLeave = (e: Event) => { if (this.composing && inTextField(e)) { this.composing = false; this.lastInputAt = this.now(); } };
    const typing: [string, (e: Event) => void][] = [["input", onInput], ["keydown", onKey], ["compositionstart", onCompose], ["compositionupdate", onCompose], ["compositionend", onCompose], ["focusout", onLeave]];
    for (const [type, fn] of typing) document.addEventListener(type, fn, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    Object.defineProperty(window, "__tavernMotion", { configurable: true, get: this.debugGetter });
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    media?.addEventListener?.("change", onReduced);
    const observer = typeof MutationObserver === "function" ? new MutationObserver(onReduced) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    this.teardown = [
      () => document.removeEventListener("visibilitychange", onVisibility),
      // Only our own: a newer bundle that mounted before this one's disposer ran keeps its hook.
      () => { if (Object.getOwnPropertyDescriptor(window, "__tavernMotion")?.get === this.debugGetter) delete (window as { __tavernMotion?: unknown }).__tavernMotion; },
      () => media?.removeEventListener?.("change", onReduced),
      () => observer?.disconnect(),
      ...typing.map(([type, fn]) => () => document.removeEventListener(type, fn, { capture: true })),
    ];
  }

  /** A frontend generation starts (Tavern's content script mounts): listen before any surface renders. */
  activate() {
    this.mounts++;
    this.ended = false;
    this.install();
  }

  /**
   * The generation ends (bb replaced the bundle or deactivated Tavern): finish running cues, remove every listener, and stay ended, so an
   * old tree rendering on its way out can't install them again. The next mount activates it.
   */
  dispose() {
    if (--this.mounts > 0) return;
    this.mounts = 0;
    this.settle();
    for (const off of this.teardown) off();
    this.teardown = []; this.installed = false; this.ended = true;
    this.lastInputAt = -Infinity; this.composing = false;
  }

  /**
   * `window.__tavernMotion`, for "why didn't it move": a frozen copy built on each read, so it costs nothing at rest and nothing done to
   * it reaches the coordinator. Times are on the coordinator's clock (`now`).
   */
  snapshot() {
    const now = this.now();
    const f = Object.freeze;
    return f({
      now, paused: this.paused, reduced: this.reduced, composing: this.composing,
      typingHoldUntil: this.lastInputAt === -Infinity ? null : this.lastInputAt + TYPING_HOLD_MS,
      held: f([...this.held.keys()]),
      running: f([...this.cues].map(c => f({ surface: c.surface, kind: c.kind, key: c.key, msLeft: Math.max(0, Math.round(c.end - now)) }))),
      refusals: f(this.log.map(l => f({ ...l }))),
    });
  }

  /** Tests only: drop every listener, cue and memory. */
  reset() {
    for (const c of [...this.cues]) { for (const a of c.anims) a.cancel(); this.cues.delete(c); }
    for (const off of this.teardown) off();
    this.teardown = []; this.installed = false; this.history = []; this.last.clear(); this.held.clear();
    this.lastInputAt = -Infinity; this.composing = false; this.ended = false; this.mounts = 0;
    this.paused = false; this.reduced = false; this.log.length = 0;
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getReduced = () => this.reduced;
  getPaused = () => this.paused;
  private emit() { for (const l of [...this.listeners]) l(); }

  private readReduced() {
    if (typeof window === "undefined") return false;
    if (document.documentElement.dataset.motion === "reduced") return true;
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private setReduced(reduced: boolean) {
    if (reduced === this.reduced) return;
    this.reduced = reduced;
    if (reduced) this.settle();
    this.emit();
  }

  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    const now = this.now();
    if (paused) {
      this.pausedAt = now;
      for (const c of this.cues) for (const a of c.anims) a.pause();
    } else {
      const gap = now - this.pausedAt;
      // A hidden tab can let a pending pause run to the end; play() would then rewind it and replay the cue, so an ended animation is finished instead.
      for (const c of this.cues) { c.end += gap; for (const a of c.anims) ended(a) ? settleOne(a) : a.play(); }
      for (const h of this.history) if (h.end > this.pausedAt) h.end += gap;
    }
    this.paused = paused;
    this.emit();
  }

  setHeld(surface: Surface, held: boolean) {
    if ((this.held.get(surface) ?? false) === held) return;
    if (held) this.held.set(surface, true); else this.held.delete(surface);
    if (held) this.settle(c => c.surface === surface && c.region === "widget");
  }

  /**
   * Whether an unbounded ambient loop (a drawn sprite, which has no end to schedule) may run on this surface now. The strong stops
   * apply: reduced motion, a hidden or paused tab, the typing hold, and a surface that is held (an ask in its widget row). Reading is
   * deliberately not one of them: a standing sprite that froze whenever an ask appeared would read as broken, and a loop draws no text
   * and takes no cue slot and no window time.
   */
  mayLoop(surface: Surface): boolean {
    if (this.ended || this.reduced || this.paused) return false;
    if (this.composing || this.now() - this.lastInputAt < TYPING_HOLD_MS) return false;
    return !this.held.get(surface);
  }

  /** Typing holds new automatic cues everywhere, and cuts the widget rows' running cues at once: they sit beside the composer. */
  private typed() {
    this.lastInputAt = this.now();
    for (const c of this.cues) if (c.region === "widget") { this.cut(x => x.region === "widget"); break; }
  }

  /** Stop matching cues at rest: a cancelled animation leaves the element's own style, never its end frame, whatever its fill. */
  private cut(filter: (c: Cue) => boolean) {
    for (const c of [...this.cues]) {
      if (!filter(c)) continue;
      for (const a of c.anims) a.cancel();
      this.release(c);
    }
  }

  private refuse(surface: Surface, kind: string, key: string, reason: Refusal, onDone?: () => void): null {
    this.log.push({ surface, kind, key, reason, at: this.now() });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    onDone?.();
    return null;
  }

  /** Motion time a surface would use in the last WINDOW_MS with one more cue of `ms` from `now`; overlaps count once. Own-window cues (`ownWindow`, `yields`) count only for another own-window cue. */
  private windowUse(surface: Surface, now: number, ms: number, which: "others" | "all" | "own" = "others") {
    const from = now - WINDOW_MS;
    const spans = this.history.filter(h => h.surface === surface && h.end > from && (which === "all" || (which === "own") === h.own)).map(h => [Math.max(h.start, from), h.end] as [number, number]);
    spans.push([now, now + ms]);
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0, s = -Infinity, e = -Infinity;
    for (const [a, b] of spans) { if (a > e) { if (e > s) total += e - s; s = a; e = b; } else e = Math.max(e, b); }
    return total + (e > s ? e - s : 0);
  }

  cue(surface: Surface, el: Element | null, kind: string, o: CueOptions): Cue | null {
    this.install();
    const id = `${surface}|${kind}|${o.key}`;
    if (this.ended || !el || !el.isConnected) { o.onDone?.(); return null; }
    if (this.reduced) return this.refuse(surface, kind, o.key, "reduced", o.onDone);
    const auto = o.auto !== false && !o.moment, own = !!(o.ownWindow || o.yields);
    const ms = Math.min(o.ms, BURST_MAX_MS);
    const now = this.now();
    if (!o.moment) {
      if (el.closest("[data-ask]")) return this.refuse(surface, kind, o.key, "ask", o.onDone);
      if (o.region === "widget" && this.held.get(surface)) return this.refuse(surface, kind, o.key, "held", o.onDone);
      // Every surface holds its automatic cues while the user types in any text field: within TYPING_HOLD_MS of the last input, or while
      // a composition is open. Focus and a draft don't count, because bb focuses the composer, with any draft it restored, whenever a
      // thread opens. A journal also holds while a blocked or rejected entry is in view (its held flag).
      if (auto && (this.composing || now - this.lastInputAt < TYPING_HOLD_MS)) return this.refuse(surface, kind, o.key, "held", o.onDone);
      if (surface.startsWith("journal:") && auto && this.held.get(surface)) return this.refuse(surface, kind, o.key, "held", o.onDone);
      for (const c of this.cues) if (c.id === id) return this.refuse(surface, kind, o.key, "merged"); // the running cue's onDone lands the state
    }
    if (auto && o.repeat && stuckInView()) return this.refuse(surface, kind, o.key, "ask", o.onDone);
    if (auto && o.repeat && this.paused) return this.refuse(surface, kind, o.key, "paused", o.onDone);
    if (auto && !o.repeat) {
      if (this.paused) return this.refuse(surface, kind, o.key, "paused", o.onDone);
      const last = this.last.get(id);
      if (last !== undefined && now - last < (o.yields ? o.restMs ?? BURST_REST_MS : BURST_REST_MS)) return this.refuse(surface, kind, o.key, "rest", o.onDone);
      if (o.yields) {
        if (stuckInView()) return this.refuse(surface, kind, o.key, "ask", o.onDone);
        if ([...this.cues].some(c => c.surface === surface)) return this.refuse(surface, kind, o.key, "yield", o.onDone);
        if (this.windowUse(surface, now, ms, "all") + YIELD_HEADROOM_MS > MOTION_PER_WINDOW_MS) return this.refuse(surface, kind, o.key, "window", o.onDone);
      }
      const running = [...this.cues];
      if (o.ambient) {
        const cap = surface === "page" ? PAGE_SLOTS : this.held.get(surface) ? THREAD_SLOTS_HELD : surface.startsWith("journal:") ? JOURNAL_SLOTS : THREAD_SLOTS;
        if (running.filter(c => c.ambient && c.surface === surface).length >= cap) return this.refuse(surface, kind, o.key, "slot", o.onDone);
      } else if (running.filter(c => c.auto && !c.ambient).length >= ONE_SHOT_CUES) return this.refuse(surface, kind, o.key, "cues", o.onDone);
      if (this.windowUse(surface, now, ms, own ? "all" : "others") > MOTION_PER_WINDOW_MS) return this.refuse(surface, kind, o.key, "window", o.onDone);
      if (own && this.windowUse(surface, now, ms, "own") > OWN_PER_WINDOW_MS) return this.refuse(surface, kind, o.key, "window", o.onDone);
    }
    const before = new Set(animationsOf(el));
    // The reflow only restarts a class already on the element; a first cue adds it and forces nothing mid-commit.
    if (o.className) { if (el.classList.contains(o.className)) { el.classList.remove(o.className); void (el as HTMLElement).offsetWidth; } el.classList.add(o.className); }
    const returned = o.run?.(el) ?? [];
    const anims = [...new Set([...returned, ...animationsOf(el).filter(a => !before.has(a))])];
    const cue: Cue = { surface, kind, key: o.key, id, ambient: !!o.ambient, auto, moment: !!o.moment, region: o.region, el, className: o.className, anims, start: now, end: now + ms, onDone: o.onDone };
    this.cues.add(cue);
    if (auto && !o.repeat) { this.last.set(id, now); this.history.push({ surface, start: now, end: now + ms, own }); this.prune(now); }
    if (this.paused) for (const a of anims) a.pause();
    if (!anims.length) this.release(cue);
    else void Promise.allSettled(anims.map(a => a.finished)).then(() => this.release(cue));
    return cue;
  }

  private prune(now: number) {
    this.history = this.history.filter(h => h.end > now - WINDOW_MS);
    for (const [id, t] of this.last) if (now - t >= BURST_REST_MS) this.last.delete(id);
  }

  private release(cue: Cue) {
    if (!this.cues.delete(cue)) return;
    if (cue.className) cue.el.classList.remove(cue.className);
    cue.onDone?.();
  }

  /** Finish matching cues at their end state: reduced motion mid-flight, a held widget row, a skipped moment. */
  settle(filter: (c: Cue) => boolean = () => true) {
    for (const c of [...this.cues]) {
      if (!filter(c)) continue;
      for (const a of c.anims) { try { a.finish(); } catch { a.cancel(); } }
      this.release(c);
    }
  }
}

export const motion = new Coordinator();

/**
 * A surface's handle on the coordinator. `held` is the surface's own signal: in a thread's widget row, an ask is in the row; turning
 * true settles that row's running cues. Typing is the coordinator's own hold, on every surface.
 */
export function useTavernMotion(surface: Surface, opts: { held?: boolean } = {}) {
  motion.install();
  const reduced = useSyncExternalStore(motion.subscribe, motion.getReduced, () => false);
  const paused = useSyncExternalStore(motion.subscribe, motion.getPaused, () => false);
  const held = !!opts.held;
  useLayoutEffect(() => { motion.setHeld(surface, held); }, [surface, held]);
  useLayoutEffect(() => () => motion.setHeld(surface, false), [surface]);
  const cue = useCallback((el: Element | null, kind: string, o: CueOptions) => motion.cue(surface, el, kind, o), [surface]);
  const settle = useCallback((filter?: (c: Cue) => boolean) => motion.settle(c => c.surface === surface && (!filter || filter(c))), [surface]);
  return { reduced, paused, cue, settle };
}

/** Calls `onChange(prev, next)` when `value` changes after the first render; never on mount. */
export function useChangeCue<T>(value: T, onChange: (prev: T, next: T) => void) {
  const prev = useRef(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useLayoutEffect(() => {
    if (Object.is(prev.current, value)) return;
    const was = prev.current;
    prev.current = value;
    latest.current(was, value);
  }, [value]);
}
