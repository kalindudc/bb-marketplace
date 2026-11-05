import type { ExperimentalTabReference } from "@get-bb/plugin-sdk/app";

export const FLARES_TAB_ID = "flares";
export const FLARE_ICON = "flare/flare";
export const FLARES_TAB: ExperimentalTabReference & { availability: "action" } = {
  id: FLARES_TAB_ID,
  context: { kind: "thread" },
  availability: "action",
};
