import { useEffect, useState } from "react";
import { experimental_usePluginId, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { DEFAULT_SETTINGS, SETTINGS_CHANNEL, SETTINGS_LOCAL_CHANNEL, parseSettings, type SwitchboardSettings } from "./settings";

const sameSettings = (left: SwitchboardSettings, right: SwitchboardSettings) =>
  (Object.keys(left) as (keyof SwitchboardSettings)[]).every((key) => left[key] === right[key]);

export function useSwitchboardSettings(): SwitchboardSettings {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [version, setVersion] = useState(0);
  useRealtime(SETTINGS_CHANNEL, () => setVersion((current) => current + 1));
  useEffect(() => {
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<{ pluginId: string; values: Partial<SwitchboardSettings> }>).detail;
      if (detail.pluginId === pluginId) setSettings((current) => parseSettings({ ...current, ...detail.values }));
    };
    window.addEventListener(SETTINGS_LOCAL_CHANNEL, onLocal);
    return () => window.removeEventListener(SETTINGS_LOCAL_CHANNEL, onLocal);
  }, [pluginId]);

  useEffect(() => {
    const controller = new AbortController();
    sdk.plugins.getSettings({ pluginId, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const next = parseSettings(response.values);
        setSettings((current) => sameSettings(current, next) ? current : next);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn("Switchboard could not load its settings.", error);
      });
    return () => controller.abort();
  }, [sdk, pluginId, version]);

  return settings;
}
