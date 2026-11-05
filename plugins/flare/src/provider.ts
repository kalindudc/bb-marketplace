import type { BbPluginApi, PluginProviderFallbackModel } from "@get-bb/plugin-sdk";

// Flare's renderer: a provider that runs no model. Its threads are Flare's hidden companion threads, where each flare
// arrives as an agent-only prompt and comes back, word for word, as an assistant message. bb renders assistant
// messages with every installed plugin's renderer, so a flare looks exactly like a reply would, and Flare needs to
// know nothing about those plugins. Nothing here calls a model: a turn costs no tokens and no money.

export const PROVIDER_ID = "flare";
export const MODEL_ID = "flare-renderer";
export const REASONING_LEVEL = "low";

/** Starts every prompt Flare sends a companion, naming the flare; the renderer echoes only what follows it. */
export const RENDER_MARKER = "[flare:render]\n";
const RENDER_PROMPT = /^\[flare:render(?: ([A-Za-z0-9_-]{1,64}))?\]\n/;

/** The prompt that shows one flare in a companion. The flare id lets the Flares tab put a divider over its message. */
export const renderPrompt = (flareId: string, text: string): string => `[flare:render ${flareId}]\n${text}`;

/** A prompt Flare sent a companion, read back: which flare (null before 0.2) and the text to show; null otherwise. */
export function parseRenderPrompt(prompt: string): { flareId: string | null; text: string } | null {
  const match = RENDER_PROMPT.exec(prompt);
  return match === null ? null : { flareId: match[1] ?? null, text: prompt.slice(match[0].length) };
}

/** What the renderer answers a prompt Flare did not send, for someone who picked it for a thread of their own. */
export const NOT_AN_AGENT =
  "This is Flare's renderer, not an agent: it only shows flares in the Flares tab, and it runs no model. Pick another provider for this thread.";

export const RENDERER_MODEL = {
  id: MODEL_ID,
  displayName: "Flare renderer",
  description: "Shows flares in the Flares tab. Runs no model and costs nothing; not for chatting.",
  supportedReasoningEfforts: [{ reasoningEffort: REASONING_LEVEL, description: "No model runs" }],
  defaultReasoningEffort: REASONING_LEVEL,
  isDefault: true,
} satisfies PluginProviderFallbackModel;

export function registerProvider(bb: BbPluginApi): void {
  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "Flare",
    icon: "flare/flare",
    strings: {
      signInHint: "Nothing to sign in to: Flare's renderer runs no model.",
      expiredHint: "Flare's renderer has no session to expire.",
      installUrl: "https://github.com/kalindudc/bb-marketplace/tree/main/plugins/flare",
      iconTint: { light: "#b45309", dark: "#f59e0b" },
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
    // A companion turn is a single message; folding it into "Worked for" would hide the flare.
    completedTurnDisplay: "flat",
    models: { fallback: [RENDERER_MODEL] },
  });
}
