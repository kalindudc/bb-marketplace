// jsdom has no Web Animations API. A small stand-in: element.animate() and CSS classes listed in `css` both become FakeAnimations
// that advance only through tick(), so tests read playState and currentTime directly, as the browser checks did.
export class FakeAnimation {
  playState: AnimationPlayState = "running";
  currentTime = 0;
  readonly finished: Promise<FakeAnimation>;
  private resolve!: () => void;
  private reject!: (e: unknown) => void;
  keyframes: Keyframe[] = [];
  constructor(readonly target: Element, readonly duration: number, readonly className?: string) {
    this.finished = new Promise<FakeAnimation>((res, rej) => { this.resolve = () => res(this); this.reject = rej; });
    this.finished.catch(() => {});
  }
  pause() { if (this.playState === "running") this.playState = "paused"; }
  // As in the browser, play() on an animation at its end rewinds it and plays it again.
  play() { if (this.playState === "finished" || (this.playState === "paused" && this.currentTime >= this.duration)) this.currentTime = 0; if (this.playState !== "idle") this.playState = "running"; }
  /** A hidden tab: the pause was still pending, so the animation reached its end, but the tab is throttled and has not settled it. */
  endWhileHidden() { this.currentTime = this.duration; this.playState = "finished"; }
  effect = { getComputedTiming: () => ({ endTime: this.duration }) };
  finish() { if (this.playState === "finished" || this.playState === "idle") return; this.currentTime = this.duration; this.playState = "finished"; this.resolve(); }
  cancel() { if (this.playState === "finished" || this.playState === "idle") return; this.playState = "idle"; this.reject(new Error("cancelled")); }
  tick(ms: number) { if (this.playState !== "running") return; this.currentTime = Math.min(this.duration, this.currentTime + ms); if (this.currentTime >= this.duration) this.finish(); }
}

export function installAnimations(css: Record<string, number> = {}) {
  const all: FakeAnimation[] = [];
  const proto = Element.prototype as unknown as Record<string, unknown>;
  const saved = { animate: proto.animate, getAnimations: proto.getAnimations };
  const live = (a: FakeAnimation) => a.playState === "running" || a.playState === "paused";
  proto.animate = function (this: Element, k: unknown, o?: number | { duration?: number }) {
    const a = new FakeAnimation(this, typeof o === "number" ? o : o?.duration ?? 300); a.keyframes = Array.isArray(k) ? k as Keyframe[] : []; all.push(a); return a;
  };
  proto.getAnimations = function (this: Element, o?: { subtree?: boolean }) {
    const els = [this, ...(o?.subtree ? [...this.querySelectorAll("*")] : [])];
    for (const el of els) for (const [cls, ms] of Object.entries(css)) {
      const has = el.classList.contains(cls) || (el.parentElement?.closest(`.${cls}`) != null && cls.startsWith("mo-") && el.matches(".fl"));
      const existing = all.find(a => a.target === el && a.className === cls && live(a));
      if (has && !existing && !all.some(a => a.target === el && a.className === cls && a.playState === "finished" && el.classList.contains(cls))) all.push(new FakeAnimation(el, ms, cls));
      if (!has && existing) existing.cancel();
    }
    return all.filter(a => els.includes(a.target) && live(a));
  };
  return {
    all,
    running: () => all.filter(a => a.playState === "running"),
    tick: (ms: number) => { for (const a of [...all]) a.tick(ms); },
    uninstall: () => { proto.animate = saved.animate; proto.getAnimations = saved.getAnimations; },
  };
}

export const flush = () => new Promise<void>(r => setTimeout(r, 0));

/** A controllable prefers-reduced-motion query. */
export function installMatchMedia() {
  let matches = false;
  const listeners = new Set<() => void>();
  const saved = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() { return query.includes("reduce") && matches; }, media: query, onchange: null,
    addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  return { set(v: boolean) { matches = v; for (const l of [...listeners]) l(); }, uninstall() { window.matchMedia = saved; } };
}
