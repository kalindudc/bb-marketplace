// @vitest-environment node
import { expect, it } from "vitest";
import { Actor } from "../../../src/ui/engine/actor";
import { createArt } from "../../../src/ui/engine/sprites";
import { actor as paintBody } from "../../../src/ui/engine/sprites/parts";
import { poseBook } from "../../../src/ui/engine/sprites/poses";
import { seedTraits } from "../../../src/ui/engine/sprites/traits";

const input = { seed: "wren", classId: "wanderer", hue: "teal", charge: null, keeper: false } as const;
const art = createArt(input);
const traits = seedTraits(input);
const poses = poseBook(() => "lantern", traits.blinkOffset, art.signature);
const lively = { mode: "lively", held: false, typing: false } as const;
const calm = { ...lively, mode: "calm" } as const;
const dt = 1 / 60;

function walk(id: string, batch = 5) {
  const actor = new Actor(id, art, "working");
  return Array.from({ length: 84 }, () => {
    for (let n = 0; n < 5; n += batch) actor.update(dt, 640, lively, batch);
    return { frame: actor.frame(false), x: actor.body.x, lift: actor.body.lift };
  });
}

it("moves a tall-hatted head after the torso has started to dip, with no canvas lift", () => {
  const samples = walk("wren").slice(8, 40);
  expect(new Set(samples.map(({ lift }) => lift))).toEqual(new Set([0]));
  const gait = samples.map(({ frame }) => {
    const pose = poses.poses[poses.index(frame)]!;
    return { chin: paintBody(traits, pose, null).chin, anchor: art.lightAnchor({ ...frame, swing: 0 })!.y };
  });
  expect(new Set(gait.map(p => p.chin)).size).toBeGreaterThan(1);
  expect(gait.some((p, i) => i > 0 && p.anchor !== gait[i - 1]!.anchor && p.chin === gait[i - 1]!.chin)).toBe(true);
});

it("varies gait phase or period, travel and consecutive cycles without depending on update batching", () => {
  const first = walk("member-a");
  const other = walk("member-b");
  expect(first).toEqual(walk("member-a", 1));
  expect(first.map(p => p.frame.step)).not.toEqual(other.map(p => p.frame.step));
  expect(first.map(p => p.x)).not.toEqual(other.map(p => p.x));
  const cadence = first.slice(8).filter((p, i, frames) => p.frame.step < (frames[i - 1]?.frame.step ?? 0));
  expect(new Set(cadence.slice(1).map((p, i) => p.x - cadence[i]!.x)).size).toBeGreaterThan(2);
});

it("keeps the walk's torso and head motion under round one's two-pixel dip", () => {
  const steps = walk("member-a").slice(8);
  const gaits = steps.map(({ frame }) => poses.poses[poses.index(frame)]!.gait!);
  expect(Math.max(...gaits.map(p => p.shoulders))).toBe(1);
  expect(Math.max(...gaits.map(p => p.head))).toBe(1);
  expect(gaits.filter(p => p.arm === 0).length).toBeGreaterThan(gaits.length / 2);
  expect(Math.max(...steps.map(({ frame }) => Math.abs(frame.swing)))).toBeLessThan(0.48);
});

it("keeps Calm hops smaller than Lively hops", () => {
  const peak = (rules: typeof calm | typeof lively) => {
    const actor = new Actor("wren", art, "reported");
    actor.playCue("hop", false, rules);
    return Math.max(...Array.from({ length: 40 }, () => {
      actor.update(dt, 640, rules);
      return actor.body.lift;
    }));
  };
  expect(peak(calm)).toBeGreaterThan(0);
  expect(peak(calm)).toBeLessThan(peak(lively));
});

it("keeps the tall-hatted head connected to the torso as an idle breath rises and falls", () => {
  const actor = new Actor("wren", art, "idle");
  const headAndTorso = (t: number) => {
    const pose = poses.poses[poses.index({ ...actor.frame(false), t })]!;
    const result = paintBody(traits, pose, null);
    return { chin: result.chin, anchor: result.anchor!.y };
  };
  const samples = Array.from({ length: 500 }, (_, i) => headAndTorso(i * 16));
  expect(samples.some((p, i) => i > 0 && p.chin - samples[i - 1]!.chin === p.anchor - samples[i - 1]!.anchor && p.chin !== samples[i - 1]!.chin)).toBe(true);
});

it("seeds irregular blink gaps by member and still blinks while walking", () => {
  function blinks(id: string) {
    const frame = new Actor(id, art, "idle").frame(false);
    const events: number[] = [];
    let prior = false;
    for (let t = 0; t < 120_000; t++) {
      const current = poses.poses[poses.index({ ...frame, t })]!.blink;
      if (current && !prior) events.push(t);
      prior = current;
    }
    return events;
  }
  const first = blinks("member-a");
  expect(first).toEqual(blinks("member-a"));
  expect(first).not.toEqual(blinks("member-b"));
  expect(first.length).toBeGreaterThan(4);
  expect(new Set(first.slice(2).map((at, i) => at - first[i + 1]!)).size).toBeGreaterThan(2);
  expect(walk("member-a").some(({ frame }) => poses.poses[poses.index(frame)]!.blink)).toBe(true);
});

function gazeTrace(id: string, mode: typeof lively | typeof calm = lively, seconds = 6) {
  const actor = new Actor(id, art, "working");
  return Array.from({ length: seconds * 60 }, () => {
    actor.update(dt, 640, mode);
    const frame = actor.frame(false);
    const pose = poses.poses[poses.index(frame)]!;
    if (!pose.gaze) return null;
    const { runs } = paintBody(traits, pose, null);
    const neutral = paintBody(traits, { ...pose, gaze: undefined }, null);
    return { gaze: pose.gaze, visible: runs.join() !== neutral.runs.join() };
  });
}

function glanceEvents(trace: ReturnType<typeof gazeTrace>) {
  type Direction = NonNullable<(typeof trace)[number]>["gaze"];
  const events: { start: number; end: number; direction: Direction }[] = [];
  trace.forEach((glance, i) => {
    if (glance && !trace[i - 1]) events.push({ start: i, end: i, direction: glance.gaze });
    if (glance) events[events.length - 1]!.end = i + 1;
  });
  return events;
}

it("holds visible seeded glances during a walk, with space between them", () => {
  const first = gazeTrace("member-a");
  const events = glanceEvents(first);
  const complete = events.filter(e => e.start > 0 && e.end < first.length);
  expect(complete.length).toBeGreaterThanOrEqual(2);
  expect(complete.every(e => e.end - e.start >= 24)).toBe(true);
  expect(events.slice(1).every((e, i) => e.start - events[i]!.end >= 48)).toBe(true);
  expect(first.some(g => g?.visible)).toBe(true);
  expect(events.map(e => e.start)).not.toEqual(glanceEvents(gazeTrace("member-b")).map(e => e.start));
  expect(first).toEqual(gazeTrace("member-a"));
});

it("makes sparse, visible and varied glances while standing between moves", () => {
  const first = gazeTrace("member-a", calm, 45);
  const other = gazeTrace("member-b", calm, 45);
  const events = glanceEvents(first);
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.length).toBeLessThanOrEqual(4);
  expect(new Set([...events, ...glanceEvents(other)].map(e => e.direction)).size).toBeGreaterThan(1);
  expect(first.some(g => g?.visible)).toBe(true);
  expect(events.map(e => e.start)).not.toEqual(glanceEvents(other).map(e => e.start));
  expect(events.map(e => e.start)).toEqual(glanceEvents(gazeTrace("member-a", calm, 45)).map(e => e.start));
});

it("does not glance beside an ask or in a still frame", () => {
  const actor = new Actor("member-a", art, "working");
  for (let i = 0; i < 180; i++) {
    actor.update(dt, 640, { ...lively, held: true }, 15);
    const held = poses.poses[poses.index(actor.frame(false))]!;
    const still = poses.poses[poses.index(actor.frame(true))]!;
    expect(held.gaze).toBeUndefined();
    expect(still.gaze).toBeUndefined();
  }
});

it("swings the lantern while travelling, then shows a damped tail without travelling or waking for invisible swing", () => {
  const actor = new Actor("wren", art, "working");
  const swing = () => art.lightAnchor({ ...actor.frame(false), t: 0 })!.x;
  const moving = Array.from({ length: 48 }, () => {
    actor.update(dt, 640, lively, 5);
    return swing();
  });
  expect(new Set(moving.slice(12)).size).toBeGreaterThan(1);
  for (let i = 0; i < 60 && Math.abs(actor.body.swing) < 0.32; i++) actor.update(dt, 640, lively);
  expect(Math.abs(actor.body.swing)).toBeGreaterThanOrEqual(0.32);
  const x = actor.body.x;
  actor.update(dt, 640, calm);
  expect(actor.nextDraw(640)).toBe(0);
  const tail = Array.from({ length: 40 }, () => {
    actor.update(dt, 640, calm, 5);
    return swing();
  });
  expect(actor.body.x).toBe(x);
  expect(new Set(tail).size).toBeGreaterThan(1);
  expect(new Set(tail.slice(-10)).size).toBe(1);
  expect(actor.nextDraw(640)).toBeGreaterThan(0);
});
