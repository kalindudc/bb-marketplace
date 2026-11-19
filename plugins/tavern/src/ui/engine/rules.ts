import type { Activity, Cue, Mood } from "./art";

export type MotionMode = "off" | "calm" | "lively";
export type ActorRules = { mode: MotionMode; typing: boolean; held: boolean };

const MOOD_CUE: Record<Mood, Cue | null> = {
  idle: null, working: "tap", waiting: "notice", reported: "wave", verified: "flourish",
  blocked: "drop", resting: "blink", error: "drop",
};

export function enteringMood(mood: Mood) {
  return MOOD_CUE[mood];
}

export function actorActivity(mood: Mood, rules: ActorRules): Exclude<Activity, "cue"> {
  if (rules.mode === "off") return "stand";
  if (rules.held || rules.typing) return "quiet";
  return rules.mode === "lively" && (mood === "working" || mood === "idle") ? "walk" : "stand";
}

export function allowsCue(rules: ActorRules, auto: boolean) {
  return rules.mode !== "off" && !rules.held && !(auto && rules.typing);
}
