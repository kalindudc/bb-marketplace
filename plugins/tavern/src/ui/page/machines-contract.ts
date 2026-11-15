import { defineContract } from "../../shared/define-contract";
import { placementContract, type PlacementCatalogView, type PlacementPreview, type PlacementPreviewInput } from "../../shared/placement-rpc";
import { settingsContract } from "../../shared/settings";

export type { PlacementPreview, PlacementPreviewInput };
export type PlacementCatalog = PlacementCatalogView;

/** While false, the page stays out of the sidebar, the phone page picker and settings, and says the preview is not available yet. */
export const PLACEMENT_RPC_LIVE = true;
/** False until the pipeline can run work on another machine: the page shows its preview banner, and a caught machine rule "would run" there but waits. */
export const MACHINE_RULES_RUN = false;

export const machinesContract = defineContract({
  settings: settingsContract.settings,
  settingsUpdate: settingsContract.settingsUpdate,
  placementCatalog: placementContract.placementCatalog,
  placementPreview: placementContract.placementPreview,
});
