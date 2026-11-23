import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartyStrip } from "../../../src/ui/engine/strip";
import * as engine from "../../../src/ui/engine/scheduler";
import * as sprites from "../../../src/ui/engine/sprites";
import { Actor } from "../../../src/ui/engine/actor";
import { roundToLightCell, subscribeStripLantern } from "../../../src/ui/engine/light";
import { watchLantern } from "../../../src/ui/engine/light-overlay";
import type { LightAnchor } from "../../../src/ui/engine/art";
import { fakeEngineClock } from "./fake-clock";
import * as characters from "../../../src/ui/kit/characters";
import { motion } from "../../../src/ui/kit/motion";

const character = { id: "wren", avatar: "a-new-roll", name: "Wren", hue: "teal", charge: "chevron", look: { hat: "pointy" } } as const;
const askDisclosure = { panelId: "ask-panel", expanded: false, open: vi.fn() };
const wanderer = { character, classLabel: "Wanderer", classId: "wanderer", mood: "idle", keeper: false, surface: "thread:wren", region: "widget" } as const;

beforeEach(() => { document.documentElement.classList.add("dark"); });
afterEach(() => { cleanup(); document.documentElement.classList.remove("dark"); motion.reset(); vi.restoreAllMocks(); });

it("swaps the carried source on a theme change without moving a held ask marker", async () => {
  let strip: engine.EngineWorld;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    strip = candidate;
    return { invalidate: change => { change?.(); candidate.refresh?.(); candidate.draw(false); }, remove() {} };
  });
  let bounds: number[][] = [];
  const clip = vi.fn((rule: string) => ({ rule, bounds }));
  const context = {
    beginPath: () => { bounds = []; }, rect: (...rect: number[]) => { bounds.push(rect); }, clip,
    clearRect() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {},
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  const listener = vi.fn();
  const stop = subscribeStripLantern(listener);
  try {
    render(<div><PartyStrip {...wanderer} classId="warden" classLabel="Warden" held mood="waiting" askDisclosure={askDisclosure} /><span data-ask>Review the route</span></div>);
    strip!.draw(false);
    expect(listener.mock.lastCall?.[1]).toMatchObject({ kind: "crystal" });
    const mark = screen.getByText("!"), ask = screen.getByText("Review the route");
    const pixels = clip.mock.results.at(-1)?.value;
    expect(pixels).toEqual({ rule: "evenodd", bounds: [[0, 0, 48, 56]] });
    expect(screen.getByRole("button", { name: /open asks/i }).style.transform).toBe("");
    const still = [mark.outerHTML, ask.outerHTML];
    document.documentElement.classList.remove("dark");
    await Promise.resolve();
    expect(listener.mock.lastCall?.[1]).toBeNull();
    expect(strip!.lightAnchors?.()).toEqual([]);
    expect(clip.mock.results.at(-1)?.value).toEqual(pixels);
    expect([mark.outerHTML, ask.outerHTML]).toEqual(still);
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(listener.mock.lastCall?.[1]).toMatchObject({ kind: "crystal" });
    expect([mark.outerHTML, ask.outerHTML]).toEqual(still);
  } finally { stop(); }
});

it("uses the avatar seed and member class and places the carried light in page coordinates", () => {
  let world: engine.EngineWorld | undefined;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    world = candidate;
    return { invalidate: change => { change?.(); candidate.draw(true); }, remove() {} };
  });
  const createArt = vi.spyOn(sprites, "createArt");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const props = { character, classLabel: "Wanderer", classId: "wanderer", mood: "idle", keeper: false, surface: "thread:wren" } as const;
  const { rerender } = render(<PartyStrip {...props} />);
  expect(createArt).toHaveBeenCalledWith({ seed: "a-new-roll", classId: "wanderer", hue: "teal", charge: "chevron", look: { hat: "pointy" }, keeper: false });
  const strip = document.querySelector(".twalk")!;
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(31, 99, 100, 64));
  world!.draw(true);
  const anchor = world!.lightAnchors?.()[0];
  expect(anchor).toEqual({ x: 42, y: expect.any(Number), kind: "lantern" });
  expect(anchor!.y).toBeGreaterThan(99);
  expect(anchor!.y).toBeLessThan(157);
  rerender(<PartyStrip {...props} character={{ ...character, avatar: undefined }} />);
  expect(createArt.mock.lastCall?.[0].seed).toBe("wren");
  rerender(<PartyStrip {...props} classId="smith" />);
  expect(world!.lightAnchors?.()).toEqual([expect.objectContaining({ kind: "ember" })]);
});

it("paints an inert prop in the same 70px canvas and does not invalidate when the prop stays the same", () => {
  const fillRect = vi.fn();
  const ctx = { fillRect, beginPath() {}, rect() {}, clip() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {} };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
  const invalidate = vi.fn();
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    invalidate.mockImplementation(change => { change?.(); candidate.draw(true); });
    candidate.draw(true);
    return { invalidate, remove() {} };
  });
  const view = render(<PartyStrip {...wanderer} prop="book" />);
  expect(screen.getByRole("region").querySelector("canvas")?.height).toBe(70);
  expect(fillRect.mock.calls.some(([x, y]) => x >= 48 && y >= 34)).toBe(true);
  const calls = invalidate.mock.calls.length;
  view.rerender(<PartyStrip {...wanderer} prop="book" />);
  expect(invalidate).toHaveBeenCalledTimes(calls);
  view.rerender(<PartyStrip {...wanderer} prop="seal" />);
  expect(invalidate).toHaveBeenCalledTimes(calls + 1);
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("leaves the host's transcript-to-composer fade and backing alone", () => {
  const css = readFileSync("src/ui/engine/engine.css", "utf8");
  expect(css).not.toMatch(/\[data-(?:overflow-fade|scroll-footer)(?:=|\])/);
});

it("fits the thread hop and speech within the compact lane without shrinking page scenes", () => {
  let world!: engine.EngineWorld;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    world = candidate;
    return { invalidate: change => { change?.(); candidate.draw(false); }, remove() {} };
  });
  vi.spyOn(engine.scheduler, "isActive").mockReturnValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(358);
  const view = render(<PartyStrip {...wanderer} mode="lively" />);
  const lane = screen.getByRole("region", { name: "Wren walking" });
  const sprite = screen.getByRole("button", { name: /Wren, Wanderer/ });
  const height = () => lane.querySelector("canvas")!.height;
  const spriteTop = () => Number(sprite.style.transform.match(/, (\d+)px\)/)![1]);
  world.draw(false);
  const atRest = spriteTop();
  expect(height()).toBe(70);
  expect(lane.style.height).toBe(`${height()}px`);
  expect(atRest + 56).toBeLessThan(height());

  Object.defineProperty(sprite, "animate", { value: () => ({ finished: new Promise(() => {}), playState: "running", finish() {}, cancel() {} }) });
  fireEvent.click(sprite);
  let peak = atRest;
  for (let step = 0; step < 25; step++) {
    world.update(1 / 60, 1);
    world.draw(false);
    peak = Math.min(peak, spriteTop());
  }
  expect(atRest - peak).toBeGreaterThanOrEqual(8);
  expect(peak).toBeGreaterThan(0);

  view.rerender(<PartyStrip {...wanderer} mode="lively" speech={{ actorId: "wren", text: "The lantern is lit." }} />);
  expect(screen.getByRole("status").textContent).toBe("The lantern is lit.");
  expect(height()).toBe(70);
  view.unmount();
  const scene = render(<PartyStrip {...wanderer} pageScene={{ threadId: "wren" }} />);
  expect(scene.container.querySelector("canvas")!.height).toBe(64);
});

it("reacts to clicks beside a held ask without moving the exclamation mark or asking for speech", () => {
  let world: engine.EngineWorld;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    world = candidate;
    return { invalidate: change => { change?.(); candidate.refresh?.(); candidate.draw(false); }, remove() {} };
  });
  vi.spyOn(engine.scheduler, "isActive").mockReturnValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const play = vi.spyOn(Actor.prototype, "playCue");
  const speak = vi.fn();
  motion.setHeld("thread:wren", true);
  render(<PartyStrip {...{ character, classLabel: "Wanderer", classId: "wanderer", mood: "waiting", keeper: false, surface: "thread:wren", region: "widget", held: true, canClickSpeak: true, onActorClick: speak, askDisclosure }} />);
  const button = screen.getByRole("button", { name: /Wren, Wanderer/ });
  Object.defineProperty(button, "animate", { value: () => ({ finished: new Promise(() => {}), playState: "running", finish() {}, cancel() {} }) });
  const mark = screen.getByText("!");
  expect(button.contains(mark)).toBe(false);
  expect(mark.hasAttribute("data-tavern-still")).toBe(true);
  const light = vi.fn();
  const stop = subscribeStripLantern(light);
  try {
    world!.refresh?.(); world!.draw(false);
    const original = [button.style.transform, mark.outerHTML];
    for (let click = 0; click < 6; click++) {
      fireEvent.click(button);
      for (let step = 0; step < 15; step++) {
        world!.update(1 / 60, 1); world!.draw(false);
        expect([button.style.transform, mark.outerHTML]).toEqual(original);
        expect(light.mock.lastCall?.[1]).toMatchObject({ ...world!.lightAnchors!()[0], intensity: 1 });
      }
    }
  } finally { stop(); }
  const cues = play.mock.calls.map(([cue, auto]) => { expect(auto).toBe(false); return cue; });
  expect(cues).toHaveLength(6);
  expect(new Set(cues).size).toBe(3);
  expect(cues.every((cue, i) => i === 0 || cue !== cues[i - 1])).toBe(true);
  expect(speak).not.toHaveBeenCalled();
  expect(askDisclosure.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open asks for Wren" }));
  expect(askDisclosure.open).toHaveBeenCalledOnce();
});

it("tracks the emitted pixel while standing and walking but keeps brightness steady while typing, reduced, Off or Quiet", () => {
  let world: engine.EngineWorld;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    world = candidate;
    return { invalidate: change => { change?.(); candidate.refresh?.(); candidate.draw(candidate.mode() === "off"); }, remove() {} };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(380);
  const art = sprites.createArt({ seed: "wren", classId: "wanderer", hue: "teal", charge: null, keeper: false });
  let x = 4;
  vi.spyOn(sprites, "createArt").mockReturnValue({ ...art, lightAnchor: () => ({ kind: "lantern", x, y: 20 }) });
  let typing = false;
  vi.spyOn(motion, "getHolds").mockImplementation(() => ({ typing, held: false }));
  const listener = vi.fn();
  const unsubscribe = subscribeStripLantern(listener);
  const props = { ...wanderer, mood: "working" } as const;
  try {
    const view = render(<PartyStrip {...props} mode="calm" />);
    const draw = (reduced = false) => {
      const still = reduced || world.mode() === "off";
      world.refresh?.();
      if (!still) world.update(1 / 60, 35);
      world.draw(still);
      const anchor = listener.mock.lastCall?.[1];
      expect(anchor).toMatchObject(world.lightAnchors!()[0]!);
      return anchor.intensity as number;
    };
    const first = draw();
    x++;
    expect(draw()).not.toBe(first);
    view.rerender(<PartyStrip {...props} mode="lively" />);
    x++; draw(); x++; draw();
    typing = true;
    expect(draw()).toBe(1);
    x++;
    expect(draw()).toBe(1);
    typing = false;
    expect(draw(true)).toBe(1);
    expect(draw(true)).toBe(1);
    view.rerender(<PartyStrip {...props} mode="off" />);
    expect(draw()).toBe(1);
    expect(draw()).toBe(1);
    const react = vi.spyOn(Actor.prototype, "react");
    const speak = vi.fn();
    view.rerender(<PartyStrip {...props} mode="lively" quiet onActorClick={speak} />);
    expect(world!.mode()).toBe("off");
    fireEvent.click(screen.getByRole("button", { name: /Wren, Wanderer/ }));
    expect(react).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: "off" }), true);
    expect(speak).not.toHaveBeenCalled();
    expect(draw()).toBe(1);
    view.unmount();
    expect(listener.mock.lastCall?.[1]).toBeNull();
  } finally {
    unsubscribe();
  }
});

function mountWithClock(mode: "off" | "calm" | "lively", enabled: boolean) {
  const clock = fakeEngineClock();
  const renderPositions: LightAnchor[] = [];
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    const world = { ...candidate, draw(still: boolean) {
      candidate.draw(still);
      const anchor = candidate.lightAnchors?.()[0];
      if (anchor) renderPositions.push(anchor);
    } };
    const handle = clock.scheduler.register(world);
    handle.setVisible(true);
    return handle;
  });
  vi.spyOn(engine.scheduler, "isActive").mockReturnValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(380);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("twalk") ? new DOMRect(0, 0, 380, 64) : this.matches("[data-promptbox]") ? new DOMRect(0, 70, 380, 48) : new DOMRect();
  });
  const paint = vi.fn(), source = vi.fn<(strip: HTMLElement, anchor: LightAnchor | null) => void>();
  const overlay = watchLantern(document.createElement("canvas"), { lanternLight: enabled, lanternLightBb: true, lanternStrength: "medium" }, paint);
  const unsubscribe = subscribeStripLantern((strip, anchor) => { source(strip, anchor); overlay.draw(strip, anchor); });
  const view = render(<div data-app-composer><PartyStrip {...wanderer} mode={mode} mood="working" /><div data-composer-box><form data-promptbox /></div></div>);
  return { ...clock, paint, source, renderPositions, dispose() { unsubscribe(); overlay.dispose(); view.unmount(); } };
}

it.each(["off", "calm", "lively"] as const)("adds no wakes in %s while drawing only new light maps", mode => {
  const run = (enabled: boolean) => {
    const frame = vi.spyOn(window, "requestAnimationFrame"), timer = vi.spyOn(window, "setTimeout");
    const clock = mountWithClock(mode, enabled);
    try {
      clock.advance(3600);
      expect(frame).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      const { frames, timerWakes } = clock.scheduler.snapshot();
      return { frames, timerWakes, requests: clock.requestFrame.mock.calls.length, draws: clock.renderPositions.length, paints: clock.paint.mock.calls.length,
        anchors: clock.source.mock.calls.flatMap(([, anchor]) => anchor ? [anchor] : []), rendered: clock.renderPositions };
    } finally { clock.dispose(); vi.restoreAllMocks(); }
  };
  const { paints: unlit, ...off } = run(false);
  const { paints: lit, ...on } = run(true);
  expect(unlit).toBe(0);
  expect(on).toEqual(off);
  if (mode === "off") expect(on).toMatchObject({ frames: 0, timerWakes: 0, requests: 0, draws: 1 });
  else expect(on.frames).toBeGreaterThan(0);
  const positions = on.anchors.map(({ x, y }) => ({ x, y }));
  expect(positions.filter((anchor, i, all) => !i || anchor.x !== all[i - 1]!.x || anchor.y !== all[i - 1]!.y))
    .toEqual(on.rendered.filter((anchor, i, all) => !i || anchor.x !== all[i - 1]!.x || anchor.y !== all[i - 1]!.y)
      .map(({ x, y }) => ({ x, y })));
  if (mode === "off") {
    expect(on.anchors).toHaveLength(1);
    expect(lit).toBe(1);
  } else {
    expect(lit).toBeGreaterThan(1);
    expect(lit).toBeLessThan(on.draws);
  }
});

type GroundStroke = { x: number; y: number; w: number; h: number; colour: string; alpha: number };

function mountDaylight(mode: "off" | "calm" | "lively" = "lively", mood: "idle" | "working" = "idle", width = 390) {
  document.documentElement.classList.remove("dark");
  const clock = fakeEngineClock();
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    const handle = clock.scheduler.register(candidate);
    handle.setVisible(true);
    return handle;
  });
  vi.spyOn(engine.scheduler, "isActive").mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  const palette = characters.CHARACTER_PALETTE_FALLBACK;
  vi.spyOn(characters, "readPalette").mockReturnValue(palette);
  const paint: GroundStroke[] = [], rim: GroundStroke[] = [];
  const ctx = {
    fillStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over",
    clearRect(_x: number, _y: number, w: number) { if (w === width) paint.length = rim.length = 0; },
    save() {}, restore() { this.globalAlpha = 1; this.globalCompositeOperation = "source-over"; },
    translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
    fillRect(x: number, y: number, w: number, h: number) {
      const stroke = { x, y, w, h, colour: this.fillStyle, alpha: this.globalAlpha };
      if (this.globalCompositeOperation === "destination-over") paint.push(stroke);
      else if (this.globalAlpha < 1 && this.fillStyle === "#ffd996") rim.push(stroke);
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const view = render(<PartyStrip {...wanderer} mode={mode} mood={mood} />);
  const setMode = (next: typeof mode) => view.rerender(<PartyStrip {...wanderer} mode={next} mood={mood} />);
  const button = screen.getByRole("button", { name: /Wren, Wanderer/ });
  Object.defineProperty(button, "animate", { value: () => ({ finished: new Promise(() => {}), playState: "running", finish() {}, cancel() {} }) });
  const position = () => button.style.transform.match(/-?\d+(?=px)/g)!.map(Number);
  const shadow = () => paint.filter(pixel => pixel.colour === palette.ink);
  return { ...clock, button, position, paint, rim, shadow, setMode };
}

const shadowBounds = (pixels: GroundStroke[]) => {
  expect(pixels.length).toBeGreaterThan(0);
  return {
    left: Math.min(...pixels.map(p => p.x)), right: Math.max(...pixels.map(p => p.x + p.w)),
    top: Math.min(...pixels.map(p => p.y)), bottom: Math.max(...pixels.map(p => p.y + p.h)),
  };
};

it("paints a daytime cast shadow and a faint warm patch, not an extra layer at night", async () => {
  const { paint, shadow, rim } = mountDaylight("calm");
  const shade = shadowBounds(shadow());
  const warmth = paint.filter(pixel => pixel.colour === "#ffd996" && pixel.y >= 58);
  expect(shade.right).toBeGreaterThan(shadowBounds(warmth).right);
  expect(new Set(shadow().map(pixel => pixel.alpha)).size).toBeGreaterThan(1);
  expect(Math.max(...shadow().map(pixel => pixel.alpha))).toBe(0.1);
  expect(Math.max(...warmth.map(pixel => pixel.alpha))).toBe(0.09);
  document.documentElement.classList.add("dark");
  await Promise.resolve();
  expect(paint).toEqual([]);
  expect(rim).toEqual([]);
});

it("lets stepped sunrays approach from the upper left without touching the strip edge", () => {
  const { paint } = mountDaylight("calm");
  const rays = paint.filter(pixel => pixel.colour === "#ffd996" && pixel.y < 40);
  expect(rays.length).toBeGreaterThan(0);
  expect(Math.max(...rays.map(pixel => pixel.alpha))).toBe(0.18);
  expect(Math.min(...rays.map(pixel => pixel.alpha))).toBeLessThan(0.03);
  const centres = rays.filter(pixel => pixel.alpha >= 0.16);
  expect(centres.map(({ x, y }) => [x - centres[0]!.x, y - centres[0]!.y])).toEqual([[0, 0], [2, 2]]);
  expect(rays.every(p => p.x >= 2 && p.y >= 2)).toBe(true);
});

it("lets only the small crown highlight shimmer on Calm's existing draws", () => {
  const { advance, rim, paint } = mountDaylight("calm");
  const ground = [...paint];
  const peaks = new Set<number>();
  for (let i = 0; i < 480; i += 6) {
    const peak = Math.max(...rim.map(pixel => pixel.alpha));
    expect(rim.filter(pixel => pixel.alpha === peak).length).toBeLessThanOrEqual(2);
    expect(rim.filter(pixel => pixel.alpha !== peak).every(pixel => pixel.alpha === 0.24)).toBe(true);
    peaks.add(peak);
    advance(6);
  }
  expect(peaks.size).toBeGreaterThan(1);
  expect(paint).toEqual(ground);
});

it.each([61, 390])("keeps whole cells and zero boundary alpha across the %ipx strip", width => {
  const { advance, paint, shadow, position } = mountDaylight("lively", "working", width);
  let furthest = 0;
  for (let i = 0; i <= 800; i += 4) {
    const shade = shadowBounds(shadow());
    expect(shade.left).toBeGreaterThan(0);
    expect(shade.right).toBeLessThan(width);
    for (const { x, y, w, h } of paint) {
      expect([x % 2, y % 2, w % 2, h % 2]).toEqual([0, 0, 0, 0]);
      expect(x).toBeGreaterThan(0);
      expect(x + w).toBeLessThan(width);
      expect(y).toBeGreaterThan(0);
      expect(y + h).toBeLessThan(70);
    }
    furthest = Math.max(furthest, position()[0]!);
    advance(4);
  }
  expect(furthest).toBeGreaterThanOrEqual(width - 50);
});

it("moves the shadow on a walk and click hop while the sunrays stay at the strip corner", () => {
  const { advance, button, position, paint, shadow, setMode } = mountDaylight("calm", "working");
  const rays = () => paint.filter(pixel => pixel.colour === "#ffd996" && pixel.y < 40);
  const cornerRays = rays();
  expect(cornerRays.length).toBeGreaterThan(0);
  const standing = shadowBounds(shadow());
  setMode("lively");
  advance(50);
  const walking = shadowBounds(shadow());
  const [walkX, restY] = position();
  expect(walkX).toBeGreaterThan(0);
  expect(rays()).toEqual(cornerRays);
  expect(walking.left).toBe(walkX! + standing.left);
  expect(walking.right - walking.left).toBeGreaterThan(standing.right - standing.left);
  fireEvent.click(button);
  const span = (bounds: ReturnType<typeof shadowBounds>) => bounds.right - bounds.left;
  const takeoff = shadowBounds(shadow());
  let peak = takeoff;
  let highest = restY!;
  const offsets = new Set<number>();
  for (let i = 0; i < 52; i++) {
    advance(1);
    const [x, y] = position();
    expect(rays()).toEqual(cornerRays);
    if (y! < restY!) offsets.add(shadowBounds(shadow()).left - x!);
    if (y! < highest) { highest = y!; peak = shadowBounds(shadow()); }
  }
  expect(highest).toBeLessThan(restY!);
  expect(offsets.size).toBeGreaterThan(1);
  expect(span(peak)).toBeLessThan(span(takeoff));
  expect(peak.bottom).toBeLessThanOrEqual(takeoff.bottom);
  expect(position()[1]).toBe(restY);
  expect(span(shadowBounds(shadow()))).toBe(span(takeoff));
});

it.each(["off", "reduced"] as const)("holds the daylight shadow steady on click with motion %s", setting => {
  const { scheduler, advance, button, position, paint, rim } = mountDaylight(setting === "off" ? "off" : "lively", "working");
  if (setting === "reduced") {
    vi.spyOn(motion, "getReduced").mockReturnValue(true);
    scheduler.setEnvironment({ hidden: false, reduced: true });
  }
  expect(paint.length).toBeGreaterThan(0);
  const before = { position: position(), paint: [...paint], brightness: Math.max(...rim.map(pixel => pixel.alpha)), wakes: scheduler.snapshot().timerWakes };
  fireEvent.click(button);
  advance(120);
  expect({ position: position(), paint, brightness: Math.max(...rim.map(pixel => pixel.alpha)), wakes: scheduler.snapshot().timerWakes }).toEqual(before);
});

it("follows the Wanderer's lantern swing on a Calm click, then returns to sparse idle draws", () => {
  const clock = mountWithClock("calm", true);
  const play = vi.spyOn(Actor.prototype, "playCue");
  try {
    const button = screen.getByRole("button", { name: /Wren, Wanderer/ });
    Object.defineProperty(button, "animate", { value: () => ({ finished: new Promise(() => {}), playState: "running", finish() {}, cancel() {} }) });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(play.mock.calls.map(([cue]) => cue)).toEqual(["hop", "tip", "signature"]);
    clock.source.mockClear();
    clock.paint.mockClear();
    clock.advance(55);
    const anchors = clock.source.mock.calls.flatMap(([, anchor]) => anchor ? [anchor] : []);
    expect(new Set(anchors.map(anchor => roundToLightCell(anchor.x))).size).toBeGreaterThan(1);
    expect(clock.paint.mock.calls.length).toBeGreaterThan(1);
    clock.advance(180);
    const count = clock.scheduler.snapshot().timerWakes;
    const rest = button.style.transform;
    clock.advance(600);
    expect(clock.scheduler.snapshot().timerWakes - count).toBeLessThan(20);
    expect(button.style.transform).toBe(rest);
  } finally { clock.dispose(); }
});
