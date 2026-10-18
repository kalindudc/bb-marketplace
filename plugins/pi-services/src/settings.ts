import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";

/** The realtime channel the server publishes on when a setting changes. */
export const SETTINGS_CHANNEL = "pi-services/settings";

export const SETTING_DESCRIPTORS = {
  executable: {
    type: "string",
    label: "Pi executable",
    description: "Command or path used to launch the pi CLI from the bb server.",
    default: "pi",
  },
  model: {
    type: "string",
    label: "Model",
    description: "Model passed to pi --model (for example sonnet:high or provider/model). Leave empty to use pi's default model.",
    default: "",
  },
} satisfies PluginSettingDescriptors;
