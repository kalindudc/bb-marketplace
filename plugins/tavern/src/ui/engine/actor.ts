import { CUE_MS, type ArtFrame, type CharacterArt, type Cue, type Mood } from "./art";
import { createBody, hop, stepBody } from "./physics";
import { actorActivity, allowsCue, enteringMood, type ActorRules } from "./rules";

export class Actor {
  readonly body = createBody();
  moodSince = 0;
  target: number | null = null;
  private time = 0;
  private facing: 1 | -1 = 1;
  private distance = 0;
  private activity: "stand" | "walk" | "quiet" = "stand";
  private cue: { kind: Cue; start: number; auto: boolean } | null = null;

  constructor(readonly id: string, public art: CharacterArt, public mood: Mood) {}

  get quietIdle() {
    return this.art.quietIdle(this.mood);
  }

  setMood(mood: Mood) {
    if (this.mood === mood) return null;
    this.mood = mood;
    this.moodSince = this.time;
    return enteringMood(mood);
  }

  playCue(kind: Cue, auto: boolean, rules: ActorRules) {
    if (!allowsCue(rules, auto)) return null;
    const cue = this.cue = { kind, start: this.time, auto };
    if (kind === "hop") hop(this.body);
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

  update(dt: number, span: number, rules: ActorRules) {
    this.time += dt * 1000;
    this.activity = actorActivity(this.mood, rules);
    if (this.cue && (!allowsCue(rules, this.cue.auto) || this.time - this.cue.start >= CUE_MS[this.cue.kind])) this.clearCue();

    this.body.x = Math.min(span, Math.max(0, this.body.x));
    const previous = this.body.x;
    this.target = this.activity === "walk" && span > 0 ? (this.facing === 1 ? span : 0) : null;
    stepBody(this.body, this.target, dt);
    if (this.target !== null) {
      this.distance += Math.abs(this.body.x - previous);
      if (this.body.x === this.target) this.facing = this.facing === 1 ? -1 : 1;
    }
  }

  frame(still: boolean): ArtFrame {
    const cue = still ? null : this.cue;
    return {
      activity: still ? "stand" : cue ? "cue" : this.activity,
      cue: cue?.kind ?? null, progress: cue ? (this.time - cue.start) / CUE_MS[cue.kind] : 0,
      t: still ? 0 : this.time, mood: this.mood, facing: this.facing,
      step: still ? 0 : Math.floor(this.distance / 6), swing: still ? 0 : this.body.swing,
      flame: still ? 1 : 1 + 0.11 * Math.sin(this.time / 130) + 0.05 * Math.sin(this.time / 47),
      still,
    };
  }
}
