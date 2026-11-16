// @vitest-environment node
import { describe, expect, it } from "vitest";
import { restingAdvisory, type RestingMember } from "../../src/server/resting";

const member = (patch: Partial<RestingMember>): RestingMember => ({
  threadId: "thr_resting",
  displayName: "Lark",
  classId: "ranger",
  state: "done",
  boardQuestId: "quest_one",
  waypointId: "w1",
  ...patch,
});

describe("resting party advisory", () => {
  it("offers resting scouts for a bounded follow-up and names their thread ids", () => {
    const text = restingAdvisory([member({})], { classId: "ranger", boardQuestId: "quest_one" })!;
    expect(text).toContain("advisory, never a refusal");
    expect(text).toContain("Resting scouts: Lark (resting, w1, thr_resting)");
    expect(text).toContain("bounded follow-up");
  });

  it("warns against re-briefing a resting Smith on unrelated work and while it is mid-review", () => {
    const smith = member({ classId: "smith", displayName: "Bram" });
    const plain = restingAdvisory([smith], { classId: "smith", boardQuestId: "quest_one" })!;
    expect(plain).toContain("Resting builders: Bram");
    expect(plain).toContain("unrelated task");
    expect(plain).not.toContain("mid-review");
    const reviewed = restingAdvisory([smith], { classId: "smith", boardQuestId: "quest_one", reviewedWaypoints: new Set(["w1"]) })!;
    expect(reviewed).toContain("mid-review");
  });

  it("never offers a Warden, because a check needs a fresh context", () => {
    const text = restingAdvisory([member({ classId: "warden", displayName: "Rook" })], { classId: "warden", boardQuestId: "quest_one" })!;
    expect(text).toContain("Never re-brief a Warden");
    expect(text).not.toContain("instead of hiring");
  });

  it("says nothing about work that is still running, released from another quest, or absent", () => {
    expect(restingAdvisory([member({ state: "working" })], { classId: "ranger", boardQuestId: "quest_one" })).toBeNull();
    expect(restingAdvisory([member({ boardQuestId: "quest_two" })], { classId: "ranger", boardQuestId: "quest_one" })).toBeNull();
    expect(restingAdvisory([], { classId: "ranger" })).toBeNull();
  });

  it("reports a released member as released rather than resting", () => {
    expect(restingAdvisory([member({ state: "stopped" })], { classId: "ranger", boardQuestId: "quest_one" })).toContain("(released, w1, thr_resting)");
  });
});
