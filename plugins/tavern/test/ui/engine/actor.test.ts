// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Actor } from "../../../src/ui/engine/actor";
import type { CharacterArt } from "../../../src/ui/engine/art";
import { createArt } from "../../../src/ui/engine/sprites";
import { walkSpan } from "../../../src/ui/engine/strip";
import { motion } from "../../../src/ui/kit/motion";

const art: CharacterArt = {
  width: 24, height: 28, ground: 24, draw: () => {}, lightAnchor: () => null,
  nextChange: () => null, pixelKey: () => 0, signature: "nod",
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
  expect(a.setMood("waiting")).toBeNull();
  expect(a.setMood("blocked")).toBeNull();
  expect(a.setMood("error")).toBeNull();
  expect(a.setMood("waiting")).toBeNull();
  step(a);
  expect(a.frame(false).activity).toBe("stand");
  expect(a.body.x).toBe(at);
});

it("walks to a waystation, wanders once between turns and comes back", () => {
  const a = actor();
  a.setRoadHome(40, true);
  step(a, clear, 180);
  expect(a.body.x).toBe(40);
  a.setRoadHome(106, false);
  step(a, clear, 60);
  expect(a.body.x).toBeGreaterThan(40);
  expect(a.body.x).toBeLessThan(106);
  step(a, clear, 300);
  expect(a.body.x).toBe(106);
  expect(a.frame(false).activity).toBe("stand");
  a.setMood("idle");
  a.wander(150);
  step(a, clear, 30);
  expect(a.body.x).toBeGreaterThan(106);
  step(a, clear, 220);
  expect(a.body.x).toBe(106);
  expect(a.nextDraw(150)).toBeNull();
});

it("faces the direction of the resize before the next animation step", () => {
  const a = actor();
  step(a);
  const previous = a.body.x;
  const narrow = Math.floor(previous / 2);
  expect(a.body.vx).toBeGreaterThan(0);
  a.setRules(clear, narrow);
  expect(a.body.x).toBeLessThan(previous);
  expect(a.body.x).toBe(narrow);
  expect(a.frame(false).facing).toBe(-1);
  expect(a.body.vx).toBe(0);
  a.update(1 / 60, narrow, clear);
  expect(a.body.vx).toBeLessThan(0);
  expect(a.frame(false).facing).toBe(Math.sign(a.body.vx));
});

it("faces its velocity throughout a seeded walk with repeated resizes", () => {
  const a = actor();
  let seed = 0x63593947;
  let span = 170, resizes = 0, moved = 0;
  for (let n = 0; n < 7200; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (seed % 61 === 0) {
      span = (seed >>> 8) % 170;
      const clipped = a.body.x > span;
      a.setRules(clear, span);
      if (span > 0 && clipped) expect(a.frame(false).facing).toBe(-1);
      expect(a.body.x).toBeLessThanOrEqual(span);
      resizes++;
    }
    a.update(1 / 60, span, clear, 1 + (seed >>> 24) % 5);
    if (a.body.vx !== 0) {
      expect(a.frame(false).facing).toBe(Math.sign(a.body.vx));
      moved++;
    }
  }
  expect(resizes).toBeGreaterThan(80);
  expect(moved).toBeGreaterThan(5000);
});

it("keeps hop facing through a resize and turns inward when walking resumes", () => {
  const a = actor();
  step(a);
  const span = Math.floor(a.body.x / 2);
  a.react("hop", clear, false);
  step(a, clear, 12);
  a.setRules(clear, span);
  for (let n = 0; n < 18 && a.frame(false).activity === "cue"; n++) {
    a.update(1 / 60, span, clear);
    if (a.frame(false).activity === "cue") {
      expect(a.frame(false).facing).toBe(1);
      expect(a.body.x).toBe(span);
      expect(a.body.vx).toBe(0);
    }
  }
  a.update(1 / 60, span, clear, 36);
  expect(a.frame(false).activity).toBe("walk");
  expect(a.body.vx).toBeLessThan(0);
  expect(a.frame(false).facing).toBe(Math.sign(a.body.vx));
});

it("keeps the smaller idle without automatic cues, but accepts deliberate cues", () => {
  const a = actor();
  step(a);
  const at = a.body.x;
  a.playCue("tap", true, clear);
  expect(a.frame(false).cue).toBe("tap");
  const held = { ...clear, held: true };
  step(a, held, 1);
  const frame = a.frame(false);
  expect(frame).toMatchObject({ activity: "stand", cue: null, still: false, small: true, swing: 0, flame: 1 });
  expect(a.body.lift).toBe(0);
  expect(a.playCue("tap", true, held)).toBeNull();
  step(a, held);
  expect(a.frame(false)).toEqual({ ...frame, t: frame.t + 1000 });
  expect(a.body.x).toBe(at);
  for (const cue of ["notice", "hop"] as const) {
    const end = a.playCue(cue, false, held);
    expect(a.frame(false)).toMatchObject({ activity: "cue", still: false, cue });
    expect(a.frame(true)).toMatchObject({ still: true, t: 0, activity: "stand", swing: 0, flame: 1 });
    end?.();
  }
  expect(a.frame(false)).toEqual({ ...frame, t: frame.t + 1000 });
});

it("changes facing but does not start a reaction clock when motion is off or reduced", () => {
  const a = actor();
  const reaction = a.nextReaction();
  expect(a.react(reaction, clear, true)).toBeNull();
  expect(a.lastReaction).toBe(reaction);
  expect(a.nextReaction()).not.toBe(reaction);
  expect(a.frame(true)).toMatchObject({ facing: -1, still: true, t: 0, cue: null });
});

it("clears an automatic cue when an attention mood arrives, without swallowing a direct interaction", () => {
  const a = actor();
  a.playCue("tap", true, clear);
  expect(a.setMood("waiting")).toBeNull();
  expect(a.frame(false)).toMatchObject({ still: false, small: true, cue: null, flame: 1 });
  expect(a.playCue("notice", true, clear)).toBeNull();
  a.playCue("notice", false, clear);
  step(a, clear, 10);
  expect(a.frame(false)).toMatchObject({ still: false, cue: "notice" });
});

it("measures travel within the composer and falls back to the strip", () => {
  expect(walkSpan(300, 600, 48)).toBe(252);
  expect(walkSpan(null, 600, 48)).toBe(552);
  expect(walkSpan(0, 600, 48)).toBe(552);
  expect(walkSpan(600, 300, 48)).toBe(252);
  expect(walkSpan(10, 600, 48)).toBe(0);
});

it("delegates quiet idle names to the generated character's class kit", () => {
  const wanderer = createArt({ seed: "tam", classId: "wanderer", hue: "rose", charge: null, keeper: false });
  const a = new Actor("tam", wanderer, "working");
  expect(a.quietIdle).toBe("tends the lantern");
  a.setMood("idle");
  expect(a.quietIdle).toBe("checks the satchel");
  expect(a.setMood("reported")).toBe("wave");
});
