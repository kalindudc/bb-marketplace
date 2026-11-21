import type { Activity, Cue, Mood } from "./art";

export type MotionMode = "off" | "calm" | "lively";
export type ActorRules = { mode: MotionMode; typing: boolean; held: boolean };

const MOOD_CUE: Record<Mood, Cue | null> = {
  idle: null, working: "tap", waiting: null, reported: "wave", verified: "flourish",
  blocked: null, resting: null, error: null,
};

export function enteringMood(mood: Mood) {
  return MOOD_CUE[mood];
}

export function isAttentionMood(mood: Mood): boolean {
  return mood === "waiting" || mood === "blocked" || mood === "error";
}

export function actorActivity(mood: Mood, rules: ActorRules): Exclude<Activity, "cue"> {
  if (rules.mode === "off" || rules.held || isAttentionMood(mood)) return "stand";
  if (rules.typing) return "quiet";
  return rules.mode === "lively" && (mood === "working" || mood === "idle") ? "walk" : "stand";
}

export function allowsCue(rules: ActorRules, auto: boolean, mood: Mood) {
  return rules.mode !== "off" && (!auto || !(rules.held || rules.typing || isAttentionMood(mood)));
}
