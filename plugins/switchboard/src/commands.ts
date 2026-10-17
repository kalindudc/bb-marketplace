import type { PluginCommandRegistration } from "@get-bb/plugin-sdk/app";

export interface ListHandlers {
  focusFilter(): void;
  nextNeedsYou(): void;
  toggleView(): void;
  newSection(): void;
}

let active: ListHandlers | null = null;

export function registerListHandlers(handlers: ListHandlers): () => void {
  active = handlers;
  return () => { if (active === handlers) active = null; };
}

export function createCommands(): PluginCommandRegistration[] {
  const command = (id: string, title: string, key: keyof ListHandlers,
    defaultShortcut?: PluginCommandRegistration["defaultShortcut"]): PluginCommandRegistration => ({
    id, title, ...(defaultShortcut ? { defaultShortcut } : {}),
    isAvailable: () => active !== null,
    run: () => { active?.[key](); },
  });
  return [
    command("focus-filter", "Switchboard: Focus the thread filter", "focusFilter", { key: "f", mod: true, alt: true }),
    command("next-needs-you", "Switchboard: Go to the next thread that needs you", "nextNeedsYou", { key: "j", mod: true, alt: true }),
    command("toggle-view", "Switchboard: Switch between sections and status lanes", "toggleView"),
    command("new-section", "Switchboard: New section", "newSection"),
  ];
}
