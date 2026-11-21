import { motion, TYPING_HOLD_MS } from "../kit/motion";
import type { LightAnchor } from "./art";
import type { MotionMode } from "./rules";

export interface EngineWorld {
  mode(): MotionMode;
  update(seconds: number, steps: number): void;
  draw(still: boolean): void;
  /** Ms to a discrete change, 0 for the usual draw cadence, or null when an invalidation is the only way to change. */
  nextDraw(): number | null;
  refresh?(): boolean;
  suspend?(reason: "still" | "hidden" | "offscreen" | "removed"): void;
  lightAnchors?(): readonly LightAnchor[];
}

type Clock = {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(id: number): void;
};
type WorldEntry = {
  world: EngineWorld; visible: boolean; active: boolean; dirty: boolean; still: boolean | null;
  since: number; last: number; remainder: number; due: number | null; continuous: boolean;
};
type Sample = { update: number; draw: number };

const SAMPLE_SIZE = 24;
const UPDATE_HZ = 60;
const DRAW_HZ = [12, 8, 6] as const;
const BUDGET_WINDOW_MS = 2000;
const BUDGET_SHARE = 2 / (1000 / UPDATE_HZ);
const EPSILON = 1e-5;

export class Scheduler {
  private readonly worlds = new Set<WorldEntry>();
  private readonly samples: Sample[] = [];
  private hidden = false;
  private reduced = false;
  private frameId: number | null = null;
  private timer: { id: number; due: number } | null = null;
  private busy = false;
  private frames = 0;
  private timerWakes = 0;
  private level = 0;
  private budgetSince: number | null = null;
  private budgetWork = 0;

  constructor(private readonly clock: Clock) {}

  register(world: EngineWorld) {
    const entry: WorldEntry = { world, visible: false, active: false, dirty: true, still: null, since: 0, last: 0, remainder: 0, due: null, continuous: false };
    this.worlds.add(entry);
    return {
      setVisible: (visible: boolean) => { entry.visible = visible; this.reconcile(); },
      invalidate: (change?: () => void) => {
        if (entry.active && !this.busy) this.advance(entry, this.clock.now());
        change?.();
        entry.dirty = true;
        this.reconcile();
      },
      refresh: () => {
        if (!entry.active || !world.refresh) return;
        this.advance(entry, this.clock.now());
        if (world.refresh()) entry.dirty = true;
        this.reconcile();
      },
      remove: () => { this.worlds.delete(entry); world.suspend?.("removed"); this.reconcile(); },
    };
  }

  setEnvironment({ hidden, reduced }: { hidden: boolean; reduced: boolean }) {
    this.hidden = hidden;
    this.reduced = reduced;
    this.reconcile();
  }

  isActive(world: EngineWorld) {
    return [...this.worlds].some(entry => entry.world === world && entry.active);
  }

  snapshot() {
    let update = 0, draw = 0, worstUpdateMs = 0, worstDrawMs = 0;
    for (const sample of this.samples) {
      update += sample.update; draw += sample.draw;
      worstUpdateMs = Math.max(worstUpdateMs, sample.update);
      worstDrawMs = Math.max(worstDrawMs, sample.draw);
    }
    const count = this.samples.length || 1;
    return Object.freeze({
      frames: this.frames, timerWakes: this.timerWakes, worlds: this.worlds.size, running: this.frameId !== null || this.timer !== null, budgetLevel: this.level,
      updateHz: UPDATE_HZ, drawHz: DRAW_HZ[this.level]!, averageUpdateMs: update / count, averageDrawMs: draw / count, worstUpdateMs, worstDrawMs,
    });
  }

  private reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock.now();
      for (const entry of this.worlds) {
        const visible = !this.hidden && entry.visible;
        const still = this.reduced || entry.world.mode() === "off";
        const active = visible && !still;
        const wasActive = entry.active;
        entry.active = active;
        if (wasActive && !active) {
          entry.due = null;
          entry.world.suspend?.(still ? "still" : this.hidden ? "hidden" : "offscreen");
          entry.dirty = true;
        }
        if (active && !wasActive) {
          entry.last = entry.since = now;
          entry.remainder = 0;
          entry.dirty = true;
        }
        if (visible && (entry.dirty || still !== entry.still)) {
          entry.dirty = false;
          entry.still = still;
          entry.world.refresh?.();
          entry.world.draw(still);
          if (active) this.plan(entry, now);
        }
      }
    } finally { this.busy = false; }
    this.schedule();
  }

  private advance(entry: WorldEntry, ts: number) {
    const elapsed = Math.max(0, ts - entry.last);
    const expected = entry.due === null ? 0 : entry.due - entry.last;
    // Sparse idle deadlines can be seconds away; only a late callback is subject to the catch-up cap.
    if (entry.due !== null) entry.remainder += Math.min(elapsed, Math.max(0, expected) + 100);
    entry.last = ts;
    const step = 1000 / UPDATE_HZ;
    const count = Math.floor((entry.remainder + EPSILON) / step);
    if (count === 0) return;
    entry.remainder = Math.max(0, entry.remainder - count * step);
    entry.world.update(step / 1000, count);
  }

  private nextContinuousDraw(entry: WorldEntry, now: number) {
    const interval = 1000 / DRAW_HZ[this.level]!;
    return entry.since + (Math.floor((now - entry.since + EPSILON) / interval) + 1) * interval;
  }

  private plan(entry: WorldEntry, now: number) {
    const delay = entry.world.nextDraw();
    const step = 1000 / UPDATE_HZ;
    entry.continuous = delay === 0;
    entry.due = delay === null ? null : entry.continuous ? this.nextContinuousDraw(entry, now)
      : entry.last + Math.max(0, Math.max(1, Math.ceil((delay - EPSILON) / step)) * step - entry.remainder);
    if (entry.due !== null) this.budgetSince ??= now;
  }

  private assessBudget(now: number, work: number) {
    if (this.budgetSince === null) return;
    this.budgetWork += work;
    const elapsed = now - this.budgetSince;
    if (elapsed + EPSILON < BUDGET_WINDOW_MS) return;
    const share = this.budgetWork / elapsed;
    this.budgetSince = now;
    this.budgetWork = 0;
    const previous = this.level;
    if (share + EPSILON >= BUDGET_SHARE && this.level < DRAW_HZ.length - 1) this.level++;
    else if (share < BUDGET_SHARE / 2 && this.level > 0) this.level--;
    if (this.level !== previous) for (const entry of this.worlds) {
      if (entry.due !== null && entry.continuous) entry.due = this.nextContinuousDraw(entry, now);
    }
  }

  private schedule() {
    let due = Infinity;
    for (const entry of this.worlds) if (entry.due !== null) due = Math.min(due, entry.due);
    if (this.timer?.due === due) return;
    if (this.timer) { this.clock.clearTimer(this.timer.id); this.timer = null; }
    if (!Number.isFinite(due)) {
      this.budgetSince = null;
      this.budgetWork = 0;
      if (this.frameId !== null) this.clock.cancelFrame(this.frameId);
      this.frameId = null;
    } else if (this.frameId === null) {
      const id = this.clock.setTimer(() => {
        this.timer = null;
        this.timerWakes++;
        // A display timestamp can predate the timer that requested it.
        this.frameId = this.clock.requestFrame(ts => this.tick(Math.max(ts, due)));
      }, Math.max(0, due - this.clock.now()));
      this.timer = { id, due };
    }
  }

  private tick = (ts: number) => {
    this.frameId = null;
    this.busy = true;
    let update = 0, draw = 0;
    const advanced: WorldEntry[] = [];
    try {
      for (const entry of this.worlds) {
        if (entry.due === null || entry.due > ts + EPSILON) continue;
        const start = this.clock.now();
        this.advance(entry, ts);
        entry.world.refresh?.();
        const startDraw = this.clock.now();
        entry.dirty = false;
        entry.world.draw(false);
        const end = this.clock.now();
        update += startDraw - start;
        draw += end - startDraw;
        advanced.push(entry);
      }
      this.samples[this.frames++ % SAMPLE_SIZE] = { update, draw };
      const planning = this.clock.now();
      for (const entry of advanced) this.plan(entry, ts);
      this.assessBudget(ts, update + draw + this.clock.now() - planning);
    } finally { this.busy = false; }
    this.reconcile();
  };
}

export const scheduler = new Scheduler({
  now: () => performance.now(),
  requestFrame: cb => requestAnimationFrame(cb),
  cancelFrame: id => cancelAnimationFrame(id),
  setTimer: (cb, delay) => window.setTimeout(cb, Math.ceil(delay)),
  clearTimer: id => window.clearTimeout(id),
});

type WorldHandle = ReturnType<Scheduler["register"]>;
const observed = new Map<Element, WorldHandle>();
let observer: IntersectionObserver | null = null;
let unsubscribe: (() => void) | null = null;
let typing = false;
let typingTimer: number | undefined;
const TYPING_EVENTS = ["input", "keydown", "compositionstart", "compositionupdate", "compositionend", "focusout"];

function inViewport(el: Element) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
    getComputedStyle(el).visibility !== "hidden";
}

const measureAll = () => { for (const [el, handle] of observed) handle.setVisible(inViewport(el)); };
const syncMotion = () => scheduler.setEnvironment({ hidden: motion.getPaused(), reduced: motion.getReduced() });
const debug = () => scheduler.snapshot();
const syncTyping = () => {
  const current = motion.getHolds("page").typing;
  if (typing !== current) {
    typing = current;
    for (const handle of observed.values()) handle.refresh();
  }
  return current;
};
const finishTyping = () => {
  typingTimer = undefined;
  if (!syncTyping()) return;
  const { composing, now, typingHoldUntil } = motion.snapshot();
  if (!composing && typingHoldUntil !== null) {
    typingTimer = window.setTimeout(finishTyping, Math.max(1, Math.ceil(typingHoldUntil - now + 1)));
  }
};
const onInput = () => {
  const holding = syncTyping();
  window.clearTimeout(typingTimer);
  typingTimer = holding ? window.setTimeout(finishTyping, TYPING_HOLD_MS) : undefined;
};

export function observeWorld(el: Element, world: EngineWorld): Pick<WorldHandle, "invalidate" | "remove"> {
  if (observed.size === 0) {
    motion.install();
    subscribeInput();
    unsubscribe = motion.subscribe(syncMotion);
    syncMotion();
    Object.defineProperty(window, "__tavernEngine", { configurable: true, get: debug });
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) observed.get(entry.target)?.setVisible(entry.isIntersecting && getComputedStyle(entry.target).visibility !== "hidden");
      });
    } else {
      window.addEventListener("scroll", measureAll, true);
      window.addEventListener("resize", measureAll);
    }
  }
  const handle = scheduler.register(world);
  observed.set(el, handle);
  observer?.observe(el);
  handle.setVisible(inViewport(el));
  return {
    invalidate: handle.invalidate,
    remove: () => {
      observer?.unobserve(el);
      observed.delete(el);
      handle.remove();
      if (observed.size > 0) return;
      observer?.disconnect();
      observer = null;
      window.removeEventListener("scroll", measureAll, true);
      window.removeEventListener("resize", measureAll);
      for (const event of TYPING_EVENTS) document.removeEventListener(event, onInput, true);
      window.clearTimeout(typingTimer);
      typing = false;
      unsubscribe?.();
      unsubscribe = null;
      if (Object.getOwnPropertyDescriptor(window, "__tavernEngine")?.get === debug) delete (window as { __tavernEngine?: unknown }).__tavernEngine;
    },
  };
}

function subscribeInput() {
  // Capture after the coordinator, whose listeners record the hold first.
  for (const event of TYPING_EVENTS) document.addEventListener(event, onInput, { capture: true, passive: true });
  finishTyping();
}
