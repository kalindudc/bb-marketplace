import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, SETTING_DESCRIPTORS, wholeNumber } from "../src/settings";

describe("settings", () => {
  it("uses the documented defaults for missing settings", () => {
    expect(parseSettings(undefined)).toEqual({
      density: "default", sectionColour: "rail", treeGuides: true,
      statusChips: true, showAge: true, showBranch: false, showPullRequests: true,
      view: "sections", needsYouShelf: false, showArchived: false, staleDays: 3, snoozeHour: 9,
      infoCard: "glance",
    });
    expect(SETTING_DESCRIPTORS.density.default).toBe(DEFAULT_SETTINGS.density);
    expect(SETTING_DESCRIPTORS.density.experimental_optionLabels).toEqual({
      compact: "Compact (28 px)", default: "Comfortable (32 px)", "two-line": "Two lines (48 px)",
    });
  });

  it("keeps each valid value", () => {
    expect(parseSettings({ density: "two-line", sectionColour: "swatch", treeGuides: false,
      statusChips: false, showAge: false, showBranch: true, showPullRequests: false,
      view: "status", needsYouShelf: true, showArchived: true, staleDays: 0, snoozeHour: 23, infoCard: "full" })).toEqual({
      density: "two-line", sectionColour: "swatch", treeGuides: false,
      statusChips: false, showAge: false, showBranch: true, showPullRequests: false,
      view: "status", needsYouShelf: true, showArchived: true, staleDays: 0, snoozeHour: 23, infoCard: "full",
    });
  });

  it("falls back independently for invalid types and unknown options", () => {
    expect(parseSettings({ density: "cozy", sectionColour: 8, treeGuides: "false",
      statusChips: null, showAge: 1, showBranch: "yes", showPullRequests: [],
      view: "other", needsYouShelf: "true", staleDays: 1.5, snoozeHour: -1, infoCard: "cozy" })).toEqual(DEFAULT_SETTINGS);
    for (const value of [-1, 90.1, 91, Infinity, "7", NaN]) {
      expect(parseSettings({ staleDays: value }).staleDays).toBe(3);
    }
    expect(parseSettings({ snoozeHour: 24 }).snoozeHour).toBe(9);
  });

  it("validates bounded whole numbers with Standard Schema", () => {
    const schema = wholeNumber(23)["~standard"];
    expect(schema.validate(0)).toEqual({ value: 0 });
    expect(schema.validate(23)).toEqual({ value: 23 });
    for (const value of [-1, 1.5, 24, "9", NaN]) {
      expect(schema.validate(value)).toHaveProperty("issues");
    }
  });
});
