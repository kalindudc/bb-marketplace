import type { ExperimentalOpenTabOptions, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";

export const PANEL_ACTION_ID = "changes";
export const PANEL_TAB: ExperimentalOpenTabOptions = {
  tab: { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" },
};

export function createCommands(): PluginCommandRegistration[] {
  return [
    {
      id: "open",
      title: "Vantage: Show changes across repositories",
      isAvailable: ({ threadId }) => threadId !== null,
      run({ experimental_panel }) {
        experimental_panel.openTab(PANEL_TAB);
      },
    },
  ];
}
