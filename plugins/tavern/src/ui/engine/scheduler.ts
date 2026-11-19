import { motion } from "../kit/motion";
import type { LightAnchor } from "./art";
import type { MotionMode } from "./rules";

export interface EngineWorld {
  mode(): MotionMode;
  update(seconds: number): void;
  draw(still: boolean): void;
  suspend?(reason: "still" | "hidden" | "offscreen" | "removed"): void;
  lightAnchors?(): readonly LightAnchor[];
}

type Clock = {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
};
type RecordOfWorld = { world: EngineWorld; visible: boolean; active: boolean; dirty: boolean; still: boolean | null };
type Sample = { update: number; draw: number };

const SAMPLE_SIZE = 120;
const UPDATE_HZ = [60, 30, 15] as const;
const DRAW_MS = 1000 / 12;
const BUDGET_MS = 2;
const EPSILON = 1e-6;

export class Scheduler {
  private readonly worlds = new Set<RecordOfWorld>();
  private readonly samples: Sample[] = [];
  private hidden = false;
  private reduced = false;
  private frameId: number | null = null;
  private last: number | null = null;
  private accumulator = 0;
  private drawElapsed = 0;
  private frames = 0;
  private level = 0;

  constructor(private readonly clock: Clock) {}

  register(world: EngineWorld) {
    const entry: RecordOfWorld = { world, visible: false, active: false, dirty: true, still: null };
    this.worlds.add(entry);
    return {
      setVisible: (visible: boolean) => { entry.visible = visible; this.reconcile(); },
      invalidate: () => { entry.dirty = true; this.reconcile(); },
      remove: () => { world.suspend?.("removed"); this.worlds.delete(entry); this.reconcile(); },
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
      frames: this.frames, worlds: this.worlds.size, running: this.frameId !== null, budgetLevel: this.level,
      updateHz: UPDATE_HZ[this.level]!, averageUpdateMs: update / count, averageDrawMs: draw / count, worstUpdateMs, worstDrawMs,
    });
  }

  private reconcile() {
    let running = false;
    for (const entry of this.worlds) {
      const visible = !this.hidden && entry.visible;
      const still = this.reduced || entry.world.mode() === "off";
      const active = visible && !still;
      if (entry.active && !active) {
        entry.world.suspend?.(still ? "still" : this.hidden ? "hidden" : "offscreen");
        entry.dirty = true;
      }
      entry.active = active;
      running ||= active;
      if (visible && (entry.dirty || still !== entry.still)) {
        entry.dirty = false;
        entry.still = still;
        entry.world.draw(still);
      }
    }
    if (running) {
      this.frameId ??= this.clock.requestFrame(this.tick);
    } else {
      if (this.frameId !== null) this.clock.cancelFrame(this.frameId);
      this.frameId = this.last = null;
      this.accumulator = this.drawElapsed = 0;
    }
  }

  private tick = (ts: number) => {
    // A throttled frame must not replay a backlog of physics steps.
    const elapsed = this.last === null ? 0 : Math.min(100, Math.max(0, ts - this.last));
    this.last = ts;
    this.accumulator += elapsed;
    this.drawElapsed += elapsed;
    const step = 1000 / UPDATE_HZ[this.level]!;
    const start = this.clock.now();
    while (this.accumulator + EPSILON >= step) {
      for (const entry of this.worlds) if (entry.active) entry.world.update(step / 1000);
      this.accumulator = Math.max(0, this.accumulator - step);
    }
    const update = this.clock.now() - start;
    let draw = 0;
    if (this.drawElapsed + EPSILON >= DRAW_MS) {
      this.drawElapsed = Math.max(0, this.drawElapsed - DRAW_MS) % DRAW_MS;
      const startDraw = this.clock.now();
      for (const entry of this.worlds) if (entry.active) entry.world.draw(false);
      draw = this.clock.now() - startDraw;
    }
    this.samples[this.frames % SAMPLE_SIZE] = { update, draw };
    this.frames++;
    if (this.frames % SAMPLE_SIZE === 0 && this.level < UPDATE_HZ.length - 1) {
      const { averageUpdateMs, averageDrawMs } = this.snapshot();
      if (averageUpdateMs + averageDrawMs > BUDGET_MS) this.level++;
    }
    if (this.frameId !== null) this.frameId = this.clock.requestFrame(this.tick);
  };
}

export const scheduler = new Scheduler({
  now: () => performance.now(),
  requestFrame: cb => requestAnimationFrame(cb),
  cancelFrame: id => cancelAnimationFrame(id),
});

type WorldHandle = ReturnType<Scheduler["register"]>;
const observed = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | null = null;
let unsubscribe: (() => void) | null = null;

function inViewport(el: Element) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
    getComputedStyle(el).visibility !== "hidden";
}

const measureAll = () => { for (const [el, setVisible] of observed) setVisible(inViewport(el)); };
const syncMotion = () => scheduler.setEnvironment({ hidden: motion.getPaused(), reduced: motion.getReduced() });
const debug = () => scheduler.snapshot();

export function observeWorld(el: Element, world: EngineWorld): Pick<WorldHandle, "invalidate" | "remove"> {
  if (observed.size === 0) {
    motion.install();
    unsubscribe = motion.subscribe(syncMotion);
    syncMotion();
    Object.defineProperty(window, "__tavernEngine", { configurable: true, get: debug });
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) observed.get(entry.target)?.(entry.isIntersecting && getComputedStyle(entry.target).visibility !== "hidden");
      });
    } else {
      window.addEventListener("scroll", measureAll, true);
      window.addEventListener("resize", measureAll);
    }
  }
  const handle = scheduler.register(world);
  observed.set(el, handle.setVisible);
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
      unsubscribe?.();
      unsubscribe = null;
      if (Object.getOwnPropertyDescriptor(window, "__tavernEngine")?.get === debug) delete (window as { __tavernEngine?: unknown }).__tavernEngine;
    },
  };
}
