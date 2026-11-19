import { MOODS, type ArtFrame, type Mood } from "../art";
import type { Handwork } from "./traits";

type Pose = {
  lift: number;
  glance: -1 | 0 | 1;
  blink: boolean;
  seated: boolean;
  slump: boolean;
  glow: boolean;
  stride: number;
  gesture: Handwork | "wave" | "work" | null;
  beat: boolean;
};

const upright: Pose = { lift: 0, glance: 0, blink: false, seated: false, slump: false, glow: false, stride: 0, gesture: null, beat: false };
export type SpritePose = Readonly<Pose>;

function restPose(mood: Mood): Pose {
  return {
    ...upright,
    glance: mood === "waiting" ? -1 : mood === "working" || mood === "blocked" || mood === "error" ? 1 : 0,
    seated: mood === "resting",
    slump: mood === "blocked" || mood === "error",
    glow: mood === "verified",
  };
}

const cues = {
  tap: [{ gesture: "work" }, { gesture: "work", beat: true, glance: 1 }],
  notice: [{ glance: -1 }, { glance: -1, lift: 1, beat: true }],
  wave: [{ gesture: "wave" }, { gesture: "wave", beat: true }],
  flourish: [{ glow: true, gesture: "wave" }, { glow: true, lift: 1, gesture: "wave", beat: true }],
  drop: [{ slump: true, glance: 1 }, { slump: true, glance: 1, blink: true }],
  blink: [{ blink: true }, { blink: true }],
  hop: [{ stride: -1 }, { lift: 2, stride: 1 }],
} as const satisfies Record<string, readonly [Partial<Pose>, Partial<Pose>]>;

export function poseBook(handwork: (mood: Mood) => Handwork, blinkOffset: number) {
  const poses: SpritePose[] = [];
  const indices = new Map<string, number>();
  const add = (pose: Pose) => {
    const key = JSON.stringify(pose);
    const cached = indices.get(key);
    if (cached !== undefined) return cached;
    const index = poses.push(pose) - 1;
    indices.set(key, index);
    return index;
  };
  const byMood = Object.fromEntries(MOODS.map(mood => {
    const base = restPose(mood);
    const rest = add(base);
    const blink = base.seated || base.slump ? rest : add({ ...base, blink: true });
    const breath = base.seated || base.slump ? rest : add({ ...base, lift: 1 });
    const gesture = handwork(mood);
    const reads = gesture === "map" || gesture === "scroll" || gesture === "ledger";
    const quiet = { ...base, gesture, glance: reads && base.glance !== -1 ? 1 as const : base.glance };
    const calm = add(quiet);
    const turn = base.slump || (base.seated && gesture !== "lantern") ? calm : add({ ...quiet, beat: true });
    return [mood, { rest, blink, breath, calm, turn }];
  })) as Record<Mood, { rest: number; blink: number; breath: number; calm: number; turn: number }>;
  const walk = [-1, 0, 1, 2].map(stride => add({ ...upright, lift: stride === 0 || stride === 2 ? 1 : 0, stride }));
  const byCue = Object.fromEntries(Object.entries(cues).map(([cue, [start, peak]]) => [cue, [
    add({ ...upright, ...start }), add({ ...upright, ...peak }),
  ]])) as Record<keyof typeof cues, number[]>;
  const seatedBlink = add({ ...restPose("resting"), blink: true });

  return { poses, index(frame: ArtFrame) {
    const mood = byMood[frame.mood];
    if (frame.still) return mood.rest;
    if (frame.activity === "quiet") return (frame.t + blinkOffset) % 3200 < 1600 ? mood.calm : mood.turn;
    if (frame.activity === "walk") return walk[frame.step & 3]!;
    if (frame.activity === "cue" && frame.cue) {
      if (frame.progress < 0.12 || frame.progress > 0.88) return mood.rest;
      if (frame.mood === "resting") return frame.cue === "blink" ? seatedBlink : mood.rest;
      return byCue[frame.cue][frame.progress >= 0.33 && frame.progress <= 0.67 ? 1 : 0]!;
    }
    if ((frame.t + blinkOffset) % 5200 < 120) return mood.blink;
    return (frame.t + blinkOffset) % 4200 < 580 ? mood.breath : mood.rest;
  } };
}
