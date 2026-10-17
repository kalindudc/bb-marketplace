import { useEffect, useState } from "react";
import { experimental_usePluginId, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { DEFAULT_SETTINGS, SETTINGS_CHANNEL, parseSettings, type SessionLogSettings } from "./settings";

const sameSettings = (left: SessionLogSettings, right: SessionLogSettings) =>
  (Object.keys(left) as (keyof SessionLogSettings)[]).every((key) => left[key] === right[key]);

/**
 * The plugin's settings, or null until they first load. They are read when the
 * panel mounts (the host's own settings hook caches for 30 seconds) and again
 * whenever the server reports a change on the settings channel.
 */
export function useSessionLogSettings(): SessionLogSettings | null {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const [settings, setSettings] = useState<SessionLogSettings | null>(null);
  const [version, setVersion] = useState(0);
  useRealtime(SETTINGS_CHANNEL, () => setVersion((current) => current + 1));

  useEffect(() => {
    const controller = new AbortController();
    sdk.plugins.getSettings({ pluginId, signal: controller.signal })
      .then((response) => {
        const next = parseSettings(response.values);
        setSettings((current) => current !== null && sameSettings(current, next) ? current : next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Session Log could not load its settings, so it uses the defaults.", error);
        setSettings((current) => current ?? DEFAULT_SETTINGS);
      });
    return () => controller.abort();
  }, [sdk, pluginId, version]);

  return settings;
}
