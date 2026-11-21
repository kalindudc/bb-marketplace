import { CUE_MS, MOODS, type ArtFrame, type Mood, type Signature } from "../art";
import { idlePulse, variation } from "../rhythm";
import { isAttentionMood } from "../rules";
import type { Handwork } from "./traits";

const GAZES = [undefined, "forward", "back", "up"] as const;

type Pose = {
  lift: number;
  breath: "full" | "small" | null;
  glance: -1 | 0 | 1;
  gaze?: (typeof GAZES)[number];
  face: "calm" | "frown" | "pleased" | "delighted";
  blink: boolean;
  seated: boolean;
  slump: boolean;
  glow: boolean;
  raised: boolean;
  stride: number;
  gait?: { near: number; far: number; nearUp: boolean; farUp: boolean; shoulders: number; head: number; arm: number };
  dip?: number;
  gesture: Handwork | "wave" | "work" | "tip" | null;
  action: Signature | null;
  accent: "peak" | "finish" | null;
  beat: boolean;
};

const upright: Pose = { lift: 0, breath: null, glance: 0, face: "calm", blink: false, seated: false, slump: false, glow: false, raised: false, stride: 0, gesture: null, action: null, accent: null, beat: false };
export type SpritePose = Readonly<Pose>;

function restPose(mood: Mood): Pose {
  return {
    ...upright,
    glance: mood === "waiting" ? -1 : mood === "working" || mood === "blocked" || mood === "error" ? 1 : 0,
    face: mood === "verified" ? "pleased" : mood === "blocked" ? "frown" : "calm",
    seated: mood === "resting",
    slump: mood === "blocked" || mood === "error",
    glow: mood === "verified",
    raised: mood === "verified",
    gesture: mood === "reported" ? "scroll" : null,
  };
}

const cues = {
  tap: [{ gesture: "work" }, { gesture: "work", beat: true, glance: 1 }],
  notice: [{ glance: -1 }, { glance: -1, lift: 1, beat: true }],
  wave: [{ gesture: "wave" }, { gesture: "wave", beat: true }],
  flourish: [{ glow: true, face: "pleased", gesture: "wave" }, { glow: true, face: "delighted", lift: 1, gesture: "wave", beat: true }],
  drop: [{ slump: true, glance: 1 }, { slump: true, glance: 1, blink: true }],
  blink: [{ blink: true }, { blink: true }],
} as const satisfies Record<string, readonly [Partial<Pose>, Partial<Pose>]>;

export function smallIdle(frame: ArtFrame) {
  return !!frame.small || isAttentionMood(frame.mood);
}

const STEP_REACH = [2, 1, 0, -1, -2, -1, 0, 1];
const ARM_SWING = [0, 0, 1, 0, 0, 0, -1, 0];

function gaitPose(step: number): NonNullable<Pose["gait"]> {
  const opposite = (step + 4) & 7;
  const footfall = step & 3;
  return {
    far: STEP_REACH[step]!, near: STEP_REACH[opposite]!,
    farUp: step >= 5, nearUp: opposite >= 5,
    shoulders: Number(footfall === 0),
    head: Number(footfall === 1),
    arm: ARM_SWING[step]!,
  };
}

export function poseBook(handwork: (mood: Mood) => Handwork, seed: number, signature: Signature = "nod") {
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
    const smallBase = { ...base, blink: base.seated };
    const rest = add(smallBase);
    const small = add({ ...smallBase, breath: "small" });
    const gesture = base.gesture ?? (mood === "working" || mood === "resting" ? handwork(mood) :
      signature === "quill" ? "ledger" : signature === "spyglass" ? "spyglass" : null);
    const glance = base.glance === 0 ? 1 : 0;
    const idle = GAZES.map(gaze => Array.from({ length: 4 }, (_, variant) => add({
      ...base, gesture, breath: variant & 1 ? "full" : null,
      blink: Boolean(variant & 2), gaze, action: gaze ? signature : null,
    })));
    const work = handwork(mood);
    const reads = work === "map" || work === "scroll" || work === "ledger";
    const quiet = Array.from({ length: 4 }, (_, variant) => add({
      ...smallBase, gesture: work, glance: reads && base.glance !== -1 ? 1 : base.glance,
      breath: variant & 1 ? "full" : null,
      beat: Boolean(variant & 2) && !base.slump && (!base.seated || work === "lantern"),
    }));
    const crouch = add({ ...base, stride: -1, breath: isAttentionMood(mood) ? null : "full" });
    const hop = [crouch, add({ ...base, stride: 1 })];
    const tip = [add({ ...base, gesture: "tip" }), add({ ...base, gesture: "tip", accent: "peak", dip: 1 }), add({ ...base, dip: 1 })];
    const own = [
      add({ ...base, action: signature }),
      add({ ...base, action: signature, accent: "peak", glance }),
      add({ ...base, action: signature, accent: "finish", glance }),
    ];
    return [mood, { rest, small, idle, quiet, hop, tip, signature: own }];
  })) as Record<Mood, { rest: number; small: number; idle: number[][] } & Record<"quiet" | "hop" | "tip" | "signature", number[]>>;
  const gait = STEP_REACH.map((_, step) => gaitPose(step));
  const walk = GAZES.map(gaze => [false, true].map(blink => gait.map(step => add({ ...upright, gait: step, gaze, blink }))));
  const byCue = Object.fromEntries(Object.entries(cues).map(([cue, [start, peak]]) => [cue, [
    add({ ...upright, ...start }), add({ ...upright, ...peak }),
  ]])) as Record<keyof typeof cues, number[]>;
  const waitingBlink = add({ ...restPose("resting"), blink: true });
  function at(frame: ArtFrame): { index: number; next: number | null; ember?: boolean } {
    const mood = byMood[frame.mood];
    if (frame.still) return { index: mood.rest, next: null };
    const pace = frame.motionSeed ?? seed;
    const small = smallIdle(frame);
    if (frame.activity === "walk" && !small) {
      const blink = idlePulse(frame.t, pace ^ 0x52a1e829, 5600, 3500, 120);
      const look = idlePulse(frame.t, pace ^ 0x3b4eb56d, 2250, 700, 600);
      const direction = look.on ? variation(pace, look.window) : 0;
      const gaze = look.on ? direction < 0.50 ? 1 : direction < 0.75 ? 2 : 3 : 0;
      return { index: walk[gaze]![Number(blink.on)]![frame.step & 7]!, next: null };
    }
    if (frame.activity === "cue" && frame.cue) {
      const progress = frame.progress;
      const cue = frame.cue;
      if (cue === "hop") {
        const end = progress < 0.10 ? 0.10 : progress < 0.43 ? 0.43 : progress < 0.58 ? 0.58 : 1;
        const index = progress >= 0.58 ? mood.rest : mood.hop[Number(progress >= 0.10 && progress < 0.43)]!;
        return { index, next: (end - progress) * CUE_MS.hop };
      }
      const deliberate = cue === "tip" || cue === "signature";
      const lift = deliberate ? 0.30 : 0.33;
      const lower = deliberate ? 0.72 : 0.67;
      const end = progress < 0.12 ? 0.12 : progress < lift ? lift : progress < lower ? lower : progress < 0.88 ? 0.88 : 1;
      let index = mood.rest;
      if (progress >= 0.12 && progress < 0.88) {
        const peak = Number(progress >= lift && progress < lower);
        if (cue === "signature" || cue === "tip") index = mood[cue][progress >= lower ? 2 : peak]!;
        else if (frame.mood !== "resting") index = byCue[cue][peak]!;
        else if (cue === "blink") index = waitingBlink;
      }
      return { index, next: (end - progress) * CUE_MS[frame.cue] };
    }
    if (small) {
      const breath = idlePulse(frame.t, pace, 9000, 2100, 850);
      return { index: breath.on ? mood.small : mood.rest, next: breath.next };
    }
    const breath = idlePulse(frame.t, pace, 4000, 1700, 680);
    if (frame.activity === "quiet") {
      const turn = idlePulse(frame.t, pace ^ 0xf627ab45, 5600, 2100, 850);
      return { index: mood.quiet[Number(breath.on) + 2 * Number(turn.on)]!, next: Math.min(breath.next, turn.next) };
    }
    const blink = idlePulse(frame.t, pace ^ 0x52a1e829, 5600, 3500, 120);
    const beat = idlePulse(frame.t, pace ^ 0x01d2f3b5, 14000, 7000, 720);
    const next = Math.min(blink.next, beat.next, breath.next);
    const gaze = beat.on ? 1 + Math.floor(3 * variation(pace, beat.window)) : 0;
    return { index: mood.idle[gaze]![Number(breath.on) + 2 * Number(blink.on)]!, next, ember: breath.on };
  }
  return { poses, at, index: (frame: ArtFrame) => at(frame).index };
}
