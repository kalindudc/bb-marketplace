import { describe, expect, it, vi } from "vitest";
import { fakeEngineClock as setup } from "./fake-clock";

describe("the engine scheduler", () => {
  it("shares one timer and frame between worlds and separates physics from the draw rate", () => {
    const { scheduler, advance, world, timers, frames, requestFrame } = setup();
    const a = world(), b = world();
    const first = scheduler.register(a), second = scheduler.register(b);
    first.setVisible(true); second.setVisible(true);
    expect(timers.size).toBe(1);
    expect(requestFrame).not.toHaveBeenCalled();
    advance(60);
    expect(a.update.mock.calls).toEqual(b.update.mock.calls);
    expect(a.update).toHaveBeenCalledTimes(12);
    expect(a.update).toHaveBeenCalledWith(1 / 60, 5);
    expect(a.draw).toHaveBeenCalledTimes(13);
    expect(scheduler.snapshot()).toMatchObject({ worlds: 2, frames: 12, running: true, budgetLevel: 0 });
    first.remove(); second.remove();
    expect(timers.size + frames.size).toBe(0);
  });

  it("stops at rest and waits for the earliest invalidation across worlds", () => {
    const { scheduler, advance, world, requestFrame } = setup();
    let next: number | null = null;
    const a = world(), b = world();
    const first = scheduler.register({ ...a, nextDraw: () => next });
    const second = scheduler.register({ ...b, nextDraw: () => next === null ? null : 1000 });
    first.setVisible(true); second.setVisible(true);
    advance(300);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(scheduler.snapshot().running).toBe(false);
    next = 500;
    second.invalidate(); first.invalidate();
    advance(30);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(a.draw).toHaveBeenCalledTimes(3);
    expect(b.draw).toHaveBeenCalledTimes(2);
    next = null;
    first.invalidate(); second.invalidate();
    advance(300);
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it("stops when hidden, off-screen, reduced or off, and resumes without catch-up", () => {
    const { scheduler, advance, world, frames, timers } = setup();
    const a = world();
    let off = false;
    const handle = scheduler.register({ ...a, mode: () => off ? "off" : "calm" });
    expect(frames.size + timers.size).toBe(0);
    handle.setVisible(true);
    advance(5);
    scheduler.setEnvironment({ hidden: true, reduced: false });
    expect(frames.size + timers.size).toBe(0);
    advance(100);
    scheduler.setEnvironment({ hidden: false, reduced: false });
    const before = a.update.mock.calls.length;
    advance(5);
    expect(a.update.mock.calls.length - before).toBe(1);
    expect(a.update).toHaveBeenLastCalledWith(1 / 60, 5);
    scheduler.setEnvironment({ hidden: false, reduced: true });
    expect(a.draw).toHaveBeenLastCalledWith(true);
    expect(frames.size + timers.size).toBe(0);
    const count = a.draw.mock.calls.length;
    advance(100);
    expect(a.draw).toHaveBeenCalledTimes(count);
    scheduler.setEnvironment({ hidden: false, reduced: false });
    expect(timers.size).toBe(1);
    off = true; handle.invalidate();
    expect(a.draw).toHaveBeenLastCalledWith(true);
    expect(frames.size + timers.size).toBe(0);
    off = false; handle.invalidate();
    expect(timers.size).toBe(1);
    handle.setVisible(false);
    expect(frames.size + timers.size).toBe(0);
    handle.setVisible(true);
    expect(timers.size).toBe(1);
  });

  it("keeps the full draw rate when 12 Hz wakes cost more than 2 ms each but stay under the elapsed budget", () => {
    const { scheduler, advance, world, cost } = setup();
    let work = 1.5;
    scheduler.register({ ...world(), draw: () => cost(work) }).setVisible(true);
    advance(240);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 0, frames: 48 });
    work = 5;
    advance(240);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 0, frames: 96 });
  });

  it("reduces expensive draws rather than physics steps, then recovers under half budget", () => {
    const { scheduler, advance, world, cost } = setup();
    let drawCost = 9;
    const update = vi.fn((_dt: number) => cost(1));
    scheduler.register({ ...world(), update, draw: () => cost(drawCost) }).setVisible(true);
    advance(120);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 1, updateHz: 60, drawHz: 8, worstUpdateMs: 1, worstDrawMs: 9 });
    const degradedAt = scheduler.snapshot().frames;
    advance(120);
    expect(scheduler.snapshot().frames - degradedAt).toBe(16);
    expect(scheduler.snapshot().budgetLevel).toBe(1);
    drawCost = 19;
    advance(120);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 2, updateHz: 60, drawHz: 6 });
    expect(update.mock.calls.every(([dt]) => dt === 1 / 60)).toBe(true);
    drawCost = 0.5;
    advance(120);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 1, drawHz: 8 });
    advance(120);
    expect(scheduler.snapshot()).toMatchObject({ budgetLevel: 0, drawHz: 12 });
  });
});
