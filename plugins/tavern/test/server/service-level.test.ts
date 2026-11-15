// @vitest-environment node
import { describe, expect, it } from "vitest";
import { levelFromCount, RESULTS_PER_LEVEL } from "../../src/shared/level";

describe("earned service levels", () => {
  it("uses eight earned results per level", () => { expect(RESULTS_PER_LEVEL).toBe(8); });
  it.each([[0, null], [1, 1], [7, 1], [8, 2], [9, 2], [15, 2], [16, 3], [40, 6]])("maps %s earned results to level %s", (count, expected) => {
    expect(levelFromCount(count!)).toBe(expected);
  });
});
