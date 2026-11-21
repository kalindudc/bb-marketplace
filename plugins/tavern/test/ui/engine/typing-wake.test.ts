// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Actor } from "../../../src/ui/engine/actor";
import { observeWorld, scheduler } from "../../../src/ui/engine/scheduler";
import { createArt } from "../../../src/ui/engine/sprites";
import { motion, TYPING_HOLD_MS } from "../../../src/ui/kit/motion";

it.each(["input", "compositionend"])("wakes a seated quiet pose when the %s hold ends, even if the timer reads early", lastEvent => {
  vi.useFakeTimers();
  const start = Date.now();
  let lag = 0;
  vi.spyOn(motion, "now").mockImplementation(() => Date.now() - start - lag);
  const page = document.body.appendChild(document.createElement("div"));
  const field = page.appendChild(document.createElement("input"));
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 48, 64));
  const art = createArt({ seed: "wren", classId: "smith", hue: "teal", charge: null, keeper: false });
  const actor = new Actor("wren", art, "resting");
  const rules = () => ({ mode: "calm" as const, ...motion.getHolds("page") });
  const draw = vi.fn((still: boolean) => actor.frame(still).activity);
  const handle = observeWorld(page, {
    mode: () => "calm", nextDraw: () => actor.nextDraw(0), draw,
    refresh: () => actor.setRules(rules()), update: (dt, steps) => actor.update(dt, 0, rules(), steps),
  });
  try {
    expect(draw).toHaveLastReturnedWith("stand");
    if (lastEvent === "compositionend") {
      field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      vi.advanceTimersByTime(TYPING_HOLD_MS + 20);
      expect(draw).toHaveLastReturnedWith("quiet");
    }
    field.dispatchEvent(new Event(lastEvent, { bubbles: true }));
    expect(draw).toHaveLastReturnedWith("quiet");
    expect(scheduler.snapshot().running).toBe(false);
    lag = 1.25;
    vi.advanceTimersByTime(TYPING_HOLD_MS + 1);
    expect(draw).toHaveLastReturnedWith("quiet");
    draw.mockClear();
    vi.advanceTimersByTime(3);
    expect(draw).toHaveLastReturnedWith("stand");
    expect(draw).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().running).toBe(true);
  } finally {
    handle.remove(); page.remove(); motion.reset(); vi.restoreAllMocks(); vi.useRealTimers();
  }
});
