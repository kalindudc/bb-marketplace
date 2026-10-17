import { describe, expect, it } from "vitest";
import { densityMetrics } from "../src/metrics";

describe("density metrics", () => {
  it("keeps one spacing map for compact, comfortable and two-line layouts", () => {
    const shared = { base: 28, pillLeft: 8, pillRight: 6 };
    expect(densityMetrics("compact")).toEqual({ ...shared, rowH: 28, indent: 14, gap: 6,
      headerH: 26, sectionGap: 10, controlH: 28 });
    expect(densityMetrics("default")).toEqual({ ...shared, rowH: 32, indent: 16, gap: 8,
      headerH: 30, sectionGap: 16, controlH: 32 });
    expect(densityMetrics("two-line")).toEqual({ ...shared, rowH: 48, indent: 16, gap: 8,
      headerH: 30, sectionGap: 18, controlH: 32 });
  });
});
