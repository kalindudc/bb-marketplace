import { describe, expect, it } from "vitest";
import { BUBBLE_MS, speechDecision, type SpeechInput } from "../../../src/ui/engine/speech";

const base: SpeechInput = { actorId: "wren:lead", voice: "full", mood: "idle", moodSince: 0, pageSince: 0, now: 500_000, lastLineAt: null };
const decide = (change: Partial<SpeechInput> = {}) => speechDecision({ ...base, ...change });

describe("speech policy", () => {
  it.each(["typing", "held", "stuckInView"] as const)("suppresses clicks and automatic lines during %s", hold => {
    expect(decide({ [hold]: true })).toBeNull();
    expect(decide({ [hold]: true, click: true })).toBeNull();
  });

  it.each(["waiting", "blocked", "error", "released"] as const)("never speaks in %s", mood => {
    expect(decide({ mood, wrappedAt: base.now })).toBeNull();
    expect(decide({ mood, click: true })).toBeNull();
  });

  it("honours full, light and off", () => {
    expect(decide()?.slot).toBe("idle");
    expect(decide({ voice: "light" })).toBeNull();
    expect(decide({ voice: "light", click: true })?.slot).toBe("idle");
    expect(decide({ voice: "off", click: true, wrappedAt: base.now })).toBeNull();
    expect(decide({ voice: "light", mood: "reported", moodSince: base.now - 1_000 })).toBeNull();
    expect(decide({ voice: "light", mood: "verified", moodSince: base.now - 1_000 })?.slot).toBe("verified");
    expect(decide({ voice: "light", wrappedAt: base.now })?.slot).toBe("wrap");
    expect(decide({ voice: "light", arrivedAt: base.now })).toBeNull();
    expect(decide({ arrivedAt: base.now })?.slot).toBe("greet");
  });

  it.each(["reported", "verified"] as const)("speaks once for %s, one second after a cue", mood => {
    const event = { mood, moodSince: 100_000, cueEndsAt: 102_000 };
    expect(decide({ ...event, now: 102_999 })).toBeNull();
    const line = decide({ ...event, now: 103_000 });
    expect(line?.slot).toBe(mood);
    expect(decide({ ...event, now: 104_000 })?.key).toBe(line?.key);
    expect(decide({ ...event, now: 104_000, lastLineAt: 103_000 })).toBeNull();
    expect(decide({ ...event, now: 103_000 + BUBBLE_MS })).toBeNull();
  });

  it("does not replay a wrap from before the page opened", () => {
    expect(decide({ voice: "light", pageSince: 500_000, wrappedAt: 499_999 })).toBeNull();
  });

  it.each(["idle", "working", "resting"] as const)("keeps a seeded three to seven minute gap in %s", mood => {
    const lastLineAt = 250_000;
    expect(decide({ mood, now: 59_999 })).toBeNull();
    expect(decide({ mood, now: lastLineAt + 179_999, lastLineAt })).toBeNull();
    const next = decide({ mood, now: lastLineAt + 420_000, lastLineAt });
    expect(next?.slot).toBe(mood);
    expect(decide({ mood, now: lastLineAt + 421_000, lastLineAt })).toEqual(next);
  });
});
