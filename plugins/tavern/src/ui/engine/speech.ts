import type { MoodOrGone } from "../../shared/mood";
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
  arrivedAt?: number;
  wrappedAt?: number;
  click?: boolean;
  typing?: boolean;
  held?: boolean;
  stuckInView?: boolean;
};

export function speechDecision(input: SpeechInput): { slot: SpeechKey; key: string } | null {
  const { actorId, voice, mood, moodSince, pageSince, now, lastLineAt, wrappedAt, arrivedAt } = input;
  if (voice === "off" || input.typing || input.held || input.stuckInView) return null;
  if (mood === "waiting" || mood === "blocked" || mood === "error" || mood === "released") return null;

  const line = (slot: SpeechKey, moment: string, at: number) => ({ slot, key: `${actorId}:${slot}:${moment}:${at}` });
  const due = (eventAt: number, at = eventAt) =>
    eventAt >= pageSince && now >= at && now - at < BUBBLE_MS && (lastLineAt === null || lastLineAt < at);

  if (input.click) return line(mood, "click", now);
  if (wrappedAt !== undefined && due(wrappedAt)) return line("wrap", "wrap", wrappedAt);
  if (arrivedAt !== undefined && voice === "full" && due(arrivedAt)) return line("greet", "arrival", arrivedAt);
  if (mood === "verified" || mood === "reported") {
    const at = Math.max(moodSince, input.cueEndsAt ?? moodSince) + CUE_SETTLE_MS;
    return (mood === "verified" || voice === "full") && due(moodSince, at) ? line(mood, "entry", moodSince) : null;
  }
  if (voice !== "full") return null;
  const since = Math.max(pageSince, moodSince, lastLineAt ?? pageSince);
  const next = line(mood, "ambient", since);
  const gap = MIN_GAP_MS + speechSeed(next.key) % (GAP_SPAN_MS + 1);
  return now >= since + gap ? next : null;
}
