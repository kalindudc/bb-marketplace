// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { HEARTH_REPLAY_MAX_MS, HEARTH_REPLAY_MIN_MS, Hearth, awayClock, hearthReplayGap, hearthWords } from "../../../src/ui/kit/hearth";
import { motion } from "../../../src/ui/kit/motion";
import { flush, installAnimations } from "./motion-fakes";

const st = (...tones: ("busy" | "holding" | "idle" | "quiet" | "archived")[]) => tones.map(tone => ({ tone }));
const line = (w: ReturnType<typeof hearthWords>) => `${w.lead} · ${w.detail}`;

describe("hearthWords", () => {
  it("speaks in the rows' words, counted through keeperStatus, and names only what is at work", () => {
    expect(line(hearthWords(st("busy", "busy", "busy", "holding", "holding", "holding", "idle", "quiet", "holding")))).toBe("Lit · 3 Keepers busy");
    expect(line(hearthWords(st(...Array(9).fill("holding"))))).toBe("Banked · nobody at work");
    expect(line(hearthWords(st("holding", "quiet", "idle")))).toBe("Banked · nobody at work");
    expect(line(hearthWords([]))).toBe("Not lit yet · no Keeper");
    expect(line(hearthWords(st("busy")))).toBe("Lit · 1 Keeper busy");
  });

  it("says Out at closing time, and switches to due back at the Back at time", () => {
    const now = new Date(2026, 10, 16, 22, 0).getTime(), back = new Date(2026, 10, 16, 23, 30).getTime();
    const closed = (until: number | null, dueBack: boolean) => hearthWords(st("busy", "holding"), { away: { closed: true, until, dueBack }, now });
    expect(line(closed(back, false))).toBe("Out · closed until 23:30");
    expect(closed(back, false).state).toBe("out");
    expect(line(closed(back, true))).toBe("Out · was due back at 23:30");
    expect(line(closed(null, false))).toBe("Out · closed");
    expect(line(hearthWords(st("busy"), { away: { closed: false, until: null, dueBack: false }, now }))).toBe("Lit · 1 Keeper busy");
    expect(line(hearthWords(st("busy"), { away: null }))).toBe("Lit · 1 Keeper busy");
    for (const w of [closed(back, false), closed(back, true), closed(null, false)]) expect(w.lead).toBe("Out");
  });

  it("writes closing time in local 24-hour time, with the day when it isn't today", () => {
    const now = new Date(2026, 10, 16, 22, 0).getTime();
    expect(awayClock(new Date(2026, 10, 16, 8, 5).getTime(), now)).toBe("08:05");
    expect(awayClock(new Date(2026, 10, 17, 8, 0).getTime(), now)).toBe("Tue 08:00");
    expect(line(hearthWords([], { away: { closed: true, until: new Date(2026, 10, 17, 8, 0).getTime(), dueBack: false }, now }))).toBe("Out · closed until Tue 08:00");
  });

  it("leaves archived Keepers out, but a member still on the road keeps the hearth lit", () => {
    expect(line(hearthWords(st("busy", "archived")))).toBe("Lit · 1 Keeper busy");
    expect(line(hearthWords(st("holding", "holding", "holding", "archived", "archived")))).toBe("Banked · nobody at work");
    expect(line(hearthWords(st("holding", ...Array(8).fill("archived"))))).toBe("Banked · nobody at work");
    expect(line(hearthWords(st("archived", "archived")))).toBe("Not lit · no active Keeper");
    expect(line(hearthWords(st("archived", "archived"), { onRoad: 1 }))).toBe("Lit · 1 on the road");
    expect(hearthWords(st("archived")).state).toBe("out");
    expect(line(hearthWords([]))).toBe("Not lit yet · no Keeper");
    for (const s of [st("archived"), st("archived", "archived", "archived"), []]) expect(line(hearthWords(s))).not.toMatch(/\b0 of 0\b/);
  });

  it("never tells a person a Keeper is working", () => {
    const all = [st("busy"), st("holding"), st("quiet", "holding"), []].map(s => line(hearthWords(s))).join(" ");
    expect(all.toLowerCase()).not.toContain("working");
  });
});

describe("Hearth", () => {
  let fx: ReturnType<typeof installAnimations>;
  let t = 0;
  beforeEach(() => { motion.reset(); t = 1_000_000; motion.now = () => t; fx = installAnimations({ "mo-flick": 3600, "mo-flare": 500, "mo-out": 600 }); });
  afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); });

  const lit = hearthWords(st("busy", "holding")), banked = hearthWords(st("holding")), out = hearthWords([], {});
  const mount = (words = lit, extra: { size?: number; flareKey?: string } = {}) => render(<div className="tavern"><Hearth words={words} surface="page" {...extra} /></div>);

  it("uses the Lively interval and stops repeating when banked or Off", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(motion, "cue");
    try {
      const v = render(<div className="tavern"><Hearth words={lit} surface="page" replay ambientMotion="lively" repeatSeconds={3} /></div>);
      act(() => vi.advanceTimersByTime(3000));
      expect(spy.mock.calls.some(c => c[2] === "hearth replay" && c[3].repeat)).toBe(true);
      v.rerender(<div className="tavern"><Hearth words={banked} surface="page" replay ambientMotion="lively" repeatSeconds={3} /></div>);
      const count = spy.mock.calls.length;
      act(() => vi.advanceTimersByTime(6000));
      expect(spy.mock.calls).toHaveLength(count);
      v.unmount(); motion.reset(); spy.mockClear();
      render(<div className="tavern"><Hearth words={lit} surface="page" replay ambientMotion="off" /></div>);
      act(() => vi.advanceTimersByTime(60000));
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); vi.useRealTimers(); }
  });
  it("always shows its words, and clamps its size to 24-40 px", () => {
    const v = mount(lit, { size: 12 });
    expect(v.container.textContent).toContain("Lit · 1 Keeper busy");
    expect(v.container.querySelector("svg")!.getAttribute("width")).toBe("24");
    expect(v.container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    v.unmount();
    expect(mount(out, { size: 60 }).container.querySelector("svg")!.getAttribute("width")).toBe("40");
  });

  it("issues every one of its cues as its own window's, so it never takes motion time from another cue (smoke 6)", () => {
    const spy = vi.spyOn(motion, "cue");
    const v = mount(lit, { flareKey: "a" });
    v.rerender(<div className="tavern"><Hearth words={lit} surface="page" flareKey="b" /></div>);
    v.rerender(<div className="tavern"><Hearth words={hearthWords([], { away: { closed: true, until: null, dueBack: false } })} surface="page" flareKey="b" /></div>);
    const kinds = spy.mock.calls.map(c => c[2]);
    expect(kinds).toEqual(expect.arrayContaining(["hearth flicker", "hearth flare", "hearth out"]));
    for (const c of spy.mock.calls) expect(c[3].ownWindow || c[3].yields).toBe(true);
    spy.mockRestore();
  });

  it("carries its state as a class, and the first night is out", () => {
    expect(mount(banked).container.querySelector(".tavern-hearth")!.className).toContain("banked");
    cleanup();
    const v = mount(hearthWords([]));
    expect(v.container.querySelector(".tavern-hearth")!.className).toContain("out");
    expect(v.container.textContent).toContain("Not lit yet · no Keeper");
  });

  it("flickers once on arrival when lit, and a remount within the rest does not replay it", async () => {
    mount(lit);
    expect(motion.cues.size).toBe(1);
    fx.tick(3600); await flush();
    cleanup();
    mount(lit);
    expect(motion.cues.size).toBe(0);
    expect(motion.log.map(l => l.reason)).toEqual(["rest"]);
  });

  it("stays still on arrival when banked, flickers when it becomes lit, and flares when a quest returns", async () => {
    const v = mount(banked);
    expect(motion.cues.size).toBe(0);
    v.rerender(<div className="tavern"><Hearth words={lit} surface="page" /></div>);
    expect([...motion.cues].map(c => c.kind)).toEqual(["hearth flicker"]);
    fx.tick(3600); await flush();
    v.rerender(<div className="tavern"><Hearth words={lit} surface="page" flareKey="q1" /></div>);
    expect([...motion.cues].map(c => c.kind)).toEqual(["hearth flare"]);
  });
});

describe("the hearth replay", () => {
  let fx: ReturnType<typeof installAnimations>;
  const spyCue = () => vi.spyOn(motion, "cue");
  let cueSpy: ReturnType<typeof spyCue>;
  let renders = 0;
  beforeEach(() => {
    motion.reset(); renders = 0;
    // The coordinator's clock is the fake timers' Date, so a turn is judged at the moment it fires.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(1_000_000); motion.now = () => Date.now();
    fx = installAnimations({ "mo-flick": 3600, "mo-flick1": 1500, "mo-flare": 500, "mo-out": 600 });
    cueSpy = spyCue();
    // Every gap 22 s: the jitter itself is hearthReplayGap's test.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; delete document.documentElement.dataset.motion; });

  const lit = hearthWords(st("busy", "holding")), banked = hearthWords(st("holding"));
  const view = (words = lit, replay = true) => <Profiler id="hearth" onRender={() => { renders++; }}><div className="tavern"><Hearth words={words} surface="page" replay={replay} /></div></Profiler>;
  /** Ends the cues that have run their length, then moves the timers, so each turn finds the last one finished. */
  const advance = async (ms: number) => {
    fx.tick(ms);
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    await act(() => vi.advanceTimersByTimeAsync(ms));
  };
  // The fakes don't restart a class on the same element, so plays are counted from the coordinator.
  const played = () => cueSpy.mock.calls.map((c, i) => ({ kind: c[2], o: c[3], ok: cueSpy.mock.results[i]!.value !== null })).filter(c => c.kind === "hearth replay" && c.ok);
  const replays = () => played().length;
  const reasons = () => motion.log.filter(l => l.kind === "hearth replay").map(l => l.reason);

  it("draws each gap from 18 to 26 s, so it never ticks like a clock", () => {
    const a = hearthReplayGap(() => 0.1), b = hearthReplayGap(() => 0.9);
    expect(a).not.toBe(b);
    for (const g of [a, b, hearthReplayGap(() => 0), hearthReplayGap(() => 0.999)]) { expect(g).toBeGreaterThanOrEqual(HEARTH_REPLAY_MIN_MS); expect(g).toBeLessThanOrEqual(HEARTH_REPLAY_MAX_MS); }
    expect([HEARTH_REPLAY_MIN_MS, HEARTH_REPLAY_MAX_MS]).toEqual([18_000, 26_000]);
  });

  it("replays one 1.5 s flicker while a Keeper is busy, skipping a turn that would crowd the arrival's flicker", async () => {
    render(view());
    expect(cueSpy.mock.calls.map(c => c[2])).toEqual(["hearth flicker"]);
    await advance(22_000);
    expect(replays()).toBe(0);
    expect(reasons()).toEqual(["window"]);
    await advance(22_000);
    expect(replays()).toBe(1);
    await advance(22_000);
    expect(replays()).toBe(2);
    for (const c of played()) expect(c.o).toMatchObject({ ms: 1500, className: "mo-flick1", yields: true, restMs: 18_000 });
  });

  it("doesn't re-render the hearth for a replay", async () => {
    render(view());
    const before = renders;
    await advance(22_000); await advance(22_000); await advance(22_000);
    expect(replays()).toBe(2);
    expect(renders).toBe(before);
  });

  it("stops at once when no Keeper is busy, and never starts with the setting off or under reduced motion", async () => {
    const v = render(view());
    await advance(22_000); await advance(22_000);
    expect(replays()).toBe(1);
    const flying = [...motion.cues].find(c => c.kind === "hearth replay")!;
    expect(flying).toBeDefined();
    // Banking mid-flight stills the replay at once, and nothing more is scheduled.
    v.rerender(view(banked));
    expect(motion.cues.has(flying)).toBe(false);
    const before = reasons().length;
    await advance(60_000);
    expect(reasons()).toHaveLength(before);
    expect(replays()).toBe(1);
    cleanup(); motion.reset(); motion.now = () => Date.now(); cueSpy.mockClear();
    render(view(lit, false));
    await advance(60_000);
    expect(reasons()).toEqual([]);
    cleanup();
    document.documentElement.dataset.motion = "reduced";
    render(view());
    await advance(60_000);
    expect(reasons()).toEqual([]);
    expect(replays()).toBe(0);
  });

  it("holds its turn while the page is hidden, while the user types, and with an ask in view", async () => {
    render(view());
    await advance(22_000); await advance(22_000);
    expect(replays()).toBe(1);
    // Hidden once that replay has ended; a running one would pause and stay registered until the page shows again.
    await advance(2_000);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(20_000);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    // Typing 1 s before the next turn holds it; an ask on screen holds the one after.
    const field = document.createElement("input"); document.body.appendChild(field);
    await advance(21_000);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await advance(1_000);
    const ask = document.createElement("div"); ask.dataset.ask = ""; document.body.appendChild(ask);
    ask.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 0, right: 100, width: 100, height: 40 } as DOMRect);
    await advance(22_000);
    expect(replays()).toBe(1);
    expect(reasons()).toEqual(["window", "paused", "held", "ask"]);
  });

  it("skips a turn while a one-shot plays on the page, rather than queueing", async () => {
    render(view());
    await advance(22_000); await advance(22_000);
    expect(replays()).toBe(1);
    await advance(21_000);
    motion.cue("page", document.body.appendChild(document.createElement("span")), "sets out", { key: "lark", ms: 450, run: x => [x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 4000 })] });
    await advance(1_000);
    expect(reasons().at(-1)).toBe("yield");
    expect(replays()).toBe(1);
    await advance(22_000);
    expect(replays()).toBe(2);
  });

  it("ends its words with the flicker and a link to the setting, only while the replay is on", async () => {
    vi.useRealTimers();
    const slot = (replay: boolean) => renderSlot({ id: "hearth", component: () => <div className="tavern"><Hearth words={lit} surface="page" replay={replay} settingsHref="/settings/plugins/tavern" /></div> } as never, {}, {});
    const on = slot(true);
    const link = await on.findByRole("link", { name: /Ambient motion/ });
    expect(link.getAttribute("href")).toBe("/settings/plugins/tavern");
    // A no-break space before each "·", so a wrapped line never starts with one.
    // The leading space keeps the words apart when read as text; on screen the line's gap does that.
    expect(on.container.querySelector(".hearth-x")!.textContent).toBe(" Flickers while work runs\u00a0· Settings ›");
    expect(on.container.querySelector(".tavern-hearth")!.textContent).toBe("Lit · 1 Keeper busy\u00a0· Flickers while work runs\u00a0· Settings ›");
    expect(on.container.querySelector(".hearth-w")!.textContent).toBe("Lit · 1 Keeper busy\u00a0·");
    on.lifecycle.unmount();
    const off = slot(false);
    await off.findByText(/Lit/);
    expect(off.container.querySelector(".hearth-x")).toBeNull();
    expect(off.container.querySelector(".hearth-dot")).toBeNull();
    off.lifecycle.unmount();
  });
});
