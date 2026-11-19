// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Actor } from "../../../src/ui/engine/actor";
import type { CharacterArt } from "../../../src/ui/engine/art";
import { legacyArt } from "../../../src/ui/engine/legacy-art";
import { walkSpan } from "../../../src/ui/engine/strip";
import { motion } from "../../../src/ui/kit/motion";

const art: CharacterArt = {
  width: 24, height: 28, ground: 24, draw: () => {}, lightAnchor: () => null,
  quietIdle: mood => ({ working: "reads a scroll", waiting: "tends the lantern", resting: "leans on the tool" })[mood as "working"] ?? "breathes",
};
const clear = { mode: "lively", typing: false, held: false } as const;
const actor = () => new Actor("wren", art, "working");
const step = (a: Actor, rules = clear as Parameters<Actor["update"]>[2], times = 60) => {
  for (let n = 0; n < times; n++) a.update(1 / 60, 150, rules);
};
afterEach(() => { document.body.replaceChildren(); motion.reset(); vi.restoreAllMocks(); });

it("uses a mood-specific quiet idle until composition and the typing hold end", () => {
  let now = 0;
  vi.spyOn(motion, "now").mockImplementation(() => now);
  motion.install();
  const field = document.body.appendChild(document.createElement("input"));
  const a = actor();
  const update = () => step(a, { ...clear, ...motion.getHolds("thread:t1") });
  update();
  expect(a.frame(false).activity).toBe("walk");
  const at = a.body.x;
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  now = 3000;
  update();
  expect(a.frame(false).activity).toBe("quiet");
  expect(a.quietIdle).toBe("reads a scroll");
  expect(a.body.x).toBe(at);
  field.dispatchEvent(new Event("compositionend", { bubbles: true }));
  now += 1999;
  update();
  expect(a.body.x).toBe(at);
  now += 1;
  update();
  expect(a.frame(false).activity).toBe("walk");
  expect(a.body.x).toBeGreaterThan(at);
});

it("never travels in Calm, walks in Lively at work, and stands when waiting", () => {
  const a = actor();
  step(a, { ...clear, mode: "calm" });
  expect(a.frame(false).activity).toBe("stand");
  expect(a.body.x).toBe(0);
  step(a);
  expect(a.body.x).toBeGreaterThan(0);
  const at = a.body.x;
  expect(a.setMood("waiting")).toBe("notice");
  expect(a.setMood("waiting")).toBeNull();
  step(a);
  expect(a.frame(false).activity).toBe("stand");
  expect(a.body.x).toBe(at);
});

it("cuts travel and cues under a held widget row but keeps the quiet idle clock moving", () => {
  const a = actor();
  step(a);
  const at = a.body.x;
  a.playCue("hop", false, clear);
  expect(a.frame(false).cue).toBe("hop");
  const held = { ...clear, held: true };
  step(a, held, 1);
  const frame = a.frame(false);
  expect(frame).toMatchObject({ activity: "quiet", cue: null });
  expect(a.body.lift).toBe(0);
  expect(a.playCue("notice", false, held)).toBeNull();
  step(a, held);
  expect(a.frame(false).t).toBeGreaterThan(frame.t);
  expect(a.body.x).toBe(at);
  expect(a.frame(true)).toMatchObject({ still: true, t: 0, activity: "stand", swing: 0, flame: 1 });
});

it("measures travel within the composer and falls back to the strip", () => {
  expect(walkSpan(300, 600, 48)).toBe(252);
  expect(walkSpan(null, 600, 48)).toBe(552);
  expect(walkSpan(0, 600, 48)).toBe(552);
  expect(walkSpan(600, 300, 48)).toBe(252);
  expect(walkSpan(10, 600, 48)).toBe(0);
});

it("keeps the prototype's quiet idle names in the legacy adapter", () => {
  const legacy = legacyArt({ seed: "wren", classId: "keeper", hue: "teal", charge: null, keeper: true });
  expect([legacy.quietIdle("working"), legacy.quietIdle("waiting"), legacy.quietIdle("resting")]).toEqual([
    "reads a scroll", "tends the lantern", "leans on the tool",
  ]);
});
