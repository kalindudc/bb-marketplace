// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fitTabs } from "../../src/ui/tab-bar";

describe("fitTabs", () => {
  it("shows every tab when they all fit, without room for More", () => {
    expect(fitTabs([100, 100, 100], 300, 60, 0)).toEqual([0, 1, 2]);
  });

  it("shows as many tabs as fit in their order, leaving room for More", () => {
    expect(fitTabs([100, 100, 100, 100], 360, 60, 0)).toEqual([0, 1, 2]);
    expect(fitTabs([100, 100, 100, 100], 359, 60, 0)).toEqual([0, 1]);
  });

  it("keeps the current tab in the bar when it would have gone under More", () => {
    expect(fitTabs([100, 100, 100, 100, 100], 360, 60, 4)).toEqual([0, 1, 4]);
    expect(fitTabs([100, 100, 100, 100, 100], 250, 60, 3)).toEqual([3]);
  });

  it("stops at the first tab that does not fit, so a narrower one after it does not jump the order", () => {
    expect(fitTabs([100, 250, 50, 100], 360, 60, 0)).toEqual([0]);
  });
});
