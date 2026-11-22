// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Actor } from "../../../src/ui/engine/actor";
import { type ArtFrame } from "../../../src/ui/engine/art";
import { Scheduler } from "../../../src/ui/engine/scheduler";
import { createArt } from "../../../src/ui/engine/sprites";
import { CHARACTER_PALETTE_FALLBACK as palette } from "../../../src/ui/kit/characters";

const FRAME = 1000 / 60;
const DRAW = 1000 / 12;
const makeArt = (classId: string) => createArt({ seed: "wren", classId, hue: "teal", charge: null, keeper: classId === "keeper" });
const rules = { mode: "calm", held: false, typing: false } as const;

function simulate(mood: ArtFrame["mood"], mode = "calm" as "calm" | "lively" | "off", reduced = false, legacy = false, sampleAt?: ReadonlyMap<number, string>, classId = "smith", span = 640) {
  const art = makeArt(classId);
  let now = 0, next = 0, requests = 0, wakes = 0, timerWakes = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; fire: () => void }>();
  const clock = {
    now: () => now,
    requestFrame(cb: FrameRequestCallback) { requests++; callbacks.set(++next, cb); return next; },
    cancelFrame(id: number) { callbacks.delete(id); },
    setTimer(fire: () => void, delay: number) { timers.set(++next, { at: now + delay, fire }); return next; },
    clearTimer(id: number) { timers.delete(id); },
  };
  const scheduler = new Scheduler(clock);
  const actor = new Actor("wren", art, mood);
  const pictures = new Map<number, string>();
  let draws = 0;
  const world = {
    mode: () => mode,
    refresh: () => actor.setRules({ ...rules, mode }, span),
    update(seconds: number, steps = 1) { actor.update(seconds, span, { ...rules, mode }, steps); },
    nextDraw: () => actor.nextDraw(span),
    draw(still: boolean) { draws++; record(still); },
  };
  function record(still: boolean) {
    const pixels: string[] = [];
    const ctx = {
      fillStyle: "", clearRect() {},
      fillRect(...rect: number[]) { pixels.push(`${ctx.fillStyle}:${rect.join(",")}`); },
    };
    art.draw(ctx as unknown as CanvasRenderingContext2D, actor.frame(still), palette);
    pictures.set(Math.round(now / FRAME), `${Math.round(actor.body.x / 2)}:${pixels.join(";")}`);
  }
  if (legacy) {
    now = FRAME;
    world.refresh();
    world.draw(false);
    let accumulator = 0, drawElapsed = 0, last = FRAME;
    for (let frame = 1; frame <= 3600; frame++) {
      now = frame * FRAME;
      requests++; wakes++;
      accumulator += now - last; drawElapsed += now - last; last = now;
      while (accumulator + 1e-6 >= FRAME) { world.update(1 / 60); accumulator = Math.max(0, accumulator - FRAME); }
      if (drawElapsed + 1e-6 >= DRAW) { drawElapsed = Math.max(0, drawElapsed - DRAW) % DRAW; world.draw(false); }
      else if (sampleAt?.has(frame)) record(false);
    }
  } else {
    scheduler.setEnvironment({ hidden: false, reduced });
    const handle = scheduler.register(world);
    now = FRAME;
    handle.setVisible(true);
    for (let frame = 1; frame <= 3600; frame++) {
      const at = frame * FRAME;
      for (const [id, timer] of timers) if (timer.at <= at + 1e-6) {
        now = timer.at;
        timers.delete(id); timerWakes++; timer.fire();
      }
      now = at;
      for (const [id, cb] of [...callbacks]) { callbacks.delete(id); wakes++; cb(at); }
    }
    handle.remove();
  }
  return { requests, wakes, timerWakes, draws, pictures };
}

describe("drawing only when due", () => {
  it.each([["idle", "calm", 120], ["waiting", "calm", 50], ["working", "lively", 722]] as const)(
    "%s in %s requests at most %i frames per simulated minute", (mood, mode, max) => {
      const before = simulate(mood, mode, false, true);
      const after = simulate(mood, mode);
      expect(before).toMatchObject({ requests: 3600, wakes: 3600, draws: 720 });
      expect(after.requests).toBeLessThanOrEqual(max);
      expect(after.wakes).toBeLessThanOrEqual(max);
      expect(after.timerWakes).toBe(after.requests);
      expect(after.draws).toBeGreaterThan(1);
    },
  );

  it.each([["idle", "calm"], ["waiting", "calm"], ["working", "lively"]] as const)(
    "draws the same %s pixels at the same times as the old 60 Hz stepping loop", (mood, mode) => {
      const next = simulate(mood, mode);
      const old = simulate(mood, mode, false, true, next.pictures);
      for (const [at, pixels] of next.pictures) expect(pixels, `frame ${at}`).toBe(old.pictures.get(at));
    },
  );

  it.each(["wanderer", "keeper"])("keeps a Calm %s under 80 wakes per minute and matches every changed pose", classId => {
    const idle = simulate("idle", "calm", false, false, undefined, classId);
    expect(idle.wakes).toBeLessThanOrEqual(80);
    expect(idle.wakes).toBeGreaterThan(40);
    const oldLoop = simulate("idle", "calm", false, true, idle.pictures, classId);
    for (const [at, pixels] of idle.pictures) expect(pixels, `idle frame ${at}`).toBe(oldLoop.pictures.get(at));
    const walk = simulate("working", "lively", false, false, undefined, classId);
    const oldWalk = simulate("working", "lively", false, true, walk.pictures, classId);
    expect(walk.pictures).toEqual(oldWalk.pictures);
  });

  it("keeps drawing the standing idle in Lively when the strip is only as wide as the sprite", () => {
    const narrow = simulate("working", "lively", false, false, undefined, "smith", 0);
    const calm = simulate("working", "calm", false, false, undefined, "smith", 0);
    expect(narrow.wakes).toBeGreaterThan(0);
    expect(new Set(narrow.pictures.values()).size).toBeGreaterThan(1);
    expect(narrow.pictures).toEqual(calm.pictures);
  });

  it.each([["off", false], ["calm", true]] as const)("%s with reduced=%s draws once without requesting frames", (mode, reduced) => {
    expect(simulate("idle", mode, reduced)).toMatchObject({ requests: 0, wakes: 0, timerWakes: 0, draws: 1 });
  });
});
