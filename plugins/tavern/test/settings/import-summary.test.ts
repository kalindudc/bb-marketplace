import { expect, it } from "vitest";
import { importSummary, type SettingsChange } from "../../src/shared/settings";
const unset = (key: string): SettingsChange => ({ key, from: true, to: null, kind: "unset" });
const set = (key: string): SettingsChange => ({ key, from: false, to: true, kind: "set" });
it("shares the replacement warning and reset count across previews", () => {
  expect(importSummary([unset("a"), unset("b"), unset("c"), set("d"), set("e")])).toBe("Replaces all settings. 3 settings return to defaults. 2 others change.");
  expect(importSummary([unset("a"), set("b")])).toBe("Replaces all settings. 1 setting returns to defaults. 1 other changes.");
  expect(importSummary([set("a")])).toBe("Replaces all settings. No settings return to defaults. 1 other changes.");
  expect(importSummary([unset("a")])).toBe("Replaces all settings. 1 setting returns to defaults.");
  expect(importSummary([])).toBe("Replaces all settings. No settings return to defaults. Nothing else would change.");
});
it("reports completed replacements in the past tense", () => {
  expect(importSummary([unset("a"), unset("b"), set("c")], true)).toBe("Replaced all settings. 2 settings returned to defaults. 1 other changed.");
  expect(importSummary([unset("a")], true)).toBe("Replaced all settings. 1 setting returned to defaults.");
  expect(importSummary([set("a")], true)).toBe("Replaced all settings. No settings returned to defaults. 1 other changed.");
  expect(importSummary([], true)).toBe("Replaced all settings. No settings returned to defaults. Nothing else changed.");
});
