// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useRef, useLayoutEffect } from "react";
import { motion, useTavernMotion, BURST_REST_MS, MOTION_PER_WINDOW_MS, ONE_SHOT_CUES, PAGE_SLOTS, THREAD_SLOTS_HELD, TYPING_HOLD_MS, type Surface } from "../../../src/ui/kit/motion";
import { FakeAnimation, flush, installAnimations, installMatchMedia } from "./motion-fakes";

let fx: ReturnType<typeof installAnimations>;
let t = 0;
const root = () => { const r = document.createElement("div"); r.className = "tavern"; document.body.appendChild(r); return r; };
const el = (parent: Element = root()) => { const e = document.createElement("span"); parent.appendChild(e); return e; };
const slide = (e: Element, ms = 400) => [e.animate([{ transform: "translateY(4px)" }, { transform: "none" }], { duration: ms })];
const refusals = () => motion.log.map(l => l.reason);
const hide = (hidden: boolean) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); document.dispatchEvent(new Event("visibilitychange")); };

beforeEach(() => { motion.reset(); t = 1_000_000; motion.now = () => t; fx = installAnimations(); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); document.body.innerHTML = ""; delete document.documentElement.dataset.motion; });

it("lively repeats bypass rest and budgets but not typing or stuck items", async () => {
 const e = el();
 const repeat = () => motion.cue("page", e, "loop", {key:"loop",ms:3600,ambient:true,repeat:true,run:x=>slide(x,3600)});
 expect(repeat()).not.toBeNull();
 fx.running().forEach(a=>a.finish()); await flush(); t+=4000;
 expect(repeat()).not.toBeNull();
 motion.settle(); await flush();
 const field = document.createElement("textarea"); document.body.append(field);
 field.dispatchEvent(new Event("input", {bubbles:true}));
 expect(repeat()).toBeNull();
});
describe("class cues", () => {
  beforeEach(() => { fx.uninstall(); fx = installAnimations({ "mo-flare": 500 }); });
  /** Each read of offsetWidth, with whether the cue's class was on the element at that moment. A reflow flushes style, as in the
   * browser, so a class taken off ends its animation and adding it again starts a new one. */
  const reflows = () => {
    const seen: boolean[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { seen.push(this.classList.contains("mo-flare")); this.getAnimations(); return 0; });
    return { seen, restore: () => spy.mockRestore() };
  };

  it("adds a class the element does not have without forcing a reflow", () => {
    const e = el(), r = reflows();
    try {
      expect(motion.cue("page", e, "hearth flare", { key: "first", ms: 500, className: "mo-flare" })).not.toBeNull();
      expect(r.seen).toEqual([]);
      expect(e.classList.contains("mo-flare")).toBe(true);
      expect(fx.running().map(a => a.className)).toEqual(["mo-flare"]);
    } finally { r.restore(); }
  });

  it("still restarts a class already on the element, with one reflow while it is off", () => {
    const e = el(); e.classList.add("mo-flare");
    const r = reflows();
    try {
      expect(motion.cue("page", e, "hearth flare", { key: "again", ms: 500, className: "mo-flare" })).not.toBeNull();
      expect(r.seen).toEqual([false]);
      expect(e.classList.contains("mo-flare")).toBe(true);
      expect(fx.running().map(a => a.className)).toEqual(["mo-flare"]);
    } finally { r.restore(); }
  });
});

describe("budgets", () => {
  it("gives a page three burst slots and a thread one", () => {
    const r = root();
    const page = Array.from({ length: PAGE_SLOTS + 1 }, (_, i) => motion.cue("page", el(r), "busy dot", { key: `k${i}`, ms: 3200, ambient: true, run: e => slide(e, 3200) }));
    expect(page.filter(Boolean)).toHaveLength(PAGE_SLOTS);
    const thread = [0, 1].map(i => motion.cue("thread:a", el(r), "busy dot", { key: `t${i}`, ms: 3200, ambient: true, run: e => slide(e, 3200) }));
    expect(thread.filter(Boolean)).toHaveLength(1);
    expect(refusals()).toEqual(["slot", "slot"]);
  });

  it("runs four cues at once across every kind and keeps the rest still, landing their state", () => {
    const done = vi.fn();
    const kinds = ["report", "phase fill", "decision", "since you looked", "quest returns", "report"];
    const got = kinds.map((k, i) => motion.cue("page", el(), k, { key: `q${i}`, ms: 400, run: e => slide(e), onDone: done }));
    expect(got.filter(Boolean)).toHaveLength(ONE_SHOT_CUES);
    expect(refusals()).toEqual(["cues", "cues"]);
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("merges a repeat while a cue runs and refuses it during the 30 s rest after", async () => {
    const e = el();
    expect(motion.cue("page", e, "report", { key: "juno", ms: 400, run: x => slide(x) })).not.toBeNull();
    expect(motion.cue("page", e, "report", { key: "juno", ms: 400, run: x => slide(x) })).toBeNull();
    fx.tick(400); await flush(); t += 1500;
    expect(motion.cue("page", e, "report", { key: "juno", ms: 400, run: x => slide(x) })).toBeNull();
    t += BURST_REST_MS;
    expect(motion.cue("page", e, "report", { key: "juno", ms: 400, run: x => slide(x) })).not.toBeNull();
    expect(refusals()).toEqual(["merged", "rest"]);
  });

  it("keeps the rest across a remount, because it is keyed by meaning, not by node", async () => {
    motion.cue("page", el(), "report", { key: "juno", ms: 400, run: x => slide(x) });
    fx.tick(400); await flush();
    expect(motion.cue("page", el(), "report", { key: "juno", ms: 400, run: x => slide(x) })).toBeNull();
  });

  it("lets a 6.5 s stream of 26 reports move a surface for at most 5 s, then holds it still", async () => {
    const r = root(); let moving = 0;
    for (let i = 0; i < 26 * 5; i++) {
      if (i % 5 === 0) motion.cue("page", el(r), "report", { key: `m${i / 5}`, ms: 400, run: x => slide(x) });
      if (fx.running().length) moving += 50;
      fx.tick(50); await flush(); t += 50;
    }
    expect(moving).toBeLessThanOrEqual(MOTION_PER_WINDOW_MS);
    expect(moving).toBeGreaterThan(4000);
    expect(refusals()).toContain("window");
    expect(fx.running()).toHaveLength(0);
  });

  it("never refuses the two moments or the user's own actions", () => {
    for (let i = 0; i < ONE_SHOT_CUES; i++) motion.cue("page", el(), "report", { key: `r${i}`, ms: 400, run: x => slide(x) });
    expect(motion.cue("thread:a", el(), "party forms", { key: "seal", ms: 1000, moment: true, run: x => slide(x, 1000) })).not.toBeNull();
    expect(motion.cue("page", el(), "cellar", { key: "q1", ms: 300, auto: false, run: x => slide(x, 300) })).not.toBeNull();
  });
});

describe("stop conditions", () => {
  it("keeps cues playing when the window loses focus, and allows new ones: watching from another app is still watching", () => {
    const a = motion.cue("page", el(), "sets out", { key: "lark", ms: 450, run: x => slide(x, 450) })!.anims[0]!;
    fx.tick(50);
    window.dispatchEvent(new Event("blur"));
    fx.tick(100);
    expect(a.playState).toBe("running");
    expect(a.currentTime).toBe(150);
    expect(motion.getPaused()).toBe(false);
    expect(motion.cue("page", el(), "report", { key: "x", ms: 400, run: x => slide(x) })).not.toBeNull();
    window.dispatchEvent(new Event("focus"));
    expect(a.playState).toBe("running");
  });

  it("pauses running cues while the page is hidden, refuses new ones as paused, and resumes them when it is visible again", () => {
    const a = motion.cue("page", el(), "quest returns", { key: "q", ms: 500, run: x => slide(x, 500) })!.anims[0]!;
    hide(true);
    fx.tick(200);
    expect(a.playState).toBe("paused");
    expect(a.currentTime).toBe(0);
    expect(motion.cue("page", el(), "report", { key: "x", ms: 400, run: x => slide(x) })).toBeNull();
    expect(refusals()).toEqual(["paused"]);
    hide(false);
    expect(a.playState).toBe("running");
    expect(motion.cue("page", el(), "report", { key: "y", ms: 400, run: x => slide(x) })).not.toBeNull();
  });

  it("starts paused when it installs in a page that is already hidden", () => {
    motion.reset(); motion.now = () => t;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    expect(motion.cue("page", el(), "report", { key: "x", ms: 400, run: x => slide(x) })).toBeNull();
    expect(refusals()).toEqual(["paused"]);
    hide(false);
    expect(motion.cue("page", el(), "report", { key: "x", ms: 400, run: x => slide(x) })).not.toBeNull();
  });

  it("never replays a cue that reached its end while the page was hidden", () => {
    const a = motion.cue("page", el(), "hearth flicker", { key: "h", ms: 3600, className: "mo-flick", run: x => slide(x, 3600) })!.anims[0]!;
    fx.tick(3300);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    (a as unknown as FakeAnimation).endWhileHidden();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(a.playState).toBe("finished");
    expect(a.currentTime).toBe(3600);
  });

  it("settles everything to its end state when reduced motion turns on mid-flight, by the media query or the kit hook", async () => {
    const mm = installMatchMedia();
    try {
      motion.reset(); motion.now = () => t;
      const done = vi.fn();
      const a = motion.cue("page", el(), "quest returns", { key: "q", ms: 500, run: x => slide(x, 500), onDone: done })!.anims[0]!;
      mm.set(true);
      expect(a.playState).toBe("finished");
      expect(done).toHaveBeenCalledOnce();
      expect(motion.cue("page", el(), "report", { key: "y", ms: 400, run: x => slide(x) })).toBeNull();
      expect(refusals()).toContain("reduced");
      mm.set(false);
      const b = motion.cue("page", el(), "cellar", { key: "c", ms: 300, auto: false, run: x => slide(x, 300) })!.anims[0]!;
      document.documentElement.dataset.motion = "reduced";
      await flush();
      expect(b.playState).toBe("finished");
    } finally { mm.uninstall(); }
  });

  it("refuses anything beside an ask", () => {
    const ask = document.createElement("div"); ask.dataset.ask = ""; root().appendChild(ask);
    expect(motion.cue("page", el(ask), "report", { key: "a", ms: 400, run: x => slide(x) })).toBeNull();
    expect(refusals()).toEqual(["ask"]);
  });

  it("plays page cues with a restored draft in a focused field, and holds them for 2 s after typing in any text field", () => {
    const r = root(); const input = document.createElement("textarea"); input.value = "a draft bb restored"; r.appendChild(input); input.focus();
    expect(motion.cue("page", el(r), "report", { key: "a", ms: 400, run: x => slide(x) })).not.toBeNull();
    const composer = document.createElement("div"); composer.setAttribute("contenteditable", "true"); document.body.appendChild(composer);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    t += TYPING_HOLD_MS - 1;
    expect(motion.cue("page", el(r), "report", { key: "b", ms: 400, run: x => slide(x) })).toBeNull();
    expect(refusals()).toEqual(["held"]);
    t += 1;
    expect(motion.cue("page", el(r), "report", { key: "c", ms: 400, run: x => slide(x) })).not.toBeNull();
  });

  it("holds every surface while an IME composition is open, and lets the user's own cues and the moments through", () => {
    const field = document.createElement("input"); document.body.appendChild(field);
    expect(motion.cue("page", el(), "report", { key: "a", ms: 400, run: x => slide(x) })).not.toBeNull();
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    t += 60_000;
    for (const surface of ["page", "thread:w", "journal:w"] as const) expect(motion.cue(surface, el(), "report", { key: `held-${surface}`, ms: 400, run: x => slide(x) })).toBeNull();
    expect(motion.cue("thread:w", el(), "tick", { key: "mine", ms: 180, auto: false, run: x => slide(x, 180) })).not.toBeNull();
    expect(motion.cue("page", el(), "party forms", { key: "m", ms: 1100, moment: true, run: x => slide(x, 1100) })).not.toBeNull();
    expect(refusals()).toEqual(["held", "held", "held"]);
  });
});

describe("hearth cues count toward the window only for themselves (smoke 6)", () => {
  const lighting = (key = "hearth") => motion.cue("page", el(), "hearth flicker", { key, ms: 3600, ambient: true, ownWindow: true, run: x => slide(x, 3600) });
  const end = async () => { fx.tick(5000); await flush(); };
  // 1 s of earlier motion in the window: a report that slid in 10 s before. With the lighting's 3.6 s that leaves 0.4 s, so on the old
  // rule the road step (to 4.25 s after the lighting began) went over the 5 s window.
  const earlier = async () => { expect(motion.cue("page", el(), "report", { key: "r0", ms: 1000, run: x => slide(x, 1000) })).not.toBeNull(); await end(); t += 10_000; };
  const setsOut = () => motion.cue("page", el(), "sets out", { key: "lark", ms: 450, run: x => slide(x, 450) });
  const roadStep = () => motion.cue("page", el(), "road step", { key: "lark-road", ms: 2800, ambient: true, run: x => slide(x, 2800) });

  it("lets a member who sets out as the hearth lights play its road step", async () => {
    await earlier();
    expect(lighting()).not.toBeNull();
    t += 1000; expect(setsOut()).not.toBeNull();
    t += 450; expect(roadStep()).not.toBeNull();
    expect(refusals()).toEqual([]);
  });

  it("gives way itself: it counts everyone's motion when it decides whether it plays", async () => {
    await earlier();
    expect(setsOut()).not.toBeNull();
    t += 450; expect(roadStep()).not.toBeNull();
    t += 550; expect(lighting()).toBeNull();
    expect(refusals()).toEqual(["window"]);
  });

  it("keeps the hearth's own motion to 3.6 s per window on top of the 5 s, so the worst case is 8.6 s", async () => {
    expect(lighting()).not.toBeNull();
    // A flare after the lighting has ended would fit the 5 s total (4.1 s) but take the hearth past its own 3.6 s. (One during the
    // lighting overlaps it, so it adds no motion time and plays.)
    await end(); t += 4000;
    expect(motion.cue("page", el(), "hearth flare", { key: "hearth", ms: 500, ownWindow: true, run: x => slide(x, 500) })).toBeNull();
    expect(refusals()).toEqual(["window"]);
    // The party still has its whole 5 s beside the lighting: 3.6 + 5 = 8.6 s in one window, and no more.
    expect(motion.cue("page", el(), "report", { key: "a", ms: 2500, run: x => slide(x, 2500) })).not.toBeNull(); await end();
    t += 2500;
    expect(motion.cue("page", el(), "report", { key: "b", ms: 2500, run: x => slide(x, 2500) })).not.toBeNull(); await end();
    t += 2500;
    expect(motion.cue("page", el(), "report", { key: "c", ms: 500, run: x => slide(x, 500) })).toBeNull();
    expect(refusals()).toEqual(["window", "window"]);
  });

  it("counts other hearth cues when a hearth cue decides", async () => {
    expect(motion.cue("page", el(), "hearth flare", { key: "hearth", ms: 1500, ownWindow: true, run: x => slide(x, 1500) })).not.toBeNull(); await end();
    // 1.5 s of flare, then 3.6 s of lighting 2 s later: 5.1 s of the hearth's own motion in the window.
    t += 2000;
    expect(lighting("hearth-2")).toBeNull();
    expect(refusals()).toEqual(["window"]);
    // Any other cue doesn't count the flare: a road step still has the whole window.
    expect(roadStep()).not.toBeNull();
  });
});

describe("yielding cues (the hearth replay)", () => {
  const replay = (key = "hearth-replay") => motion.cue("page", el(), "hearth replay", { key, ms: 1500, ambient: true, yields: true, restMs: 18_000, run: x => slide(x, 1500) });
  const end = async () => { fx.tick(5000); await flush(); };

  it("never takes window from another cue: a member setting out right after two replays still plays its road step", async () => {
    expect(replay()).not.toBeNull(); await end(); t += 18_000;
    expect(replay()).not.toBeNull(); await end(); t += 2_000;
    expect(motion.cue("page", el(), "sets out", { key: "lark", ms: 450, run: x => slide(x, 450) })).not.toBeNull();
    expect(motion.cue("page", el(), "road step", { key: "lark-road", ms: 2800, ambient: true, run: x => slide(x, 2800) })).not.toBeNull();
    expect(refusals()).toEqual([]);
  });

  it("skips its turn while any other cue runs on its surface, and when it would leave less than 2 s of the window", async () => {
    expect(motion.cue("page", el(), "sets out", { key: "lark", ms: 3200, run: x => slide(x, 3200) })).not.toBeNull();
    expect(replay()).toBeNull();
    await end();
    expect(replay()).toBeNull();
    expect(refusals()).toEqual(["yield", "window"]);
    // The 3.2 s cue leaves the 30 s window once it ended 30 s ago.
    t += 33_200;
    expect(replay()).not.toBeNull();
  });

  it("rests for its own interval, and only a yielding cue can shorten the 30 s rest", async () => {
    expect(replay()).not.toBeNull(); await end(); t += 18_000;
    expect(replay()).not.toBeNull(); await end();
    expect(motion.cue("page", el(), "report", { key: "r", ms: 400, restMs: 1000, run: x => slide(x) })).not.toBeNull(); await end(); t += 2_000;
    expect(motion.cue("page", el(), "report", { key: "r", ms: 400, restMs: 1000, run: x => slide(x) })).toBeNull();
    expect(refusals()).toEqual(["rest"]);
  });

  it("gives way to an ask, a blocker or a failure on screen, but not to one scrolled out of view", () => {
    const stuck = document.createElement("div"); stuck.dataset.stuck = ""; document.body.appendChild(stuck);
    stuck.getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 0, right: 200, width: 200, height: 40 } as DOMRect);
    expect(replay()).toBeNull();
    expect(refusals()).toEqual(["ask"]);
    stuck.getBoundingClientRect = () => ({ top: innerHeight + 10, bottom: innerHeight + 50, left: 0, right: 200, width: 200, height: 40 } as DOMRect);
    expect(replay()).not.toBeNull();
  });

  it("gives way to any alert on screen, such as a refusal that is not marked stuck", () => {
    const alert = document.createElement("p"); alert.setAttribute("role", "alert"); alert.textContent = "Couldn’t release it: the hold changed"; document.body.appendChild(alert);
    alert.getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 0, right: 200, width: 200, height: 20 } as DOMRect);
    expect(replay()).toBeNull();
    expect(refusals()).toEqual(["ask"]);
    alert.remove();
    expect(replay()).not.toBeNull();
  });
});

describe("window.__tavernMotion", () => {
  type Snap = { paused: boolean; refusals: { length: number }[] & { length: number }; running: { msLeft: number }[] };
  const read = () => (window as unknown as { __tavernMotion: Snap }).__tavernMotion;
  it("reads the coordinator's state on demand, with each refusal timed", () => {
    expect(motion.cue("thread:w", el(), "busy dot", { key: "dot", ms: 3200, ambient: true, run: x => slide(x, 3200) })).not.toBeNull();
    motion.setHeld("thread:w", true);
    t += 100;
    expect(motion.cue("thread:w", el(), "busy dot", { key: "other", ms: 3200, ambient: true, run: x => slide(x, 3200) })).toBeNull();
    const field = document.createElement("input"); document.body.appendChild(field);
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(read()).toEqual({
      now: t, paused: false, reduced: false, composing: true, typingHoldUntil: t + TYPING_HOLD_MS, held: ["thread:w"],
      running: [{ surface: "thread:w", kind: "busy dot", key: "dot", msLeft: 3100 }],
      refusals: [{ surface: "thread:w", kind: "busy dot", key: "other", reason: "slot", at: t }],
    });
    motion.setHeld("thread:w", false);
  });

  it("returns a frozen copy each read, so nothing done to it reaches the coordinator", () => {
    motion.cue("page", el(), "report", { key: "a", ms: 400, run: x => slide(x) });
    motion.setPaused(true);
    motion.cue("page", el(), "report", { key: "b", ms: 400, run: x => slide(x) });
    motion.setPaused(false);
    const snap = read();
    expect(read()).not.toBe(snap);
    expect(() => { snap.paused = true; }).toThrow(TypeError);
    expect(() => { snap.refusals.length = 0; }).toThrow(TypeError);
    expect(() => { snap.running[0]!.msLeft = 0; }).toThrow(TypeError);
    expect(() => { (snap.refusals[0] as unknown as { reason: string }).reason = "x"; }).toThrow(TypeError);
    expect(() => { (window as unknown as { __tavernMotion: unknown }).__tavernMotion = {}; }).toThrow(TypeError);
    expect(motion.getPaused()).toBe(false);
    expect(refusals()).toEqual(["paused"]);
    expect(motion.cues.size).toBe(1);
  });

  it("leaves another bundle's hook in place when it is disposed after that bundle mounted", () => {
    motion.activate();
    const next = () => ({ from: "the next bundle" });
    Object.defineProperty(window, "__tavernMotion", { configurable: true, get: next });
    motion.dispose();
    expect((window as unknown as { __tavernMotion: unknown }).__tavernMotion).toEqual({ from: "the next bundle" });
    delete (window as { __tavernMotion?: unknown }).__tavernMotion;
  });

  it("is gone once the coordinator is disposed", () => {
    motion.activate();
    expect("__tavernMotion" in window).toBe(true);
    motion.dispose();
    expect("__tavernMotion" in window).toBe(false);
  });
});

function Widget({ held, surface }: { held: boolean; surface: Surface }) {
  const dot = useRef<HTMLSpanElement>(null);
  const { cue } = useTavernMotion(surface, { held });
  useLayoutEffect(() => { cue(dot.current, "busy dot", { key: "dot", ms: 3200, ambient: true, region: "widget", run: x => slide(x, 3200) }); }, [cue]);
  return <div className="tavern"><span ref={dot} /></div>;
}

describe("useTavernMotion", () => {
  it("settles the widget row when it becomes held (an ask) and starts nothing there while held", () => {
    const view = render(<Widget held={false} surface="thread:w" />);
    const a = fx.all[0]!;
    expect(a.playState).toBe("running");
    view.rerender(<Widget held surface="thread:w" />);
    expect(a.playState).toBe("finished");
    expect(motion.cue("thread:w", el(), "report", { key: "nod", ms: 400, region: "widget", run: x => slide(x) })).toBeNull();
    expect(motion.cue("thread:w", el(), "busy dot", { key: "other", ms: 3200, ambient: true, run: x => slide(x) })).toBeNull();
    expect(THREAD_SLOTS_HELD).toBe(0);
    expect(refusals()).toEqual(["held", "slot"]);
  });
});
