import { vi } from "vitest";
import { Scheduler, type EngineWorld } from "../../../src/ui/engine/scheduler";

export function fakeEngineClock() {
  let time = 0, work = 0, next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const requestFrame = vi.fn((cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
  const scheduler = new Scheduler({
    now: () => time + work, requestFrame, cancelFrame: id => { frames.delete(id); },
    setTimer: (cb, delay) => { timers.set(++next, { at: time + work + delay, cb }); return next; },
    clearTimer: id => { timers.delete(id); },
  });
  const advance = (n: number) => {
    for (let i = 0; i < n; i++) {
      const frameAt = time + 1000 / 60;
      work = 0;
      for (const [id, { at, cb }] of timers) if (at <= frameAt + 1e-6) {
        time = at;
        timers.delete(id); cb();
      }
      time = frameAt;
      for (const [id, cb] of [...frames]) { frames.delete(id); cb(time); }
    }
  };
  const world = () => ({
    mode: (): ReturnType<EngineWorld["mode"]> => "lively",
    update: vi.fn<(seconds: number, steps: number) => void>(), draw: vi.fn(), nextDraw: () => 0,
  });
  return { scheduler, advance, world, frames, timers, requestFrame, cost: (ms: number) => { work += ms; } };
}
