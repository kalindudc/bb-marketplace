import { CUE_MS, type ArtFrame, type CharacterArt, type Cue, type Mood } from "./art";
import { createBody, hop, settled, stepBody } from "./physics";
import { motionSeed, strideCycle, variation } from "./rhythm";
import { actorActivity, allowsCue, enteringMood, isAttentionMood, type ActorRules } from "./rules";

const REACTIONS = ["hop", "tip", "signature"] as const;
export type Reaction = (typeof REACTIONS)[number];

export class Actor {
  readonly body = createBody();
  readonly motionSeed: number;
  moodSince = 0;
  target: number | null = null;
  lastReaction: Reaction | null = null;
  private time = 0;
  private facing: 1 | -1 = 1;
  private distance: number;
  private cycle = 0;
  private gait: ReturnType<typeof strideCycle>;
  private activity: "stand" | "walk" | "quiet" = "stand";
  private held = false;
  private cue: { kind: Cue; start: number; auto: boolean; launch: number } | null = null;

  constructor(readonly id: string, public art: CharacterArt, public mood: Mood, memberId = id) {
    this.motionSeed = motionSeed(memberId);
    this.gait = strideCycle(this.motionSeed, 0);
    this.distance = this.gait.length * variation(this.motionSeed, -1);
  }

  get quietIdle() {
    return this.art.quietIdle(this.mood);
  }

  get small() {
    return this.held || isAttentionMood(this.mood);
  }

  setMood(mood: Mood) {
    if (this.mood === mood) return null;
    this.mood = mood;
    this.moodSince = this.time;
    if (this.cue?.auto && this.small) this.clearCue();
    return enteringMood(mood);
  }

  nextReaction(): Reaction {
    const last = this.lastReaction === null ? -1 : REACTIONS.indexOf(this.lastReaction);
    return REACTIONS[(last + 1) % REACTIONS.length]!;
  }

  react(kind: Reaction, rules: ActorRules, still: boolean) {
    this.lastReaction = kind;
    if (!still) return this.playCue(kind, false, rules);
    this.facing = this.facing === 1 ? -1 : 1;
    return null;
  }

  playCue(kind: Cue, auto: boolean, rules: ActorRules) {
    if (!allowsCue(rules, auto, this.mood)) return null;
    this.clearCue();
    const launch = kind === "hop" && !this.small ? (rules.mode === "lively" ? 120 : 86) : 0;
    const cue = this.cue = { kind, start: this.time, auto, launch };
    if (kind === "signature" && this.art.signature === "lantern") this.body.angularVelocity += this.facing * (rules.mode === "lively" ? 7 : 5.5);
    return () => { if (this.cue === cue) this.clearCue(); };
  }

  private clearCue() {
    this.cue = null;
    this.body.lift = this.body.vy = 0;
  }

  stop() {
    this.clearCue();
    this.body.vx = this.body.ax = this.body.swing = this.body.angularVelocity = 0;
  }

  setRules(rules: ActorRules, span: number) {
    const requested = actorActivity(this.mood, rules);
    const activity = requested === "walk" && span <= 0 ? "stand" : requested;
    const changed = this.activity !== activity || this.held !== rules.held;
    this.held = rules.held;
    this.activity = activity;
    if (this.small) {
      this.body.vx = this.body.ax = 0;
      if (this.cue?.kind !== "signature") this.body.swing = this.body.angularVelocity = 0;
    }
    if (this.cue && !allowsCue(rules, this.cue.auto, this.mood)) { this.clearCue(); return true; }
    return changed;
  }

  update(dt: number, span: number, rules: ActorRules, steps = 1) {
    this.setRules(rules, span);
    this.body.x = Math.min(span, Math.max(0, this.body.x));
    const walk = this.activity === "walk" && span > 0;
    if (!walk && !this.cue && settled(this.body)) {
      this.target = null;
      this.body.ax = 0;
      this.time += steps * dt * 1000;
      return;
    }
    for (let i = 0; i < steps; i++) {
      this.time += dt * 1000;
      if (this.cue && this.time - this.cue.start + 1e-6 >= CUE_MS[this.cue.kind]) this.clearCue();
      if (this.cue?.launch && this.time - this.cue.start >= 90) {
        if (!this.small) hop(this.body, this.cue.launch);
        this.cue.launch = 0;
      }
      const previous = this.body.x;
      this.target = walk && !this.cue ? (this.facing === 1 ? span : 0) : null;
      const drive = this.target === null ? 0 : this.facing * 17 * Math.sin(2 * Math.PI * this.distance / this.gait.length) * Math.min(1, Math.abs(this.body.vx) / this.gait.speed);
      stepBody(this.body, this.target, dt, this.gait.speed, drive);
      if (this.target !== null) {
        this.distance += Math.abs(this.body.x - previous);
        while (this.distance >= this.gait.length) {
          this.distance -= this.gait.length;
          this.gait = strideCycle(this.motionSeed, ++this.cycle);
        }
        if (this.body.x === this.target) this.facing = this.facing === 1 ? -1 : 1;
      }
    }
  }

  nextDraw(span: number): number | null {
    if ((this.activity === "walk" && span > 0) || this.cue || !settled(this.body)) return 0;
    return this.art.nextChange(this.frame(false));
  }

  frame(still: boolean): ArtFrame {
    const cue = still ? null : this.cue;
    const time = Math.round(this.time * 1e6) / 1e6;
    const activity = still ? "stand" : cue ? "cue" : this.activity;
    const flickers = !still && !this.small && (activity === "cue" || activity === "walk");
    return {
      activity,
      cue: cue?.kind ?? null, progress: cue ? (time - cue.start) / CUE_MS[cue.kind] : 0,
      t: still ? 0 : time, mood: this.mood, facing: this.facing,
      step: activity === "walk" ? Math.floor(8 * this.distance / this.gait.length) : 0,
      motionSeed: this.motionSeed,
      swing: still || (this.small && cue?.kind !== "signature") ? 0 : this.facing * this.body.swing,
      flame: flickers ? this.flicker(time) : 1,
      still, small: this.small,
    };
  }

  private flicker(time: number) {
    const phase = time + (this.motionSeed % 1024);
    return 1 + 0.11 * Math.sin(phase / 130) + 0.05 * Math.sin(phase / 47);
  }
}
