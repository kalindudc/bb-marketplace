import type { MoodOrGone } from "./art";
import { speechSeed, type SpeechKey } from "../../shared/says";
import type { VoiceMode } from "../../shared/settings";

export const BUBBLE_MS = 4_500;
const CUE_SETTLE_MS = 1_000;
const MIN_GAP_MS = 180_000;
const GAP_SPAN_MS = 240_000;

export type SpeechInput = {
  actorId: string;
  voice: VoiceMode;
  mood: MoodOrGone;
  moodSince: number;
  pageSince: number;
  now: number;
  lastLineAt: number | null;
  cueEndsAt?: number;
  milestone?: boolean;
  lastAmbientAttemptAt?: number;
  lastEventAttemptAt?: number;
  arrivedAt?: number;
  wrappedAt?: number;
  click?: boolean;
  typing?: boolean;
  held?: boolean;
  stuckInView?: boolean;
};

export function speechSlot(mood: MoodOrGone): mood is Exclude<SpeechKey, "greet" | "wrap"> {
  return mood === "idle" || mood === "working" || mood === "resting" || mood === "reported" || mood === "verified";
}

export function planSpeech(input: SpeechInput) {
  const { actorId, voice, mood, moodSince, pageSince, now, lastLineAt, wrappedAt, arrivedAt } = input;
  if (voice === "off" || input.typing || input.held || input.stuckInView || !speechSlot(mood)) return null;

  const line = (slot: SpeechKey, kind: string, stamp: number, at = stamp) => ({ slot, key: `${actorId}:${slot}:${kind}:${stamp}`, kind, at });
  const eligible = (eventAt: number, at = eventAt) =>
    eventAt >= pageSince && now - at < BUBBLE_MS && Math.max(lastLineAt ?? -Infinity, input.lastEventAttemptAt ?? -Infinity) < at;

  if (input.click) return line(mood, "click", now);
  if (wrappedAt !== undefined && eligible(wrappedAt)) return line("wrap", "wrap", wrappedAt);
  if (arrivedAt !== undefined && voice === "full" && eligible(arrivedAt)) return line("greet", "arrival", arrivedAt);
  if (mood === "verified" || mood === "reported") {
    const at = Math.max(moodSince, input.cueEndsAt ?? moodSince) + CUE_SETTLE_MS;
    return input.milestone !== false && (mood === "verified" || voice === "full") && eligible(moodSince, at)
      ? line(mood, "entry", moodSince, at) : null;
  }
  if (voice !== "full") return null;
  const since = Math.max(pageSince, moodSince, lastLineAt ?? pageSince, input.lastAmbientAttemptAt ?? pageSince);
  const next = line(mood, "ambient", since);
  return { ...next, at: since + MIN_GAP_MS + speechSeed(next.key) % (GAP_SPAN_MS + 1) };
}

export function speechDecision(input: SpeechInput): { slot: SpeechKey; key: string } | null {
  const next = planSpeech(input);
  return next && next.at <= input.now ? { slot: next.slot, key: next.key } : null;
}
