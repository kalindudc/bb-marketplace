import { useCallback } from "react";
import { experimental_usePluginId, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { parseSettings, SETTINGS_LOCAL_CHANNEL, type SwitchboardSettings } from "./settings";

export function useUpdateSettings(): (values: Partial<SwitchboardSettings>) => void {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  return useCallback((values: Partial<SwitchboardSettings>) => {
    const publish = (next: Partial<SwitchboardSettings>) =>
      window.dispatchEvent(new CustomEvent(SETTINGS_LOCAL_CHANNEL, { detail: { pluginId, values: next } }));
    publish(values);
    void sdk.plugins.updateSettings({ pluginId, values }).catch(async () => {
      toast.error("Switchboard could not change that setting");
      try {
        const current = await sdk.plugins.getSettings({ pluginId });
        publish(parseSettings(current.values));
      } catch (cause) { console.warn("Switchboard could not reload its settings.", cause); }
    });
  }, [sdk, pluginId]);
}
