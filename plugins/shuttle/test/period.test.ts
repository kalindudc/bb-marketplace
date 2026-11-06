// @vitest-environment node
import { describe, expect, it } from "vitest";
import { addDays, isDay, periodLabel, previousText, stepEnd } from "../src/period";

describe("usage periods", () => {
  it("names a day or a run of days the way the page shows them", () => {
    const today = "2026-11-06";
    expect(periodLabel("today", today, today)).toBe("Today, Nov 6");
    expect(periodLabel("today", "2026-11-05", today)).toBe("Yesterday, Nov 5");
    expect(periodLabel("today", "2026-11-04", today)).toBe("Wed, Nov 4");
    expect(periodLabel("today", "2025-12-31", today)).toBe("Wed, Dec 31, 2025");
    expect(periodLabel("7d", today, today)).toBe("Oct 31 \u2013 Nov 6");
    expect(periodLabel("7d", "2026-11-07", "2026-11-08")).toBe("Nov 1 \u2013 7");
    expect(periodLabel("30d", "2026-01-10", today)).toBe("Dec 12, 2025 \u2013 Jan 10, 2026");
    expect(previousText("today", true)).toBe("yesterday by now");
    expect(previousText("today", false)).toBe("the day before");
    expect(previousText("30d", false)).toBe("the 30 days before");
  });

  it("steps by the period's length, and back to following today once a step reaches it", () => {
    expect(stepEnd("today", "2026-11-06", -1, "2026-11-06")).toBe("2026-11-05");
    expect(stepEnd("today", "2026-11-05", 1, "2026-11-06")).toBeNull();
    expect(stepEnd("7d", "2026-11-06", -1, "2026-11-06")).toBe("2026-10-30");
    expect(stepEnd("90d", "2026-08-08", 1, "2026-11-06")).toBeNull();
    // Whole days across the change from daylight saving time on Nov 1.
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(isDay("2026-11-05")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("0002-01-01")).toBe(false);
  });
});
