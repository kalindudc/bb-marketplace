import { CUE_MS, MOODS, type ArtFrame, type Mood, type Signature } from "../art";
import { isAttentionMood } from "../rules";
import type { Handwork } from "./traits";

type Pose = {
  lift: number;
  breath: "full" | "small" | null;
  glance: -1 | 0 | 1;
  face: "calm" | "frown" | "pleased" | "delighted";
  blink: boolean;
  seated: boolean;
  slump: boolean;
  glow: boolean;
  raised: boolean;
  stride: number;
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

function phase(t: number, period: number, offset: number, length: number) {
  const at = (t + offset) % period;
  return at < length ? { on: true, next: length - at } : { on: false, next: period - at };
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
    const full = { ...base, gesture };
    const calm = add(full);
    const blink = add({ ...full, blink: true });
    const breath = add({ ...full, breath: "full" });
    const beat = add({ ...full, action: signature });
    const work = handwork(mood);
    const reads = work === "map" || work === "scroll" || work === "ledger";
    const quiet = { ...smallBase, gesture: work, glance: reads && base.glance !== -1 ? 1 as const : base.glance };
    const stillHands = add(quiet);
    const turn = base.slump || (base.seated && work !== "lantern") ? stillHands : add({ ...quiet, beat: true });
    const hop = [add({ ...base, stride: -1 }), add({ ...base, lift: isAttentionMood(mood) ? 0 : 2, stride: 1 })];
    const tip = [add({ ...base, gesture: "tip" }), add({ ...base, gesture: "tip", accent: "peak" })];
    const own = [
      add({ ...base, action: signature }),
      add({ ...base, action: signature, accent: "peak" }),
      add({ ...base, action: signature, accent: "finish" }),
    ];
    return [mood, { rest, small, calm, blink, breath, beat, stillHands, turn, hop, tip, signature: own }];
  })) as Record<Mood, Record<"rest" | "small" | "calm" | "blink" | "breath" | "beat" | "stillHands" | "turn", number> & Record<"hop" | "tip" | "signature", number[]>>;
  const walk = [-1, 0, 1, 2].map(stride => add({ ...upright, lift: stride === 0 || stride === 2 ? 1 : 0, stride }));
  const byCue = Object.fromEntries(Object.entries(cues).map(([cue, [start, peak]]) => [cue, [
    add({ ...upright, ...start }), add({ ...upright, ...peak }),
  ]])) as Record<keyof typeof cues, number[]>;
  const waitingBlink = add({ ...restPose("resting"), blink: true });
  const blinkPeriod = 3000 + (seed * 37 % 4000);
  const beatPeriod = 8000 + (seed * 71 % 8000);
  const breathPeriod = 2750 + (seed % 251);

  function at(frame: ArtFrame): { index: number; next: number | null; ember?: boolean } {
    const mood = byMood[frame.mood];
    if (frame.still) return { index: mood.rest, next: null };
    if (frame.activity === "walk") return { index: walk[frame.step & 3]!, next: null };
    if (frame.activity === "cue" && frame.cue) {
      const progress = frame.progress;
      const cue = frame.cue;
      const deliberate = cue === "tip" || cue === "signature";
      const lift = deliberate ? 0.30 : 0.33;
      const lower = deliberate ? 0.72 : 0.67;
      const end = progress < 0.12 ? 0.12 : progress < lift ? lift : progress < lower ? lower : progress < 0.88 ? 0.88 : 1;
      let index = mood.rest;
      if (progress >= 0.12 && progress < 0.88) {
        const peak = Number(progress >= lift && progress < lower);
        if (cue === "signature") index = mood.signature[progress >= lower ? 2 : peak]!;
        else if (cue === "hop" || cue === "tip") index = mood[cue][peak]!;
        else if (frame.mood !== "resting") index = byCue[cue][peak]!;
        else if (cue === "blink") index = waitingBlink;
      }
      return { index, next: (end - progress) * CUE_MS[frame.cue] };
    }
    if (smallIdle(frame)) {
      const breath = phase(frame.t, 6400, seed % 6400, 800);
      return { index: breath.on ? mood.small : mood.rest, next: breath.next };
    }
    if (frame.activity === "quiet") {
      const turn = phase(frame.t, 3200, seed, 1600);
      return { index: turn.on ? mood.stillHands : mood.turn, next: mood.stillHands === mood.turn ? null : turn.next };
    }
    const blink = phase(frame.t, blinkPeriod, seed, 120);
    const beat = phase(frame.t, beatPeriod, seed * 3, 720);
    const breath = phase(frame.t, breathPeriod, seed, 560);
    if (blink.on) return { index: mood.blink, next: Math.min(blink.next, breath.next), ember: breath.on };
    const next = Math.min(blink.next, beat.next, breath.next);
    return { index: beat.on ? mood.beat : breath.on ? mood.breath : mood.calm, next, ember: breath.on };
  }
  return { poses, at, index: (frame: ArtFrame) => at(frame).index };
}
