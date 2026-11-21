import { CUE_MS, type ArtFrame, type CharacterArt, type Cue, type Mood } from "./art";
import { createBody, hop, settled, stepBody } from "./physics";
import { actorActivity, allowsCue, enteringMood, isAttentionMood, type ActorRules } from "./rules";

const REACTIONS = ["hop", "tip", "signature"] as const;
export type Reaction = (typeof REACTIONS)[number];

export class Actor {
  readonly body = createBody();
  moodSince = 0;
  target: number | null = null;
  lastReaction: Reaction | null = null;
  private time = 0;
  private facing: 1 | -1 = 1;
  private distance = 0;
  private activity: "stand" | "walk" | "quiet" = "stand";
  private held = false;
  private cue: { kind: Cue; start: number; auto: boolean } | null = null;

  constructor(readonly id: string, public art: CharacterArt, public mood: Mood) {}

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
    const cue = this.cue = { kind, start: this.time, auto };
    if (kind === "hop" && !this.small) hop(this.body);
    if (kind === "signature" && this.art.signature === "lantern") this.body.angularVelocity += 7;
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

  setRules(rules: ActorRules) {
    const activity = actorActivity(this.mood, rules);
    const changed = this.activity !== activity || this.held !== rules.held;
    this.held = rules.held;
    this.activity = activity;
    if (this.cue && !allowsCue(rules, this.cue.auto, this.mood)) { this.clearCue(); return true; }
    return changed;
  }

  update(dt: number, span: number, rules: ActorRules, steps = 1) {
    this.setRules(rules);
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
      const previous = this.body.x;
      this.target = walk ? (this.facing === 1 ? span : 0) : null;
      stepBody(this.body, this.target, dt);
      if (this.target !== null) {
        this.distance += Math.abs(this.body.x - previous);
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
      step: still ? 0 : Math.floor(this.distance / 6), swing: still || (this.small && cue?.kind !== "signature") ? 0 : this.body.swing,
      flame: flickers ? 1 + 0.11 * Math.sin(time / 130) + 0.05 * Math.sin(time / 47) : 1,
      still, small: this.small,
    };
  }
}
