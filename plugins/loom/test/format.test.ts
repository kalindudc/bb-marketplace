import { describe, expect, it } from "vitest";
import { compactCount } from "../src/format";

describe("compactCount", () => {
  it("writes a count in a few characters, moving up a unit at a thousand", () => {
    expect([950, 587_182, 7_298_070, 47_341_333, 2_802_561_377, 1_759_354_796, 28_000_000_000].map(compactCount)).toEqual(["950", "587k", "7.3M", "47M", "2.8B", "1.8B", "28B"]);
  });

  it("never shows a thousand of a unit after rounding", () => {
    expect([999_600, 9_970_000, 999_600_000, 999_600_000_000].map(compactCount)).toEqual(["1.0M", "10M", "1.0B", "1.0T"]);
  });
});
