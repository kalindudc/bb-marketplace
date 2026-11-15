import { useEffect } from "react";
import { experimental_usePluginId, useComposer, type ComposerDraftReplacement, type ComposerDraftSnapshot, type ComposerMention } from "@get-bb/plugin-sdk/app";

/** The server's "@" provider (server.ts): item id is the named thread's id, title its given name. */
export const NAMES_PROVIDER = "names";

const isName = (mention: ComposerMention, pluginId: string): mention is Extract<ComposerMention, { kind: "plugin" }> =>
  mention.kind === "plugin" && mention.pluginId === pluginId && mention.provider === NAMES_PROVIDER;

/**
 * bb turns a picked provider item into a plugin pill; Tavern swaps it for bb's own thread mention over the same text and range,
 * so the sent message links the thread and the agent gets bb's exact reference. Returns the same snapshot when there is nothing to swap.
 */
export function swapNameMentions(draft: ComposerDraftSnapshot, pluginId: string): ComposerDraftSnapshot | ComposerDraftReplacement {
  if (!draft.mentions.some(m => isName(m, pluginId))) return draft;
  return {
    text: draft.text,
    mentions: draft.mentions.map(m => isName(m, pluginId) ? { kind: "thread" as const, threadId: m.id, label: m.label, from: m.from, to: m.to } : m),
  };
}

/** A bare composer banner that draws nothing: it only swaps name pills as they appear. */
export function NameMentionSwap() {
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const draft = composer.draft;
  useEffect(() => {
    if (draft.mentions.some(m => isName(m, pluginId))) composer.replace(current => swapNameMentions(current, pluginId));
  }, [draft, pluginId]);
  return null;
}
