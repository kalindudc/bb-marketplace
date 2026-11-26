import { experimental_usePluginId, useBbNavigate, useComposer, type ComposerDraftReplacement, type ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";
import { armClassSettings } from "./remember";

export function withClassPill(draft: ComposerDraftSnapshot, cls: { id: string; label: string }, pluginId: string): ComposerDraftReplacement {
  let text = draft.text;
  let mentions = [...draft.mentions];
  const prior = mentions.filter((m) => m.kind === "plugin" && m.pluginId === pluginId && m.provider === "classes").sort((a, b) => b.from - a.from);
  if (prior.length === 1 && "id" in prior[0]! && prior[0]!.id === cls.id) return draft;
  for (const removed of prior) {
    text = text.slice(0, removed.from) + text.slice(removed.to);
    mentions = mentions.filter((m) => m !== removed).map((m) => m.from >= removed.to ? { ...m, from: m.from - (removed.to - removed.from), to: m.to - (removed.to - removed.from) } : m);
  }
  const shift = cls.label.length + 1;
  return { ...draft, text: `${cls.label} ${text}`, mentions: [{ kind: "plugin", pluginId, provider: "classes", id: cls.id, label: cls.label, from: 0, to: cls.label.length }, ...mentions.map((m) => ({ ...m, from: m.from + shift, to: m.to + shift }))] };
}

type KeeperDraft = { projectId: string; goal: string };
let opening: KeeperDraft | undefined;

// The host seeds a prompt only into an empty draft. Never retag a different, unsent draft.
export function takeKeeperDraft(projectId: string | null, text: string): boolean {
  if (!opening || opening.projectId !== projectId || opening.goal !== text) return false;
  opening = undefined;
  return true;
}

export function useStartKeeper(keeper = { id: "keeper", label: "Keeper" }) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  return (draft?: KeeperDraft) => {
    if (draft) {
      if (composer.scope.kind === "new-thread" && composer.scope.projectId === draft.projectId && composer.draft.text === draft.goal) {
        composer.replace(current => withClassPill(current, keeper, pluginId));
      } else opening = draft;
      navigate.toCompose({ projectId: draft.projectId, focusPrompt: true, initialPrompt: draft.goal });
      return;
    }
    opening = undefined;
    const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId ?? undefined : undefined;
    armClassSettings(keeper.id);
    navigate.toCompose({ projectId, focusPrompt: true });
    if (composer.scope.kind === "new-thread") composer.replace(current => withClassPill(current, keeper, pluginId));
  };
}
