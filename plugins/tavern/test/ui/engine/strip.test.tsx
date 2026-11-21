import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PartyStrip } from "../../../src/ui/engine/strip";
import * as engine from "../../../src/ui/engine/scheduler";
import * as sprites from "../../../src/ui/engine/sprites";
import { Actor } from "../../../src/ui/engine/actor";
import { roundToLightCell, subscribeStripLantern } from "../../../src/ui/engine/light";
import { watchLantern } from "../../../src/ui/engine/light-overlay";
import type { LightAnchor } from "../../../src/ui/engine/art";
import { fakeEngineClock } from "./fake-clock";
import { motion } from "../../../src/ui/kit/motion";

const character = { id: "wren", avatar: "a-new-roll", name: "Wren", hue: "teal", charge: "chevron", look: { hat: "pointy" } } as const;
const wanderer = { character, classLabel: "Wanderer", classId: "wanderer", mood: "idle", keeper: false, surface: "thread:wren", region: "widget" } as const;

afterEach(() => { cleanup(); motion.reset(); vi.restoreAllMocks(); });

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
  expect(world!.lightAnchors?.()).toEqual([]);
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
  render(<PartyStrip {...{ character, classLabel: "Wanderer", classId: "wanderer", mood: "waiting", keeper: false, surface: "thread:wren", region: "widget", held: true, canClickSpeak: true, onActorClick: speak }} />);
  const button = screen.getByRole("button", { name: /Wren, Wanderer/ });
  Object.defineProperty(button, "animate", { value: () => ({ finished: new Promise(() => {}), playState: "running", finish() {}, cancel() {} }) });
  const mark = screen.getByText("!");
  expect(button.contains(mark)).toBe(false);
  world!.refresh?.(); world!.draw(false);
  const original = [button.style.transform, mark.outerHTML];
  for (let click = 0; click < 6; click++) {
    fireEvent.click(button);
    for (let step = 0; step < 15; step++) {
      world!.update(1 / 60, 1); world!.draw(false);
      expect([button.style.transform, mark.outerHTML]).toEqual(original);
    }
  }
  const cues = play.mock.calls.map(([cue, auto]) => { expect(auto).toBe(false); return cue; });
  expect(cues).toHaveLength(6);
  expect(new Set(cues).size).toBe(3);
  expect(cues.every((cue, i) => i === 0 || cue !== cues[i - 1])).toBe(true);
  expect(speak).not.toHaveBeenCalled();
});

it("follows the walking art but holds the light during an idle, typing, reduced motion, Motion Off and Quiet", () => {
  let world: engine.EngineWorld;
  vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
    world = candidate;
    return { invalidate: change => { change?.(); candidate.refresh?.(); candidate.draw(candidate.mode() === "off"); }, remove() {} };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const art = sprites.createArt({ seed: "wren", classId: "wanderer", hue: "teal", charge: null, keeper: false });
  let x = 4;
  vi.spyOn(sprites, "createArt").mockReturnValue({ ...art, lightAnchor: () => ({ kind: "lantern", x, y: 20 }) });
  let typing = false;
  vi.spyOn(motion, "getHolds").mockImplementation(() => ({ typing, held: false }));
  const listener = vi.fn();
  const unsubscribe = subscribeStripLantern(listener);
  const props = { character, classLabel: "Wanderer", classId: "wanderer", mood: "idle", keeper: false, surface: "thread:wren", region: "widget" } as const;
  try {
    const view = render(<PartyStrip {...props} mode="calm" />);
    const draw = (reduced = false) => { world.refresh?.(); world.update(0.1, 1); world.draw(reduced); };
    x++; draw(); draw(); draw();
    expect(listener).toHaveBeenCalledTimes(1);
    view.rerender(<PartyStrip {...props} mode="lively" />);
    x++; draw(); x++; draw();
    expect(listener).toHaveBeenCalledTimes(3);
    typing = true;
    x++; draw(); draw();
    expect(listener).toHaveBeenCalledTimes(3);
    typing = false;
    draw(true); draw(true);
    expect(listener).toHaveBeenCalledTimes(3);
    view.rerender(<PartyStrip {...props} mode="off" />);
    draw(); draw();
    expect(listener).toHaveBeenCalledTimes(3);
    const react = vi.spyOn(Actor.prototype, "react");
    const speak = vi.fn();
    view.rerender(<PartyStrip {...props} mode="lively" quiet onActorClick={speak} />);
    expect(world!.mode()).toBe("off");
    fireEvent.click(screen.getByRole("button", { name: /Wren, Wanderer/ }));
    expect(react).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: "off" }), true);
    expect(speak).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(4);
    draw(); draw();
    expect(listener).toHaveBeenCalledTimes(4);
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
  const view = render(<div data-app-composer><PartyStrip {...wanderer} mode={mode} /><div data-composer-box><form data-promptbox /></div></div>);
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
  if (mode !== "lively") {
    expect(on.anchors).toHaveLength(1);
    expect(lit).toBe(1);
  } else {
    expect(on.anchors).toEqual(on.rendered.filter((anchor, i, all) => !i || anchor.x !== all[i - 1]!.x || anchor.y !== all[i - 1]!.y));
    expect(lit).toBeGreaterThan(100);
    expect(lit).toBeLessThan(on.draws);
  }
});

it("repaints from the Wanderer's lantern swing on a Calm click, then holds still again", () => {
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
    const count = clock.paint.mock.calls.length;
    clock.advance(600);
    expect(clock.paint).toHaveBeenCalledTimes(count);
  } finally { clock.dispose(); }
});
