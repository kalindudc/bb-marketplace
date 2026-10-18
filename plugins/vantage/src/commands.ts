import type { PluginCommandRegistration } from "@get-bb/plugin-sdk/app";

export const PANEL_ACTION_ID = "changes";

export function createCommands(): PluginCommandRegistration[] {
  return [
    {
      id: "open",
      title: "Vantage: Show changes across repositories",
      isAvailable: ({ threadId }) => threadId !== null,
      run({ openPanel }) {
        openPanel({ actionId: PANEL_ACTION_ID });
      },
    },
  ];
}
