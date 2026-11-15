import { useState } from "react";
import { experimental_usePluginId, useBbNavigate, useComposer, type ComposerDraftReplacement, type ComposerDraftSnapshot, type ComposerSelection } from "@get-bb/plugin-sdk/app";
import type { ClassDef } from "../../shared/schema";
import { Crest } from "../kit";
import type { Registry } from "./common";
import { armClassSettings } from "../kit/remember";

/** The draft with one class pill in front, replacing any class pill already there. */
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

/** A class's picker values: provider, model, permission mode and a known reasoning level. */
export function classSelection(cls: Pick<ClassDef, "provider" | "model" | "permission" | "reasoning">): ComposerSelection {
  const selection: ComposerSelection = {};
  if (cls.provider) selection.providerId = cls.provider;
  if (cls.model) selection.model = cls.model;
  if (cls.permission) selection.permissionMode = cls.permission;
  if (cls.reasoning && ["minimal", "low", "medium", "high", "xhigh"].includes(cls.reasoning)) selection.reasoningLevel = cls.reasoning as ComposerSelection["reasoningLevel"];
  return selection;
}

export function ClassStartCards({ registry, openComposer = false }: { registry: Registry; openComposer?: boolean }) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [error, setError] = useState<string | null>(null);
  // On the Tavern page (openComposer) bb's composer opens first, then the class pill goes into its draft; the composer's class
  // banner applies the armed class's model and permissions, because a page has no pickers and bb rejects setSelection there.
  // On bb's homepage the composer is right here, so the cards set them, and a refusal shows below the cards.
  const choose = async (cls: ClassDef) => {
    if (composer.scope.kind !== "new-thread") return;
    setError(null);
    if (openComposer) { armClassSettings(cls.id); navigate.toCompose({ projectId: composer.scope.projectId ?? undefined, focusPrompt: true }); }
    try {
      composer.replace((draft) => withClassPill(draft, cls, pluginId));
      if (openComposer) return;
      await composer.setSelection(classSelection(cls));
      composer.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <>{error && <p role="alert">Could not start this class: {error}</p>}<div className="tv-start-cards">{registry.classes.filter((cls) => cls.startable).map((cls) => { const candidates = cls.characters.flatMap((id) => { const character = registry.characters.find((item) => item.id === id); return character ? [character] : []; }); const character = candidates[0]; const names = new Intl.ListFormat("en-GB", { type: "disjunction" }).format(candidates.map((candidate) => candidate.name)); return <button className={`tv-start-card ${openComposer && cls.id === "keeper" ? "tv-start-keeper" : ""}`} key={cls.id} disabled={composer.scope.kind !== "new-thread"} onClick={() => void choose(cls)}><span>{character && <Crest cls={cls} character={character} size={28} />}<strong>{openComposer && cls.id === "keeper" ? "Start with a " : ""}{cls.label}</strong> <small>({cls.plain})</small></span><span>{names ? `Candidates: ${names}` : "Character assigned at start"}</span>{!openComposer && <span>{cls.description}</span>}<small>{cls.model ?? "project default model"}</small></button>; })}</div></>;
}
