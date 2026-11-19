// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reuseRule, type RestingEngagement } from "../../src/server/resting";

const resting: RestingEngagement = { state: "resting", since: 1, lastWork: "Found the source", rejectedWaypoints: [], underReview: false };
describe("resting reuse rules", () => {
  it("limits Rangers to a follow-up on the same quest", () => {
    expect(reuseRule("ranger", resting, "A")).toBe("a follow-up on A");
  });
  it("limits Smiths to their own work and excludes mid-review work", () => {
    expect(reuseRule("smith", resting, "A")).toContain("work it just made on A");
    expect(reuseRule("smith", { ...resting, underReview: true }, "A")).toBeNull();
  });
  it("limits Wanderers to the same bounded work", () => {
    expect(reuseRule("wanderer", resting, "A")).toContain("not a new domain");
  });
  it("offers Wardens only for a rejected waypoint", () => {
    expect(reuseRule("warden", resting, "A")).toBeNull();
    expect(reuseRule("warden", { ...resting, rejectedWaypoints: ["w1"] }, "A")).toBe("re-checking w1 after the maker's fix");
  });
  it("does not invent a reuse policy for a custom class", () => {
    expect(reuseRule("custom", resting, "A")).toBeNull();
  });
});
