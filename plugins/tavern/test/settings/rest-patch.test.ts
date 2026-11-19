// @vitest-environment node
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS, settingsPatchSchema, settingsSchema } from "../../src/shared/settings";

it("does not default the reminder interval in a sparse Keeper patch", () => {
  for (const keepers of [{}, { partyMax: 12 }, { staleStrikes: 3 }, { greenlight: "by-size" }])
    expect(settingsPatchSchema.parse({ keepers })).toEqual({ keepers });
});

it("preserves a saved reminder interval when another Keeper setting changes", () => {
  const patch = settingsPatchSchema.parse({ keepers: { partyMax: 12 } });
  const effective = settingsSchema.parse({ ...DEFAULT_SETTINGS, keepers: { ...DEFAULT_SETTINGS.keepers, restMinutes: 120, ...patch.keepers } });
  expect(effective.keepers).toMatchObject({ partyMax: 12, restMinutes: 120 });
  expect(settingsPatchSchema.parse({ keepers: { restMinutes: 45 } })).toEqual({ keepers: { restMinutes: 45 } });
});

it("still defaults older complete Keeper settings to a thirty-minute reminder", () => {
  const { restMinutes, ...keepers } = DEFAULT_SETTINGS.keepers;
  expect(restMinutes).toBe(30);
  expect(settingsSchema.parse({ ...DEFAULT_SETTINGS, keepers }).keepers.restMinutes).toBe(30);
});
