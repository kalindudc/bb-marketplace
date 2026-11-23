import { experimental_useRpcQuery, useBbNavigate, useEnvironmentProviders } from "@get-bb/plugin-sdk/app";
import { OpensMark } from "../kit";
import { machinesContract, PLACEMENT_RPC_LIVE } from "./machines-contract";
import { makeNames, settingsSummary } from "./machines-model";
import { FoldLoad, SettingsSkeleton } from "./skeletons";

/** "Where work runs" in bb's settings: one row with the counts and the way into the page, which holds the rules themselves. */
export function MachinesSettingsRow() {
  const navigate = useBbNavigate();
  const settings = experimental_useRpcQuery({ contract: machinesContract, method: "settings", input: null });
  const catalog = experimental_useRpcQuery({ contract: machinesContract, method: "placementCatalog", input: {}, enabled: PLACEMENT_RPC_LIVE });
  const envs = useEnvironmentProviders();
  const data = settings.data;
  if (!data) return <div className="tavern tv-page tv-set"><FoldLoad error={settings.error} retry={settings.refetch} label="where work runs"><SettingsSkeleton rows={1} /></FoldLoad></div>;
  const blocked = data.placementPolicy?.state === "invalid";
  const line = blocked ? "Placement is blocked: Tavern can't read the saved rules, so new members wait." : settingsSummary(data.effective.machines, makeNames(catalog.data ?? null, envs.providers, [], undefined));
  return <div className="tavern tv-page tv-set">
    <div className="tv-set-row" data-settings-row="machines.rules machines.forges"><div className="tv-set-l"><span className="tv-set-lbl" data-settings-copy>Rules</span><p data-settings-copy>{line}</p></div>
      <div className="tv-set-c"><button type="button" className="btn" onClick={() => navigate.toPluginPanel("tavern", { subPath: "machines" })}>Open Where work runs<OpensMark /></button></div></div>
  </div>;
}
