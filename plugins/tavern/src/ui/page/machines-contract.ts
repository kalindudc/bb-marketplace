import { defineContract } from "../../shared/define-contract";
import { placementContract, type PlacementCatalogView, type PlacementPreview, type PlacementPreviewInput } from "../../shared/placement-rpc";
import { settingsContract } from "../../shared/settings";

export type { PlacementPreview, PlacementPreviewInput };
export type PlacementCatalog = PlacementCatalogView;

/** While false, the page stays out of the sidebar, the phone page picker and settings, and says the preview is not available yet. */
export const PLACEMENT_RPC_LIVE = true;

export const machinesContract = defineContract({
  settings: settingsContract.settings,
  settingsUpdate: settingsContract.settingsUpdate,
  placementCatalog: placementContract.placementCatalog,
  placementPreview: placementContract.placementPreview,
});
