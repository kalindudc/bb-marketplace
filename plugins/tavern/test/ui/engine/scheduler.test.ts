import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../../../src/ui/engine/scheduler";
import type { EngineWorld } from "../../../src/ui/engine/scheduler";

function setup() {
  let time = 0, work = 0;
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
  const scheduler = new Scheduler({ now: () => time + work, requestFrame, cancelFrame: id => { frames.delete(id); } });
  const advance = (n: number) => {
    for (let i = 0; i < n; i++) {
      time += 1000 / 60;
      work = 0;
      for (const [id, cb] of [...frames]) { frames.delete(id); cb(time); }
    }
  };
  const world = () => ({
    mode: (): ReturnType<EngineWorld["mode"]> => "lively",
    update: vi.fn(), draw: vi.fn(),
  });
  return { scheduler, advance, world, frames, requestFrame, cost: (ms: number) => { work += ms; } };
}

describe("the engine scheduler", () => {
  it("steps two worlds on one frame loop and separates physics from the draw rate", () => {
    const { scheduler, advance, world, frames, requestFrame } = setup();
    const a = world(), b = world();
    const first = scheduler.register(a), second = scheduler.register(b);
    first.setVisible(true); second.setVisible(true);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    advance(60);
    expect(frames.size).toBe(1);
    expect(a.update.mock.calls).toEqual(b.update.mock.calls);
    expect(a.update).toHaveBeenCalledTimes(59);
    expect(a.update).toHaveBeenCalledWith(1 / 60);
    expect(a.draw.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(a.draw.mock.calls.length).toBeLessThanOrEqual(14);
    expect(scheduler.snapshot()).toMatchObject({ worlds: 2, frames: 60, running: true, budgetLevel: 0 });
    first.remove(); second.remove();
    expect(frames.size).toBe(0);
  });

  it("stops when hidden, off-screen, reduced, or off, and resumes without catch-up", () => {
    const { scheduler, advance, world, frames } = setup();
    const a = world();
    let off = false;
    const handle = scheduler.register({ ...a, mode: () => off ? "off" : "calm" });
    expect(frames.size).toBe(0);
    handle.setVisible(true);
    advance(5);
    scheduler.setEnvironment({ hidden: true, reduced: false });
    expect(frames.size).toBe(0);
    advance(100);
    scheduler.setEnvironment({ hidden: false, reduced: false });
    const before = a.update.mock.calls.length;
    advance(2);
    expect(a.update.mock.calls.length - before).toBe(1);
    scheduler.setEnvironment({ hidden: false, reduced: true });
    expect(a.draw).toHaveBeenLastCalledWith(true);
    expect(frames.size).toBe(0);
    const count = a.draw.mock.calls.length;
    advance(100);
    expect(a.draw).toHaveBeenCalledTimes(count);
    scheduler.setEnvironment({ hidden: false, reduced: false });
    expect(frames.size).toBe(1);
    off = true; handle.invalidate();
    expect(a.draw).toHaveBeenLastCalledWith(true);
    expect(frames.size).toBe(0);
    off = false; handle.invalidate();
    expect(frames.size).toBe(1);
    handle.setVisible(false);
    expect(frames.size).toBe(0);
    handle.setVisible(true);
    expect(frames.size).toBe(1);
  });

  it("steps down twice under sustained cost and counts update and draw separately", () => {
    const { scheduler, advance, cost } = setup();
    const update = vi.fn(() => cost(1));
    const draw = vi.fn(() => cost(20));
    scheduler.register({ mode: () => "lively", update, draw }).setVisible(true);
    advance(90);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 0, frames: 90 });
    advance(30);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 1, updateHz: 30 });
    advance(120);
    const read = scheduler.snapshot();
    expect(read).toMatchObject({ budgetLevel: 2, updateHz: 15, worstUpdateMs: 1, worstDrawMs: 20 });
    expect(read.averageUpdateMs + read.averageDrawMs).toBeGreaterThan(2);
    expect(update).toHaveBeenLastCalledWith(1 / 30);
    advance(60);
    expect(update).toHaveBeenLastCalledWith(1 / 15);
  });
});
