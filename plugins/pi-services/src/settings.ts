/** The realtime channel the server publishes on when a setting changes. */
export const SETTINGS_CHANNEL = "pi-services/settings";

export interface PiServicesSettings {
  executable: string;
  model: string;
}

export const DEFAULT_SETTINGS: PiServicesSettings = {
  executable: "pi",
  model: "",
};

export const SETTINGS_KV_KEY = "settings";
