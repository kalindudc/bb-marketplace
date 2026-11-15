import type { BbPluginApi, PluginProviderFallbackModel } from "@get-bb/plugin-sdk";

export const PROVIDER_ID = "tavern";
export const MODEL_ID = "tavern-renderer";
export const REASONING_LEVEL = "low";
export const RENDER_MARKER = "[tavern:render]\n";
const RENDER_PROMPT = /^\[tavern:render(?: ([A-Za-z0-9_-]{1,64}))?\]\n/;
export const renderPrompt = (questId: string, text: string): string => `[tavern:render ${questId}]\n${text}`;

export function parseRenderPrompt(prompt: string): { questId: string | null; text: string } | null {
  const match = RENDER_PROMPT.exec(prompt);
  return match === null ? null : { questId: match[1] ?? null, text: prompt.slice(match[0].length) };
}

export const NOT_AN_AGENT =
  "This is Tavern's renderer, not an agent: it only shows the Keeper's delivery on the tale page, and it runs no model. Pick another provider for this thread.";

export const RENDERER_MODEL = {
  id: MODEL_ID,
  displayName: "Tavern renderer",
  description: "Shows the Keeper's delivery on the tale page. Runs no model and costs nothing; not for chatting.",
  supportedReasoningEfforts: [{ reasoningEffort: REASONING_LEVEL, description: "No model runs" }],
  defaultReasoningEffort: REASONING_LEVEL,
  isDefault: true,
} satisfies PluginProviderFallbackModel;

export function registerProvider(bb: BbPluginApi): void {
  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "Tavern renderer",
    icon: "tavern/tavern",
    strings: {
      signInHint: "Nothing to sign in to: Tavern's renderer runs no model.",
      expiredHint: "Tavern's renderer has no session to expire.",
      installUrl: "https://github.com/kalindudc/bb-marketplace/tree/main/plugins/tavern",
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [REASONING_LEVEL],
    },
    reasoningLevels: [{ id: REASONING_LEVEL, label: "None" }],
    composerActions: [],
    completedTurnDisplay: "flat",
    models: { fallback: [RENDERER_MODEL] },
  });
}
